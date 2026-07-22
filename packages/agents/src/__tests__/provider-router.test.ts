import { describe, expect, it } from 'vitest';
import type { ProviderConfig, ProviderHealth } from '@ai-devflow/core';
import { ProviderExecutionError, ProviderRouter, classifyProviderFailure } from '../provider-router.js';

function makeRouterHarness(ids: string[]) {
  const providers: ProviderConfig[] = ids.map((id, priority) => ({
    id, kind: 'openai' as const, displayName: id, enabled: true, priority,
    authType: 'api_key' as const, credentialRef: `provider:${id}`, revision: 1,
  }));
  const values = new Map<string, ProviderHealth>();
  const key = (providerId: string, routeId: string) => `${providerId}\0${routeId}`;
  const health = {
    get: (providerId: string, routeId: string) => values.get(key(providerId, routeId)),
    listByProvider: (providerId: string) => [...values.values()].filter((v) => v.providerId === providerId),
    upsert: (value: ProviderHealth) => {
      values.set(key(value.providerId, value.routeId), value);
    },
    clearProvider: (providerId: string) => {
      for (const [entryKey, value] of values) if (value.providerId === providerId) values.delete(entryKey);
    },
  };
  const sleeps: number[] = [];
  const router = new ProviderRouter({
    listProviders: () => providers,
    resolveSecret: () => 'secret',
    health,
    now: () => 1_000,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  });
  return { router, health, providers, sleeps };
}

