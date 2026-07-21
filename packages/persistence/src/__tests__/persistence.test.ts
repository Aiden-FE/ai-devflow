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
    repos.projects.updateSettings('p', { maxConcurrent: 8, agentRoles: { coder: 'codex' } });
    expect(repos.projects.get('p')!.settings.maxConcurrent).toBe(8);
    expect(repos.projects.get('p')!.settings.agentRoles!.coder).toBe('codex');
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
    title: 'T', description: '', status: 'backlog' as const, role: 'coder' as const,
    stages: [], currentStage: 0, statusChangedAt: 1, createdAt: 1, updatedAt: 1, retryCount: 0,
  };
}

describe('full lifecycle', () => {
  beforeEach(() => {
    repos.projects.insert({ id: 'p', name: 'P', path: '/x', defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
    repos.iterations.insert({ id: 'i', projectId: 'p', name: 'I', version: 'v1', status: 'active', createdAt: 1 });
    repos.requirements.insert({ id: 'r', iterationId: 'i', title: 'R', description: '', priority: 'high', acceptance: 'acc', createdAt: 1, archived: false });
  });

  it('advances backlog -> ... -> archived with statusChangedAt updates', () => {
    repos.tasks.insert(makeTask('t', 'r', 'i', 'p'));
    const t0 = repos.tasks.get('t')!;
    expect(t0.status).toBe('backlog');

    repos.tasks.updateStatus('t', 'ready', 100);
    expect(repos.tasks.get('t')!.status).toBe('ready');
    expect(repos.tasks.get('t')!.statusChangedAt).toBe(100);

    repos.tasks.assignAgent('t', 'claude_code');
    expect(repos.tasks.get('t')!.agentType).toBe('claude_code');

    repos.tasks.updateStatus('t', 'in_progress', 200);
    repos.tasks.updateStatus('t', 'in_review', 300);
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
    repos.executions.insert({ id: execId, taskId: 't', attempt: 1, agentType: 'claude_code', startedAt: 10, status: 'running' });
    repos.logs.insert({ id: randomId(), taskId: 't', executionId: execId, level: 'info', text: 'start', t: 11 });
    repos.logs.insert({ id: randomId(), taskId: 't', executionId: execId, level: 'error', text: 'boom', t: 12 });
    expect(repos.logs.listByTask('t').length).toBe(2);
    expect(repos.executions.getLatest('t')!.id).toBe(execId);
    repos.executions.update({ id: execId, taskId: 't', attempt: 1, agentType: 'claude_code', startedAt: 10, endedAt: 20, status: 'failed', summary: 'boom' });
    expect(repos.executions.getLatest('t')!.status).toBe('failed');
  });

  it('listByTask returns the most recent N logs (not the oldest)', () => {
    repos.tasks.insert(makeTask('t', 'r', 'i', 'p'));
    const execId = randomId();
    repos.executions.insert({ id: execId, taskId: 't', attempt: 1, agentType: 'claude_code', startedAt: 0, status: 'running' });
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
      id: 't2', requirementId: 'r', iterationId: 'i', projectId: 'p', title: 'T2', description: '', status: 'backlog',
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
      id: 'td', requirementId: 'r', iterationId: 'i', projectId: 'p', title: 'TD', description: '', status: 'backlog',
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
