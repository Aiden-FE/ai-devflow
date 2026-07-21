import { EventEmitter } from 'node:events';
import type {
  AgentEvent,
  Checkpoint,
  ExecutionRecord,
  LogEntry,
  Task,
  TaskStatus,
  Project,
  TaskMessage,
  PendingInteraction,
  InteractionKind,
  ReviewVerdict,
  RejectTaskInput,
} from '@ai-devflow/core';
import {
  canTransition,
  canReject,
  checkTaskDependencies,
  now,
  randomId,
  decideRetry,
  DEFAULT_RETRY_POLICY,
  type RetryPolicy,
} from '@ai-devflow/core';
import type { Repositories } from '@ai-devflow/persistence';
import type { AgentRunner, AgentRun } from '@ai-devflow/agents';
import { createWorktree, removeWorktree, mergeWorktreeBranch, WorktreeError } from './worktree.js';
import { Semaphore } from './semaphore.js';

export interface OrchestratorOptions {
  worktreesBaseDir: string;
  maxConcurrent?: number;
  retryPolicy?: RetryPolicy;
  /** 是否在可恢复失败时自动重试。 */
  autoRetry?: boolean;
  /** 审查不通过后自动返工修复的最大轮数（超过则停在开发中等待人工介入，避免无限循环）。默认 2。 */
  maxReviewRounds?: number;
  /** 是否已配置可用 AI 服务（提供商）。缺省视为 true（无提供商时 runner.run 会可恢复失败）。 */
  hasProvider?: () => boolean;
}

export interface TaskEvent {
  taskId: string;
  event: AgentEvent;
}

export interface TaskMessageEvent {
  taskId: string;
  message: TaskMessage;
}

export interface TaskInteractionEvent {
  taskId: string;
  interaction: PendingInteraction;
}

/** 启动/恢复参数。 */
export interface StartInit {
  resumeFrom?: Checkpoint;
  /** 澄清回答文本（clarification）。 */
  userInput?: string;
  /** 通用交互响应（approval/confirmation）。 */
  interactionResponse?: { kind: InteractionKind; value: string };
  /** 授权恢复：批准/拒绝的工具（合并进能力配置以放行/拒绝对应工具）。 */
  approvalTool?: { name: string; allow: boolean };
  /** 审查中（testing）暂停后的恢复：直接回到测试中重跑审查，不重复开发阶段。 */
  resumeToReview?: boolean;
}

/**
 * 活跃流水线：一次 start() 的完整生命周期（可能跨多个阶段/审查的多个 AgentRun）。
 * pause()/cancel() 通过 stopReason 请求受控停止，并借 settled 等待运行真正退出。
 */
interface ActivePipeline {
  /** 运行代次（每次 start 递增）：隔离旧运行的晚到回调（重试定时器等）。 */
  generation: number;
  /** 受控停止原因：paused（待沟通）/ canceled（取消）。设置后事件循环退出、失败处理器跳过、晚到事件丢弃。 */
  stopReason?: 'paused' | 'canceled';
  /** 当前阶段的 Agent 运行（无运行中的窗口期为 undefined）。 */
  run?: AgentRun;
  /** 当前执行记录 ID。 */
  executionId?: string;
  /** start() 完全收尾（含 finally）时解决。 */
  settled: Promise<void>;
}

const IMPLICIT_STAGE_ID = '__main__';

/** 审查 Agent 必须覆盖的基本规则维度（随审查结论一并持久化）。 */
const REVIEW_CHECKS = ['需求覆盖', '测试/构建/lint', '明显回归', '安全问题', '无关改动'];

export class Orchestrator extends EventEmitter {
  private sem: Semaphore;
  /** 活跃流水线（按任务）。存在即表示任务有正在进行的 start()。 */
  private active = new Map<string, ActivePipeline>();
  /** 每个任务的运行代次（单调递增）：隔离旧运行的晚到回调。 */
  private generations = new Map<string, number>();
  /** 可追踪、可撤销的自动重试定时器（按任务，一个任务至多一个）。 */
  private retryTimers = new Map<string, NodeJS.Timeout>();
  private retryPolicy: RetryPolicy;
  private autoRetry: boolean;
  private hasProvider: () => boolean;

  constructor(
    private repos: Repositories,
    private runner: AgentRunner,
    private opts: OrchestratorOptions,
  ) {
    super();
    this.sem = new Semaphore(opts.maxConcurrent ?? 2);
    this.retryPolicy = opts.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.autoRetry = opts.autoRetry ?? true;
    this.hasProvider = opts.hasProvider ?? (() => true);
  }

