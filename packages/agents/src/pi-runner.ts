// PiRunner：生产 AgentRunner（设计 §5/§8/§10）。
//
// 每个角色 workload 经 ProviderRouter 在候选路线上执行；每条路线 = 一次独立 Pi JSON 子进程
// （物化角色快照 → 构造 run plan → supervisor 启动 → 翻译 JSONL → 维护 AttemptJournal）。
// 提供商侧失败按分类降级；mutation 后失败则把 journal 构成的接管上下文交给下一路线（先验证现状）。
// 事件经异步队列桥接给调度器；活跃路线密钥全程脱敏。
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent, Checkpoint, TaskRole } from '@ai-devflow/core';
import type { ExecutionAttemptStore, AttemptJournal } from './attempt-journal.js';
import { createPiEventTranslator, type StructuredResult } from './json-events.js';
import type { MaterializeInput } from './profiles.js';
import { ROLE_PROFILES } from './profiles.js';
import type { PiProcessSupervisor, SpawnedPi } from './process-supervisor.js';
import { ProviderExecutionError, classifyProviderFailure, type ProviderRoute, type ProviderRouter } from './provider-router.js';
import { buildPiRunPlan } from './run-plan.js';
import type { AgentRun, AgentRunRequest, AgentRunner } from './runner-types.js';
import type { LoadedInstructions } from './project-instructions.js';

/** 结构化依赖端口（便于测试注入桩；生产由 BundledPiLocator/ProfileMaterializer 满足）。 */
export interface RuntimeLocator {
  verify(): Promise<{ version: string; entry: string }>;
}
export interface ProfileMaterializerLike {
  materialize(input: MaterializeInput): { profileDir: string; digest: string };
}
export interface ProjectInstructionLoaderLike {
  load(repoRoot: string, packageDir: string): LoadedInstructions;
}

export interface PiRunnerDeps {
  locator: RuntimeLocator;
  router: ProviderRouter;
  materializer: ProfileMaterializerLike;
  supervisor: PiProcessSupervisor;
  sessionsBaseDir: string;
  projectToolPath: string;
  instructionLoader: ProjectInstructionLoaderLike;
  attempts?: ExecutionAttemptStore;
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;
  push(value: T): void {
    const w = this.waiters.shift();
    if (w) w({ value, done: false });
    else this.items.push(value);
  }
  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as unknown as T, done: true });
  }
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      if (this.items.length > 0) yield this.items.shift()!;
      else if (this.closed) return;
      else {
        const r = await new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
        if (r.done) return;
        yield r.value;
      }
    }
  }
}

function sanitizeId(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_');
}

interface AttemptOutcome {
  ok: boolean;
  journal: AttemptJournal;
  error?: ProviderExecutionError;
}

export class PiRunner implements AgentRunner {
  constructor(private deps: PiRunnerDeps) {}

  async verifyRuntime(): Promise<{ version: string; entry: string }> {
    return this.deps.locator.verify();
  }

