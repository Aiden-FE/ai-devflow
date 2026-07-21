import { EventEmitter } from 'node:events';
import type {
  AgentEvent,
  AgentType,
  AgentCapabilities,
  Checkpoint,
  ExecutionRecord,
  LogEntry,
  Task,
  TaskStatus,
  Project,
  TaskMessage,
  PendingInteraction,
  InteractionKind,
} from '@ai-devflow/core';
import {
  canTransition,
  checkTaskDependencies,
  defaultAgentForRole,
  now,
  randomId,
  decideRetry,
  DEFAULT_RETRY_POLICY,
  type RetryPolicy,
} from '@ai-devflow/core';
import type { Repositories } from '@ai-devflow/persistence';
import type { AgentRegistry, AgentRun } from '@ai-devflow/agents';
import { createWorktree, removeWorktree, mergeWorktreeBranch, WorktreeError } from './worktree.js';
import { Semaphore } from './semaphore.js';

export interface OrchestratorOptions {
  worktreesBaseDir: string;
  maxConcurrent?: number;
  retryPolicy?: RetryPolicy;
  /** 是否在可恢复失败时自动重试。 */
  autoRetry?: boolean;
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
}

const IMPLICIT_STAGE_ID = '__main__';

export class Orchestrator extends EventEmitter {
  private sem: Semaphore;
  private runs = new Map<string, { run: AgentRun; canceled: boolean }>();
  private retryPolicy: RetryPolicy;
  private autoRetry: boolean;
  /** 最近一次解析的能力配置（授权恢复合并用）。 */
  private capsByTask = new Map<string, AgentCapabilities>();

  constructor(
    private repos: Repositories,
    private registry: AgentRegistry,
    private opts: OrchestratorOptions,
  ) {
    super();
    this.sem = new Semaphore(opts.maxConcurrent ?? 2);
    this.retryPolicy = opts.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.autoRetry = opts.autoRetry ?? true;
  }

  /** 启动任务：分派 Agent、创建 worktree、运行流水线。 */
  async start(taskId: string, init?: StartInit): Promise<void> {
    const task = this.repos.tasks.get(taskId);
    if (!task) throw new Error(`任务不存在：${taskId}`);
    if (this.runs.has(taskId)) throw new Error(`任务已在运行：${taskId}`);

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

    // 默认适配器：解析并分配首个可用 Agent（角色覆盖 > claude_code > codex > pi）。
    // 这样“默认（按角色）”的任务也能直接启动，无需手动指定。
    if (!task.agentType) {
      const agentType = await this.resolveDefaultAgent(task, project);
      this.repos.tasks.assignAgent(task.id, agentType);
      task.agentType = agentType;
    }

    // 状态门禁：进入 in_progress
    if (task.status !== 'in_progress') {
      const gate = canTransition(task, 'in_progress', {
        hasAcceptance: true,
        hasAgentAssigned: !!task.agentType,
        hasUserAnswer: !!init?.userInput || !!init?.interactionResponse,
        hasArtifacts: false,
      });
      if (!gate.ok && task.status !== 'awaiting_input') {
        throw new Error(`无法启动任务：${gate.reasons.join('; ')}`);
      }
      this.transition(task, 'in_progress', { hasUserAnswer: !!init?.userInput || !!init?.interactionResponse });
    }

    const release = await this.sem.acquire();
    try {
      await this.runPipeline(task, project, init);
    } catch (err) {
      this.emit('task-error', { taskId, error: (err as Error).message });
      // 用任务重试计数决定是否重试，避免依赖执行记录（worktree 失败时可能无记录）导致 attempt 不递增、无限重试。
      const attempt = task.retryCount + 1;
      this.handleFailure(task, err as Error, attempt);
    } finally {
      release();
      this.runs.delete(taskId);
    }
  }

