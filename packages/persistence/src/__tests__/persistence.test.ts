import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, createRepositories, tx, getCurrentVersion, type Repositories, type DatabaseSync } from '../index.js';
import { randomId } from '@ai-devflow/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let db: DatabaseSync;
let repos: Repositories;

function newMemory() {
  db = openDatabase(':memory:');
  repos = createRepositories(db);
}

beforeEach(() => newMemory());
afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
});

describe('migrations', () => {
  it('applies all migrations and records version', () => {
    const v = getCurrentVersion(db);
    expect(v).toBeGreaterThanOrEqual(2);
  });

  it('is idempotent on reopen (file db)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aidf-'));
    const path = join(dir, 'test.db');
    try {
      const d1 = openDatabase(path);
      const v1 = getCurrentVersion(d1);
      d1.close();
      const d2 = openDatabase(path);
      const v2 = getCurrentVersion(d2);
      expect(v2).toBe(v1);
      // schema_version table unique constraint not violated on re-run
      d2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('transactions', () => {
  it('commits on success', () => {
    tx(db, () => {
      repos.projects.insert({ id: 'p1', name: 'P', path: '/x', defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
    });
    expect(repos.projects.get('p1')).toBeDefined();
  });

  it('rolls back on error', () => {
    expect(() =>
      tx(db, () => {
        repos.projects.insert({ id: 'p2', name: 'P', path: '/x', defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(repos.projects.get('p2')).toBeUndefined();
  });

  it('supports nested savepoints', () => {
    tx(db, () => {
      repos.projects.insert({ id: 'p3', name: 'P', path: '/x', defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
      tx(db, () => {
        repos.projects.insert({ id: 'p4', name: 'P', path: '/x', defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
      });
    });
    expect(repos.projects.get('p3')).toBeDefined();
    expect(repos.projects.get('p4')).toBeDefined();
  });
});

describe('repositories CRUD', () => {
  it('projects insert/get/list/update/delete', () => {
    repos.projects.insert({ id: 'p', name: 'P', path: '/x', defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: { maxConcurrent: 4 } });
    expect(repos.projects.get('p')!.settings.maxConcurrent).toBe(4);
    expect(repos.projects.list().length).toBe(1);
    repos.projects.updateSettings('p', { maxConcurrent: 8 });
    expect(repos.projects.get('p')!.settings.maxConcurrent).toBe(8);
    repos.projects.delete('p');
    expect(repos.projects.get('p')).toBeUndefined();
  });

  it('cascades delete from project to task', () => {
    repos.projects.insert({ id: 'p', name: 'P', path: '/x', defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
    repos.iterations.insert({ id: 'i', projectId: 'p', name: 'I', version: 'v1', status: 'active', createdAt: 1 });
    repos.requirements.insert({ id: 'r', iterationId: 'i', title: 'R', description: '', priority: 'medium', acceptance: 'acc', createdAt: 1, archived: false });
    repos.tasks.insert(makeTask('t', 'r', 'i', 'p'));
    expect(repos.tasks.get('t')).toBeDefined();
    repos.projects.delete('p');
    expect(repos.tasks.get('t')).toBeUndefined();
    expect(repos.iterations.get('i')).toBeUndefined();
  });
});

function makeTask(id: string, reqId: string, iterId: string, projId: string) {
  return {
    id, requirementId: reqId, iterationId: iterId, projectId: projId,
    title: 'T', description: '', status: 'ready' as const, role: 'coder' as const,
    stages: [], currentStage: 0, statusChangedAt: 1, createdAt: 1, updatedAt: 1, retryCount: 0,
  };
}

describe('full lifecycle', () => {
  beforeEach(() => {
    repos.projects.insert({ id: 'p', name: 'P', path: '/x', defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
    repos.iterations.insert({ id: 'i', projectId: 'p', name: 'I', version: 'v1', status: 'active', createdAt: 1 });
    repos.requirements.insert({ id: 'r', iterationId: 'i', title: 'R', description: '', priority: 'high', acceptance: 'acc', createdAt: 1, archived: false });
  });

  it('advances ready -> ... -> archived with statusChangedAt updates', () => {
    repos.tasks.insert(makeTask('t', 'r', 'i', 'p'));
    const t0 = repos.tasks.get('t')!;
    expect(t0.status).toBe('ready');

    repos.tasks.updateStatus('t', 'in_progress', 150);
    expect(repos.tasks.get('t')!.status).toBe('in_progress');
    expect(repos.tasks.get('t')!.statusChangedAt).toBe(150);

    repos.tasks.updateStatus('t', 'in_review', 200);
    repos.tasks.updateStatus('t', 'archived', 400);
    const final = repos.tasks.get('t')!;
    expect(final.status).toBe('archived');
  });

  it('listRecoverable returns in_progress and awaiting_input', () => {
    repos.tasks.insert(makeTask('a', 'r', 'i', 'p'));
    repos.tasks.insert(makeTask('b', 'r', 'i', 'p'));
    repos.tasks.insert(makeTask('c', 'r', 'i', 'p'));
    repos.tasks.updateStatus('a', 'in_progress', 1);
    repos.tasks.updateStatus('b', 'awaiting_input', 1);
    repos.tasks.updateStatus('c', 'archived', 1);
    const ids = repos.tasks.listRecoverable().map((t) => t.id).sort();
    expect(ids).toEqual(['a', 'b']);
  });

  it('retry count increments', () => {
    repos.tasks.insert(makeTask('t', 'r', 'i', 'p'));
    repos.tasks.incRetry('t');
    repos.tasks.incRetry('t');
    expect(repos.tasks.get('t')!.retryCount).toBe(2);
  });

  it('pending question upsert/answer/delete survives across reads', () => {
    repos.tasks.insert(makeTask('t', 'r', 'i', 'p'));
    repos.tasks.updateStatus('t', 'awaiting_input', 1);
    repos.pendingQuestions.upsert({ taskId: 't', question: 'which lib?', context: 'ctx', askedAt: 1 });
    expect(repos.pendingQuestions.get('t')!.question).toBe('which lib?');
    repos.pendingQuestions.answer('t', 'use vitest', 2);
    const q = repos.pendingQuestions.get('t')!;
    expect(q.answer).toBe('use vitest');
    expect(q.answeredAt).toBe(2);
    repos.pendingQuestions.delete('t');
    expect(repos.pendingQuestions.get('t')).toBeUndefined();
  });

  it('execution records and logs persist and query', () => {
    repos.tasks.insert(makeTask('t', 'r', 'i', 'p'));
    const execId = randomId();
    repos.executions.insert({ id: execId, taskId: 't', attempt: 1, startedAt: 10, status: 'running' });
    repos.logs.insert({ id: randomId(), taskId: 't', executionId: execId, level: 'info', text: 'start', t: 11 });
    repos.logs.insert({ id: randomId(), taskId: 't', executionId: execId, level: 'error', text: 'boom', t: 12 });
    expect(repos.logs.listByTask('t').length).toBe(2);
    expect(repos.executions.getLatest('t')!.id).toBe(execId);
    repos.executions.update({ id: execId, taskId: 't', attempt: 1, startedAt: 10, endedAt: 20, status: 'failed', summary: 'boom' });
    expect(repos.executions.getLatest('t')!.status).toBe('failed');
  });

  it('listByTask returns the most recent N logs (not the oldest)', () => {
    repos.tasks.insert(makeTask('t', 'r', 'i', 'p'));
    const execId = randomId();
    repos.executions.insert({ id: execId, taskId: 't', attempt: 1, startedAt: 0, status: 'running' });
    // 插入 20 条日志，limit=5 应返回最近 5 条（t=16..20），而非最早 5 条（t=1..5）
    for (let i = 1; i <= 20; i++) {
      repos.logs.insert({ id: randomId(), taskId: 't', executionId: execId, level: 'info', text: `line${i}`, t: i });
    }
    const recent = repos.logs.listByTask('t', 5);
    expect(recent.length).toBe(5);
    expect(recent.map((l) => l.text)).toEqual(['line16', 'line17', 'line18', 'line19', 'line20']);
  });

  it('checkpoints upsert/getLatest', () => {
    repos.tasks.insert(makeTask('t', 'r', 'i', 'p'));
    repos.checkpoints.upsert({ id: randomId(), taskId: 't', stageId: 's1', stageIndex: 0, context: 'c1', createdAt: 1 });
    repos.checkpoints.upsert({ id: randomId(), taskId: 't', stageId: 's2', stageIndex: 1, context: 'c2', createdAt: 2 });
    expect(repos.checkpoints.getLatest('t')!.stageId).toBe('s2');
    expect(repos.checkpoints.listByTask('t').length).toBe(2);
  });
});

describe('notifications & webhooks repos', () => {
  it('notification rules list by project includes global', () => {
    repos.notificationRules.insert({ id: 'g', status: 'in_progress', minutes: 5, channels: ['desktop'], enabled: true });
    repos.notificationRules.insert({ id: 'p1', projectId: 'p', status: 'in_progress', minutes: 3, channels: ['webhook'], enabled: true });
    expect(repos.notificationRules.listByProject('p').length).toBe(2);
    expect(repos.notificationRules.listByProject('other').length).toBe(1);
  });

  it('delivery dedup exists check', () => {
    repos.notificationDeliveries.insert({ id: 'd1', ruleId: 'r', taskId: 't', channel: 'desktop', sentAt: 1, status: 'sent' });
    expect(repos.notificationDeliveries.exists('r', 't', 'desktop')).toBe(true);
    expect(repos.notificationDeliveries.exists('r', 't', 'webhook')).toBe(false);
  });

  it('webhook config stores secret (ciphertext) and deliveries', () => {
    repos.webhookConfigs.insert({ id: 'w', name: 'W', url: 'http://x', secret: 'enc-blob', events: ['task.stuck'], enabled: true, createdAt: 1 });
    expect(repos.webhookConfigs.get('w')!.secret).toBe('enc-blob');
    repos.webhookDeliveries.insert({ id: 'wd', webhookId: 'w', event: 'task.stuck', payload: '{}', status: 200, attempt: 1, sentAt: 1, durationMs: 5, ok: true });
    expect(repos.webhookDeliveries.listByWebhook('w').length).toBe(1);
  });

  it('credentials upsert/get/delete', () => {
    repos.credentials.upsert('k', 'enc1');
    expect(repos.credentials.get('k')).toBe('enc1');
    repos.credentials.upsert('k', 'enc2');
    expect(repos.credentials.get('k')).toBe('enc2');
    repos.credentials.delete('k');
    expect(repos.credentials.get('k')).toBeUndefined();
  });
});

describe('restart consistency', () => {
  it('data persists across reopen (file db)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aidf-'));
    const path = join(dir, 'test.db');
    try {
      let d = openDatabase(path);
      let r = createRepositories(d);
      r.projects.insert({ id: 'p', name: 'P', path: '/x', defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
      d.close();
      d = openDatabase(path);
      r = createRepositories(d);
      expect(r.projects.get('p')!.name).toBe('P');
      d.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('paused_from & requirement archive', () => {
  function setup() {
    repos.projects.insert({ id: 'p', name: 'P', path: '/x', defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
    repos.iterations.insert({ id: 'i', projectId: 'p', name: 'I', version: 'v1', status: 'active', createdAt: 1 });
    repos.requirements.insert({ id: 'r', iterationId: 'i', title: 'R', description: '', priority: 'medium', acceptance: 'a', createdAt: 1, archived: false });
    repos.tasks.insert({
      id: 't', requirementId: 'r', iterationId: 'i', projectId: 'p', title: 'T', description: '', status: 'in_progress',
      role: 'coder', stages: [], currentStage: 0, statusChangedAt: 1, createdAt: 1, updatedAt: 1, retryCount: 0,
    });
  }

  it('updateStatus records paused_from when entering awaiting_input and clears on leave', () => {
    setup();
    repos.tasks.updateStatus('t', 'awaiting_input', 10);
    const paused = repos.tasks.get('t')!;
    expect(paused.status).toBe('awaiting_input');
    expect(paused.pausedFrom).toBe('in_progress');
    // 恢复到 in_progress -> 清除 paused_from
    repos.tasks.updateStatus('t', 'in_progress', 20);
    expect(repos.tasks.get('t')!.pausedFrom).toBeUndefined();
  });

  it('listByRequirement returns only the requirement tasks', () => {
    setup();
    repos.tasks.insert({
      id: 't2', requirementId: 'r', iterationId: 'i', projectId: 'p', title: 'T2', description: '', status: 'ready',
      role: 'coder', stages: [], currentStage: 0, statusChangedAt: 1, createdAt: 2, updatedAt: 2, retryCount: 0,
    });
    expect(repos.tasks.listByRequirement('r').length).toBe(2);
  });

  it('requirement archive flag round-trips', () => {
    setup();
    expect(repos.requirements.get('r')!.archived).toBe(false);
    repos.requirements.archive('r', 99);
    const r = repos.requirements.get('r')!;
    expect(r.archived).toBe(true);
    expect(r.archivedAt).toBe(99);
  });

  it('task depends_on round-trips and updates', () => {
    setup();
    repos.tasks.insert({
      id: 'td', requirementId: 'r', iterationId: 'i', projectId: 'p', title: 'TD', description: '', status: 'ready',
      role: 'coder', stages: [], currentStage: 0, statusChangedAt: 1, createdAt: 1, updatedAt: 1, retryCount: 0,
      dependsOn: ['t', 't2'],
    });
    expect(repos.tasks.get('td')!.dependsOn).toEqual(['t', 't2']);
    // 未声明 dependsOn 的旧任务默认为空数组
    expect(repos.tasks.get('t')!.dependsOn).toEqual([]);
    // update 修改 dependsOn
    const td = repos.tasks.get('td')!;
    td.dependsOn = ['t'];
    repos.tasks.update(td);
    expect(repos.tasks.get('td')!.dependsOn).toEqual(['t']);
  });
});

describe('backlog removal migration (v6)', () => {
  it('migrates legacy backlog tasks / paused_from / notification rules to ready', () => {
    // 模拟历史库：先建库跑全部迁移，再把 schema_version 回退到 5，注入 backlog 数据，
    // 重开库触发 v6/v7 迁移（v6 把 backlog 迁为 ready）。
    const dir = mkdtempSync(join(tmpdir(), 'aidf-backlog-'));
    const path = join(dir, 'test.db');
    try {
      // 构造一个真实的 v5 库（v6 之前），含历史 backlog 数据；随后一次性升级到最新（v9）。
      let d = openDatabase(path, { maxVersion: 5 });
      let r = createRepositories(d);
      r.projects.insert({ id: 'p', name: 'P', path: '/x', defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
      r.iterations.insert({ id: 'i', projectId: 'p', name: 'I', version: 'v1', status: 'active', createdAt: 1 });
      r.requirements.insert({ id: 'r', iterationId: 'i', title: 'R', description: '', priority: 'medium', acceptance: 'a', createdAt: 1, archived: false });
      // 历史任务：backlog 状态 + paused_from=backlog
      d.prepare("INSERT INTO tasks(id,requirement_id,iteration_id,project_id,title,description,status,role,stages_json,current_stage,status_changed_at,created_at,updated_at,retry_count,paused_from,depends_on_json) VALUES('t','r','i','p','T','','backlog','coder','[]',0,1,1,1,0,'backlog','[]')").run();
      r.notificationRules.insert({ id: 'nb', status: 'backlog', minutes: 5, channels: ['desktop'], enabled: true });
      d.close();

      // 重开 -> v6（backlog 迁移）…v9 一次性生效
      d = openDatabase(path);
      r = createRepositories(d);
      const t = r.tasks.get('t')!;
      expect(t.status).toBe('ready');
      expect(t.pausedFrom).toBe('ready');
      const rules = r.notificationRules.list();
      expect(rules.every((x) => x.status !== 'backlog')).toBe(true);
      expect(rules.find((x) => x.id === 'nb')!.status).toBe('ready');
      d.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('new tasks default to ready (fresh schema)', () => {
    // 省略 status 插入应得到 ready（DEFAULT 'ready'）。
    const d = openDatabase(':memory:');
    const r = createRepositories(d);
    r.projects.insert({ id: 'p', name: 'P', path: '/x', defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
    r.iterations.insert({ id: 'i', projectId: 'p', name: 'I', version: 'v1', status: 'active', createdAt: 1 });
    r.requirements.insert({ id: 'r', iterationId: 'i', title: 'R', description: '', priority: 'medium', acceptance: 'a', createdAt: 1, archived: false });
    d.prepare("INSERT INTO tasks(id,requirement_id,iteration_id,project_id,title,description,role,stages_json,current_stage,status_changed_at,created_at,updated_at,retry_count,depends_on_json) VALUES('t','r','i','p','T','','coder','[]',0,1,1,1,0,'[]')").run();
    expect(r.tasks.get('t')!.status).toBe('ready');
    d.close();
  });
});

describe('task messages & pending interactions', () => {
  beforeEach(() => {
    repos.projects.insert({ id: 'p', name: 'P', path: '/x', defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
    repos.iterations.insert({ id: 'i', projectId: 'p', name: 'I', version: 'v1', status: 'active', createdAt: 1 });
    repos.requirements.insert({ id: 'r', iterationId: 'i', title: 'R', description: '', priority: 'medium', acceptance: 'a', createdAt: 1, archived: false });
    repos.tasks.insert(makeTask('t', 'r', 'i', 'p'));
  });

  it('task messages insert/list in time order', () => {
    repos.taskMessages.insert({ id: 'm1', taskId: 't', role: 'user', kind: 'text', text: 'hi', t: 1 });
    repos.taskMessages.insert({ id: 'm2', taskId: 't', role: 'assistant', kind: 'tool_call', toolName: 'Bash', toolUseId: 'tu1', toolInput: '{"cmd":"ls"}', t: 2 });
    repos.taskMessages.insert({ id: 'm3', taskId: 't', role: 'tool', kind: 'tool_result', toolUseId: 'tu1', toolResult: 'out', t: 3 });
    const list = repos.taskMessages.listByTask('t');
    expect(list.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(list[1]!.kind).toBe('tool_call');
    expect(list[2]!.isError).toBe(false);
  });

  it('pending interactions insert/getPending/resolve', () => {
    repos.pendingInteractions.insert({
      id: 'pi1', taskId: 't', kind: 'approval', title: 'Bash: rm -rf', toolName: 'Bash', toolUseId: 'tu1',
      requestId: 'req1', status: 'pending', createdAt: 1,
    });
    expect(repos.pendingInteractions.getPendingForTask('t')!.id).toBe('pi1');
    expect(repos.pendingInteractions.getPendingForTask('nope')).toBeUndefined();
    repos.pendingInteractions.resolve('pi1', 'denied', undefined, 2);
    expect(repos.pendingInteractions.get('pi1')!.status).toBe('denied');
    expect(repos.pendingInteractions.get('pi1')!.resolvedAt).toBe(2);
    // 已解决的不再算作 pending
    expect(repos.pendingInteractions.getPendingForTask('t')).toBeUndefined();
  });

  it('pending interactions listByTask ordered', () => {
    repos.pendingInteractions.insert({ id: 'a', taskId: 't', kind: 'clarification', title: 'q1', status: 'answered', response: 'x', createdAt: 1, resolvedAt: 2 });
    repos.pendingInteractions.insert({ id: 'b', taskId: 't', kind: 'confirmation', title: 'q2', status: 'pending', createdAt: 3 });
    const list = repos.pendingInteractions.listByTask('t');
    expect(list.map((x) => x.id)).toEqual(['a', 'b']);
  });
});

describe('tasks.insertMany (transactional batch) & migration v8', () => {
  beforeEach(() => {
    repos.projects.insert({ id: 'p', name: 'P', path: '/x', defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
    repos.iterations.insert({ id: 'i', projectId: 'p', name: 'I', version: 'v1', status: 'active', createdAt: 1 });
    repos.requirements.insert({ id: 'r', iterationId: 'i', title: 'R', description: '', priority: 'medium', acceptance: 'a', createdAt: 1, archived: false });
  });

  it('schema migrates to v8 (requirement index)', () => {
    expect(getCurrentVersion(db)).toBeGreaterThanOrEqual(8);
  });

  it('insertMany persists all tasks with their dependencies', () => {
    const a = makeTask('a', 'r', 'i', 'p');
    const b = { ...makeTask('b', 'r', 'i', 'p'), dependsOn: ['a'] };
    repos.tasks.insertMany([a, b]);
    expect(repos.tasks.listByRequirement('r').length).toBe(2);
    expect(repos.tasks.get('b')!.dependsOn).toEqual(['a']);
  });

  it('insertMany rolls back atomically on failure (no partial DAG)', () => {
    const a = makeTask('a', 'r', 'i', 'p');
    repos.tasks.insertMany([a]);
    // 第二个批次含重复主键 -> 整批回滚，不影响已有数据
    const dup = makeTask('a', 'r', 'i', 'p'); // 重复 id 'a'
    const c = makeTask('c', 'r', 'i', 'p');
    expect(() => repos.tasks.insertMany([c, dup])).toThrow();
    // 'c' 不应被落库（回滚）
    expect(repos.tasks.get('c')).toBeUndefined();
    expect(repos.tasks.listByRequirement('r').length).toBe(1);
  });

  it('supports the testing status value (backward compatible TEXT column)', () => {
    const t = { ...makeTask('t', 'r', 'i', 'p'), status: 'testing' as const };
    repos.tasks.insert(t);
    expect(repos.tasks.get('t')!.status).toBe('testing');
    // testing 属于可恢复运行态
    expect(repos.tasks.listRecoverable().some((x) => x.id === 't')).toBe(true);
  });
});