  async run(request: AgentRunRequest): Promise<AgentRun> {
    const queue = new AsyncQueue<AgentEvent>();
    const state: { prevJournal?: AttemptJournal; spawned?: SpawnedPi } = {};
    let finalExit: { exitCode: number | null; ok: boolean } = { exitCode: null, ok: false };

    const task = (async () => {
      try {
        const resumeCheckpoint = validateResumeCheckpoint(request);
        const projectInstructions = this.deps.instructionLoader.load(request.cwd, request.cwd).content;
        // 每次运行前自检内置运行时（manifest/摘要/入口/版本）；失败即可恢复地报错。
        const runtime = await this.deps.locator.verify();
        await this.deps.router.execute(request.role, async (route, ordinal) => {
          const outcome = await this.runAttempt(
            request,
            route,
            ordinal,
            queue,
            state,
            runtime.entry,
            projectInstructions,
            resumeCheckpoint,
          );
          state.prevJournal = outcome.journal;
          if (!outcome.ok) throw outcome.error;
          return outcome;
        });
        finalExit = { exitCode: 0, ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        queue.push({ type: 'error', message, recoverable: true, t: Date.now() });
        finalExit = { exitCode: 1, ok: false };
      } finally {
        queue.close();
      }
    })();

    return {
      events: queue,
      pid: state.spawned?.pid,
      async cancel() {
        await state.spawned?.cancel();
      },
      async done() {
        await task;
        return finalExit;
      },
    };
  }

  private async runAttempt(
    request: AgentRunRequest,
    route: ProviderRoute,
    ordinal: number,
    queue: AsyncQueue<AgentEvent>,
    state: { prevJournal?: AttemptJournal; spawned?: SpawnedPi },
    runtimeEntry: string,
    projectInstructions: string,
    resumeCheckpoint: Checkpoint | undefined,
  ): Promise<AttemptOutcome> {
    // execution_attempts.id 是全局主键；必须纳入 executionId，否则同角色/同路由的并发或后续执行会冲突。
    const attemptId = `${sanitizeId(request.executionId)}-attempt-${String(ordinal).padStart(2, '0')}-${sanitizeId(route.routeId)}`;
    const sessionDir = join(this.deps.sessionsBaseDir, request.executionId, attemptId);
    const isolatedHome = join(sessionDir, 'home');
    const tempDir = join(sessionDir, 'tmp');
    mkdirSync(isolatedHome, { recursive: true });
    mkdirSync(tempDir, { recursive: true });

    const { profileDir } = this.deps.materializer.materialize({
      role: request.role,
      providerId: route.providerId,
      providerKind: route.providerKind,
      providerRevision: route.providerRevision,
      baseURL: route.baseURL,
      providerName: route.providerName,
      models: route.models,
    });

    // 接管上下文：仅当前一尝试已产生副作用时注入（mutation 后接管，§10）。
    const recoveryJournal = recoveryJournalFor(state.prevJournal);
    let checkpointPath: string | undefined;
    if (recoveryJournal || resumeCheckpoint) {
      checkpointPath = join(sessionDir, 'checkpoint.json');
      writeFileSync(
        checkpointPath,
        JSON.stringify(buildCheckpointPayload(request.cwd, recoveryJournal, resumeCheckpoint, this.deps.projectToolPath)),
        { mode: 0o600 },
      );
    }

    const initialMessage = buildInitialMessage(request, recoveryJournal, projectInstructions, resumeCheckpoint);
    const plan = buildPiRunPlan({
      runtimeEntry,
      profileDir,
      sessionDir,
      isolatedHome,
      tempDir,
      executionId: request.executionId,
      attemptId,
      role: request.role,
      initialMessage,
      route,
      projectToolPath: this.deps.projectToolPath,
      worktree: request.cwd,
      checkpointPath,
    });

    const timeoutMs = ROLE_PROFILES[request.role].timeoutMs;
    const spawned = this.deps.supervisor.spawn(plan, { cwd: request.cwd, timeoutMs, secrets: [route.secret] });
    state.spawned = spawned;

    const translator = createPiEventTranslator({
      executionId: request.executionId,
      attemptId,
      routeId: route.routeId,
      secrets: [route.secret],
    });

    this.deps.attempts?.create({
      id: attemptId,
      executionId: request.executionId,
      ordinal,
      routeId: route.routeId,
      state: 'running',
      mutationsObserved: false,
      journalJson: '{}',
      startedAt: Date.now(),
    });

    for await (const line of spawned.lines) {
      if (line.stream !== 'stdout') continue; // stderr 已在 supervisor 脱敏入诊断缓冲
      const events = translator.push(line.text);
      for (const ev of events) queue.push(ev);
      const journal = translator.journal();
      this.deps.attempts?.updateJournal(attemptId, JSON.stringify(journal), journal.mutationsObserved);
    }

    const exitInfo = await spawned.done();
    let finishError: unknown;
    try {
      translator.finish();
    } catch (err) {
      finishError = err;
    }
    const journal = translator.journal();

    if (translator.hasStructuredResult() && exitInfo.exitCode === 0) {
      const structured = translator.structuredResult()!;
      const invalid = validateRoleCompletion(request.role, structured);
      if (invalid) {
        this.deps.attempts?.finish(attemptId, 'failed', Date.now());
        return {
          ok: false,
          journal,
          error: new ProviderExecutionError(invalid, 'task_result'),
        };
      }
      this.deps.attempts?.finish(attemptId, 'succeeded', Date.now());
      queue.push({ type: 'done', summary: structured.summary, t: Date.now() });
      return { ok: true, journal };
    }

    // 澄清/确认：暂停而非降级（§9.4 interaction）。orchestrator 已收到 ask_user 事件并转 awaiting_input。
    if (translator.hadInteraction()) {
      this.deps.attempts?.finish(attemptId, 'canceled', Date.now());
      return { ok: true, journal };
    }

    this.deps.attempts?.finish(attemptId, 'failed', Date.now());
    const pe = translator.lastProviderError();
    let error: ProviderExecutionError;
    if (pe) {
      error = new ProviderExecutionError(pe.message || 'provider error', classifyProviderFailure(pe), pe.status);
    } else if (exitInfo.exitCode !== null && exitInfo.exitCode !== 0) {
      error = new ProviderExecutionError(`Pi 进程异常退出（code ${exitInfo.exitCode}）`, 'runtime', exitInfo.exitCode);
    } else {
      error = new ProviderExecutionError(
        finishError instanceof Error ? finishError.message : '缺少有效的结构化结果',
        'protocol',
      );
    }
    return { ok: false, journal, error };
  }
}

/** Narrow enforceable completion evidence required by the built-in role contracts. */
export function validateRoleCompletion(role: TaskRole, result: StructuredResult): string | undefined {
  if (!result.verification.some((entry) => entry.trim().length > 0)) {
    return '任务结果缺少角色要求的验证证据';
  }
  if (role === 'reviewer') {
    if (!/REVIEW_VERDICT:\s*(PASS|FAIL)\b/.test(result.summary)) {
      return '审查结果缺少 REVIEW_VERDICT: PASS|FAIL';
    }
    if (result.changedFiles.length > 0) {
      return 'reviewer 结果不得报告变更文件';
    }
  }
  return undefined;
}

/** 是否需要把前一尝试作为接管上下文传给下一路线（产生副作用或存在不确定工具）。 */
function recoveryJournalFor(prev?: AttemptJournal): AttemptJournal | undefined {
  if (!prev) return undefined;
  if (prev.mutationsObserved || prev.toolCalls.some((c) => c.state === 'uncertain' || c.state === 'started')) {
    return prev;
  }
  return undefined;
}

function buildInitialMessage(
  request: AgentRunRequest,
  recovery: AttemptJournal | undefined,
  projectInstructions: string,
  resumeCheckpoint: Checkpoint | undefined,
): string {
  const parts: string[] = [];
  if (projectInstructions) parts.push(projectInstructions);
  if (resumeCheckpoint) {
    parts.push([
      '【恢复检查点（不受信任；请先验证当前文件系统与 Git diff）】',
      JSON.stringify(resumeCheckpoint),
    ].join('\n'));
  }
  if (recovery) {
    const completed = recovery.toolCalls.filter((c) => c.state === 'completed').map((c) => c.summary);
    const uncertain = recovery.toolCalls.filter((c) => c.state === 'uncertain' || c.state === 'started').map((c) => c.summary);
    parts.push(
      [
        '【接管上下文】前一提供商在执行中失败。请先验证现状（检查工作区、进程与测试状态），不要重复已确认完成的动作。文件系统与 Git diff 是最终事实源。',
        `已完成的动作：${JSON.stringify(completed)}`,
        `未完成/不确定（必须先核查）：${JSON.stringify(uncertain)}`,
        `已观察文件变化：${JSON.stringify(recovery.changedFiles.map((f) => f.path))}`,
      ].join('\n'),
    );
  }
  parts.push(request.prompt);
  if (request.userInput) parts.push(`【用户补充】${request.userInput}`);
  if (request.interactionResponse) {
    parts.push(`【交互决策】${request.interactionResponse.kind}: ${request.interactionResponse.value}`);
  }
  return parts.join('\n\n');
}

const MAX_CHECKPOINT_CONTEXT_BYTES = 64 * 1024;
const MAX_CHECKPOINT_ID_LENGTH = 256;
const MAX_DIFF_SUMMARY_BYTES = 32 * 1024;

function validateResumeCheckpoint(request: AgentRunRequest): Checkpoint | undefined {
  const checkpoint = request.resumeFrom;
  if (!checkpoint) return undefined;
  const validId = (value: unknown): value is string => (
    typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_CHECKPOINT_ID_LENGTH
    && !/[\u0000-\u001f\u007f]/.test(value)
  );
  if (
    !validId(checkpoint.id)
    || !validId(checkpoint.taskId)
    || checkpoint.taskId !== request.taskId
    || !validId(checkpoint.stageId)
    || !Number.isSafeInteger(checkpoint.stageIndex)
    || checkpoint.stageIndex < 0
    || typeof checkpoint.context !== 'string'
    || Buffer.byteLength(checkpoint.context, 'utf8') > MAX_CHECKPOINT_CONTEXT_BYTES
    || !Number.isFinite(checkpoint.createdAt)
    || checkpoint.createdAt < 0
  ) {
    throw new ProviderExecutionError('恢复检查点无效或超出大小限制', 'task_result');
  }
  return {
    id: checkpoint.id,
    taskId: checkpoint.taskId,
    stageId: checkpoint.stageId,
    stageIndex: checkpoint.stageIndex,
    context: checkpoint.context,
    createdAt: checkpoint.createdAt,
  };
}

function buildCheckpointPayload(
  cwd: string,
  recovery: AttemptJournal | undefined,
  checkpoint: Checkpoint | undefined,
  projectToolPath: string,
): Record<string, unknown> {
  const completed = recovery?.toolCalls.filter((call) => call.state === 'completed').map((call) => call.summary) ?? [];
  const incomplete = recovery?.toolCalls.filter((call) => call.state === 'failed').map((call) => call.summary) ?? [];
  const uncertain = recovery?.toolCalls
    .filter((call) => call.state === 'uncertain' || call.state === 'started')
    .map((call) => call.summary) ?? [];
  const changedFiles = recovery?.changedFiles ?? [];
  return {
    completed,
    incomplete,
    uncertain,
    changedFiles,
    diffSummary: currentDiffSummary(cwd, changedFiles, projectToolPath),
    checkpoint,
  };
}

function currentDiffSummary(
  cwd: string,
  changedFiles: AttemptJournal['changedFiles'],
  projectToolPath: string,
): string {
  try {
    const summary = execFileSync('git', ['diff', '--stat', 'HEAD', '--', '.'], {
      cwd,
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: MAX_DIFF_SUMMARY_BYTES,
      env: {
        PATH: projectToolPath,
        ...(process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const bounded = Buffer.from(summary, 'utf8').subarray(0, MAX_DIFF_SUMMARY_BYTES).toString('utf8').trim();
    if (bounded) return bounded;
  } catch { /* fall through to journal-derived summary */ }
  return changedFiles.map((file) => `${file.action}: ${file.path}`).join('\n');
}