  /** 启动任务：分派 Agent、创建 worktree、运行流水线。 */
  async start(taskId: string, init?: StartInit): Promise<void> {
    const task = this.repos.tasks.get(taskId);
    if (!task) throw new Error(`任务不存在：${taskId}`);
    if (this.active.has(taskId)) throw new Error(`任务已在运行：${taskId}`);
    // 显式启动/重试：撤销该任务待执行的自动重试（一个任务同一时刻至多一个待执行重试）。
    this.revokeRetry(taskId);

    // 运行代次递增：旧运行的晚到回调（重试定时器等）据此识别并放弃。
    const generation = (this.generations.get(taskId) ?? 0) + 1;
    this.generations.set(taskId, generation);
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    const entry: ActivePipeline = { generation, settled };
    this.active.set(taskId, entry);
    try {
      const project = this.repos.projects.get(task.projectId);
      if (!project) throw new Error(`项目不存在：${task.projectId}`);

      // 串行依赖：前置任务未完成（未进入 in_review/archived）则禁止启动。
      // resume（待沟通/待授权恢复）传 init，跳过此检查：后继此前已启动过，依赖早已满足。
      if (!init && task.dependsOn && task.dependsOn.length > 0) {
        const predecessors = task.dependsOn
          .map((id) => this.repos.tasks.get(id))
          .filter((t): t is Task => !!t);
        const dep = checkTaskDependencies(predecessors.map((p) => ({ id: p.id, title: p.title, status: p.status })));
        if (!dep.ok) throw new Error(`无法启动任务：${dep.reasons.join('; ')}`);
      }

      // Pi-only：无 Agent 选择。是否有可用 AI 服务由 hasProvider() 判定（提供商配置）。
      // 状态门禁：进入 in_progress（审查恢复则回到 testing）
      if (task.status !== 'in_progress') {
        if (init?.resumeToReview) {
          this.transition(task, 'testing', { hasUserAnswer: true });
        } else {
          const gate = canTransition(task, 'in_progress', {
            hasAcceptance: true,
            hasAgentAssigned: this.hasProvider(),
            hasUserAnswer: !!init?.userInput || !!init?.interactionResponse,
            hasArtifacts: false,
          });
          if (!gate.ok && task.status !== 'awaiting_input') {
            throw new Error(`无法启动任务：${gate.reasons.join('; ')}`);
          }
          this.transition(task, 'in_progress', { hasUserAnswer: !!init?.userInput || !!init?.interactionResponse });
        }
      }

      const release = await this.sem.acquire();
      try {
        if (init?.resumeToReview) {
          await this.reviewAndFinalize(task, project, entry);
        } else {
          await this.runPipeline(task, project, init, entry);
        }
      } catch (err) {
        if (entry.stopReason) {
          // 受控停止（待沟通/取消）过程中的异常不按失败处理：任务状态由 pause()/cancel() 落定。
          const latest = this.repos.executions.getLatest(taskId);
          if (latest) this.log(latest, 'warn', `受控停止过程中忽略异常：${(err as Error).message}`);
        } else {
          this.emit('task-error', { taskId, error: (err as Error).message });
          // 用任务重试计数决定是否重试，避免依赖执行记录（worktree 失败时可能无记录）导致 attempt 不递增、无限重试。
          const attempt = task.retryCount + 1;
          this.handleFailure(task, err as Error, attempt, generation);
        }
      } finally {
        release();
      }
    } finally {
      this.active.delete(taskId);
      settle();
    }
  }

  /** 运行流水线各阶段。 */
  private async runPipeline(task: Task, project: Project, init: StartInit | undefined, entry: ActivePipeline): Promise<void> {
    const stages = task.stages.length > 0 ? task.stages : [{ id: IMPLICIT_STAGE_ID, name: '执行', role: task.role }];
    const startStage = init?.resumeFrom?.stageIndex ?? task.currentStage ?? 0;

    // 先创建执行记录：这样 worktree 创建失败等也能落日志并计入尝试次数，
    // 避免 getLatest() 永远 undefined 导致 attempt 不递增、无限重试。
    const execution: ExecutionRecord = {
      id: randomId(),
      taskId: task.id,
      attempt: (this.repos.executions.getLatest(task.id)?.attempt ?? 0) + 1,
      startedAt: now(),
      status: 'running',
    };
    this.repos.executions.insert(execution);
    entry.executionId = execution.id;
    this.log(execution, 'info', `启动 ${task.role} 角色执行（第 ${execution.attempt} 次尝试）`);

    // 启动窗口期被受控停止（如信号量等待期间 pause/cancel）：不创建 worktree，直接收尾。
    if (entry.stopReason) {
      this.markExecution(execution, entry.stopReason === 'paused' ? 'paused' : 'canceled', this.stopSummary(entry.stopReason));
      return;
    }

    // 创建 worktree（若恢复且已存在则复用）
    let worktreePath = task.worktreePath;
    if (!worktreePath) {
      try {
        this.log(execution, 'info', `创建 Git worktree（基础分支 ${project.defaultBranch}）…`);
        const handle = await createWorktree({
          repoPath: project.path,
          baseDir: this.opts.worktreesBaseDir,
          id: task.id,
          baseBranch: project.defaultBranch,
        });
        worktreePath = handle.path;
        this.repos.tasks.setWorktree(task.id, worktreePath);
        task.worktreePath = worktreePath;
      } catch (err) {
        const msg = err instanceof WorktreeError
          ? `${err.message}${err.hint ? '（' + err.hint + '）' : ''}`
          : (err as Error).message;
        this.log(execution, 'error', `worktree 创建失败：${msg}`);
        throw err;
      }
    }

    for (let i = startStage; i < stages.length; i++) {
      const stage = stages[i]!;
      if (entry.stopReason) {
        this.markExecution(execution, entry.stopReason === 'paused' ? 'paused' : 'canceled', this.stopSummary(entry.stopReason));
        return;
      }

      // 阶段依赖检查
      if (stage.dependsOn && stage.dependsOn.length > 0) {
        for (const dep of stage.dependsOn) {
          const depCp = this.repos.checkpoints.listByTask(task.id).find((c) => c.stageId === dep);
          if (!depCp) {
            this.log(execution, 'error', `阶段 ${stage.id} 依赖 ${dep} 的检查点不存在`);
            throw new Error(`阶段依赖未满足：${dep}`);
          }
        }
      }

      task.currentStage = i;
      this.repos.tasks.update(task);

      const prompt = this.buildPrompt(task, stage);
      const run = await this.runner.run({
        taskId: task.id,
        executionId: execution.id,
        role: task.role,
        prompt,
        cwd: worktreePath!,
        resumeFrom: i === startStage ? init?.resumeFrom : undefined,
        userInput: i === startStage ? init?.userInput : undefined,
        interactionResponse: i === startStage ? init?.interactionResponse : undefined,
      });
      entry.run = run;

      let stageDone = false;
      let askedUser = false;
      try {
        for await (const ev of run.events) {
          // 受控停止（pause/cancel）：丢弃晚到事件，取消运行并退出循环。
          if (entry.stopReason) {
            await run.cancel();
            break;
          }
          await this.handleEvent(task, execution, ev, entry);
          if (ev.type === 'ask_user' || ev.type === 'approval_request') {
            askedUser = true;
            // 暂停：记录检查点与待处理交互，执行记录标记 paused，转 awaiting_input，停止当前运行。
            // 拒绝授权不判定成功：暂停后由用户决策，恢复时按决策放行/拒绝，绝不自动归档。
            this.recordCheckpoint(task, stage, i, ev);
            this.markExecution(execution, 'paused', ev.type === 'ask_user' ? '等待用户回答' : '等待工具授权');
            this.transition(task, 'awaiting_input');
            task.pausedFrom = 'in_progress';
            await run.cancel();
            break;
          }
          if (ev.type === 'done') {
            stageDone = true;
          }
          if (ev.type === 'error') {
            throw new Error((ev as { message: string }).message);
          }
        }
      } finally {
        entry.run = undefined;
      }

      if (askedUser) return; // 等待用户回答/授权后 resume

      if (!stageDone) {
        // 阶段未正常完成（受控停止或异常）
        if (entry.stopReason) {
          this.markExecution(execution, entry.stopReason === 'paused' ? 'paused' : 'canceled', this.stopSummary(entry.stopReason));
          return;
        }
        throw new Error(`阶段 ${stage.id} 未完成`);
      }

      // 阶段完成，写检查点
      this.recordCheckpoint(task, stage, i, { type: 'status', stage: stage.id, detail: 'done', t: now() });
      execution.status = 'succeeded';
      execution.endedAt = now();
      execution.summary = `${stage.name} 完成`;
      this.repos.executions.update(execution);
    }

    // 全部开发阶段完成 -> 进入「测试中」，启动 reviewer 角色对应的审查 Agent。
    // 开发任务禁止直接进入待验收：必须经审查通过才合并并进入 in_review。
    this.transition(task, 'testing');
    await this.reviewAndFinalize(task, project, entry);
  }

