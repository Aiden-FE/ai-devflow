import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDatabase, createRepositories, type Repositories, type DatabaseSync } from '@ai-devflow/persistence';
import type { AgentRunner, AgentRun, RunnerAgentRunRequest as AgentRunRequest } from '@ai-devflow/agents';
import { Orchestrator } from '../orchestrator.js';
import type { Task, AgentEvent } from '@ai-devflow/core';
import { randomId, now } from '@ai-devflow/core';
import { FakeAgentRunner, isReviewExecution, type TestEventSpec } from './fake-agent-runner.js';
import { runFromEvents } from './fake-agent-runner.js';
import { ensureSprintBranch } from '../worktree.js';

let db: DatabaseSync;
let repos: Repositories;
let orch: Orchestrator;
let runner: FakeAgentRunner;
let worktreeDir: string;
let events: Array<{ taskId: string; event: AgentEvent }>;

/** 在 dir 初始化一个真实的 git 仓库（main 分支 + 初始提交），供 mergeWorktreeBranch 成功。 */
function initGitRepo(dir: string): void {
  shGit(dir, ['init', '-q', '-b', 'main']);
  shGit(dir, ['config', 'user.email', 't@t']);
  shGit(dir, ['config', 'user.name', 't']);
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  shGit(dir, ['add', '.']);
  shGit(dir, ['commit', '-q', '-m', 'init']);
}

