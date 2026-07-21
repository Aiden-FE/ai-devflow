import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, createRepositories, type Repositories } from '@ai-devflow/persistence';
import { AgentRegistry, ControllableTestAdapter, type TestEventSpec, type AgentAdapter, type AgentRun } from '@ai-devflow/agents';
import { Orchestrator } from '../orchestrator.js';
import type { DatabaseSync } from '@ai-devflow/persistence';
import type { Task, AgentEvent, AgentRunRequest } from '@ai-devflow/core';
import { randomId, now } from '@ai-devflow/core';

let db: DatabaseSync;
let repos: Repositories;
let orch: Orchestrator;
let worktreeDir: string;
let events: Array<{ taskId: string; event: AgentEvent }>;

function setup(script: (req: AgentRunRequest) => TestEventSpec[]) {
  db = openDatabase(':memory:');
  repos = createRepositories(db);
  worktreeDir = mkdtempSync(join(tmpdir(), 'aidf-orch-'));
  const reg = new AgentRegistry();
  reg.register(new ControllableTestAdapter({ script }));
  // reviewer 角色对应的审查 Agent：开发完成后进入 testing 时由其审查（默认给出 PASS）。
  reg.register(new AvailableFakeAdapter('codex'));
  orch = new Orchestrator(repos, reg, { worktreesBaseDir: worktreeDir, maxConcurrent: 2, autoRetry: false });
  events = [];
  orch.on('task-event', (e) => events.push(e));
  // 项目 + 迭代 + 需求
  repos.projects.insert({ id: 'p', name: 'P', path: '/tmp/unused', defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
  repos.iterations.insert({ id: 'i', projectId: 'p', name: 'I', version: 'v1', status: 'active', createdAt: 1 });
  repos.requirements.insert({ id: 'r', iterationId: 'i', title: 'R', description: '', priority: 'medium', acceptance: 'acc', createdAt: 1, archived: false });
}

afterEach(() => {
  try { db.close(); } catch { /* */ }
  rmSync(worktreeDir, { recursive: true, force: true });
});

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: randomId(),
    requirementId: 'r',
    iterationId: 'i',
    projectId: 'p',
    title: 'T',
    description: 'do it',
    status: 'ready',
    agentType: 'test',
    role: 'coder',
    stages: [{ id: 's1', name: '实现', role: 'coder' }],
    currentStage: 0,
    statusChangedAt: now(),
    createdAt: now(),
    updatedAt: now(),
    retryCount: 0,
    worktreePath: join(worktreeDir, 'fake-wt'),
    ...over,
  };
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
    // 恢复后 logs 包含用户回答
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

  it('fails dead in_progress tasks and keeps awaiting_input', async () => {
    // in_progress 任务带 running 执行记录（模拟重启前中断）
    const tRunning = makeTask({ id: randomId(), status: 'in_progress' });
    repos.tasks.insert(tRunning);
    repos.executions.insert({
      id: randomId(), taskId: tRunning.id, attempt: 1, agentType: 'test',
      startedAt: now(), status: 'running',
    });
    // awaiting_input 任务
    const tWaiting = makeTask({ id: randomId(), status: 'awaiting_input' });
    repos.tasks.insert(tWaiting);
    repos.pendingQuestions.upsert({ taskId: tWaiting.id, question: 'q?', context: '', askedAt: now() });

    const res = await orch.recover();
    expect(res.failed).toContain(tRunning.id);
    expect(res.awaiting).toContain(tWaiting.id);
    expect(repos.tasks.get(tRunning.id)!.status).toBe('ready');
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

    // 前置仍在待开发 -> 后继启动被依赖门禁拒绝
    await expect(orch.start(succ.id)).rejects.toThrow(/前置任务未完成/);
    expect(repos.tasks.get(succ.id)!.status).toBe('ready');

    // 前置推进到测试中（开发已交付）-> 后继可启动
    pred.status = 'in_review';
    pred.statusChangedAt = now();
    repos.tasks.update(pred);
    await orch.start(succ.id);
    expect(repos.tasks.get(succ.id)!.status).toBe('in_review');
  });

  it('resume (from awaiting_input) skips the dependency check', async () => {
    // 后继此前已启动并暂停在待沟通；即便前置此刻未完成（如被退回开发），恢复也不应被依赖门禁拦截。
    const pred = makeTask({ id: randomId(), status: 'in_progress' });
    const succ = makeTask({ id: randomId(), status: 'awaiting_input', dependsOn: [pred.id] });
    repos.tasks.insert(pred);
    repos.tasks.insert(succ);
    repos.pendingQuestions.upsert({ taskId: succ.id, question: 'q?', context: '', askedAt: now() });
    await orch.resume(succ.id, 'answer');
    expect(repos.tasks.get(succ.id)!.status).toBe('in_review');
  });
});