  private stopSummary(reason: 'paused' | 'canceled'): string {
    return reason === 'paused' ? '手动暂停，等待补充说明' : '用户取消';
  }

  /**
   * 审查并定稿：运行 reviewer 审查 Agent。
   * - 通过 -> 合并特性分支到默认分支 -> in_review（待验收），归档仍需人工验收（tasks.accept）。
   * - 不通过 -> 退回 in_progress 并携反馈从头返工（有界，超过 maxReviewRounds 停下等人工介入）。
   */
  private async reviewAndFinalize(task: Task, project: Project, entry: ActivePipeline): Promise<void> {
    const verdict = await this.runReview(task, project, entry);
    // 受控停止（待沟通/取消）：任务状态由 pause()/cancel() 落定，此处直接收尾。
    if (!verdict) return;
    if (verdict.pass) {
      const branchName = `ai-devflow/${task.id}`;
      const mergeRes = await mergeWorktreeBranch({
        repoPath: project.path,
        branchName,
        defaultBranch: project.defaultBranch,
      });
      const latest = this.repos.executions.getLatest(task.id);
      if (mergeRes.merged) {
        this.recordMessage(task, latest, { role: 'system', kind: 'status', text: `审查通过，已合并到 ${project.defaultBranch}，产出已落入主项目` });
      } else {
        this.recordMessage(task, latest, { role: 'system', kind: 'status', text: `审查通过，但未自动合并：${mergeRes.reason}（工作保留在分支 ${branchName}）` });
      }
      // 审查通过才进入待验收（门禁 reviewPassed 强制，拒绝拖拽/IPC 绕过）。
      this.transition(task, 'in_review', { reviewPassed: true });
      return;
    }

    // 审查不通过 -> 退回开发中携反馈修复。
    const feedback = verdict.feedback ?? verdict.summary;
    this.recordMessage(task, this.repos.executions.getLatest(task.id), {
      role: 'assistant', kind: 'text', text: `审查不通过，退回开发中修复：${feedback}`,
    });
    const maxRounds = this.opts.maxReviewRounds ?? 2;
    if (task.retryCount >= maxRounds) {
      // 有界：避免审查-返工无限循环。停在开发中并给出可见错误，等待人工介入。
      this.transition(task, 'in_progress');
      this.emit('task-error', {
        taskId: task.id,
        error: `审查 ${maxRounds} 轮仍不通过，已停止自动返工，请人工介入。最后反馈：${feedback}`,
      });
      return;
    }
    this.repos.tasks.incRetry(task.id);
    task.retryCount += 1;
    this.transition(task, 'in_progress');
    // 携反馈从头重新执行开发（重置阶段索引）。
    task.currentStage = 0;
    this.repos.tasks.update(task);
    await this.runPipeline(task, project, { userInput: `[审查反馈，请据此修复] ${feedback}` }, entry);
  }

