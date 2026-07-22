// PiRunner：生产 AgentRunner（设计 §5/§8/§10）。
//
// 每个角色 workload 经 ProviderRouter 在候选路线上执行；每条路线 = 一次独立 Pi JSON 子进程
// （物化角色快照 → 构造 run plan → supervisor 启动 → 翻译 JSONL → 维护 AttemptJournal）。
// 提供商侧失败按分类降级；mutation 后失败则把 journal 构成的接管上下文交给下一路线（先验证现状）。
// 事件经异步队列桥接给调度器；活跃路线密钥全程脱敏。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent } from '@ai-devflow/core';
import type { ExecutionAttemptStore, AttemptJournal } from './attempt-journal.js';
import { createPiEventTranslator } from './json-events.js';
import type { MaterializeInput } from './profiles.js';
import { ROLE_PROFILES } from './profiles.js';
import type { PiProcessSupervisor, SpawnedPi } from './process-supervisor.js';
import { ProviderExecutionError, classifyProviderFailure, type ProviderRoute, type ProviderRouter } from './provider-router.js';
import { buildPiRunPlan } from './run-plan.js';
import type { AgentRun, AgentRunRequest, AgentRunner } from './runner-types.js';

/** 结构化依赖端口（便于测试注入桩；生产由 BundledPiLocator/ProfileMaterializer 满足）。 */
export interface RuntimeLocator {
  verify(): Promise<{ version: string; entry: string }>;
}
export interface ProfileMaterializerLike {
  materialize(input: MaterializeInput): { profileDir: string; digest: string };
}

export interface PiRunnerDeps {
  locator: RuntimeLocator;
  router: ProviderRouter;
  materializer: ProfileMaterializerLike;
  supervisor: PiProcessSupervisor;
  sessionsBaseDir: string;
  projectToolPath: string;
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
        // 每次运行前自检内置运行时（manifest/摘要/入口/版本）；失败即可恢复地报错。
        const runtime = await this.deps.locator.verify();
        await this.deps.router.execute(request.role, async (route, ordinal) => {
          const outcome = await this.runAttempt(request, route, ordinal, queue, state, runtime.entry);
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
      providerRevision: 1,
      baseURL: route.baseURL,
      providerName: route.providerName,
      models: [route.model],
    });

    // 接管上下文：仅当前一尝试已产生副作用时注入（mutation 后接管，§10）。
    let checkpointPath: string | undefined;
    const recoveryJournal = recoveryJournalFor(state.prevJournal);
    if (recoveryJournal) {
      checkpointPath = join(sessionDir, 'checkpoint.json');
      writeFileSync(checkpointPath, JSON.stringify(recoveryJournal), { mode: 0o600 });
    }

    const initialMessage = buildInitialMessage(request, recoveryJournal);
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
      this.deps.attempts?.finish(attemptId, 'succeeded', Date.now());
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

/** 是否需要把前一尝试作为接管上下文传给下一路线（产生副作用或存在不确定工具）。 */
function recoveryJournalFor(prev?: AttemptJournal): AttemptJournal | undefined {
  if (!prev) return undefined;
  if (prev.mutationsObserved || prev.toolCalls.some((c) => c.state === 'uncertain' || c.state === 'started')) {
    return prev;
  }
  return undefined;
}

function buildInitialMessage(request: AgentRunRequest, recovery?: AttemptJournal): string {
  const parts: string[] = [];
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