describe('orchestrator approval flow + capabilities', () => {
  it('passes resolved capabilities to adapter and merges roleConfig agentType', async () => {
    // 项目配置：coder 角色 -> codex + 工具白名单
    const db2 = openDatabase(':memory:');
    const r2 = createRepositories(db2);
    const dir = mkdtempSync(join(tmpdir(), 'aidf-caps-'));
    const reg = new AgentRegistry();
    reg.register(new AvailableFakeAdapter('codex'));
    const orch2 = new Orchestrator(r2, reg, { worktreesBaseDir: dir, maxConcurrent: 2, autoRetry: false });
    r2.projects.insert({ id: 'p', name: 'P', path: '/tmp/unused', defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: { roleConfigs: { coder: { agentType: 'codex', tools: ['Read', 'Edit'] } } } });
    r2.iterations.insert({ id: 'i', projectId: 'p', name: 'I', version: 'v1', status: 'active', createdAt: 1 });
    r2.requirements.insert({ id: 'r', iterationId: 'i', title: 'R', description: '', priority: 'medium', acceptance: 'acc', createdAt: 1, archived: false });
    const t = makeTask();
    t.agentType = undefined; // 按角色默认 -> codex
    r2.tasks.insert(t);
    await orch2.start(t.id);
    expect(r2.tasks.get(t.id)!.agentType).toBe('codex');
    db2.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('pauses on approval_request, resumes to in_review on allow (deny is not success)', async () => {
    const db2 = openDatabase(':memory:');
    const r2 = createRepositories(db2);
    const dir = mkdtempSync(join(tmpdir(), 'aidf-approval-'));
    const reg = new AgentRegistry();
    reg.register(new ControllableTestAdapter({
      script: (req) => {
        if (req.interactionResponse?.kind === 'approval') {
          return req.interactionResponse.value === 'allow'
            ? [{ type: 'log', level: 'info', text: 'approved run', t: 0 }, { type: 'done', summary: 'ok', t: 0 }]
            : [{ type: 'error', message: 'tool denied', recoverable: false, t: 0 }];
        }
        return [
          { type: 'log', level: 'info', text: 'want to run bash', t: 0 },
          { type: 'approval_request', toolName: 'Bash', toolUseId: 'tu1', description: 'rm -rf', t: 0 },
        ];
      },
    }));
    reg.register(new AvailableFakeAdapter('codex')); // reviewer 桩（审查通过）
    const orch2 = new Orchestrator(r2, reg, { worktreesBaseDir: dir, maxConcurrent: 2, autoRetry: false });
    r2.projects.insert({ id: 'p', name: 'P', path: '/tmp/unused', defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
    r2.iterations.insert({ id: 'i', projectId: 'p', name: 'I', version: 'v1', status: 'active', createdAt: 1 });
    r2.requirements.insert({ id: 'r', iterationId: 'i', title: 'R', description: '', priority: 'medium', acceptance: 'acc', createdAt: 1, archived: false });
    const t = makeTask();
    r2.tasks.insert(t);

    await orch2.start(t.id);
    expect(r2.tasks.get(t.id)!.status).toBe('awaiting_input');
    const inter = r2.pendingInteractions.getPendingForTask(t.id);
    expect(inter?.kind).toBe('approval');
    expect(inter?.toolName).toBe('Bash');
    // 对话消息包含 approval_request
    const msgs = r2.taskMessages.listByTask(t.id);
    expect(msgs.some((m) => m.kind === 'approval_request')).toBe(true);

    // 批准 -> 恢复并完成到待验收
    await orch2.resolveInteraction(t.id, inter!.id, 'allow');
    expect(r2.tasks.get(t.id)!.status).toBe('in_review');
    expect(r2.pendingInteractions.get(inter!.id)!.status).toBe('approved');

    db2.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('denial does not mark success (task returns to ready on error)', async () => {
    const db2 = openDatabase(':memory:');
    const r2 = createRepositories(db2);
    const dir = mkdtempSync(join(tmpdir(), 'aidf-deny-'));
    const reg = new AgentRegistry();
    reg.register(new ControllableTestAdapter({
      script: (req) => {
        if (req.interactionResponse?.kind === 'approval' && req.interactionResponse.value === 'deny') {
          return [{ type: 'error', message: 'denied', recoverable: false, t: 0 }];
        }
        return [{ type: 'approval_request', toolName: 'Bash', toolUseId: 'tu1', description: 'x', t: 0 }];
      },
    }));
    reg.register(new AvailableFakeAdapter('codex')); // reviewer 桩
    const orch2 = new Orchestrator(r2, reg, { worktreesBaseDir: dir, maxConcurrent: 2, autoRetry: false });
    r2.projects.insert({ id: 'p', name: 'P', path: '/tmp/unused', defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
    r2.iterations.insert({ id: 'i', projectId: 'p', name: 'I', version: 'v1', status: 'active', createdAt: 1 });
    r2.requirements.insert({ id: 'r', iterationId: 'i', title: 'R', description: '', priority: 'medium', acceptance: 'acc', createdAt: 1, archived: false });
    const t = makeTask();
    r2.tasks.insert(t);
    await orch2.start(t.id);
    const inter = r2.pendingInteractions.getPendingForTask(t.id)!;
    await orch2.resolveInteraction(t.id, inter.id, 'deny').catch(() => {});
    // 拒绝后任务不应进入待验收/归档（不判定成功）
    const final = r2.tasks.get(t.id)!.status;
    expect(['ready', 'in_progress', 'awaiting_input']).toContain(final);
    expect(r2.pendingInteractions.get(inter.id)!.status).toBe('denied');
    db2.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

// 慢速审查桩：reviewer 角色，产出审查日志后延迟给出 PASS，用于「审查中暂停/取消」场景。
class SlowReviewAdapter implements AgentAdapter {
  constructor(readonly id: import('@ai-devflow/core').AgentType = 'codex') {}
  async detect() {
    return { agentType: this.id, available: true, version: 'slow' };
  }
  capabilities(): import('@ai-devflow/core').AgentCapabilitySupport {
    return { tools: true, plugins: true, skills: 'all-or-none', approval: true };
  }
  async run(_req: AgentRunRequest): Promise<AgentRun> {
    let cancelled = false;
    const events = (async function* (): AsyncIterable<AgentEvent> {
      yield { type: 'log', level: 'info', text: 'reviewing', t: 0 } as AgentEvent;
      await new Promise((r) => setTimeout(r, 40));
      if (cancelled) return;
      yield { type: 'done', summary: 'ok\nREVIEW_VERDICT: PASS', t: 0 } as AgentEvent;
    })();
    return {
      pid: undefined,
      cancel: async () => { cancelled = true; },
      done: async () => ({ exitCode: cancelled ? null : 0, ok: !cancelled }),
      events,
    };
  }
}

// 晚到事件桩：cancel 被忽略，事件按真实时间间隔继续到达，用于验证停止后事件不落库。
class LateEventAdapter implements AgentAdapter {
  readonly id = 'test' as const;
  async detect() {
    return { agentType: 'test' as const, available: true, version: 'late' };
  }
  capabilities(): import('@ai-devflow/core').AgentCapabilitySupport {
    return { tools: true, plugins: true, skills: 'all-or-none', approval: true };
  }
  async run(_req: AgentRunRequest): Promise<AgentRun> {
    const events = (async function* (): AsyncIterable<AgentEvent> {
      yield { type: 'log', level: 'info', text: 'early', t: 0 } as AgentEvent;
      await new Promise((r) => setTimeout(r, 30));
      yield { type: 'log', level: 'info', text: 'late-after-stop', t: 0 } as AgentEvent;
      await new Promise((r) => setTimeout(r, 30));
      yield { type: 'done', summary: 'late-done', t: 0 } as AgentEvent;
    })();
    return {
      pid: undefined,
      cancel: async () => { /* 忽略取消：事件继续到达 */ },
      done: async () => ({ exitCode: null, ok: false }),
      events,
    };
  }
}

// 可用适配器桩：detect 恒可用，run 产出 done；可指定审查结论（PASS/FAIL），用作 reviewer 桩。
class AvailableFakeAdapter implements AgentAdapter {
  constructor(readonly id: import('@ai-devflow/core').AgentType, private verdict: 'PASS' | 'FAIL' = 'PASS') {}
  async detect() {
    return { agentType: this.id, available: true, version: 'fake' };
  }
  capabilities(): import('@ai-devflow/core').AgentCapabilitySupport {
    return { tools: true, plugins: true, skills: 'all-or-none', approval: true };
  }
  async run(_req: AgentRunRequest): Promise<AgentRun> {
    const verdictLine = this.verdict === 'PASS' ? 'REVIEW_VERDICT: PASS' : 'REVIEW_VERDICT: FAIL: 未覆盖验收标准第 2 条';
    return {
      pid: undefined,
      cancel: async () => {},
      done: async () => ({ exitCode: 0, ok: true }),
      events: (async function* () {
        yield { type: 'log', level: 'info', text: 'fake run', t: 0 } as AgentEvent;
        yield { type: 'done', summary: `ok\n${verdictLine}`, t: 0 } as AgentEvent;
      })(),
    };
  }
}

describe('orchestrator default agent resolution', () => {
  beforeEach(() => setup(() => [{ type: 'done', summary: 'ok', t: 0 }]));

  it('task without agentType resolves first available adapter (claude_code)', async () => {
    // 用自定义注册表：含可用的 claude_code 桩
    const reg = new AgentRegistry();
    reg.register(new AvailableFakeAdapter('claude_code'));
    reg.register(new AvailableFakeAdapter('codex'));
    const orch2 = new Orchestrator(repos, reg, { worktreesBaseDir: worktreeDir, maxConcurrent: 2, autoRetry: false });

    const t = makeTask();
    t.agentType = undefined;
    repos.tasks.insert(t);
    await orch2.start(t.id);
    expect(repos.tasks.get(t.id)!.agentType).toBe('claude_code');
    expect(repos.tasks.get(t.id)!.status).toBe('in_review');
  });

  it('throws clear error when no adapter available', async () => {
    const reg = new AgentRegistry(); // 空，不注册任何适配器
    const orch2 = new Orchestrator(repos, reg, { worktreesBaseDir: worktreeDir, maxConcurrent: 2, autoRetry: false });
    const t = makeTask();
    t.agentType = undefined;
    repos.tasks.insert(t);
    await expect(orch2.start(t.id)).rejects.toThrow(/没有可用的 Agent 桥接器/);
  });
});

describe('orchestrator bounded retry (no infinite loop)', () => {
  beforeEach(() => setup(() => [{ type: 'done', summary: 'ok', t: 0 }]));

  it('stops after maxAttempts and returns task to ready', async () => {
    const reg = new AgentRegistry();
    reg.register(
      new ControllableTestAdapter({ script: () => [{ type: 'error', message: 'boom', recoverable: true, t: 0 }] }),
    );
    const orch2 = new Orchestrator(repos, reg, {
      worktreesBaseDir: worktreeDir,
      maxConcurrent: 2,
      autoRetry: true,
      retryPolicy: { maxAttempts: 2, baseDelayMs: 5, maxDelayMs: 20, backoff: true },
    });
    const t = makeTask();
    repos.tasks.insert(t);
    await orch2.start(t.id); // 首次失败，调度重试
    // 等待重试耗尽
    for (let i = 0; i < 60; i++) {
      const tk = repos.tasks.get(t.id);
      if (tk!.status === 'ready' && repos.executions.listByTask(t.id).length >= 2) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const final = repos.tasks.get(t.id)!;
    expect(final.status).toBe('ready');
    const failed = repos.executions.listByTask(t.id).filter((e) => e.status === 'failed');
    expect(failed.length).toBe(2); // 恰好 maxAttempts 次，不无限重试
  }, 8000);

  it('worktree creation failure is bounded and logs the reason (no infinite loop)', async () => {
    const reg = new AgentRegistry();
    reg.register(new ControllableTestAdapter({ script: () => [{ type: 'done', summary: 'ok', t: 0 }] }));
    const orch2 = new Orchestrator(repos, reg, {
      worktreesBaseDir: worktreeDir,
      maxConcurrent: 2,
      autoRetry: true,
      retryPolicy: { maxAttempts: 2, baseDelayMs: 5, maxDelayMs: 20, backoff: true },
    });
    // project.path 为 '/tmp/unused'（非 git 仓库）-> createWorktree 必失败
    const t = makeTask();
    t.worktreePath = undefined; // 强制走 createWorktree
    t.agentType = 'test';
    repos.tasks.insert(t);
    await orch2.start(t.id);
    for (let i = 0; i < 60; i++) {
      const tk = repos.tasks.get(t.id);
      if (tk!.status === 'ready' && repos.executions.listByTask(t.id).length >= 2) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const final = repos.tasks.get(t.id)!;
    expect(final.status).toBe('ready');
    expect(repos.executions.listByTask(t.id).filter((e) => e.status === 'failed').length).toBe(2);
    // 失败原因写入日志面板
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
    // 审查结论持久化到任务对话
    const msgs = repos.taskMessages.listByTask(t.id).map((m) => m.text ?? '');
    expect(msgs.some((m) => m.includes('审查结论') && m.includes('通过'))).toBe(true);
    // 审查执行记录摘要标记 review:pass
    const execs = repos.executions.listByTask(t.id);
    expect(execs.some((e) => (e.summary ?? '').includes('review:pass'))).toBe(true);
  });

  it('review failure returns to in_progress with feedback, bounded by maxReviewRounds (no infinite loop)', async () => {
    const db2 = openDatabase(':memory:');
    const r2 = createRepositories(db2);
    const dir = mkdtempSync(join(tmpdir(), 'aidf-reviewfail-'));
    const reg = new AgentRegistry();
    reg.register(new ControllableTestAdapter({ script: () => [{ type: 'done', summary: 'dev ok', t: 0 }] }));
    reg.register(new AvailableFakeAdapter('codex', 'FAIL')); // 审查恒不通过
    const orch2 = new Orchestrator(r2, reg, { worktreesBaseDir: dir, maxConcurrent: 2, autoRetry: false, maxReviewRounds: 2 });
    r2.projects.insert({ id: 'p', name: 'P', path: '/tmp/unused', defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
    r2.iterations.insert({ id: 'i', projectId: 'p', name: 'I', version: 'v1', status: 'active', createdAt: 1 });
    r2.requirements.insert({ id: 'r', iterationId: 'i', title: 'R', description: '', priority: 'medium', acceptance: 'acc', createdAt: 1, archived: false });
    const t = makeTask();
    r2.tasks.insert(t);
    await orch2.start(t.id);
    const final = r2.tasks.get(t.id)!;
    // 审查多轮不通过 -> 停在开发中（绝不进入待验收），且有界（retryCount==maxReviewRounds）
    expect(final.status).toBe('in_progress');
    expect(final.retryCount).toBe(2);
    const msgs = r2.taskMessages.listByTask(t.id).map((m) => m.text ?? '');
    expect(msgs.some((m) => m.includes('审查不通过'))).toBe(true);
    db2.close();
    rmSync(dir, { recursive: true, force: true });
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
    expect(repos.executions.listByTask(t.id).length).toBe(execBefore); // 未启动执行
    const msgs = repos.taskMessages.listByTask(t.id).map((m) => m.text ?? '');
    expect(msgs.some((m) => m.includes('验收不通过') && m.includes('未覆盖验收标准'))).toBe(true);
  });

  it('reject to in_progress records reason and immediately starts execution', async () => {
    const t = makeTask({ status: 'in_review' });
    repos.tasks.insert(t);
    await orch.rejectTask({ taskId: t.id, reason: '回归缺陷', target: 'in_progress' });
    // 退回原因写入任务消息
    const msgs = repos.taskMessages.listByTask(t.id).map((m) => m.text ?? '');
    expect(msgs.some((m) => m.includes('验收不通过') && m.includes('回归缺陷'))).toBe(true);
    // 立即携原因启动执行（异步）：dev -> testing -> 审查通过 -> 回到待验收
    for (let i = 0; i < 100; i++) {
      if (repos.tasks.get(t.id)!.status === 'in_review') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(repos.tasks.get(t.id)!.status).toBe('in_review');
    // 执行记录确实增加（说明真正运行了，而非“显示成功但未运行”）
    expect(repos.executions.listByTask(t.id).length).toBeGreaterThan(0);
  });
});

describe('orchestrator global agent config inheritance', () => {
  function setupWithFakes(settings: import('@ai-devflow/core').ProjectSettings) {
    const db2 = openDatabase(':memory:');
    const r2 = createRepositories(db2);
    const dir = mkdtempSync(join(tmpdir(), 'aidf-inherit-'));
    const reg = new AgentRegistry();
    reg.register(new AvailableFakeAdapter('claude_code'));
    reg.register(new AvailableFakeAdapter('codex'));
    const orch2 = new Orchestrator(r2, reg, { worktreesBaseDir: dir, maxConcurrent: 2, autoRetry: false });
    r2.projects.insert({ id: 'p', name: 'P', path: '/tmp/unused', defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings });
    r2.iterations.insert({ id: 'i', projectId: 'p', name: 'I', version: 'v1', status: 'active', createdAt: 1 });
    r2.requirements.insert({ id: 'r', iterationId: 'i', title: 'R', description: '', priority: 'medium', acceptance: 'acc', createdAt: 1, archived: false });
    return { db2, r2, dir, orch2 };
  }

  it('uses global role agentType when project does not override', async () => {
    const { db2, r2, dir, orch2 } = setupWithFakes({});
    // 全局默认：coder -> codex；项目无 roleConfigs
    r2.credentials.upsert('global_agent_config', JSON.stringify({ coder: { agentType: 'codex' } }));
    const t = makeTask();
    t.agentType = undefined;
    r2.tasks.insert(t);
    await orch2.start(t.id);
    expect(r2.tasks.get(t.id)!.agentType).toBe('codex'); // 继承全局
    db2.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('project explicit agentType overrides global', async () => {
    const { db2, r2, dir, orch2 } = setupWithFakes({ roleConfigs: { coder: { agentType: 'claude_code' } } });
    r2.credentials.upsert('global_agent_config', JSON.stringify({ coder: { agentType: 'codex' } }));
    const t = makeTask();
    t.agentType = undefined;
    r2.tasks.insert(t);
    await orch2.start(t.id);
    expect(r2.tasks.get(t.id)!.agentType).toBe('claude_code'); // 项目覆盖全局
    db2.close();
    rmSync(dir, { recursive: true, force: true });
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
    await p; // 受控停止：start 干净收尾（不抛错、不进入失败重试）
    const final = repos.tasks.get(t.id)!;
    expect(final.status).toBe('awaiting_input');
    expect(final.pausedFrom).toBe('in_progress');
    expect(repos.executions.getLatest(t.id)!.status).toBe('paused');
    // 晚到事件不落库：等待超过剩余事件延迟后日志不再增长，且未运行到 done
    const logsAtPause = repos.logs.listByTask(t.id).length;
    await new Promise((r) => setTimeout(r, 150));
    expect(repos.logs.listByTask(t.id).length).toBe(logsAtPause);
    expect(repos.logs.listByTask(t.id).some((l) => l.text === 'work-3')).toBe(false);
    expect(repos.tasks.get(t.id)!.status).toBe('awaiting_input');
    // 创建了一条待处理澄清交互（供回复后恢复）
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
    const devExecBefore = repos.executions.listByTask(t.id).filter((e) => e.agentType === 'test').length;
    await orch.resolveInteraction(t.id, inter.id, '继续，注意 X');
    expect(repos.tasks.get(t.id)!.status).toBe('in_review');
    // 恰好新增一次开发运行（恢复只创建一次新运行，不重复消费）
    expect(repos.executions.listByTask(t.id).filter((e) => e.agentType === 'test').length).toBe(devExecBefore + 1);
    // 交互只消费一次，用户回答只记录一次
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
    await orch.pause(t.id, 'b'); // 已在待沟通：幂等返回
    await p;
    const pending = repos.pendingInteractions.listByTask(t.id).filter((i) => i.status === 'pending');
    expect(pending.length).toBe(1);
    expect(repos.tasks.get(t.id)!.status).toBe('awaiting_input');
  });

  it('late events from the stopped run are never persisted', async () => {
    const reg = new AgentRegistry();
    reg.register(new LateEventAdapter());
    reg.register(new AvailableFakeAdapter('codex'));
    const orch2 = new Orchestrator(repos, reg, { worktreesBaseDir: worktreeDir, maxConcurrent: 2, autoRetry: false });
    const t = makeTask();
    repos.tasks.insert(t);
    const p = orch2.start(t.id);
    await waitForLog(t.id, 'early');
    await orch2.pause(t.id);
    await p;
    await new Promise((r) => setTimeout(r, 120)); // 等晚到事件全部冲刷完
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
    const reg = new AgentRegistry();
    reg.register(new ControllableTestAdapter({
      script: () => [
        { type: 'log', level: 'info', text: 'long-1', t: 0, delayMs: 5 },
        { type: 'log', level: 'info', text: 'long-2', t: 0, delayMs: 40 },
        { type: 'done', summary: 'unreachable', t: 0, delayMs: 40 },
      ],
    }));
    reg.register(new AvailableFakeAdapter('codex'));
    const orch2 = new Orchestrator(repos, reg, {
      worktreesBaseDir: worktreeDir, maxConcurrent: 2, autoRetry: true,
      retryPolicy: { maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 20, backoff: false },
    });
    let retried = 0;
    orch2.on('task-retry', () => { retried += 1; });
    const t = makeTask();
    repos.tasks.insert(t);
    const p = orch2.start(t.id);
    for (let i = 0; i < 100 && !repos.logs.listByTask(t.id).some((l) => l.text === 'long-1'); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await orch2.cancel(t.id);
    await p; // 受控停止：干净收尾
    expect(repos.tasks.get(t.id)!.status).toBe('ready');
    expect(repos.executions.getLatest(t.id)!.status).toBe('canceled');
    // 等待远超重试延迟：不得按失败重试、不得自动重启
    const execCount = repos.executions.listByTask(t.id).length;
    await new Promise((r) => setTimeout(r, 120));
    expect(repos.executions.listByTask(t.id).length).toBe(execCount);
    expect(repos.tasks.get(t.id)!.status).toBe('ready');
    expect(retried).toBe(0);
    // 仅用户明确启动才可再运行（取消不砖任务）
    await orch2.start(t.id);
    expect(repos.tasks.get(t.id)!.status).toBe('in_review');
  });

  it('cancel while a retry is pending revokes it (no second execution)', async () => {
    const reg = new AgentRegistry();
    reg.register(new ControllableTestAdapter({ script: () => [{ type: 'error', message: 'boom', recoverable: true, t: 0 }] }));
    const orch2 = new Orchestrator(repos, reg, {
      worktreesBaseDir: worktreeDir, maxConcurrent: 2, autoRetry: true,
      retryPolicy: { maxAttempts: 5, baseDelayMs: 40, maxDelayMs: 40, backoff: false },
    });
    let onRetry!: () => void;
    const retryScheduled = new Promise<void>((r) => { onRetry = r; });
    orch2.on('task-retry', () => onRetry());
    const t = makeTask();
    repos.tasks.insert(t);
    await orch2.start(t.id); // 失败 -> 排程 40ms 后自动重试
    await retryScheduled;
    expect(repos.tasks.get(t.id)!.status).toBe('in_progress'); // 重试待定期间保持开发中
    await orch2.cancel(t.id); // 撤销该任务全部待执行重试
    expect(repos.tasks.get(t.id)!.status).toBe('ready');
    await new Promise((r) => setTimeout(r, 120)); // 超过原重试延迟
    expect(repos.executions.listByTask(t.id).length).toBe(1); // 无第二次执行
    expect(repos.tasks.get(t.id)!.status).toBe('ready');
    expect(repos.tasks.get(t.id)!.retryCount).toBe(0); // 重试未消费
  });

  it('explicit retry supersedes a pending auto-retry (no ghost run)', async () => {
    let calls = 0;
    const reg = new AgentRegistry();
    reg.register(new ControllableTestAdapter({
      script: () => {
        calls += 1;
        return calls === 1
          ? [{ type: 'error', message: 'first fails', recoverable: true, t: 0 }]
          : [{ type: 'done', summary: 'ok', t: 0 }];
      },
    }));
    reg.register(new AvailableFakeAdapter('codex'));
    const orch2 = new Orchestrator(repos, reg, {
      worktreesBaseDir: worktreeDir, maxConcurrent: 2, autoRetry: true,
      retryPolicy: { maxAttempts: 5, baseDelayMs: 60, maxDelayMs: 60, backoff: false },
    });
    let onRetry!: () => void;
    const retryScheduled = new Promise<void>((r) => { onRetry = r; });
    orch2.on('task-retry', () => onRetry());
    const t = makeTask();
    repos.tasks.insert(t);
    await orch2.start(t.id);
    await retryScheduled; // 60ms 自动重试已排程
    await orch2.retry(t.id); // 显式重试：撤销排程并立即运行到待验收
    expect(repos.tasks.get(t.id)!.status).toBe('in_review');
    await new Promise((r) => setTimeout(r, 150)); // 超过原排程延迟
    expect(calls).toBe(2); // 恰好两次运行：首次失败 + 显式重试，无幽灵重试
  });

  it('cancel on a non-running task does not brick it (no permanent fake run)', async () => {
    const t = makeTask();
    repos.tasks.insert(t);
    await orch.cancel(t.id); // 无活跃运行：幂等，不写假 run
    expect(repos.tasks.get(t.id)!.status).toBe('ready');
    await orch.start(t.id); // 仍可正常启动（回归：假 run 导致永远“任务已在运行”）
    expect(repos.tasks.get(t.id)!.status).toBe('in_review');
  });

  it('rapid repeated resolve/cancel stay consistent', async () => {
    const t = makeTask({ status: 'in_progress' });
    repos.tasks.insert(t);
    await orch.pause(t.id, 'hold'); // 无活跃运行的纯状态暂停
    const inter = repos.pendingInteractions.getPendingForTask(t.id)!;
    await orch.resolveInteraction(t.id, inter.id, 'go');
    expect(repos.tasks.get(t.id)!.status).toBe('in_review');
    // 重复 resolve：交互已消费且任务已离待沟通 -> 拒绝但不破坏状态
    await expect(orch.resolveInteraction(t.id, inter.id, 'again')).rejects.toThrow();
    expect(repos.tasks.get(t.id)!.status).toBe('in_review');
    await orch.cancel(t.id); // in_review -> ready
    await orch.cancel(t.id); // 重复取消幂等
    expect(repos.tasks.get(t.id)!.status).toBe('ready');
  });
});

describe('orchestrator pause/cancel during review (testing lane)', () => {
  beforeEach(() => setup(() => [{ type: 'done', summary: 'dev ok', t: 0 }]));

  function reviewOrch(autoRetry = false) {
    const reg = new AgentRegistry();
    reg.register(new ControllableTestAdapter({ script: () => [{ type: 'done', summary: 'dev ok', t: 0 }] }));
    reg.register(new SlowReviewAdapter('codex'));
    return new Orchestrator(repos, reg, {
      worktreesBaseDir: worktreeDir, maxConcurrent: 2, autoRetry,
      retryPolicy: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 20, backoff: false },
    });
  }

  async function waitStatus(taskId: string, status: string) {
    for (let i = 0; i < 200 && repos.tasks.get(taskId)!.status !== status; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }

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
    // 审查执行记录标记 paused，且没有误判的审查结论
    const reviewExec = repos.executions.listByTask(t.id).find((e) => e.agentType === 'codex');
    expect(reviewExec?.status).toBe('paused');
    const msgs = repos.taskMessages.listByTask(t.id).map((m) => m.text ?? '');
    expect(msgs.some((m) => m.includes('审查结论'))).toBe(false);
    // 回复 -> 回到测试中重跑审查（不重复开发阶段）-> 通过 -> 待验收
    const inter = repos.pendingInteractions.getPendingForTask(t.id)!;
    await orch2.resolveInteraction(t.id, inter.id, '继续审查');
    expect(repos.tasks.get(t.id)!.status).toBe('in_review');
    // 开发 Agent 只运行过一次（未重复开发），审查运行两次（首次 paused + 恢复后 succeeded）
    const devExecs = repos.executions.listByTask(t.id).filter((e) => e.agentType === 'test');
    expect(devExecs.length).toBe(1);
    const reviewExecs = repos.executions.listByTask(t.id).filter((e) => e.agentType === 'codex');
    expect(reviewExecs.length).toBe(2);
    expect(reviewExecs.some((e) => (e.summary ?? '').includes('review:pass'))).toBe(true);
  });

  it('cancel during review stops the reviewer and lands stably in ready (no fail verdict, no retry)', async () => {
    const orch2 = reviewOrch(true); // autoRetry 开启：证明取消不按失败重试
    const t = makeTask();
    repos.tasks.insert(t);
    const p = orch2.start(t.id);
    await waitStatus(t.id, 'testing');
    await orch2.cancel(t.id);
    await p;
    expect(repos.tasks.get(t.id)!.status).toBe('ready');
    const reviewExec = repos.executions.listByTask(t.id).find((e) => e.agentType === 'codex');
    expect(reviewExec?.status).toBe('canceled');
    const msgs = repos.taskMessages.listByTask(t.id).map((m) => m.text ?? '');
    expect(msgs.some((m) => m.includes('审查不通过'))).toBe(false);
    await new Promise((r) => setTimeout(r, 120));
    expect(repos.tasks.get(t.id)!.status).toBe('ready'); // 无自动重启
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
    expect(repos.executions.listByTask(t.id).length).toBe(execCount); // 未创建新运行
    expect(repos.pendingInteractions.get(inter.id)!.status).toBe('answered');
  });

  it('resume failure rolls back to awaiting_input (no half-done state), later resume succeeds', async () => {
    const reg = new AgentRegistry(); // 空注册表：恢复预检必失败（无可用桥接器）
    const orch2 = new Orchestrator(repos, reg, { worktreesBaseDir: worktreeDir, maxConcurrent: 2, autoRetry: false });
    const t = makeTask({ status: 'in_progress', agentType: undefined });
    repos.tasks.insert(t);
    await orch2.pause(t.id, 'hold');
    const inter = repos.pendingInteractions.getPendingForTask(t.id)!;
    await expect(orch2.resolveInteraction(t.id, inter.id, 'go')).rejects.toThrow(/没有可用的 Agent 桥接器/);
    expect(repos.tasks.get(t.id)!.status).toBe('awaiting_input'); // 回滚，不留半完成
    expect(repos.executions.listByTask(t.id).length).toBe(0); // 未创建半完成运行
    // 修复环境后再次恢复成功（交互已消费，但 resume 兼容无 pending 交互）
    reg.register(new ControllableTestAdapter({ script: () => [{ type: 'done', summary: 'ok', t: 0 }] }));
    reg.register(new AvailableFakeAdapter('codex'));
    await orch2.resume(t.id, 'go again');
    expect(repos.tasks.get(t.id)!.status).toBe('in_review');
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