  /**
   * 启动 reviewer 角色对应的审查 Agent 并解析审查结论。
   * 审查上下文包含：需求描述/验收标准、任务目标、git diff/产物与基本规则；
   * 结论与证据持久化到执行记录摘要与任务对话。
   */
  /**
   * 启动 reviewer 角色对应的审查 Agent 并解析审查结论。
   * 返回 undefined 表示审查被受控停止（待沟通/取消），调用方直接收尾。
   */
  private async runReview(task: Task, project: Project, entry: ActivePipeline): Promise<ReviewVerdict | undefined> {
    const execution: ExecutionRecord = {
      id: randomId(),
      taskId: task.id,
      attempt: (this.repos.executions.getLatest(task.id)?.attempt ?? 0) + 1,
      startedAt: now(),
      status: 'running',
    };
    this.repos.executions.insert(execution);
    entry.executionId = execution.id;
    this.log(execution, 'info', `启动审查执行（reviewer，第 ${execution.attempt} 次）`);

    const prompt = this.buildReviewPrompt(task);
    let output = '';
    let errored: string | undefined;
    try {
      const run = await this.runner.run({
        taskId: task.id,
        executionId: execution.id,
        role: 'reviewer',
        prompt,
        cwd: task.worktreePath ?? project.path,
      });
      entry.run = run;
      try {
        for await (const ev of run.events) {
          // 受控停止（pause/cancel）：丢弃晚到事件，取消审查运行并退出循环。
          if (entry.stopReason) {
            await run.cancel();
            break;
          }
          await this.handleEvent(task, execution, ev, entry);
          if (ev.type === 'done') output += `\n${ev.summary}`;
          else if (ev.type === 'log') output += `\n${ev.text}`;
          else if (ev.type === 'error') errored = ev.message;
        }
      } finally {
        entry.run = undefined;
      }
    } catch (e) {
      errored = (e as Error).message;
    }

    // 受控停止：标记审查执行记录后直接收尾，绝不停留期间误判 FAIL 进入返工分支。
    if (entry.stopReason) {
      this.markExecution(execution, entry.stopReason === 'paused' ? 'paused' : 'canceled', `审查已停止（${this.stopSummary(entry.stopReason)}）`);
      return undefined;
    }

    const verdict = this.parseReviewVerdict(output, errored);
    // 持久化审查结论与证据：执行记录摘要 + 任务对话。
    this.markExecution(
      execution,
      verdict.pass ? 'succeeded' : 'failed',
      `[review:${verdict.pass ? 'pass' : 'fail'}] ${verdict.summary}${verdict.feedback ? ` | 反馈: ${verdict.feedback}` : ''}`,
    );
    this.recordMessage(task, execution, {
      role: 'assistant',
      kind: 'text',
      text: `【审查结论】${verdict.pass ? '通过' : '不通过'}：${verdict.summary}` +
        `${verdict.feedback ? `\n反馈：${verdict.feedback}` : ''}` +
        `${verdict.checks?.length ? `\n覆盖维度：${verdict.checks.join('、')}` : ''}`,
    });
    return verdict;
  }

  /** 解析审查 Agent 输出中的结论标记；无明确 PASS 时保守按不通过（绝不绕过审查进入待验收）。 */
  private parseReviewVerdict(output: string, errored?: string): ReviewVerdict {
    const failM = /REVIEW_VERDICT:\s*FAIL:?\s*(.*)/i.exec(output);
    const passM = /REVIEW_VERDICT:\s*PASS\b/i.exec(output);
    if (failM) {
      return { pass: false, summary: '审查不通过', feedback: (failM[1] ?? '').trim() || '未给出具体原因', checks: REVIEW_CHECKS };
    }
    if (passM) {
      return { pass: true, summary: '审查通过', checks: REVIEW_CHECKS };
    }
    return {
      pass: false,
      summary: errored ? `审查执行异常：${errored}` : '审查未给出明确结论',
      feedback: errored ?? '审查 Agent 未输出 REVIEW_VERDICT 结论，按不通过处理。',
      checks: REVIEW_CHECKS,
    };
  }

  /** 构造审查上下文 prompt：需求/验收标准、任务目标、审查规则与结论输出格式。 */
  private buildReviewPrompt(task: Task): string {
    const req = this.repos.requirements.get(task.requirementId);
    return [
      '你是一名严格的代码审查 Agent（reviewer）。请审查当前工作区中针对本任务的改动（可用 git diff 查看）。',
      `【需求描述】${req?.description || '(无)'}`,
      `【验收标准】${req?.acceptance || '(无)'}`,
      `【任务目标】${task.title}`,
      `【任务描述】${task.description || '(无)'}`,
      '【审查规则】请逐项检查：1) 需求/验收标准是否覆盖；2) 测试/构建/lint 是否通过；3) 是否引入明显回归；4) 是否存在安全问题；5) 是否存在与任务无关的改动。',
      '【输出要求】最后必须单独输出一行结论，格式为：REVIEW_VERDICT: PASS 或 REVIEW_VERDICT: FAIL: <不通过原因与修复建议>。',
    ].join('\n');
  }

