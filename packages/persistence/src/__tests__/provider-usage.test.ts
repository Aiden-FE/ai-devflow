import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderCallSource, ProviderCallStatus, TokenUsage } from '@ai-devflow/core';
import { createRepositories, openDatabase, type DatabaseSync, type Repositories } from '../index.js';

let db: DatabaseSync;
let repos: Repositories;

beforeEach(() => {
  db = openDatabase(':memory:');
  repos = createRepositories(db);
});
afterEach(() => db.close());

const known = (total: number): TokenUsage => ({
  input: total - 20,
  output: 20,
  cacheRead: 0,
  cacheWrite: 0,
  total,
});
const unknown: TokenUsage = { input: null, output: null, cacheRead: null, cacheWrite: null, total: null };

function start(over: Partial<Parameters<Repositories['providerUsage']['start']>[0]> = {}) {
  return repos.providerUsage.start({
    logicalRequestId: 'request-1',
    providerId: 'provider-1',
    providerName: 'Provider One',
    routeId: 'provider-1:dev',
    model: 'model-a',
    workload: 'dev',
    source: 'task_agent',
    attemptOrdinal: 1,
    startedAt: 100,
    projectId: 'project-1',
    ...over,
  });
}

describe('ProviderUsageRepo', () => {
  it('starts, finishes, and recovers interrupted calls exactly once', () => {
    const first = start();
    repos.providerUsage.finish(first.id, { status: 'succeeded', endedAt: 180, usage: known(100) });
    expect(repos.providerUsage.query({ startAt: 0, endAt: 1000 }).summary).toMatchObject({
      providerCalls: 1,
      succeeded: 1,
      averageDurationMs: 80,
      tokens: { total: 100 },
      tokenCoverage: 1,
    });
    expect(() => repos.providerUsage.finish(first.id, { status: 'failed', endedAt: 200, usage: unknown })).toThrow(/已结束/);
    expect(() => repos.providerUsage.finish('missing', { status: 'failed', endedAt: 200, usage: unknown })).toThrow(/不存在|已结束/);

    start({ logicalRequestId: 'request-2', startedAt: 400 });
    expect(repos.providerUsage.recoverInterrupted(500)).toBe(1);
    expect(repos.providerUsage.query({ startAt: 0, endAt: 1000 }).summary).toMatchObject({
      providerCalls: 2,
      interrupted: 1,
    });
  });

  it('aggregates attempts, logical requests, token coverage, and filters', () => {
    const rows: Array<{
      logicalRequestId: string;
      providerId: string;
      providerName: string;
      model: string;
      projectId: string;
      source: ProviderCallSource;
      status: Exclude<ProviderCallStatus, 'running' | 'interrupted'>;
      total: number | null;
    }> = [
      { logicalRequestId: 'r1', providerId: 'p1', providerName: 'One', model: 'm1', projectId: 'a', source: 'task_agent', status: 'succeeded', total: 100 },
      { logicalRequestId: 'r1', providerId: 'p2', providerName: 'Two', model: 'm2', projectId: 'a', source: 'task_agent', status: 'failed', total: null },
      { logicalRequestId: 'r2', providerId: 'p1', providerName: 'One', model: 'm1', projectId: 'b', source: 'task_chat', status: 'succeeded', total: 120 },
      { logicalRequestId: 'r3', providerId: 'p2', providerName: 'Two', model: 'm2', projectId: 'b', source: 'requirement_chat', status: 'succeeded', total: 140 },
    ];
    rows.forEach((row, index) => {
      const record = start({
        ...row,
        routeId: `${row.providerId}:dev`,
        workload: row.source,
        attemptOrdinal: index + 1,
        startedAt: 100 + index * 100,
      });
      repos.providerUsage.finish(record.id, {
        status: row.status,
        endedAt: 150 + index * 100,
        failureKind: row.status === 'failed' ? 'rate_limit' : undefined,
        usage: row.total === null ? unknown : known(row.total),
      });
    });

    const all = repos.providerUsage.query({ startAt: 0, endAt: 1000 });
    expect(all.summary).toMatchObject({
      providerCalls: 4,
      logicalRequests: 3,
      succeeded: 3,
      failed: 1,
      tokens: { total: 360 },
      tokenKnownCalls: 3,
      tokenCoverage: 0.75,
    });
    expect(all.providers.map((provider) => provider.key)).toEqual(['p1', 'p2']);
    expect(repos.providerUsage.query({ startAt: 0, endAt: 1000, providerId: 'p1' }).summary).toMatchObject({
      providerCalls: 2,
      logicalRequests: 2,
    });
    expect(repos.providerUsage.query({ startAt: 0, endAt: 1000, projectId: 'a', status: 'failed' }).summary.providerCalls).toBe(1);
    expect(repos.providerUsage.query({ startAt: 0, endAt: 1000, model: 'm1', source: 'task_chat' }).summary.providerCalls).toBe(1);
  });

  it('aggregates a renamed provider into one row by stable id (raw + rolled up)', () => {
    const providerId = '776f5082-9779-4a15-8f3d-ac0b7068da9b';
    const rows = [
      // Oldest call stored under an internal UUID snapshot (name === provider id).
      { logicalRequestId: 'r1', providerName: providerId, startedAt: 100, total: 100 },
      // Later call stored under a friendly, non-internal snapshot.
      { logicalRequestId: 'r2', providerName: 'Friendly Gateway', startedAt: 200, total: 100 },
      // Same logical request (r1) retried, now under the friendly name.
      { logicalRequestId: 'r1', providerName: 'Friendly Gateway', startedAt: 300, total: 100 },
    ];
    rows.forEach((row, index) => {
      const record = start({
        logicalRequestId: row.logicalRequestId,
        providerId,
        providerName: row.providerName,
        routeId: `${providerId}:dev`,
        model: 'm1',
        workload: 'dev',
        source: 'task_agent',
        attemptOrdinal: index + 1,
        startedAt: row.startedAt,
        projectId: 'a',
      });
      repos.providerUsage.finish(record.id, {
        status: 'succeeded',
        endedAt: row.startedAt + 50,
        usage: known(row.total),
      });
    });

    // Roll the oldest (UUID-snapshot) row into provider_usage_daily; leave newer rows raw.
    expect(repos.providerUsage.rollupAndPrune(1000, 1)).toEqual({ rolledUp: 1, deleted: 1 });

    const result = repos.providerUsage.query({ startAt: 0, endAt: 100000 });
    expect(result.providers).toHaveLength(1);
    expect(result.providers[0]).toMatchObject({
      key: providerId,
      label: 'Friendly Gateway',
      providerCalls: 3,
      logicalRequests: 2,
    });
    expect(result.summary).toMatchObject({
      providerCalls: 3,
      logicalRequests: 2,
      succeeded: 3,
      tokens: { total: 300 },
      tokenKnownCalls: 3,
      tokenCoverage: 1,
    });
  });

  it('rolls up bounded batches without double-counting a split logical request', () => {
    for (const providerId of ['p1', 'p2']) {
      const record = start({
        logicalRequestId: 'shared',
        providerId,
        providerName: providerId.toUpperCase(),
        routeId: `${providerId}:dev`,
        startedAt: 100,
      });
      repos.providerUsage.finish(record.id, { status: 'succeeded', endedAt: 150, usage: known(50) });
    }

    expect(repos.providerUsage.rollupAndPrune(1000, 1)).toEqual({ rolledUp: 1, deleted: 1 });
    expect(repos.providerUsage.query({ startAt: 0, endAt: 2000 }).summary).toMatchObject({
      providerCalls: 2,
      logicalRequests: 1,
      tokens: { total: 100 },
    });
    expect(repos.providerUsage.rollupAndPrune(1000, 1)).toEqual({ rolledUp: 1, deleted: 1 });
    expect(repos.providerUsage.query({ startAt: 0, endAt: 2000 }).summary.logicalRequests).toBe(1);
    expect(repos.providerUsage.query({ startAt: 0, endAt: 2000, providerId: 'p1' }).summary.logicalRequests).toBe(1);
    expect(repos.providerUsage.query({ startAt: 0, endAt: 2000, providerId: 'p2' }).summary.logicalRequests).toBe(1);
    expect(repos.providerUsage.rollupAndPrune(1000, 1)).toEqual({ rolledUp: 0, deleted: 0 });
  });
});
