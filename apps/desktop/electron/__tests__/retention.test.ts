import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRepositories, openDatabase, type DatabaseSync, type Repositories } from '@ai-devflow/persistence';
import { DEFAULT_RETENTION_POLICY } from '@ai-devflow/core';
import { RetentionService } from '../retention.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 29, 12);

let db: DatabaseSync;
let repos: Repositories;

beforeEach(() => {
  db = openDatabase(':memory:');
  repos = createRepositories(db);
  repos.projects.insert({ id: 'p', name: 'P', path: '/tmp/p', defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
  repos.iterations.insert({ id: 'i', projectId: 'p', name: 'I', version: 'v1', status: 'active', createdAt: 1 });
  repos.requirements.insert({ id: 'r', iterationId: 'i', title: 'R', description: '', priority: 'medium', acceptance: '', createdAt: 1, archived: false });
});

afterEach(() => db.close());

function task(id: string, status: 'ready' | 'awaiting_input' | 'archived', at = NOW) {
  repos.tasks.insert({
    id, requirementId: 'r', iterationId: 'i', projectId: 'p', title: id, description: '', status,
    role: 'coder', stages: [], currentStage: 0, statusChangedAt: at, createdAt: 1, updatedAt: at,
    retryCount: 0,
  });
  if (status === 'archived') repos.tasks.updateStatus(id, 'archived', at);
}

describe('RetentionService', () => {
  it('cleans old terminal details and archived conversations while protecting active data', async () => {
    task('terminal-task', 'ready');
    task('paused-task', 'awaiting_input');
    task('archived-task', 'archived', NOW - 181 * DAY);
    task('active-task', 'ready');

    repos.executions.insert({
      id: 'terminal-exec', taskId: 'terminal-task', attempt: 1,
      startedAt: NOW - 92 * DAY, endedAt: NOW - 91 * DAY, status: 'succeeded',
    });
    repos.executions.insert({
      id: 'paused-exec', taskId: 'paused-task', attempt: 1,
      startedAt: NOW - 200 * DAY, status: 'paused',
    });
    repos.logs.insert({ id: 'old-log', taskId: 'terminal-task', executionId: 'terminal-exec', level: 'info', text: 'old', t: NOW - 91 * DAY });
    repos.logs.insert({ id: 'paused-log', taskId: 'paused-task', executionId: 'paused-exec', level: 'info', text: 'keep', t: NOW - 190 * DAY });
    repos.executionAttempts.create({
      id: 'old-attempt', executionId: 'terminal-exec', ordinal: 1, routeId: 'p:dev', state: 'succeeded',
      mutationsObserved: true, journalJson: '{"detail":true}', startedAt: NOW - 92 * DAY, endedAt: NOW - 91 * DAY,
    });
    repos.executionAttempts.create({
      id: 'paused-attempt', executionId: 'paused-exec', ordinal: 1, routeId: 'p:dev', state: 'running',
      mutationsObserved: false, journalJson: '{"keep":true}', startedAt: NOW - 200 * DAY,
    });
    repos.taskMessages.insert({ id: 'archived-message', taskId: 'archived-task', role: 'assistant', kind: 'text', text: 'old', t: NOW - 200 * DAY });
    repos.taskMessages.insert({ id: 'active-message', taskId: 'active-task', role: 'assistant', kind: 'text', text: 'keep', t: NOW - 200 * DAY });

    const oldUsage = repos.providerUsage.start({
      logicalRequestId: 'old-request', providerId: 'provider-1', providerName: 'Provider One',
      routeId: 'provider-1:dev', model: 'm', workload: 'dev', source: 'task_agent',
      attemptOrdinal: 1, startedAt: NOW - 366 * DAY, projectId: 'p',
    });
    repos.providerUsage.finish(oldUsage.id, {
      status: 'succeeded', endedAt: NOW - 366 * DAY + 100,
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
    });

    const service = new RetentionService(db, repos, { now: () => NOW, batchSize: 1 });
    const result = await service.runIfDue(true);

    expect(result).toMatchObject({ skipped: false, logsDeleted: 1, attemptsDeleted: 1, messagesDeleted: 1, providerRowsRolledUp: 1 });
    expect(repos.logs.listByExecution('terminal-exec')).toEqual([]);
    expect(repos.logs.listByExecution('paused-exec')).toHaveLength(1);
    expect(repos.executionAttempts.listByExecution('terminal-exec')).toEqual([]);
    expect(repos.executionAttempts.listByExecution('paused-exec')).toHaveLength(1);
    expect(repos.taskMessages.listByTask('archived-task')).toEqual([]);
    expect(repos.taskMessages.listByTask('active-task')).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM provider_usage').get()).toMatchObject({ n: 0 });
    expect(repos.providerUsage.query({ startAt: 0, endAt: NOW }).summary).toMatchObject({ providerCalls: 1, tokens: { total: 15 } });

    await expect(service.runIfDue()).resolves.toMatchObject({ skipped: true });
  });

  it('persists validated policy and rejects unsafe short retention', () => {
    const service = new RetentionService(db, repos, { now: () => NOW });
    expect(service.getPolicy()).toEqual(DEFAULT_RETENTION_POLICY);
    expect(() => service.setPolicy({ executionDetailDays: 6, archivedConversationDays: 180, providerRawDays: 365 })).toThrow(/7/);
    const policy = { executionDetailDays: 30, archivedConversationDays: 60, providerRawDays: 90 };
    service.setPolicy(policy);
    expect(service.getPolicy()).toEqual(policy);
  });
});