  /**
   * 验收不通过退回（专用 reject 操作）：原因必填，写入任务消息/审计。
   * - target='ready'：仅改状态到待开发。
   * - target='in_progress'（默认）：立即把原因作为修复上下文启动执行。
   */
  async rejectTask(input: RejectTaskInput): Promise<void> {
    const task = this.repos.tasks.get(input.taskId);
    if (!task) throw new Error(`任务不存在：${input.taskId}`);
    if (task.status !== 'in_review') throw new Error(`仅待验收任务可退回（当前状态：${task.status}）`);
    const reason = (input.reason ?? '').trim();
    const gate = canReject({
      hasAcceptance: true,
      hasAgentAssigned: this.hasProvider(),
      hasArtifacts: true,
      rejectReason: reason,
    });
    if (!gate.ok) throw new Error(gate.reasons.join('; '));

    const target: TaskStatus = input.target === 'ready' ? 'ready' : 'in_progress';
    const project = this.repos.projects.get(task.projectId);
    if (!project) throw new Error(`项目不存在：${task.projectId}`);

    const label = target === 'ready' ? '待开发' : '开发中';
    this.recordMessage(task, undefined, { role: 'user', kind: 'text', text: `验收不通过，退回${label}。原因：${reason}` });
    this.transition(task, target, { hasAcceptance: true, hasArtifacts: true });

    if (target === 'in_progress') {
      // 立即携原因作为修复上下文启动执行（异步运行；失败经 task-error 事件可见）。
      task.currentStage = 0;
      this.repos.tasks.update(task);
      void this.start(task.id, { userInput: `[验收退回，请据此修复] ${reason}` }).catch((e) =>
        this.emit('task-error', { taskId: task.id, error: `退回后启动执行失败：${(e as Error).message}` }),
      );
    }
  }

  private async handleEvent(task: Task, execution: ExecutionRecord, ev: AgentEvent, entry?: ActivePipeline): Promise<void> {
    // 旧运行的晚到事件（停止原因已设置）不落库、不转发。
    if (entry?.stopReason) return;
    this.emit('task-event', { taskId: task.id, event: ev } satisfies TaskEvent);
    const t = now();
    switch (ev.type) {
      case 'log':
      case 'file_change':
      case 'test_result': {
        const text =
          ev.type === 'log'
            ? ev.text
            : ev.type === 'file_change'
              ? `[file:${ev.action}] ${ev.path}`
              : `[test:${ev.passed ? 'pass' : 'fail'}] ${ev.summary}`;
        const level = ev.type === 'test_result' ? (ev.passed ? 'info' : 'error') : ev.type === 'log' ? ev.level : 'info';
        const entry: LogEntry = { id: randomId(), taskId: task.id, executionId: execution.id, level, text, t };
        this.repos.logs.insert(entry);
        this.emit('log', entry);
        // 同步落对话消息（旧 log_entries 保留兼容，对话窗口读 task_messages）。
        if (ev.type === 'log') {
          this.recordMessage(task, execution, { role: level === 'error' ? 'system' : 'assistant', kind: level === 'error' ? 'error' : 'text', text: ev.text, t });
        } else if (ev.type === 'file_change') {
          this.recordMessage(task, execution, { role: 'assistant', kind: 'tool_call', toolName: this.deriveToolName(text), text: `${ev.action} ${ev.path}`, t });
        } else {
          this.recordMessage(task, execution, { role: 'tool', kind: 'tool_result', toolResult: ev.summary, isError: !ev.passed, text: ev.summary, t });
        }
        break;
      }
      case 'ask_user': {
        this.repos.pendingQuestions.upsert({
          taskId: task.id,
          question: ev.question,
          context: ev.context,
          askedAt: t,
        });
        const msg = this.recordMessage(task, execution, { role: 'assistant', kind: 'clarification_request', text: ev.question, t });
        this.createInteraction(task, 'clarification', ev.question, { messageId: msg.id, detail: ev.context });
        break;
      }
      case 'approval_request': {
        const msg = this.recordMessage(task, execution, {
          role: 'assistant', kind: 'approval_request', text: ev.description,
          toolName: ev.toolName, toolUseId: ev.toolUseId, toolInput: ev.input, t,
        });
        this.createInteraction(task, 'approval', ev.toolName, {
          messageId: msg.id, detail: ev.description,
          toolName: ev.toolName, toolUseId: ev.toolUseId, requestId: ev.requestId,
        });
        break;
      }
      case 'status':
        this.recordMessage(task, execution, { role: 'system', kind: 'status', text: ev.detail ?? ev.stage, t });
        break;
      case 'done':
        execution.summary = ev.summary;
        this.recordMessage(task, execution, { role: 'system', kind: 'status', text: ev.summary, t });
        break;
      case 'error': {
        execution.summary = ev.message;
        const entry: LogEntry = { id: randomId(), taskId: task.id, executionId: execution.id, level: 'error', text: `[agent error] ${ev.message}`, t };
        this.repos.logs.insert(entry);
        this.emit('log', entry);
        this.recordMessage(task, execution, { role: 'system', kind: 'error', text: ev.message, t });
        break;
      }
    }
  }

  /** 从日志文本启发式推导工具名（如 "Write /a/b.ts" -> "Write"）。 */
  private deriveToolName(text: string): string | undefined {
    const m = /^([A-Za-z_]+)\s/.exec(text);
    return m?.[1];
  }