  /** 运行流水线各阶段。 */
  private async runPipeline(task: Task, project: Project, init?: StartInit): Promise<void> {
    const stages = task.stages.length > 0 ? task.stages : [{ id: IMPLICIT_STAGE_ID, name: '执行', role: task.role }];
    const startStage = init?.resumeFrom?.stageIndex ?? task.currentStage ?? 0;
    const agentType = this.resolveAgentType(task, project);
    if (!task.agentType) {
      this.repos.tasks.assignAgent(task.id, agentType);
      task.agentType = agentType;
    }

    // 解析能力配置：角色 RoleAgentConfig + 任务显式 agentType 覆盖。
    let capabilities = this.resolveCapabilities(task, project, agentType);
    // 授权恢复：把已批准/已拒绝工具并入能力配置（放行 -> allowedTools，拒绝 -> disallowedTools）。
    if (init?.approvalTool) {
      const { name, allow } = init.approvalTool;
      if (allow) {
        capabilities = { ...capabilities, tools: Array.from(new Set([...(capabilities.tools ?? []), name])) };
      } else {
        capabilities = { ...capabilities, disallowedTools: Array.from(new Set([...(capabilities.disallowedTools ?? []), name])) };
      }
    }
    this.capsByTask.set(task.id, capabilities);

    // 先创建执行记录：这样 worktree 创建失败等也能落日志并计入尝试次数，
    // 避免 getLatest() 永远 undefined 导致 attempt 不递增、无限重试。
    const execution: ExecutionRecord = {
      id: randomId(),
      taskId: task.id,
      attempt: (this.repos.executions.getLatest(task.id)?.attempt ?? 0) + 1,
      agentType,
      startedAt: now(),
      status: 'running',
    };
    this.repos.executions.insert(execution);
    this.log(execution, 'info', `启动 Agent ${agentType}（第 ${execution.attempt} 次尝试）`);

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
      if (this.isCanceled(task.id)) {
        this.markExecution(execution, 'canceled', '用户取消');
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
      const run = await this.registry.require(agentType).run({
        taskId: task.id,
        prompt,
        cwd: worktreePath!,
        resumeFrom: i === startStage ? init?.resumeFrom : undefined,
        userInput: i === startStage ? init?.userInput : undefined,
        interactionResponse: i === startStage ? init?.interactionResponse : undefined,
        capabilities,
      });
      this.runs.set(task.id, { run, canceled: false });

      let stageDone = false;
      let askedUser = false;
      try {
        for await (const ev of run.events) {
          if (this.isCanceled(task.id)) {
            await run.cancel();
            break;
          }
          await this.handleEvent(task, execution, ev);
          if (ev.type === 'ask_user' || ev.type === 'approval_request') {
            askedUser = true;
            // 暂停：记录检查点与待处理交互，转 awaiting_input，停止当前运行。
            // 拒绝授权不判定成功：暂停后由用户决策，恢复时按决策放行/拒绝，绝不自动归档。
            this.recordCheckpoint(task, stage, i, ev);
            this.transition(task, 'awaiting_input');
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
        this.runs.delete(task.id);
      }

      if (askedUser) return; // 等待用户回答/授权后 resume

      if (!stageDone) {
        // 阶段未正常完成（被取消或异常）
        if (this.isCanceled(task.id)) {
          this.markExecution(execution, 'canceled', '用户取消');
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

    // 全部阶段完成 -> 合并特性分支到项目默认分支，使产出落入主项目 -> in_review（待验收）
    const branchName = `ai-devflow/${task.id}`;
    const mergeRes = await mergeWorktreeBranch({
      repoPath: project.path,
      branchName,
      defaultBranch: project.defaultBranch,
    });
    if (mergeRes.merged) {
      this.log(execution, 'info', `已合并到 ${project.defaultBranch}，产出已落入主项目`);
    } else {
      this.log(execution, 'warn', `未自动合并：${mergeRes.reason}（工作保留在分支 ${branchName}）`);
    }
    // Agent 完成后进入待验收；归档必须经人工验收（tasks.accept），禁止自动归档。
    this.transition(task, 'in_review');
  }

  private async handleEvent(task: Task, execution: ExecutionRecord, ev: AgentEvent): Promise<void> {
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
    this.transition(task, 'in_progress', { hasUserAnswer: true });
    await this.start(taskId, { resumeFrom: cp ?? undefined, userInput });
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
      this.transition(task, 'in_progress', { hasUserAnswer: true });
      await this.start(taskId, { resumeFrom: cp ?? undefined, userInput: response });
      return;
    }
    if (inter.kind === 'approval') {
      const allow = response === 'allow';
      this.repos.pendingInteractions.resolve(interactionId, allow ? 'approved' : 'denied', response, now());
      this.recordMessage(task, undefined, {
        role: 'user', kind: 'text',
        text: `${allow ? '已批准' : '已拒绝'}：${inter.toolName ?? inter.title}`,
      });
      this.transition(task, 'in_progress', { hasUserAnswer: true });
      await this.start(taskId, {
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
    this.transition(task, 'in_progress', { hasUserAnswer: true });
    await this.start(taskId, {
      resumeFrom: cp ?? undefined,
      interactionResponse: { kind: 'confirmation', value: response },
    });
  }

  /** 取消任务。 */
  async cancel(taskId: string): Promise<void> {
    const entry = this.runs.get(taskId);
    if (entry) {
      entry.canceled = true;
      await entry.run.cancel();
    } else {
      // 标记以便运行中循环检测
      this.runs.set(taskId, { run: { events: (async function* () {})(), cancel: async () => {}, done: async () => ({ exitCode: null, ok: false }) }, canceled: true });
    }
    const task = this.repos.tasks.get(taskId);
    if (task && task.status !== 'archived') {
      // 取消后退回 ready（可重新启动）
      if (canTransition(task, 'ready', { hasAcceptance: true, hasAgentAssigned: !!task.agentType, hasArtifacts: false }).ok) {
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
    if (canTransition(task, 'ready', { hasAcceptance: true, hasAgentAssigned: !!task.agentType, hasArtifacts: false }).ok) {
      this.transition(task, 'ready');
    }
    await this.start(taskId);
  }

  private isCanceled(taskId: string): boolean {
    return this.runs.get(taskId)?.canceled ?? false;
  }

  private handleFailure(task: Task, err: Error, attempt: number): void {
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
      setTimeout(() => {
        this.repos.tasks.incRetry(task.id);
        this.start(task.id).catch((e) => this.emit('task-error', { taskId: task.id, error: (e as Error).message }));
      }, decision.delayMs).unref?.();
    } else {
      // 退回 ready 供手动重试
      if (canTransition(task, 'ready', { hasAcceptance: true, hasAgentAssigned: !!task.agentType, hasArtifacts: false }).ok) {
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
      hasAgentAssigned: !!task.agentType,
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

  private resolveAgentType(task: Task, project: Project): AgentType {
    if (task.agentType) return task.agentType;
    const roleConfig = project.settings.roleConfigs?.[task.role];
    if (roleConfig?.agentType) return roleConfig.agentType;
    const roleOverride = project.settings.agentRoles?.[task.role];
    if (roleOverride) return roleOverride;
    return defaultAgentForRole(task.role);
  }

  /**
   * 解析能力配置：角色 RoleAgentConfig（优先）+ 任务显式 agentType 覆盖。
   * 任务显式 agentType 优先于角色默认；工具/插件/Skills/授权来自角色配置。
   */
  private resolveCapabilities(task: Task, project: Project, agentType: AgentType): AgentCapabilities {
    const roleConfig = project.settings.roleConfigs?.[task.role];
    return {
      agentType,
      plugins: roleConfig?.plugins,
      skills: roleConfig?.skills,
      tools: roleConfig?.tools,
      disallowedTools: roleConfig?.disallowedTools,
      requireApproval: roleConfig?.requireApproval ?? false,
    };
  }

  /**
   * 解析默认 Agent：按“角色覆盖 > claude_code > codex > pi”顺序检测首个可用适配器。
   * 不含 'test'（测试适配器需显式指定）。无可用适配器时抛出清晰错误。
   */
  private async resolveDefaultAgent(task: Task, project: Project): Promise<AgentType> {
    const roleConfig = project.settings.roleConfigs?.[task.role];
    const roleOverride = roleConfig?.agentType ?? project.settings.agentRoles?.[task.role];
    const candidates: AgentType[] = [];
    if (roleOverride) candidates.push(roleOverride);
    for (const t of ['claude_code', 'codex', 'pi'] as AgentType[]) {
      if (!candidates.includes(t)) candidates.push(t);
    }
    for (const t of candidates) {
      const adapter = this.registry.get(t);
      if (!adapter) continue;
      try {
        const det = await adapter.detect();
        if (det.available) return t;
      } catch {
        // 检测失败则尝试下一个
      }
    }
    throw new Error(
      '没有可用的 Agent 桥接器：未检测到 claude/codex/pi。请安装其中之一并重启，或在创建任务时显式指定“测试适配器”。',
    );
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
      if (canTransition(task, 'ready', { hasAcceptance: true, hasAgentAssigned: !!task.agentType, hasArtifacts: false }).ok) {
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