describe('ProviderRouter', () => {
  it('supports an explicit test-only model route while preserving production ordering', () => {
    const harness = makeRouterHarness(['p1']);
    const router = new ProviderRouter({
      listProviders: () => harness.providers,
      resolveSecret: () => 'secret',
      health: harness.health,
      now: () => 1_000,
      sleep: async () => undefined,
      modelRouteFor: () => ({ primary: { model: 'integration-model', thinking: 'medium' } }),
    });
    expect(router.routesFor('planner')).toEqual([
      expect.objectContaining({ providerId: 'p1', model: 'integration-model', models: ['integration-model'] }),
    ]);
  });

  it('tries same-provider fallback before the next provider', async () => {
    const harness = makeRouterHarness(['p1', 'p2']);
    const visited: string[] = [];
    const value = await harness.router.execute('coder', async (route) => {
      visited.push(route.routeId);
      if (visited.length < 3) throw new ProviderExecutionError('model unavailable', 'model_unavailable', 404);
      return 'ok';
    });
    expect(value).toBe('ok');
    expect(visited).toEqual(['p1:coder:primary', 'p1:coder:fallback', 'p2:coder:primary']);
  });

  it('opens authentication failures provider-wide and skips same-provider fallback', async () => {
    const harness = makeRouterHarness(['p1', 'p2']);
    const visited: string[] = [];
    await harness.router.execute('tester', async (route) => {
      visited.push(route.routeId);
      if (route.providerId === 'p1') throw new ProviderExecutionError('unauthorized', 'authentication', 401);
      return 'ok';
    });
    expect(visited).toEqual(['p1:tester:primary', 'p2:tester:primary']);
    expect(harness.health.get('p1', 'p1:tester:primary')?.state).toBe('open');
    expect(harness.health.get('p1', 'p1:tester:fallback')?.state).toBe('open');
    // Authentication routes stay open without a cooldown expiry (until revision change).
    expect(harness.health.get('p1', 'p1:tester:primary')?.cooldownUntil).toBeUndefined();
  });

  it('never exceeds eight operation calls', async () => {
    const harness = makeRouterHarness(['p1', 'p2', 'p3', 'p4', 'p5']);
    let calls = 0;
    await expect(harness.router.execute('planner', async () => {
      calls += 1;
      throw new ProviderExecutionError('offline', 'transient_provider', 503);
    })).rejects.toThrow(/所有已配置 AI 服务/);
    expect(calls).toBeLessThanOrEqual(8);
  });

  it('does not fail over or open health for a task-result failure', async () => {
    const harness = makeRouterHarness(['p1', 'p2']);
    let calls = 0;
    await expect(harness.router.execute('reviewer', async () => {
      calls += 1;
      throw new ProviderExecutionError('review evidence invalid', 'task_result');
    })).rejects.toThrow(/review evidence invalid/);
    expect(calls).toBe(1);
    expect(harness.health.listByProvider('p1')).toEqual([]);
  });

  it('retries a transient route once before degrading', async () => {
    const harness = makeRouterHarness(['p1', 'p2']);
    const visited: string[] = [];
    const value = await harness.router.execute('tester', async (route) => {
      visited.push(route.routeId);
      if (route.providerId === 'p1') throw new ProviderExecutionError('flaky', 'transient_provider', 503);
      return 'done';
    });
    expect(value).toBe('done');
    // p1 primary attempted twice (original + one retry), then p1 fallback twice, then p2 primary succeeds.
    expect(visited).toEqual([
      'p1:tester:primary', 'p1:tester:primary',
      'p1:tester:fallback', 'p1:tester:fallback',
      'p2:tester:primary',
    ]);
  });

  it('records retryAfterMs cooldown and immediately falls back without sleeping', async () => {
    const harness = makeRouterHarness(['p1', 'p2']);
    await harness.router.execute('tester', async (route) => {
      if (route.providerId === 'p1') throw new ProviderExecutionError('slow down', 'rate_limit', 429, 5_000);
      return 'ok';
    });
    expect(harness.sleeps).toEqual([]);
    const h = harness.health.get('p1', 'p1:tester:primary');
    expect(h?.state).toBe('open');
    expect(h?.cooldownUntil).toBe(1_000 + 5_000);
  });

  it('resets health to closed on success', async () => {
    const harness = makeRouterHarness(['p1']);
    harness.health.upsert({
      providerId: 'p1', routeId: 'p1:coder:primary', state: 'open',
      consecutiveFailures: 3, cooldownUntil: 0, updatedAt: 0,
    });
    await harness.router.execute('coder', async () => 'ok');
    const h = harness.health.get('p1', 'p1:coder:primary');
    expect(h?.state).toBe('closed');
    expect(h?.consecutiveFailures).toBe(0);
  });

  it('atomically allows only one concurrent half-open probe per route', async () => {
    const harness = makeRouterHarness(['p1', 'p2']);
    harness.health.upsert({
      providerId: 'p1', routeId: 'p1:coder:primary', state: 'open',
      consecutiveFailures: 2, cooldownUntil: 900, updatedAt: 0,
    });
    harness.health.upsert({
      providerId: 'p1', routeId: 'p1:coder:fallback', state: 'open',
      consecutiveFailures: 1, updatedAt: 0,
    });
    let releaseProbe!: () => void;
    const holdProbe = new Promise<void>((resolve) => { releaseProbe = resolve; });
    let probeStarted!: () => void;
    const started = new Promise<void>((resolve) => { probeStarted = resolve; });
    const firstVisited: string[] = [];
    const first = harness.router.execute('coder', async (route) => {
      firstVisited.push(route.routeId);
      if (route.providerId === 'p1') {
        probeStarted();
        await holdProbe;
      }
      return 'first';
    });
    await started;
    expect(harness.health.get('p1', 'p1:coder:primary')?.state).toBe('half_open');

    const secondVisited: string[] = [];
    await expect(harness.router.execute('coder', async (route) => {
      secondVisited.push(route.routeId);
      return 'second';
    })).resolves.toBe('second');
    expect(secondVisited[0]).toBe('p2:coder:primary');

    releaseProbe();
    await expect(first).resolves.toBe('first');
    expect(firstVisited).toEqual(['p1:coder:primary']);
  });

  it('half-open probes only the earliest-expiring route when all are cooling down', async () => {
    const harness = makeRouterHarness(['p1', 'p2']);
    // now() === 1000; both routes cooling, p2 expires earlier.
    harness.health.upsert({ providerId: 'p1', routeId: 'p1:coder:primary', state: 'open', consecutiveFailures: 1, cooldownUntil: 9_000, updatedAt: 0 });
    harness.health.upsert({ providerId: 'p1', routeId: 'p1:coder:fallback', state: 'open', consecutiveFailures: 1, cooldownUntil: 9_000, updatedAt: 0 });
    harness.health.upsert({ providerId: 'p2', routeId: 'p2:coder:primary', state: 'open', consecutiveFailures: 1, cooldownUntil: 5_000, updatedAt: 0 });
    harness.health.upsert({ providerId: 'p2', routeId: 'p2:coder:fallback', state: 'open', consecutiveFailures: 1, cooldownUntil: 5_000, updatedAt: 0 });
    const routes = harness.router.routesFor('coder');
    expect(routes.map((r) => r.routeId)).toEqual(['p2:coder:primary']);
  });

  it('onlyProviderId never fails over to another provider', async () => {
    const harness = makeRouterHarness(['p1', 'p2']);
    const visited: string[] = [];
    await expect(harness.router.execute('coder', async (route) => {
      visited.push(route.routeId);
      throw new ProviderExecutionError('down', 'transient_provider', 503);
    }, { onlyProviderId: 'p1' })).rejects.toThrow(/所有已配置 AI 服务/);
    expect(visited.every((id) => id.startsWith('p1:'))).toBe(true);
  });

  it('maps chat workloads to tester models and proposal workloads to planner models', () => {
    const harness = makeRouterHarness(['p1']);
    const chat = harness.router.routesFor('task_chat');
    expect(chat[0]?.model).toBe('gpt-5.6-luna'); // openai tester primary
    const proposal = harness.router.routesFor('task_proposal');
    expect(proposal[0]?.model).toBe('gpt-5.6-terra'); // openai planner primary
  });
});

describe('classifyProviderFailure', () => {
  it('classifies by status and message', () => {
    expect(classifyProviderFailure({ status: 401, message: '' })).toBe('authentication');
    expect(classifyProviderFailure({ status: 429, message: '' })).toBe('rate_limit');
    expect(classifyProviderFailure({ status: 404, message: 'model not found' })).toBe('model_unavailable');
    expect(classifyProviderFailure({ status: 503, message: 'service unavailable' })).toBe('transient_provider');
    expect(classifyProviderFailure({ message: 'getaddrinfo ENOTFOUND api.example.com' })).toBe('transient_provider');
    expect(classifyProviderFailure({ message: 'unexpected token in JSON' })).toBe('protocol');
    expect(classifyProviderFailure({ message: 'spawn pi ENOENT', code: 'ENOENT' })).toBe('runtime');
  });
});