  /** 记录一条对话消息并转发 Renderer。 */
  private recordMessage(task: Task, execution: ExecutionRecord | undefined, msg: Omit<TaskMessage, 'id' | 'taskId' | 't'> & { t?: number }): TaskMessage {
    const m: TaskMessage = { id: randomId(), taskId: task.id, executionId: execution?.id, t: msg.t ?? now(), ...msg };
    this.repos.taskMessages.insert(m);
    this.emit('task-message', { taskId: task.id, message: m } satisfies TaskMessageEvent);
    return m;
  }

  /** 创建一条待处理交互并转发 Renderer。 */
  private createInteraction(
    task: Task,
    kind: InteractionKind,
    title: string,
    opts: { messageId?: string; detail?: string; toolName?: string; toolUseId?: string; requestId?: string },
  ): PendingInteraction {
    const i: PendingInteraction = {
      id: randomId(), taskId: task.id, kind, title, status: 'pending', createdAt: now(), ...opts,
    };
    this.repos.pendingInteractions.insert(i);
    this.emit('task-interaction', { taskId: task.id, interaction: i } satisfies TaskInteractionEvent);
    return i;
  }

  /** 写一条任务日志并转发给 Renderer。 */
  private log(execution: ExecutionRecord, level: 'info' | 'warn' | 'error', text: string): void {
    const entry: LogEntry = { id: randomId(), taskId: execution.taskId, executionId: execution.id, level, text, t: now() };
    this.repos.logs.insert(entry);
    this.emit('log', entry);
  }

  private recordCheckpoint(task: Task, stage: { id: string }, stageIndex: number, ev: AgentEvent): void {
    // 待沟通存提问上下文；授权存工具调用信息，便于恢复时重建。
    const context = ev.type === 'ask_user'
      ? ev.context
      : ev.type === 'approval_request'
        ? JSON.stringify({ toolName: ev.toolName, toolUseId: ev.toolUseId, description: ev.description })
        : '';
    const cp: Checkpoint = {
      id: randomId(),
      taskId: task.id,
      stageId: stage.id,
      stageIndex,
      context,
      createdAt: now(),
    };
    this.repos.checkpoints.upsert(cp);
  }

  /**
   * 手动暂停（标记待沟通）：停止并等待当前 Agent/子进程退出，执行记录标记 paused，
   * 任务稳定转 awaiting_input（保留 pausedFrom/阶段/检查点），并创建一条澄清交互写入对话，
   * 使用户能补充说明后恢复。停止原因隔离旧运行：其晚到事件/日志/消息不再落库。
   * 幂等：已在待沟通时仅确保存在待处理交互，快速重复调用不报错、不重复建交互。
   */
  async pause(taskId: string, note?: string): Promise<void> {
    const task = this.repos.tasks.get(taskId);
    if (!task) throw new Error(`任务不存在：${taskId}`);
    const title = note && note.trim() ? note.trim() : '手动暂停，等待补充说明';
    if (task.status === 'awaiting_input') {
      if (!this.repos.pendingInteractions.getPendingForTask(taskId)) {
        const msg = this.recordMessage(task, undefined, { role: 'system', kind: 'clarification_request', text: title });
        this.createInteraction(task, 'clarification', title, { messageId: msg.id, detail: '手动暂停：补充说明后将恢复执行。' });
      }
      return;
    }
    if (task.status !== 'in_progress' && task.status !== 'in_review' && task.status !== 'testing') {
      throw new Error('仅开发中/测试中/待验收任务可标记待沟通');
    }
    // 用户接管：撤销该任务待执行的自动重试。
    this.revokeRetry(taskId);
    // 停止并等待当前运行（Agent/子进程）退出；停止原因让事件循环退出且失败处理器跳过。
    const entry = this.active.get(taskId);
    if (entry) {
      entry.stopReason = 'paused';
      if (entry.run) await entry.run.cancel().catch(() => {});
      await entry.settled.catch(() => {});
    }
    // 执行记录兜底标记 paused（运行内停止路径已标记时跳过）。
    const latest = this.repos.executions.getLatest(taskId);
    if (latest && latest.status === 'running') {
      this.markExecution(latest, 'paused', title);
    }
    const from = task.status;
    this.transition(task, 'awaiting_input');
    task.pausedFrom = from;
    const msg = this.recordMessage(task, undefined, { role: 'system', kind: 'clarification_request', text: title });
    this.createInteraction(task, 'clarification', title, { messageId: msg.id, detail: '手动暂停：补充说明后将恢复执行。' });
  }

  /**
   * 待沟通恢复：按暂停来源泳道恢复（pausedFrom 保留在任务与数据库中）。
   * - in_progress/未知：携输入从检查点续跑开发流水线（只创建一次新运行）。
   * - testing：回到测试中重跑审查，不重复开发阶段。
   * - in_review：产物已交付且审查已通过，回答记录后直接回到待验收，不重新运行。
   * 恢复在运行建立前失败时回滚到待沟通，不留半完成状态（交互已消费的回答保留在对话中，
   * 可再次 resume —— resume 兼容无 pending 交互）。
   */
  private async resumeFromPause(task: Task, init: StartInit): Promise<void> {
    try {
      if (task.pausedFrom === 'in_review') {
        this.transition(task, 'in_review', { hasUserAnswer: true });
        return;
      }
      if (task.pausedFrom === 'testing') {
        await this.start(task.id, { ...init, resumeToReview: true });
        return;
      }
      await this.start(task.id, init);
    } catch (err) {
      const cur = this.repos.tasks.get(task.id);
      if (cur && cur.status !== 'awaiting_input' && cur.status !== 'archived' && !this.active.has(task.id)) {
        try {
          this.transition(cur, 'awaiting_input');
          task.status = 'awaiting_input';
        } catch { /* 回滚失败时保留原错误 */ }
      }
      throw err;
    }
  }