function setup(script: (req: AgentRunRequest) => TestEventSpec[], opts: ConstructorParameters<typeof FakeAgentRunner>[1] = {}) {
  db = openDatabase(':memory:');
  repos = createRepositories(db);
  worktreeDir = mkdtempSync(join(tmpdir(), 'aidf-orch-'));
  initGitRepo(worktreeDir);
  runner = new FakeAgentRunner(script, opts);
  orch = new Orchestrator(repos, runner, { worktreesBaseDir: worktreeDir, maxConcurrent: 2, autoRetry: false });
  events = [];
  orch.on('task-event', (e) => events.push(e));
  repos.projects.insert({ id: 'p', name: 'P', path: worktreeDir, defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
  repos.iterations.insert({ id: 'i', projectId: 'p', name: 'I', version: 'v1', status: 'active', createdAt: 1 });
  repos.requirements.insert({ id: 'r', iterationId: 'i', title: 'R', description: '', priority: 'medium', acceptance: 'acc', createdAt: 1, archived: false });
}

function makeOrch(repos2: Repositories, run: AgentRunner, over: Partial<ConstructorParameters<typeof Orchestrator>[2]> = {}) {
  return new Orchestrator(repos2, run, { worktreesBaseDir: worktreeDir, maxConcurrent: 2, autoRetry: false, ...over });
}

function seedBasic(r: Repositories, settings: import('@ai-devflow/core').ProjectSettings = {}) {
  const path = typeof worktreeDir === 'string' ? worktreeDir : '/tmp/unused';
  r.projects.insert({ id: 'p', name: 'P', path, defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings });
  r.iterations.insert({ id: 'i', projectId: 'p', name: 'I', version: 'v1', status: 'active', createdAt: 1 });
  r.requirements.insert({ id: 'r', iterationId: 'i', title: 'R', description: '', priority: 'medium', acceptance: 'acc', createdAt: 1, archived: false });
}

afterEach(() => {
  try { db.close(); } catch { /* */ }
  if (worktreeDir) rmSync(worktreeDir, { recursive: true, force: true });
});

function makeTask(over: Partial<Task> = {}): Task {
  const t: Task = {
    id: randomId(),
    requirementId: 'r',
    iterationId: 'i',
    projectId: 'p',
    title: 'T',
    description: 'do it',
    status: 'ready',
    role: 'coder',
    stages: [{ id: 's1', name: '实现', role: 'coder' }],
    currentStage: 0,
    statusChangedAt: now(),
    createdAt: now(),
    updatedAt: now(),
    retryCount: 0,
    worktreePath: join(worktreeDir, 'fake-wt'),
    ...over,
  } as Task;
  // 为 fake-wt 创建真实 worktree + 任务分支（使 mergeWorktreeBranch 成功）。
  try {
    shGit(worktreeDir, ['worktree', 'add', '-b', `ai-devflow/${t.id}`, t.worktreePath!, 'main']);
  } catch {
    // 已存在或非 git 仓库时忽略。
  }
  return t;
}

describe('orchestrator pipeline', () => {
  beforeEach(() => setup(() => [
    { type: 'log', level: 'info', text: 'starting', t: 0 },
    { type: 'file_change', path: '/a/b.ts', action: 'create', t: 0 },
    { type: 'done', summary: 'finished', t: 0 },
  ]));

  it('runs a task to in_review and persists logs/checkpoints', async () => {
    const t = makeTask();
    repos.tasks.insert(t);
    await orch.start(t.id);
    const final = repos.tasks.get(t.id)!;
    expect(final.status).toBe('in_review');
    expect(repos.logs.listByTask(t.id).length).toBeGreaterThan(0);
    expect(repos.executions.getLatest(t.id)!.status).toBe('succeeded');
    expect(repos.checkpoints.listByTask(t.id).length).toBeGreaterThan(0);
  });

  it('emits task-event for each agent event', async () => {
    const t = makeTask();
    repos.tasks.insert(t);
    await orch.start(t.id);
    expect(events.some((e) => e.event.type === 'done')).toBe(true);
    expect(events.some((e) => e.event.type === 'file_change')).toBe(true);
  });

  it('passes the dev+test experts + executionId to the runner for dev and review', async () => {
    const t = makeTask({
      role: 'coder',
      stages: [{ id: 'plan', name: '规划', role: 'planner' }],
    });
    repos.tasks.insert(t);
    await orch.start(t.id);
    // 专家化重构：按泳道派发，in_progress->dev，testing->test（忽略 stages.role）
    expect(runner.requests.map((r) => r.expert)).toEqual(['dev', 'test']);
    expect(runner.requests.every((r) => !!r.executionId)).toBe(true);
  });
});

describe('orchestrator task-message text assembly', () => {
  beforeEach(() => setup(() => [
    { type: 'log', level: 'info', text: 'files that ', t: 0 },
    { type: 'log', level: 'info', text: 'need to ', t: 0 },
    { type: 'log', level: 'info', text: 'be changed', t: 0 },
    { type: 'status', stage: 'tool', detail: 'tool finished', t: 0 },
    { type: 'log', level: 'info', text: 'final answer', t: 0 },
    { type: 'done', summary: 'finished', t: 0 },
  ]));

  it('reuses one message id for a contiguous assistant text segment', async () => {
    const streamed: import('@ai-devflow/core').TaskMessage[] = [];
    orch.on('task-message', (event) => streamed.push(event.message));
    const task = makeTask();
    repos.tasks.insert(task);

    await orch.start(task.id);

    const development = repos.executions.listByTask(task.id).find((execution) => !isReviewExecution(execution.summary))!;
    const messages = repos.taskMessages.listByTask(task.id)
      .filter((message) => message.executionId === development.id && message.role === 'assistant' && message.kind === 'text');
    expect(messages.map((message) => message.text)).toEqual([
      'files that need to be changed',
      'final answer',
    ]);
    const firstSegmentEvents = streamed.filter((message) =>
      message.executionId === development.id &&
      message.role === 'assistant' &&
      message.kind === 'text' &&
      message.text !== 'final answer');
    expect(firstSegmentEvents.map((message) => message.text)).toEqual([
      'files that ',
      'files that need to ',
      'files that need to be changed',
    ]);
    expect(new Set(firstSegmentEvents.map((message) => message.id))).toEqual(new Set([firstSegmentEvents[0]!.id]));
  });
});

describe('orchestrator ask_user + resume', () => {
  beforeEach(() => setup((req) => {
    if (!req.userInput) {
      return [
        { type: 'log', level: 'info', text: 'need input', t: 0 },
        { type: 'ask_user', question: 'which lib?', context: 'choosing test lib', t: 0 },
      ];
    }
    return [
      { type: 'log', level: 'info', text: `using ${req.userInput}`, t: 0 },
      { type: 'done', summary: 'resumed ok', t: 0 },
    ];
  }));

  it('pauses on ask_user then resumes from checkpoint with user answer', async () => {
    const t = makeTask();
    repos.tasks.insert(t);
    await orch.start(t.id);
    expect(repos.tasks.get(t.id)!.status).toBe('awaiting_input');
    const q = repos.pendingQuestions.get(t.id);
    expect(q?.question).toBe('which lib?');
    expect(repos.checkpoints.getLatest(t.id)).toBeTruthy();

    await orch.resume(t.id, 'vitest');
    expect(repos.tasks.get(t.id)!.status).toBe('in_review');
    expect(repos.pendingQuestions.get(t.id)!.answer).toBe('vitest');
    const logs = repos.logs.listByTask(t.id).map((l) => l.text);
    expect(logs.some((l) => l.includes('vitest'))).toBe(true);
  });
});

describe('orchestrator cancel', () => {
  beforeEach(() => setup(() => [
    { type: 'log', level: 'info', text: 'a', t: 0, delayMs: 5 },
    { type: 'done', summary: 'ok', t: 0, delayMs: 2000 },
  ]));

  it('cancels a running task back to ready', async () => {
    const t = makeTask();
    repos.tasks.insert(t);
    const p = orch.start(t.id);
    await new Promise((r) => setTimeout(r, 20));
    await orch.cancel(t.id);
    await p.catch(() => {});
    const final = repos.tasks.get(t.id)!;
    expect(['ready', 'in_review']).toContain(final.status);
  });
});

describe('orchestrator shutdown (app quit, §15)', () => {
  beforeEach(() => setup(() => [
    { type: 'log', level: 'info', text: 'a', t: 0, delayMs: 5 },
    { type: 'done', summary: 'ok', t: 0, delayMs: 2000 },
  ]));

  it('shutdown cancels active runs (terminates Pi process group) and seals executions', async () => {
    const t = makeTask();
    repos.tasks.insert(t);
    const p = orch.start(t.id);
    await new Promise((r) => setTimeout(r, 20));
    // shutdown 等价于对每个活跃任务调用 cancel()：终止 Pi 进程组并封存 journal。
    await orch.shutdown();
    await p.catch(() => {});
    const final = repos.tasks.get(t.id)!;
    expect(final.status).toBe('ready');
    expect(repos.executions.getLatest(t.id)!.status).toBe('canceled');
  });

  it('shutdown is a safe no-op when no tasks are active', async () => {
    await expect(orch.shutdown()).resolves.toBeUndefined();
  });
});

describe('orchestrator failure + retry', () => {
  beforeEach(() => setup(() => [
    { type: 'error', message: 'boom', recoverable: true, t: 0 },
  ]));

  it('marks execution failed and returns task to ready', async () => {
    const t = makeTask();
    repos.tasks.insert(t);
    await orch.start(t.id).catch(() => {});
    const final = repos.tasks.get(t.id)!;
    expect(final.status).toBe('ready');
    expect(repos.executions.getLatest(t.id)!.status).toBe('failed');
  });
});

describe('orchestrator recovery (restart)', () => {
  beforeEach(() => setup(() => [{ type: 'done', summary: 'ok', t: 0 }]));

  it('fails dead running tasks, preserves the testing retry source, and keeps awaiting_input', async () => {
    const tRunning = makeTask({ id: randomId(), status: 'in_progress' });
    repos.tasks.insert(tRunning);
    repos.executions.insert({ id: randomId(), taskId: tRunning.id, attempt: 1, startedAt: now(), status: 'running' });
    const tTesting = makeTask({ id: randomId(), status: 'testing', pausedFrom: undefined });
    repos.tasks.insert(tTesting);
    const tWaiting = makeTask({ id: randomId(), status: 'awaiting_input' });
    repos.tasks.insert(tWaiting);
    repos.pendingQuestions.upsert({ taskId: tWaiting.id, question: 'q?', context: '', askedAt: now() });

    const res = await orch.recover();
    expect(res.failed).toContain(tRunning.id);
    expect(res.failed).toContain(tTesting.id);
    expect(res.awaiting).toContain(tWaiting.id);
    expect(repos.tasks.get(tRunning.id)!.status).toBe('ready');
    expect(repos.tasks.get(tTesting.id)).toMatchObject({ status: 'ready', pausedFrom: 'testing' });
    expect(repos.tasks.get(tWaiting.id)!.status).toBe('awaiting_input');
    expect(repos.executions.getLatest(tRunning.id)!.status).toBe('failed');
  });
});

describe('orchestrator concurrency does not overwrite', () => {
  beforeEach(() => setup(() => [
    { type: 'log', level: 'info', text: 'a', t: 0, delayMs: 30 },
    { type: 'done', summary: 'ok', t: 0 },
  ]));

  it('two concurrent tasks keep separate logs/executions', async () => {
    const t1 = makeTask({ id: randomId() });
    const t2 = makeTask({ id: randomId() });
    repos.tasks.insert(t1);
    repos.tasks.insert(t2);
    await Promise.all([orch.start(t1.id), orch.start(t2.id)]);
    const l1 = repos.logs.listByTask(t1.id).map((l) => l.taskId);
    const l2 = repos.logs.listByTask(t2.id).map((l) => l.taskId);
    expect(l1.every((x) => x === t1.id)).toBe(true);
    expect(l2.every((x) => x === t2.id)).toBe(true);
    expect(repos.executions.getLatest(t1.id)!.taskId).toBe(t1.id);
    expect(repos.executions.getLatest(t2.id)!.taskId).toBe(t2.id);
  });
});

describe('orchestrator serial dependencies', () => {
  beforeEach(() => setup(() => [{ type: 'done', summary: 'ok', t: 0 }]));

  it('blocks start while a predecessor is incomplete, allows once it reaches in_review', async () => {
    const pred = makeTask({ id: randomId(), status: 'ready' });
    const succ = makeTask({ id: randomId(), dependsOn: [pred.id] });
    repos.tasks.insert(pred);
    repos.tasks.insert(succ);
    await expect(orch.start(succ.id)).rejects.toThrow(/前置任务未完成/);
    expect(repos.tasks.get(succ.id)!.status).toBe('ready');
    pred.status = 'in_review';
    pred.statusChangedAt = now();
    repos.tasks.update(pred);
    await orch.start(succ.id);
    expect(repos.tasks.get(succ.id)!.status).toBe('in_review');
  });

  it('resume (from awaiting_input) skips the dependency check', async () => {
    const pred = makeTask({ id: randomId(), status: 'in_progress' });
    const succ = makeTask({ id: randomId(), status: 'awaiting_input', dependsOn: [pred.id] });
    repos.tasks.insert(pred);
    repos.tasks.insert(succ);
    repos.pendingQuestions.upsert({ taskId: succ.id, question: 'q?', context: '', askedAt: now() });
    await orch.resume(succ.id, 'answer');
    expect(repos.tasks.get(succ.id)!.status).toBe('in_review');
  });
});

describe('orchestrator approval flow', () => {
  beforeEach(() => setup(() => [{ type: 'done', summary: 'ok', t: 0 }]));

  it('pauses on approval_request, resumes to in_review on allow (deny is not success)', async () => {
    const fr = new FakeAgentRunner((req) => {
      if (req.interactionResponse?.kind === 'approval') {
        return req.interactionResponse.value === 'allow'
          ? [{ type: 'log', level: 'info', text: 'approved run', t: 0 }, { type: 'done', summary: 'ok', t: 0 }]
          : [{ type: 'error', message: 'tool denied', recoverable: false, t: 0 }];
      }
      return [
        { type: 'log', level: 'info', text: 'want to run bash', t: 0 },
        { type: 'approval_request', toolName: 'Bash', toolUseId: 'tu1', description: 'rm -rf', t: 0 },
      ];
    });
    const db2 = openDatabase(':memory:');
    const r2 = createRepositories(db2);
    seedBasic(r2);
    const orch2 = makeOrch(r2, fr);
    const t = makeTask();
    r2.tasks.insert(t);

    await orch2.start(t.id);
    expect(r2.tasks.get(t.id)!.status).toBe('awaiting_input');
    const inter = r2.pendingInteractions.getPendingForTask(t.id);
    expect(inter?.kind).toBe('approval');
    expect(inter?.toolName).toBe('Bash');
    const msgs = r2.taskMessages.listByTask(t.id);
    expect(msgs.some((m) => m.kind === 'approval_request')).toBe(true);

    await orch2.resolveInteraction(t.id, inter!.id, 'allow');
    expect(r2.tasks.get(t.id)!.status).toBe('in_review');
    expect(r2.pendingInteractions.get(inter!.id)!.status).toBe('approved');
    db2.close();
  });

  it('denial does not mark success (task returns to ready on error)', async () => {
    const fr = new FakeAgentRunner((req) => {
      if (req.interactionResponse?.kind === 'approval' && req.interactionResponse.value === 'deny') {
        return [{ type: 'error', message: 'denied', recoverable: false, t: 0 }];
      }
      return [{ type: 'approval_request', toolName: 'Bash', toolUseId: 'tu1', description: 'x', t: 0 }];
    });
    const db2 = openDatabase(':memory:');
    const r2 = createRepositories(db2);
    seedBasic(r2);
    const orch2 = makeOrch(r2, fr);
    const t = makeTask();
    r2.tasks.insert(t);
    await orch2.start(t.id);
    const inter = r2.pendingInteractions.getPendingForTask(t.id)!;
    await orch2.resolveInteraction(t.id, inter.id, 'deny').catch(() => {});
    const final = r2.tasks.get(t.id)!.status;
    expect(['ready', 'in_progress', 'awaiting_input']).toContain(final);
    expect(r2.pendingInteractions.get(inter.id)!.status).toBe('denied');
    db2.close();
  });
});

describe('orchestrator bounded retry (no infinite loop)', () => {
  beforeEach(() => setup(() => [{ type: 'done', summary: 'ok', t: 0 }]));

  it('stops after maxAttempts in awaiting_input with a sanitized provider interaction', async () => {
    const fr = new FakeAgentRunner(() => [{ type: 'error', message: 'boom', recoverable: true, t: 0 }]);
    const orch2 = makeOrch(repos, fr, { autoRetry: true, retryPolicy: { maxAttempts: 2, baseDelayMs: 5, maxDelayMs: 20, backoff: true } });
    const t = makeTask();
    repos.tasks.insert(t);
    await orch2.start(t.id);
    for (let i = 0; i < 60; i++) {
      const tk = repos.tasks.get(t.id);
      if (tk!.status === 'awaiting_input' && repos.executions.listByTask(t.id).length >= 2) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const final = repos.tasks.get(t.id)!;
    expect(final.status).toBe('awaiting_input');
    const failed = repos.executions.listByTask(t.id).filter((e) => e.status === 'failed');
    expect(failed.length).toBe(2);
    const interaction = repos.pendingInteractions.getPendingForTask(t.id);
    expect(interaction).toMatchObject({ kind: 'clarification', status: 'pending' });
    expect(`${interaction?.title} ${interaction?.detail}`).toContain('多次失败');
    expect(`${interaction?.title} ${interaction?.detail}`).toContain('boom');
  }, 8000);

  it('transient_provider failure reverts task to ready (retry entry) instead of awaiting_input', async () => {
    // AI 服务暂不可用：路由器耗尽后抛 transient_provider。用户无需对话回答，应退回待开发以“启动”按钮重试。
    const fr = new FakeAgentRunner(() => [{ type: 'error', message: '所有已配置 AI 服务暂时不可用，请稍后重试', recoverable: true, failureKind: 'transient_provider', t: 0 }]);
    const orch2 = makeOrch(repos, fr, { autoRetry: true, retryPolicy: { maxAttempts: 2, baseDelayMs: 5, maxDelayMs: 20, backoff: true } });
    const t = makeTask();
    repos.tasks.insert(t);
    const failedEvents: string[] = [];
    orch2.on('task-failed', (e) => failedEvents.push(e.error));
    await orch2.start(t.id);
    for (let i = 0; i < 60; i++) {
      const tk = repos.tasks.get(t.id);
      if (tk!.status === 'ready' && repos.executions.listByTask(t.id).length >= 2) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const final = repos.tasks.get(t.id)!;
    // 退回待开发（可重新启动 = 重试入口），而非被卡在待沟通
    expect(final.status).toBe('ready');
    // 不创建待处理交互（用户无法通过对话修复 provider 故障）
    expect(repos.pendingInteractions.getPendingForTask(t.id)).toBeUndefined();
    // 两条失败执行记录（maxAttempts=2）
    expect(repos.executions.listByTask(t.id).filter((e) => e.status === 'failed').length).toBe(2);
    // 发出 task-failed 事件
    expect(failedEvents.length).toBeGreaterThan(0);
    // 对话窗口写入一条可见的错误说明（含退回待开发提示）
    const msgs = repos.taskMessages.listByTask(t.id).map((m) => `${m.kind}:${m.text ?? ''}`);
    expect(msgs.some((s) => s.includes('待开发') && s.includes('AI 服务暂时不可用'))).toBe(true);
  }, 8000);

  it('worktree creation failure is bounded and logs the reason (no infinite loop)', async () => {
    setup(() => [{ type: 'done', summary: 'ok', t: 0 }]);
    const fr = new FakeAgentRunner(() => [{ type: 'done', summary: 'ok', t: 0 }]);
    const orch2 = makeOrch(repos, fr, { autoRetry: true, retryPolicy: { maxAttempts: 2, baseDelayMs: 5, maxDelayMs: 20, backoff: true } });
    const t = makeTask();
    t.worktreePath = undefined; // 强制走 createWorktree（/tmp/unused 非 git 仓库 -> 失败）
    repos.tasks.insert(t);
    await orch2.start(t.id);
    for (let i = 0; i < 60; i++) {
      const tk = repos.tasks.get(t.id);
      if (tk!.status === 'awaiting_input' && repos.executions.listByTask(t.id).length >= 2) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const final = repos.tasks.get(t.id)!;
    expect(final.status).toBe('awaiting_input');
    expect(repos.executions.listByTask(t.id).filter((e) => e.status === 'failed').length).toBe(2);
    const logs = repos.logs.listByTask(t.id).map((l) => l.text);
    expect(logs.some((l) => l.includes('worktree'))).toBe(true);
  }, 8000);
});

describe('orchestrator review (testing lane)', () => {
  it('dev task passes through testing to in_review on a passing review, persisting review evidence', async () => {
    setup(() => [{ type: 'log', level: 'info', text: 'dev done', t: 0 }, { type: 'done', summary: 'dev ok', t: 0 }]);
    const t = makeTask();
    repos.tasks.insert(t);
    await orch.start(t.id);
    const final = repos.tasks.get(t.id)!;
    expect(final.status).toBe('in_review');
    const msgs = repos.taskMessages.listByTask(t.id).map((m) => m.text ?? '');
    expect(msgs.some((m) => m.includes('审查结论') && m.includes('通过'))).toBe(true);
    const execs = repos.executions.listByTask(t.id);
    expect(execs.some((e) => (e.summary ?? '').includes('review:pass'))).toBe(true);
  });

  it('pauses for user action when a passed review cannot commit sensitive task changes', async () => {
    setup(() => [{ type: 'done', summary: 'dev ok', t: 0 }]);
    const t = makeTask();
    writeFileSync(join(t.worktreePath!, '.env.local'), 'SECRET=not-a-real-secret\n');
    repos.tasks.insert(t);

    await orch.start(t.id);

    const final = repos.tasks.get(t.id)!;
    expect(final.status).toBe('awaiting_input');
    expect(final.pausedFrom).toBe('testing');
    const pending = repos.pendingInteractions.getPendingForTask(t.id);
    expect(pending).toMatchObject({ kind: 'clarification', status: 'pending' });
    expect(pending?.detail).toMatch(/敏感路径|\.env/);
  });

  it('pauses for user action when a passed review cannot sync the sprint branch', async () => {
    setup(() => [{ type: 'done', summary: 'dev ok', t: 0 }]);
    const t = makeTask({ status: 'awaiting_input', pausedFrom: 'testing' });
    await ensureSprintBranch({ repoPath: worktreeDir, version: 'v1', baseBranch: 'main' });

    writeFileSync(join(t.worktreePath!, 'conflict.txt'), 'task branch\n');
    shGit(t.worktreePath!, ['add', 'conflict.txt']);
    shGit(t.worktreePath!, ['commit', '-q', '-m', 'task conflict']);

    const sprintBase = mkdtempSync(join(tmpdir(), 'aidf-sprint-conflict-'));
    const sprintWorktree = join(sprintBase, 'worktree');
    shGit(worktreeDir, ['worktree', 'add', sprintWorktree, 'ai-devflow-sprint/v1']);
    writeFileSync(join(sprintWorktree, 'conflict.txt'), 'sprint branch\n');
    shGit(sprintWorktree, ['add', 'conflict.txt']);
    shGit(sprintWorktree, ['commit', '-q', '-m', 'sprint conflict']);
    shGit(worktreeDir, ['worktree', 'remove', '--force', sprintWorktree]);
    rmSync(sprintBase, { recursive: true, force: true });

    repos.tasks.insert(t);
    await orch.resume(t.id, 'retry finalization');

    const final = repos.tasks.get(t.id)!;
    expect(final.status).toBe('awaiting_input');
    expect(final.pausedFrom).toBe('testing');
    const pending = repos.pendingInteractions.getPendingForTask(t.id);
    expect(pending).toMatchObject({ kind: 'clarification', status: 'pending' });
    expect(pending?.detail).toMatch(/冲突|merge|同步/i);
  });

  it('review prompt instructs REVIEW_VERDICT must go into ai_devflow_report_result summary (regression for missing-verdict)', async () => {
    setup(() => [{ type: 'done', summary: 'dev ok', t: 0 }]);
    const t = makeTask();
    repos.tasks.insert(t);
    await orch.start(t.id);
    const reviewReq = runner.requests.find((r) => r.expert === 'test');
    expect(reviewReq).toBeDefined();
    const prompt = reviewReq!.prompt;
    // 必须明确指示结论标记写入 report_result 的 summary 参数，而非仅作为文本输出。
    expect(prompt).toContain('ai_devflow_report_result');
    expect(prompt).toContain('summary');
    expect(prompt).toMatch(/REVIEW_VERDICT:\s*PASS/);
    expect(prompt).toMatch(/REVIEW_VERDICT:\s*FAIL/);
    // 旧提示仅说"最后输出一行结论"会被 agent 当文本输出，导致校验失败；新提示必须区分 summary 参数与聊天文本。
    expect(prompt.toLowerCase()).toContain('summary 参数');
  });

  it('review failure returns to in_progress with feedback, bounded by maxReviewRounds (no infinite loop)', async () => {
    const fr = new FakeAgentRunner(() => [{ type: 'done', summary: 'dev ok', t: 0 }], { testExpertVerdict: 'FAIL' });
    const db2 = openDatabase(':memory:');
    const r2 = createRepositories(db2);
    seedBasic(r2);
    const orch2 = makeOrch(r2, fr, { maxReviewRounds: 2 });
    const t = makeTask();
    r2.tasks.insert(t);
    await orch2.start(t.id);
    const final = r2.tasks.get(t.id)!;
    expect(final.status).toBe('in_progress');
    expect(final.retryCount).toBe(2);
    const msgs = r2.taskMessages.listByTask(t.id).map((m) => m.text ?? '');
    expect(msgs.some((m) => m.includes('审查不通过'))).toBe(true);
    db2.close();
  });

  it('review missing task_review payload is a deterministic contract failure: parks ready, no dev rework, no fabricated verdict, no awaiting_input', async () => {
    // 回归：载荷缺失曾被伪造成「审查不通过」触发无效返工循环，随后耗尽重试预算把任务卡在
    // “AI 服务多次失败，请检查提供商配置后重试”的待沟通里——但它是 task_result 契约失败，
    // 与提供商连通性无关，用户点“重试”只是恢复同一条确定性失败路径（“无法重试”的表象）。
    const fr = new FakeAgentRunner(() => [{ type: 'done', summary: 'dev ok', t: 0 }], {
      testExpertEvents: () => [{ type: 'done', summary: 'ok\nREVIEW_VERDICT: PASS', t: 0 }],
    });
    const db2 = openDatabase(':memory:');
    const r2 = createRepositories(db2);
    seedBasic(r2);
    const orch2 = makeOrch(r2, fr, { maxReviewRounds: 2 });
    const t = makeTask();
    r2.tasks.insert(t);
    await orch2.start(t.id);
    const final = r2.tasks.get(t.id)!;
    // 退回待开发（可点“启动/重试”显式再跑），而非卡在待沟通。
    expect(final.status).toBe('ready');
    // 保留失败来源泳道，供「重试」按来源恢复：审查失败重试只重跑审查。
    expect(final.pausedFrom).toBe('testing');
    // 未触发返工：dev 只跑 1 次，reviewer 只跑 1 次，retryCount 不递增。
    expect(final.retryCount).toBe(0);
    expect(fr.requests.filter((r) => r.expert === 'dev')).toHaveLength(1);
    expect(fr.requests.filter((r) => r.expert === 'test')).toHaveLength(1);
    // 无待处理交互、无伪造的「审查不通过」结论。
    expect(r2.pendingInteractions.getPendingForTask(t.id)).toBeUndefined();
    const msgs = r2.taskMessages.listByTask(t.id).map((m) => m.text ?? '');
    expect(msgs.some((m) => m.includes('审查不通过'))).toBe(false);
    // 给出与提供商不可达区分开的契约失败说明。
    expect(msgs.some((m) => m.includes('结果校验失败') && m.includes('结构化结果契约'))).toBe(true);
    db2.close();
  });

  it('retry after a review contract failure reruns review only (resumeToReview), not development', async () => {
    // 显式「重试」按失败来源恢复：审查阶段（testing）契约失败 -> 只重跑审查，不重复开发。
    // 与「启动」（从开发重走）语义分化；与待沟通 resumeFromPause 的 testing 分支一致。
    // setup() 初始化全局 worktreeDir（真实 git 仓库 + makeTask 创建任务 worktree），供 mergeWorktreeBranch 成功。
    setup(() => [{ type: 'done', summary: 'unused', t: 0 }], {});
    let reviewRuns = 0;
    const fr = new FakeAgentRunner(() => [{ type: 'done', summary: 'dev ok', t: 0 }], {
      testExpertEvents: () => {
        reviewRuns += 1;
        if (reviewRuns === 1) {
          // 首次审查：载荷缺失 -> task_result 契约失败 -> parkInReady(pausedFrom=testing)。
          return [{ type: 'done', summary: 'ok\nREVIEW_VERDICT: PASS', t: 0 }];
        }
        // 重试审查：补全合法载荷 -> 通过。
        return [{
          type: 'done', summary: 'ok\nREVIEW_VERDICT: PASS', t: 0,
          result: {
            kind: 'task_review',
            review: { pass: true, summary: 'REVIEW_VERDICT: PASS' },
            knowledgeAssessment: { verdict: 'none', reason: 'no durable knowledge', evidence: ['README.md'] },
          },
        }];
      },
    });
    const db2 = openDatabase(':memory:');
    const r2 = createRepositories(db2);
    seedBasic(r2);
    const orch2 = makeOrch(r2, fr, { maxReviewRounds: 2 });
    const t = makeTask();
    r2.tasks.insert(t);
    await orch2.start(t.id);
    expect(r2.tasks.get(t.id)!.status).toBe('ready');
    expect(r2.tasks.get(t.id)!.pausedFrom).toBe('testing');
    expect(fr.requests.filter((r) => r.expert === 'dev')).toHaveLength(1);

    await orch2.retry(t.id);
    for (let i = 0; i < 60; i++) {
      if (r2.tasks.get(t.id)!.status === 'in_review') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const final = r2.tasks.get(t.id)!;
    expect(final.status).toBe('in_review');
    // retry 只重跑审查：dev 仍为 1 次，reviewer 为 2 次。
    expect(fr.requests.filter((r) => r.expert === 'dev')).toHaveLength(1);
    expect(fr.requests.filter((r) => r.expert === 'test')).toHaveLength(2);
    expect(final.retryCount).toBe(1);
    db2.close();
  });

  it('retry from a legacy testing record without pausedFrom reruns review only', async () => {
    setup(() => [{ type: 'done', summary: 'unexpected dev run', t: 0 }]);
    const t = makeTask({ status: 'testing', pausedFrom: undefined, retryCount: 1 });
    repos.tasks.insert(t);

    await orch.retry(t.id);

    expect(repos.tasks.get(t.id)!.status).toBe('in_review');
    expect(runner.requests.filter((r) => r.expert === 'dev')).toHaveLength(0);
    expect(runner.requests.filter((r) => r.expert === 'test')).toHaveLength(1);
  });

  it('review provider error is a contract-independent failure: parks ready with provider guidance, not a fabricated verdict', async () => {
    // 审查器 error 事件（如 transient_provider）：直接抛错分流到 provider 说明，不再伪造成「审查执行异常」结论。
    const fr = new FakeAgentRunner(() => [{ type: 'done', summary: 'dev ok', t: 0 }], {
      testExpertEvents: () => [{ type: 'error', message: '所有已配置 AI 服务暂时不可用，请稍后重试', recoverable: true, failureKind: 'transient_provider', t: 0 }],
    });
    const db2 = openDatabase(':memory:');
    const r2 = createRepositories(db2);
    seedBasic(r2);
    const orch2 = makeOrch(r2, fr, { maxReviewRounds: 2, retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, backoff: false } });
    const t = makeTask();
    r2.tasks.insert(t);
    await orch2.start(t.id);
    const final = r2.tasks.get(t.id)!;
    expect(final.status).toBe('ready');
    expect(final.retryCount).toBe(0);
    expect(fr.requests.filter((r) => r.expert === 'dev')).toHaveLength(1);
    expect(fr.requests.filter((r) => r.expert === 'test')).toHaveLength(1);
    const msgs = r2.taskMessages.listByTask(t.id).map((m) => m.text ?? '');
    expect(msgs.some((m) => m.includes('审查不通过'))).toBe(false);
    expect(msgs.some((m) => m.includes('AI 服务暂时不可用'))).toBe(true);
    db2.close();
  });

  it('restart after a development failure injects the prior failure reason as userInput (no blind retry)', async () => {
    // 手动「启动/重试」从 ready 重走开发时，注入上次失败原因供针对性修复，避免开发专家拿干净 prompt 重蹈覆辙。
    // 首次启动无失败历史 -> 不注入；失败重启 -> userInput 携带「[上次失败原因...]」与失败摘要。
    setup(() => [{ type: 'done', summary: 'unused', t: 0 }], {});
    let devRuns = 0;
    const fr = new FakeAgentRunner(() => {
      devRuns += 1;
      if (devRuns === 1) {
        // 首次开发：提供商暂不可用 -> transient_provider 失败 -> parkInReady(pausedFrom=in_progress)。
        return [{
          type: 'error', message: 'dev provider temporarily unavailable', recoverable: true,
          failureKind: 'transient_provider', t: 0,
        }];
      }
      return [{ type: 'done', summary: 'dev ok', t: 0 }];
    }, { testExpertVerdict: 'PASS' });
    const db2 = openDatabase(':memory:');
    const r2 = createRepositories(db2);
    seedBasic(r2);
    // autoRetry=false：避免自动重试，交由显式 retry() 驱动第二次开发。
    const orch2 = makeOrch(r2, fr, { autoRetry: false, retryPolicy: { maxAttempts: 1, baseDelayMs: 5, maxDelayMs: 5, backoff: false } });
    const t = makeTask();
    r2.tasks.insert(t);
    await orch2.start(t.id);
    // 首次启动无失败历史：开发请求不带 userInput。
    const devReqsBefore = fr.requests.filter((r) => r.expert === 'dev');
    expect(devReqsBefore).toHaveLength(1);
    expect(devReqsBefore[0]!.userInput).toBeUndefined();
    const afterFirst = r2.tasks.get(t.id)!;
    expect(afterFirst.status).toBe('ready');
    expect(afterFirst.pausedFrom).toBe('in_progress');
    expect(r2.executions.getLatest(t.id)!.status).toBe('failed');

    await orch2.retry(t.id);
    for (let i = 0; i < 60; i++) {
      if (r2.tasks.get(t.id)!.status === 'in_review') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const devReqsAfter = fr.requests.filter((r) => r.expert === 'dev');
    expect(devReqsAfter).toHaveLength(2);
    // 重启注入失败原因：第二次开发请求的 userInput 含「[上次失败原因...]」与失败摘要。
    expect(devReqsAfter[1]!.userInput).toBeTruthy();
    expect(devReqsAfter[1]!.userInput!.includes('上次失败原因')).toBe(true);
    expect(devReqsAfter[1]!.userInput!.includes('dev provider temporarily unavailable')).toBe(true);
    expect(r2.tasks.get(t.id)!.status).toBe('in_review');
    db2.close();
  });

  it('retries a transient review failure in the testing lane without rerunning development', async () => {
    setup(() => [{ type: 'done', summary: 'unused', t: 0 }]);
    let reviewRuns = 0;
    const fr = new FakeAgentRunner(() => [{ type: 'done', summary: 'dev ok', t: 0 }], {
      testExpertEvents: () => {
        reviewRuns += 1;
        if (reviewRuns === 1) {
          return [{
            type: 'error', message: 'review provider temporarily unavailable', recoverable: true,
            failureKind: 'transient_provider', t: 0,
          }];
        }
        return [{
          type: 'done', summary: 'ok\nREVIEW_VERDICT: PASS', t: 0,
          result: {
            kind: 'task_review',
            review: { pass: true, summary: 'REVIEW_VERDICT: PASS' },
            knowledgeAssessment: { verdict: 'none', reason: 'no durable knowledge', evidence: ['README.md'] },
          },
        }];
      },
    });
    const db2 = openDatabase(':memory:');
    const r2 = createRepositories(db2);
    seedBasic(r2);
    const orch2 = makeOrch(r2, fr, {
      autoRetry: true,
      retryPolicy: { maxAttempts: 2, baseDelayMs: 5, maxDelayMs: 5, backoff: false },
    });
    const t = makeTask();
    r2.tasks.insert(t);

    await orch2.start(t.id);
    for (let i = 0; i < 60; i++) {
      if (r2.tasks.get(t.id)!.status === 'in_review') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(r2.tasks.get(t.id)!.status).toBe('in_review');
    expect(r2.tasks.get(t.id)!.retryCount).toBe(1);
    expect(fr.requests.filter((r) => r.expert === 'dev')).toHaveLength(1);
    expect(fr.requests.filter((r) => r.expert === 'test')).toHaveLength(2);
    db2.close();
  });
});

describe('orchestrator rejectTask (验收不通过退回)', () => {
  beforeEach(() => setup(() => [{ type: 'done', summary: 'dev ok', t: 0 }]));

  it('requires a non-empty reason', async () => {
    const t = makeTask({ status: 'in_review' });
    repos.tasks.insert(t);
    await expect(orch.rejectTask({ taskId: t.id, reason: '  ', target: 'in_progress' })).rejects.toThrow(/退回原因/);
  });

  it('only applies to in_review tasks', async () => {
    const t = makeTask({ status: 'ready' });
    repos.tasks.insert(t);
    await expect(orch.rejectTask({ taskId: t.id, reason: 'x', target: 'in_progress' })).rejects.toThrow(/仅待验收/);
  });

  it('reject to ready only changes status (no execution)', async () => {
    const t = makeTask({ status: 'in_review' });
    repos.tasks.insert(t);
    const execBefore = repos.executions.listByTask(t.id).length;
    await orch.rejectTask({ taskId: t.id, reason: '未覆盖验收标准', target: 'ready' });
    expect(repos.tasks.get(t.id)!.status).toBe('ready');
    expect(repos.executions.listByTask(t.id).length).toBe(execBefore);
    const msgs = repos.taskMessages.listByTask(t.id).map((m) => m.text ?? '');
    expect(msgs.some((m) => m.includes('验收不通过') && m.includes('未覆盖验收标准'))).toBe(true);
  });

  it('reject to in_progress records reason and immediately starts execution', async () => {
    const t = makeTask({ status: 'in_review' });
    repos.tasks.insert(t);
    await orch.rejectTask({ taskId: t.id, reason: '回归缺陷', target: 'in_progress' });
    const msgs = repos.taskMessages.listByTask(t.id).map((m) => m.text ?? '');
    expect(msgs.some((m) => m.includes('验收不通过') && m.includes('回归缺陷'))).toBe(true);
    for (let i = 0; i < 100; i++) {
      if (repos.tasks.get(t.id)!.status === 'in_review') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(repos.tasks.get(t.id)!.status).toBe('in_review');
    expect(repos.executions.listByTask(t.id).length).toBeGreaterThan(0);
  });
});

describe('orchestrator manual pause stops the running agent', () => {
  beforeEach(() => setup((req) => {
    if (req.userInput) {
      return [
        { type: 'log', level: 'info', text: `resumed with ${req.userInput}`, t: 0 },
        { type: 'done', summary: 'resumed ok', t: 0 },
      ];
    }
    return [
      { type: 'log', level: 'info', text: 'work-1', t: 0, delayMs: 5 },
      { type: 'log', level: 'info', text: 'work-2', t: 0, delayMs: 30 },
      { type: 'log', level: 'info', text: 'work-3', t: 0, delayMs: 30 },
      { type: 'done', summary: 'should-not-reach', t: 0, delayMs: 30 },
    ];
  }));

  async function waitForLog(taskId: string, text: string) {
    for (let i = 0; i < 100 && !repos.logs.listByTask(taskId).some((l) => l.text === text); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  it('pause stops the agent, marks execution paused and stays stably awaiting_input', async () => {
    const t = makeTask();
    repos.tasks.insert(t);
    const p = orch.start(t.id);
    await waitForLog(t.id, 'work-1');
    await orch.pause(t.id, '先别做了');
    await p;
    const final = repos.tasks.get(t.id)!;
    expect(final.status).toBe('awaiting_input');
    expect(final.pausedFrom).toBe('in_progress');
    expect(repos.executions.getLatest(t.id)!.status).toBe('paused');
    const logsAtPause = repos.logs.listByTask(t.id).length;
    await new Promise((r) => setTimeout(r, 150));
    expect(repos.logs.listByTask(t.id).length).toBe(logsAtPause);
    expect(repos.logs.listByTask(t.id).some((l) => l.text === 'work-3')).toBe(false);
    expect(repos.tasks.get(t.id)!.status).toBe('awaiting_input');
    expect(repos.pendingInteractions.getPendingForTask(t.id)?.kind).toBe('clarification');
  });

  it('reply after pause creates exactly one new run and resumes to in_review', async () => {
    const t = makeTask();
    repos.tasks.insert(t);
    const p = orch.start(t.id);
    await waitForLog(t.id, 'work-1');
    await orch.pause(t.id);
    await p;
    const inter = repos.pendingInteractions.getPendingForTask(t.id)!;
    const devExecBefore = repos.executions.listByTask(t.id).filter((e) => !isReviewExecution(e.summary)).length;
    await orch.resolveInteraction(t.id, inter.id, '继续，注意 X');
    expect(repos.tasks.get(t.id)!.status).toBe('in_review');
    expect(repos.executions.listByTask(t.id).filter((e) => !isReviewExecution(e.summary)).length).toBe(devExecBefore + 1);
    expect(repos.pendingInteractions.get(inter.id)!.status).toBe('answered');
    expect(repos.taskMessages.listByTask(t.id).filter((m) => m.text === '继续，注意 X').length).toBe(1);
    expect(repos.logs.listByTask(t.id).some((l) => l.text.includes('继续，注意 X'))).toBe(true);
  });

  it('rapid repeated pause is idempotent (no throw, no duplicate interaction)', async () => {
    const t = makeTask();
    repos.tasks.insert(t);
    const p = orch.start(t.id);
    await waitForLog(t.id, 'work-1');
    await orch.pause(t.id, 'a');
    await orch.pause(t.id, 'b');
    await p;
    const pending = repos.pendingInteractions.listByTask(t.id).filter((i) => i.status === 'pending');
    expect(pending.length).toBe(1);
    expect(repos.tasks.get(t.id)!.status).toBe('awaiting_input');
  });

  it('late events from the stopped run are never persisted', async () => {
    const fr = new FakeAgentRunner(
      () => [
        { type: 'log', level: 'info', text: 'early', t: 0 },
        { type: 'log', level: 'info', text: 'late-after-stop', t: 0, delayMs: 30 },
        { type: 'done', summary: 'late-done', t: 0, delayMs: 30 },
      ],
      { ignoreCancel: true },
    );
    const orch2 = makeOrch(repos, fr);
    const t = makeTask();
    repos.tasks.insert(t);
    const p = orch2.start(t.id);
    await waitForLog(t.id, 'early');
    await orch2.pause(t.id);
    await p;
    await new Promise((r) => setTimeout(r, 120));
    const texts = repos.logs.listByTask(t.id).map((l) => l.text);
    expect(texts).toContain('early');
    expect(texts).not.toContain('late-after-stop');
    const msgs = repos.taskMessages.listByTask(t.id).map((m) => m.text ?? '');
    expect(msgs.some((m) => m.includes('late-after-stop') || m.includes('late-done'))).toBe(false);
    expect(repos.tasks.get(t.id)!.status).toBe('awaiting_input');
  });
});

describe('orchestrator cancel semantics (stop / revoke retry / no brick)', () => {
  beforeEach(() => setup(() => [{ type: 'done', summary: 'ok', t: 0 }]));

  it('cancel stops the run, records canceled, stays ready and never auto-restarts (autoRetry on)', async () => {
    const fr = new FakeAgentRunner(() => [
      { type: 'log', level: 'info', text: 'long-1', t: 0, delayMs: 5 },
      { type: 'log', level: 'info', text: 'long-2', t: 0, delayMs: 40 },
      { type: 'done', summary: 'unreachable', t: 0, delayMs: 40 },
    ]);
    const orch2 = makeOrch(repos, fr, { autoRetry: true, retryPolicy: { maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 20, backoff: false } });
    let retried = 0;
    orch2.on('task-retry', () => { retried += 1; });
    const t = makeTask();
    repos.tasks.insert(t);
    const p = orch2.start(t.id);
    for (let i = 0; i < 100 && !repos.logs.listByTask(t.id).some((l) => l.text === 'long-1'); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await orch2.cancel(t.id);
    await p;
    expect(repos.tasks.get(t.id)!.status).toBe('ready');
    expect(repos.executions.getLatest(t.id)!.status).toBe('canceled');
    const execCount = repos.executions.listByTask(t.id).length;
    await new Promise((r) => setTimeout(r, 120));
    expect(repos.executions.listByTask(t.id).length).toBe(execCount);
    expect(repos.tasks.get(t.id)!.status).toBe('ready');
    expect(retried).toBe(0);
    await orch2.start(t.id);
    expect(repos.tasks.get(t.id)!.status).toBe('in_review');
  });

  it('cancel while a retry is pending revokes it (no second execution)', async () => {
    const fr = new FakeAgentRunner(() => [{ type: 'error', message: 'boom', recoverable: true, t: 0 }]);
    const orch2 = makeOrch(repos, fr, { autoRetry: true, retryPolicy: { maxAttempts: 5, baseDelayMs: 40, maxDelayMs: 40, backoff: false } });
    let onRetry!: () => void;
    const retryScheduled = new Promise<void>((r) => { onRetry = r; });
    orch2.on('task-retry', () => onRetry());
    const t = makeTask();
    repos.tasks.insert(t);
    await orch2.start(t.id);
    await retryScheduled;
    expect(repos.tasks.get(t.id)!.status).toBe('in_progress');
    await orch2.cancel(t.id);
    expect(repos.tasks.get(t.id)!.status).toBe('ready');
    await new Promise((r) => setTimeout(r, 120));
    expect(repos.executions.listByTask(t.id).length).toBe(1);
    expect(repos.tasks.get(t.id)!.status).toBe('ready');
    expect(repos.tasks.get(t.id)!.retryCount).toBe(0);
  });

  it('explicit retry supersedes a pending auto-retry (no ghost run)', async () => {
    let calls = 0;
    const fr = new FakeAgentRunner(() => {
      calls += 1;
      return calls === 1
        ? [{ type: 'error', message: 'first fails', recoverable: true, t: 0 }]
        : [{ type: 'done', summary: 'ok', t: 0 }];
    });
    const orch2 = makeOrch(repos, fr, { autoRetry: true, retryPolicy: { maxAttempts: 5, baseDelayMs: 60, maxDelayMs: 60, backoff: false } });
    let onRetry!: () => void;
    const retryScheduled = new Promise<void>((r) => { onRetry = r; });
    orch2.on('task-retry', () => onRetry());
    const t = makeTask();
    repos.tasks.insert(t);
    await orch2.start(t.id);
    await retryScheduled;
    await orch2.retry(t.id);
    expect(repos.tasks.get(t.id)!.status).toBe('in_review');
    await new Promise((r) => setTimeout(r, 150));
    expect(calls).toBe(2);
  });

  it('cancel on a non-running task does not brick it (no permanent fake run)', async () => {
    const t = makeTask();
    repos.tasks.insert(t);
    await orch.cancel(t.id);
    expect(repos.tasks.get(t.id)!.status).toBe('ready');
    await orch.start(t.id);
    expect(repos.tasks.get(t.id)!.status).toBe('in_review');
  });

  it('rapid repeated resolve/cancel stay consistent', async () => {
    const t = makeTask({ status: 'in_progress' });
    repos.tasks.insert(t);
    await orch.pause(t.id, 'hold');
    const inter = repos.pendingInteractions.getPendingForTask(t.id)!;
    await orch.resolveInteraction(t.id, inter.id, 'go');
    expect(repos.tasks.get(t.id)!.status).toBe('in_review');
    await expect(orch.resolveInteraction(t.id, inter.id, 'again')).rejects.toThrow();
    expect(repos.tasks.get(t.id)!.status).toBe('in_review');
    await orch.cancel(t.id);
    await orch.cancel(t.id);
    expect(repos.tasks.get(t.id)!.status).toBe('ready');
  });
});

describe('orchestrator pause/cancel during review (testing lane)', () => {
  function reviewOrch(autoRetry = false) {
    const fr = new FakeAgentRunner(() => [{ type: 'done', summary: 'dev ok', t: 0 }], { testExpertDelayMs: 40 });
    return makeOrch(repos, fr, { autoRetry, retryPolicy: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 20, backoff: false } });
  }

  async function waitStatus(taskId: string, status: string) {
    for (let i = 0; i < 200 && repos.tasks.get(taskId)!.status !== status; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  beforeEach(() => setup(() => [{ type: 'done', summary: 'dev ok', t: 0 }]));

  it('pause during review stops the reviewer and resumes through testing to in_review', async () => {
    const orch2 = reviewOrch();
    const t = makeTask();
    repos.tasks.insert(t);
    const p = orch2.start(t.id);
    await waitStatus(t.id, 'testing');
    expect(repos.tasks.get(t.id)!.status).toBe('testing');
    await orch2.pause(t.id, '暂停审查');
    await p;
    const paused = repos.tasks.get(t.id)!;
    expect(paused.status).toBe('awaiting_input');
    expect(paused.pausedFrom).toBe('testing');
    const reviewExec = repos.executions.listByTask(t.id).find((e) => isReviewExecution(e.summary) && e.status === 'paused');
    expect(reviewExec?.status).toBe('paused');
    const msgs = repos.taskMessages.listByTask(t.id).map((m) => m.text ?? '');
    expect(msgs.some((m) => m.includes('审查结论'))).toBe(false);
    const inter = repos.pendingInteractions.getPendingForTask(t.id)!;
    await orch2.resolveInteraction(t.id, inter.id, '继续审查');
    expect(repos.tasks.get(t.id)!.status).toBe('in_review');
    const devExecs = repos.executions.listByTask(t.id).filter((e) => !isReviewExecution(e.summary));
    expect(devExecs.length).toBe(1);
    const reviewExecs = repos.executions.listByTask(t.id).filter((e) => isReviewExecution(e.summary));
    expect(reviewExecs.length).toBe(2);
    expect(reviewExecs.some((e) => (e.summary ?? '').includes('review:pass'))).toBe(true);
  });

  it('pauses reviewer-originated interactions through the same awaiting_input lifecycle', async () => {
    const fr = new FakeAgentRunner(
      () => [{ type: 'done', summary: 'dev ok', t: 0 }],
      {
        testExpertEvents: () => [{
          type: 'ask_user',
          question: 'Which compatibility target should be reviewed?',
          context: 'Reviewer needs a target.',
          t: 0,
        }],
      },
    );
    const orch2 = makeOrch(repos, fr);
    const t = makeTask();
    repos.tasks.insert(t);

    await orch2.start(t.id);

    expect(repos.tasks.get(t.id)).toMatchObject({ status: 'awaiting_input', pausedFrom: 'testing' });
    expect(repos.pendingInteractions.getPendingForTask(t.id)).toMatchObject({
      kind: 'clarification',
      title: 'Which compatibility target should be reviewed?',
    });
    expect(repos.executions.listByTask(t.id).find((execution) => isReviewExecution(execution.summary))).toMatchObject({
      status: 'paused',
    });
  });

  it('cancels an awaiting_input task back to ready and clears the pending interaction', async () => {
    // 已被卡在待沟通（旧逻辑“无法重试”）的任务应能放弃等待退回待开发，再点“启动”重跑。
    const fr = new FakeAgentRunner(
      () => [{ type: 'done', summary: 'dev ok', t: 0 }],
      {
        testExpertEvents: () => [{
          type: 'ask_user',
          question: '请确认审查范围',
          context: '需用户指定范围。',
          t: 0,
        }],
      },
    );
    const orch2 = makeOrch(repos, fr);
    const t = makeTask();
    repos.tasks.insert(t);
    await orch2.start(t.id);
    expect(repos.tasks.get(t.id)!.status).toBe('awaiting_input');
    expect(repos.pendingInteractions.getPendingForTask(t.id)).toBeDefined();
    // 放弃等待 -> 退回 ready 且清理待处理交互。
    await orch2.cancel(t.id);
    const final = repos.tasks.get(t.id)!;
    expect(final.status).toBe('ready');
    expect(repos.pendingInteractions.getPendingForTask(t.id)).toBeUndefined();
    // 可再次启动（不报“任务已在运行”/状态非法）。
    await expect(orch2.start(t.id)).resolves.toBeUndefined();
  });

  it('cancel during review stops the reviewer and lands stably in ready (no fail verdict, no retry)', async () => {
    const orch2 = reviewOrch(true);
    const t = makeTask();
    repos.tasks.insert(t);
    const p = orch2.start(t.id);
    await waitStatus(t.id, 'testing');
    await orch2.cancel(t.id);
    await p;
    expect(repos.tasks.get(t.id)!.status).toBe('ready');
    const reviewExec = repos.executions.listByTask(t.id).find((e) => isReviewExecution(e.summary));
    expect(reviewExec?.status).toBe('canceled');
    const msgs = repos.taskMessages.listByTask(t.id).map((m) => m.text ?? '');
    expect(msgs.some((m) => m.includes('审查不通过'))).toBe(false);
    await new Promise((r) => setTimeout(r, 120));
    expect(repos.tasks.get(t.id)!.status).toBe('ready');
  });
});

describe('orchestrator lane-aware resume (pausedFrom preserved)', () => {
  beforeEach(() => setup(() => [{ type: 'done', summary: 'ok', t: 0 }]));

  it('pause from in_review resumes to in_review on reply without a new run', async () => {
    const t = makeTask({ status: 'in_review' });
    repos.tasks.insert(t);
    await orch.pause(t.id, '想调整一下？');
    expect(repos.tasks.get(t.id)!.status).toBe('awaiting_input');
    expect(repos.tasks.get(t.id)!.pausedFrom).toBe('in_review');
    const execCount = repos.executions.listByTask(t.id).length;
    const inter = repos.pendingInteractions.getPendingForTask(t.id)!;
    await orch.resolveInteraction(t.id, inter.id, '只是确认一下');
    expect(repos.tasks.get(t.id)!.status).toBe('in_review');
    expect(repos.executions.listByTask(t.id).length).toBe(execCount);
    expect(repos.pendingInteractions.get(inter.id)!.status).toBe('answered');
  });

  it('resume with no provider configured is blocked by the start gate (ready lane)', async () => {
    // hasProvider=false：ready->in_progress 门禁拒绝启动。
    const inner = new FakeAgentRunner(() => [{ type: 'done', summary: 'ok', t: 0 }]);
    const orch2 = new Orchestrator(repos, inner, { worktreesBaseDir: worktreeDir, maxConcurrent: 2, autoRetry: false, hasProvider: () => false });
    const t = makeTask({ status: 'ready' });
    repos.tasks.insert(t);
    await expect(orch2.start(t.id)).rejects.toThrow(/AI 服务|门禁/);
    expect(repos.tasks.get(t.id)!.status).toBe('ready');
  });
});

describe('orchestrator confirmation interaction (no regression)', () => {
  beforeEach(() => setup(() => [{ type: 'done', summary: 'ok', t: 0 }]));

  it('confirmation resolve resumes the task', async () => {
    const t = makeTask({ status: 'awaiting_input', pausedFrom: 'in_progress' });
    repos.tasks.insert(t);
    repos.pendingInteractions.insert({
      id: 'ci', taskId: t.id, kind: 'confirmation', title: '继续执行？', status: 'pending', createdAt: now(),
    });
    await orch.resolveInteraction(t.id, 'ci', 'confirm');
    expect(repos.pendingInteractions.get('ci')!.status).toBe('confirmed');
    expect(repos.tasks.get(t.id)!.status).toBe('in_review');
  });
});

/**
 * 迭代专用分支集成测试（需求 4）：
 * - 启动任务时 worktree 基于迭代分支 ai-devflow-sprint/v1
 * - 审查通过后任务分支合并进迭代分支（而非主分支）
 * 使用真实 git 仓库 + 自定义 runner（在 worktree 内写文件并提交）。
 */
function shGit(cwd: string, args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** 自定义 runner：开发阶段在 worktree 内写文件并提交；审查阶段直接 PASS。 */
class GitCommitRunner implements AgentRunner {
  requests: AgentRunRequest[] = [];
  marker: string;
  constructor(marker: string) { this.marker = marker; }
  async verifyRuntime(): Promise<{ version: string; entry: string }> { return { version: 'fake', entry: 'fake' }; }
  async run(req: AgentRunRequest): Promise<AgentRun> {
    this.requests.push(req);
    if (req.expert === 'test') {
      const payload = {
        kind: 'task_review' as const,
        review: { pass: true, summary: 'REVIEW_VERDICT: PASS' },
        knowledgeAssessment: {
          verdict: 'none' as const,
          reason: '无沉淀价值',
          evidence: ['x.ts'],
        },
      };
      return runFromEvents([
        { type: 'log', level: 'info', text: 'reviewing', t: 0 },
        { type: 'done', summary: 'ok\nREVIEW_VERDICT: PASS', result: payload, t: 0 },
      ]);
    }
    // 开发阶段：在 worktree（req.cwd）内写文件并提交，模拟 agent 产出代码。
    writeFileSync(join(req.cwd, this.marker), 'done');
    shGit(req.cwd, ['add', '.']);
    shGit(req.cwd, ['commit', '-q', '-m', `feat: ${this.marker}`]);
    return runFromEvents([{ type: 'done', summary: 'dev ok', t: 0 }]);
  }
}

describe('orchestrator iteration sprint branch (需求 4)', () => {
  let gitRepo: string;
  let wtBase: string;

  beforeEach(() => {
    gitRepo = mkdtempSync(join(tmpdir(), 'aidf-sprint-repo-'));
    wtBase = mkdtempSync(join(tmpdir(), 'aidf-sprint-wt-'));
    shGit(gitRepo, ['init', '-q', '-b', 'main']);
    shGit(gitRepo, ['config', 'user.email', 't@t']);
    shGit(gitRepo, ['config', 'user.name', 't']);
    writeFileSync(join(gitRepo, 'README.md'), 'init');
    shGit(gitRepo, ['add', '.']);
    shGit(gitRepo, ['commit', '-q', '-m', 'init']);
  });

  afterEach(() => {
    rmSync(gitRepo, { recursive: true, force: true });
    rmSync(wtBase, { recursive: true, force: true });
  });

  it('task worktree bases off sprint branch; review pass merges into sprint (not main)', async () => {
    const db2 = openDatabase(':memory:');
    const r2 = createRepositories(db2);
    r2.projects.insert({ id: 'p', name: 'P', path: gitRepo, defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
    r2.iterations.insert({ id: 'i', projectId: 'p', name: 'I', version: 'v1', status: 'active', createdAt: 1 });
    r2.requirements.insert({ id: 'r', iterationId: 'i', title: 'R', description: '', priority: 'medium', acceptance: 'acc', createdAt: 1, archived: false });
    // 预创建迭代分支（模拟迭代创建时的分支初始化）
    await ensureSprintBranch({ repoPath: gitRepo, version: 'v1', baseBranch: 'main' });

    const runner2 = new GitCommitRunner('task-output.txt');
    const orch2 = new Orchestrator(r2, runner2, { worktreesBaseDir: wtBase, maxConcurrent: 1, autoRetry: false });
    const t: Task = {
      id: randomId(), requirementId: 'r', iterationId: 'i', projectId: 'p',
      title: 'T', description: 'd', status: 'ready', role: 'coder',
      stages: [{ id: 's1', name: '实现', role: 'coder' }], currentStage: 0,
      statusChangedAt: now(), createdAt: now(), updatedAt: now(), retryCount: 0,
    };
    r2.tasks.insert(t);
    await orch2.start(t.id);

    expect(r2.tasks.get(t.id)!.status).toBe('in_review');
    // 迭代分支包含任务产出（合并成功）
    shGit(gitRepo, ['checkout', '-q', 'ai-devflow-sprint/v1']);
    expect(existsSync(join(gitRepo, 'task-output.txt'))).toBe(true);
    // 主分支不包含任务产出（未合并到 main）
    shGit(gitRepo, ['checkout', '-q', 'main']);
    expect(existsSync(join(gitRepo, 'task-output.txt'))).toBe(false);
    // 任务对话记录提到合并到迭代分支
    const msgs = r2.taskMessages.listByTask(t.id).map((m) => m.text ?? '');
    expect(msgs.some((m) => m.includes('迭代分支'))).toBe(true);
    db2.close();
  });
});