  /** 用户回答澄清后从检查点恢复（兼容旧 ask_user 流程）。 */
  async resume(taskId: string, userInput: string): Promise<void> {
    const task = this.repos.tasks.get(taskId);
    if (!task) throw new Error(`任务不存在：${taskId}`);
    if (task.status !== 'awaiting_input') throw new Error(`任务不在待沟通状态：${task.status}`);
    // 解决最早的 pending 澄清交互（如有）。
    const inter = this.repos.pendingInteractions.getPendingForTask(taskId);
    if (inter && inter.kind === 'clarification') {
      this.repos.pendingInteractions.resolve(inter.id, 'answered', userInput, now());
    }
    this.repos.pendingQuestions.answer(taskId, userInput, now());
    this.recordMessage(task, undefined, { role: 'user', kind: 'text', text: userInput });
    const cp = this.repos.checkpoints.getLatest(taskId);
    await this.resumeFromPause(task, { resumeFrom: cp ?? undefined, userInput });
  }

  /**
   * 解决通用待处理交互（澄清/授权/确认）后从检查点恢复。
   * - clarification: response 为用户文本回答。
   * - approval: response 为 'allow' | 'deny'；批准则把工具并入白名单恢复，拒绝则并入黑名单（不判定成功）。
   * - confirmation: response 为 'confirm' | 'cancel'。
   */
  async resolveInteraction(taskId: string, interactionId: string, response: string): Promise<void> {
    const task = this.repos.tasks.get(taskId);
    if (!task) throw new Error(`任务不存在：${taskId}`);
    if (task.status !== 'awaiting_input') throw new Error(`任务不在待沟通状态：${task.status}`);
    const inter = this.repos.pendingInteractions.get(interactionId);
    if (!inter) throw new Error(`交互不存在：${interactionId}`);
    if (inter.status !== 'pending') throw new Error(`交互已处理：${inter.status}`);

    const cp = this.repos.checkpoints.getLatest(taskId);
    if (inter.kind === 'clarification') {
      this.repos.pendingInteractions.resolve(interactionId, 'answered', response, now());
      this.repos.pendingQuestions.answer(taskId, response, now());
      this.recordMessage(task, undefined, { role: 'user', kind: 'text', text: response });
      await this.resumeFromPause(task, { resumeFrom: cp ?? undefined, userInput: response });
      return;
    }
    if (inter.kind === 'approval') {
      const allow = response === 'allow';
      this.repos.pendingInteractions.resolve(interactionId, allow ? 'approved' : 'denied', response, now());
      this.recordMessage(task, undefined, {
        role: 'user', kind: 'text',
        text: `${allow ? '已批准' : '已拒绝'}：${inter.toolName ?? inter.title}`,
      });
      await this.resumeFromPause(task, {
        resumeFrom: cp ?? undefined,
        interactionResponse: { kind: 'approval', value: allow ? 'allow' : 'deny' },
        approvalTool: inter.toolName ? { name: inter.toolName, allow } : undefined,
      });
      return;
    }
    // confirmation
    const confirm = response === 'confirm';
    this.repos.pendingInteractions.resolve(interactionId, confirm ? 'confirmed' : 'cancelled', response, now());
    this.recordMessage(task, undefined, { role: 'user', kind: 'text', text: confirm ? '已确认' : '已取消' });
    await this.resumeFromPause(task, {
      resumeFrom: cp ?? undefined,
      interactionResponse: { kind: 'confirmation', value: response },
    });
  }

  /**
   * 取消任务：撤销该任务全部待执行重试，停止并等待当前运行退出，
   * 运行中的执行记录标记 canceled，任务稳定退回 ready；仅用户明确启动/重试才可再运行。
   * 幂等：无活跃运行时不写假运行（修复“取消后任务永久已在运行”），重复调用安全。
   */
  async cancel(taskId: string): Promise<void> {
    this.revokeRetry(taskId);
    const entry = this.active.get(taskId);
    if (entry) {
      entry.stopReason = 'canceled';
      if (entry.run) await entry.run.cancel().catch(() => {});
      await entry.settled.catch(() => {});
    }
    // 执行记录兜底标记 canceled（运行内停止路径已标记时跳过）。
    const latest = this.repos.executions.getLatest(taskId);
    if (latest && latest.status === 'running') {
      this.markExecution(latest, 'canceled', '用户取消');
    }
    const task = this.repos.tasks.get(taskId);
    if (task && task.status !== 'archived') {
      // 取消后退回 ready（可重新启动）
      if (canTransition(task, 'ready', { hasAcceptance: true, hasAgentAssigned: this.hasProvider(), hasArtifacts: false }).ok) {
        this.transition(task, 'ready');
      }
    }
    this.emit('task-canceled', { taskId });
  }

  /** 显式重试。 */
  async retry(taskId: string): Promise<void> {
    const task = this.repos.tasks.get(taskId);
    if (!task) throw new Error(`任务不存在：${taskId}`);
    this.repos.tasks.incRetry(taskId);
    task.retryCount += 1;
    if (canTransition(task, 'ready', { hasAcceptance: true, hasAgentAssigned: this.hasProvider(), hasArtifacts: false }).ok) {
      this.transition(task, 'ready');
    }
    await this.start(taskId);
  }

  /** 撤销任务待执行的自动重试（如有）。 */
  private revokeRetry(taskId: string): void {
    const timer = this.retryTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(taskId);
    }
  }

  /**
   * 调度可追踪、可撤销的自动重试。回调前核对：运行代次未变（用户未显式启动/重试）、
   * 无活跃运行、任务仍停在失败后的 in_progress（未被暂停/取消/手动改态），任一不满足则放弃。
   */
  private scheduleRetry(taskId: string, delayMs: number, generation: number): void {
    this.revokeRetry(taskId);
    const timer = setTimeout(() => {
      this.retryTimers.delete(taskId);
      if (this.generations.get(taskId) !== generation) return;
      if (this.active.has(taskId)) return;
      const cur = this.repos.tasks.get(taskId);
      if (!cur || cur.status !== 'in_progress') return;
      this.repos.tasks.incRetry(taskId);
      this.start(taskId).catch((e) => this.emit('task-error', { taskId, error: (e as Error).message }));
    }, delayMs);
    timer.unref?.();
    this.retryTimers.set(taskId, timer);
  }

  private handleFailure(task: Task, err: Error, attempt: number, generation: number): void {
    const decision = decideRetry(this.retryPolicy, attempt, this.autoRetry);
    const latest = this.repos.executions.getLatest(task.id);
    if (latest) {
      this.markExecution(latest, 'failed', err.message);
      // 把失败原因写入日志面板，避免“无日志”
      this.log(latest, 'error', `失败（第 ${attempt} 次）：${err.message}`);
    }
    if (decision.retry && this.autoRetry) {
      if (latest) this.log(latest, 'warn', `将在 ${decision.delayMs}ms 后重试（第 ${attempt + 1} 次）`);
      this.emit('task-retry', { taskId: task.id, delayMs: decision.delayMs, reason: decision.reason });
      this.scheduleRetry(task.id, decision.delayMs, generation);
    } else {
      // 退回 ready 供手动重试
      if (canTransition(task, 'ready', { hasAcceptance: true, hasAgentAssigned: this.hasProvider(), hasArtifacts: false }).ok) {
        this.transition(task, 'ready');
      }
      if (latest) this.log(latest, 'error', `已达最大重试次数，任务退回待开发：${err.message}`);
      this.emit('task-failed', { taskId: task.id, error: err.message });
    }
  }

  private markExecution(exec: ExecutionRecord, status: ExecutionRecord['status'], summary: string): void {
    exec.status = status;
    exec.endedAt = now();
    exec.summary = summary;
    this.repos.executions.update(exec);
  }

  private transition(task: Task, target: TaskStatus, ctx?: Partial<Parameters<typeof canTransition>[2]>): void {
    // 归档门禁 accepted 由调用方（tasks.accept）显式提供；编排器自身不会自动归档。
    const gate = canTransition(task, target, {
      hasAcceptance: true,
      hasAgentAssigned: this.hasProvider(),
      hasArtifacts: true,
      hasUserAnswer: false,
      ...ctx,
    });
    if (!gate.ok) {
      this.emit('task-error', { taskId: task.id, error: `状态迁移被门禁拒绝：${gate.reasons.join('; ')}` });
      throw new Error(`状态迁移被门禁拒绝：${gate.reasons.join('; ')}`);
    }
    this.repos.tasks.updateStatus(task.id, target, now());
    task.status = target;
    task.statusChangedAt = now();
    this.emit('task-status', { taskId: task.id, status: target });
  }

  private buildPrompt(task: Task, stage: { id: string; name: string }): string {
    return `【阶段】${stage.name}\n【任务】${task.title}\n【描述】${task.description || '(无)'}\n请在当前仓库工作区完成该阶段工作。`;
  }

  /** 应用重启后恢复：扫描运行中/待沟通任务。 */
  async recover(): Promise<{ recovered: string[]; failed: string[]; awaiting: string[] }> {
    const tasks = this.repos.tasks.listRecoverable();
    const recovered: string[] = [];
    const failed: string[] = [];
    const awaiting: string[] = [];
    for (const task of tasks) {
      if (task.status === 'awaiting_input') {
        awaiting.push(task.id);
        this.emit('task-awaiting', { taskId: task.id });
        continue;
      }
      // in_progress：子进程已死，标记失败并退回 ready
      const latest = this.repos.executions.getLatest(task.id);
      if (latest && latest.status === 'running') {
        this.markExecution(latest, 'failed', '应用重启，子进程已终止');
      }
      if (canTransition(task, 'ready', { hasAcceptance: true, hasAgentAssigned: this.hasProvider(), hasArtifacts: false }).ok) {
        this.transition(task, 'ready');
      }
      failed.push(task.id);
      this.emit('task-recovered-failed', { taskId: task.id });
    }
    return { recovered, failed, awaiting };
  }

  /** 清理任务的 worktree（成功归档后或手动清理）。 */
  async cleanupWorktree(taskId: string, opts?: { keepBranch?: boolean }): Promise<void> {
    const task = this.repos.tasks.get(taskId);
    if (!task?.worktreePath) return;
    const project = this.repos.projects.get(task.projectId);
    if (project) {
      await removeWorktree({
        repoPath: project.path,
        worktreePath: task.worktreePath,
        branchName: `ai-devflow/${taskId}`,
        keepBranch: opts?.keepBranch,
      }).catch(() => {});
    }
    this.repos.tasks.setWorktree(taskId, undefined);
  }
}
