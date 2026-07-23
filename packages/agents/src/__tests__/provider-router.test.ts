import { describe, expect, it } from 'vitest';
import type { ProviderConfig, ProviderHealth } from '@ai-devflow/core';
import { ProviderExecutionError, ProviderRouter, classifyProviderFailure } from '../provider-router.js';

function makeRouterHarness(ids: string[]) {
  const providers: ProviderConfig[] = ids.map((id, priority) => ({
    id, kind: 'openai' as const, displayName: id, enabled: true, priority,
    authType: 'api_key' as const, credentialRef: `provider:${id}`, revision: 1,
    defaultModel: 'gpt-default',
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

  it('uses user-configured default model for all workloads', () => {
    const harness = makeRouterHarness(['p1']);
    harness.providers[0]!.defaultModel = 'my-default';
    const routes = harness.router.routesFor('coder');
    expect(routes[0]?.model).toBe('my-default');
    expect(routes[0]?.models).toEqual(['my-default']);
  });

  it('uses workload-specific override when set', () => {
    const harness = makeRouterHarness(['p1']);
    harness.providers[0]!.defaultModel = 'my-default';
    harness.providers[0]!.workloadModels = { chat: 'chat-override' };
    const chat = harness.router.routesFor('task_chat');
    expect(chat[0]?.model).toBe('chat-override');
    const coder = harness.router.routesFor('coder');
    expect(coder[0]?.model).toBe('my-default');
  });

  it('applies per-role default thinking levels for user-configured models', () => {
    const harness = makeRouterHarness(['p1']);
    harness.providers[0]!.defaultModel = 'my-default';
    expect(harness.router.routesFor('planner')[0]?.thinking).toBe('high');
    expect(harness.router.routesFor('coder')[0]?.thinking).toBe('xhigh');
    expect(harness.router.routesFor('reviewer')[0]?.thinking).toBe('high');
    expect(harness.router.routesFor('tester')[0]?.thinking).toBe('medium');
    expect(harness.router.routesFor('task_chat')[0]?.thinking).toBe('medium');
    expect(harness.router.routesFor('requirement_chat')[0]?.thinking).toBe('medium');
    expect(harness.router.routesFor('task_proposal')[0]?.thinking).toBe('high');
    expect(harness.router.routesFor('requirement_proposal')[0]?.thinking).toBe('high');
  });

  it('skips provider when no model can be resolved for workload', () => {
    const harness = makeRouterHarness(['p1']);
    harness.providers[0]!.defaultModel = undefined;
    harness.providers[0]!.workloadModels = { chat: 'chat-only' };
    expect(harness.router.routesFor('coder')).toHaveLength(0);
    expect(harness.router.routesFor('task_chat')).toHaveLength(1);
  });

  it('tries the next provider after a model-unavailable failure', async () => {
    const harness = makeRouterHarness(['p1', 'p2', 'p3']);
    const visited: string[] = [];
    const value = await harness.router.execute('coder', async (route) => {
      visited.push(route.routeId);
      if (visited.length < 3) throw new ProviderExecutionError('model unavailable', 'model_unavailable', 404);
      return 'ok';
    });
    expect(value).toBe('ok');
    expect(visited).toEqual(['p1:coder', 'p2:coder', 'p3:coder']);
  });

  it('opens authentication failures provider-wide and skips to the next provider', async () => {
    const harness = makeRouterHarness(['p1', 'p2']);
    const visited: string[] = [];
    await harness.router.execute('tester', async (route) => {
      visited.push(route.routeId);
      if (route.providerId === 'p1') throw new ProviderExecutionError('unauthorized', 'authentication', 401);
      return 'ok';
    });
    expect(visited).toEqual(['p1:tester', 'p2:tester']);
    const authHealth = harness.health.listByProvider('p1')
      .filter((entry) => entry.lastFailureKind === 'authentication');
    expect(authHealth).toHaveLength(1);
    expect(authHealth[0]).toMatchObject({ state: 'open', cooldownUntil: undefined });
    // The same provider is quarantined for every workload until its revision changes.
    expect(harness.router.routesFor('coder').map((route) => route.providerId)).not.toContain('p1');
  });

  it('keeps model-unavailable health route-local across workloads', async () => {
    const harness = makeRouterHarness(['p1', 'p2']);
    await harness.router.execute('coder', async (route) => {
      if (route.providerId === 'p1') throw new ProviderExecutionError('model unavailable', 'model_unavailable', 404);
      return 'ok';
    });

    expect(harness.router.routesFor('tester').map((route) => route.providerId)).toContain('p1');
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

  it('preserves the last underlying error as detail on the final degradation', async () => {
    // 测试连接等场景需要从泛化「所有已配置 AI 服务暂时不可用」还原真实根因（如 401/404）。
    const harness = makeRouterHarness(['p1']);
    let caught: ProviderExecutionError | undefined;
    try {
      await harness.router.execute('tester', async () => {
        throw new ProviderExecutionError('AI 服务请求失败：401: invalid key', 'authentication', 401);
      });
    } catch (err) {
      caught = err as ProviderExecutionError;
    }
    expect(caught).toBeDefined();
    expect(caught!.detail).toBe('AI 服务请求失败：401: invalid key');
  });

  it('prefers the underlying error detail over its message when degrading', async () => {
    // executeTextOnRoute 把 stderr/原因放进 detail、message 保留为稳定标签；路由器应优先透传 detail，
    // 使测试连接能从泛化「所有已配置 AI 服务暂时不可用」还原到真实根因（而非稳定标签文案）。
    const harness = makeRouterHarness(['p1']);
    let caught: ProviderExecutionError | undefined;
    try {
      await harness.router.execute('tester', async () => {
        throw new ProviderExecutionError(
          'Pi 返回的终止协议无效',
          'protocol',
          0,
          undefined,
          '缺少 agent_end 终态事件；Pi stderr：model not found',
        );
      });
    } catch (err) {
      caught = err as ProviderExecutionError;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toBe('所有已配置 AI 服务暂时不可用，请稍后重试');
    expect(caught!.detail).toBe('缺少 agent_end 终态事件；Pi stderr：model not found');
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

  it('retries a transient route once before degrading to the next provider', async () => {
    const harness = makeRouterHarness(['p1', 'p2']);
    const visited: string[] = [];
    const value = await harness.router.execute('tester', async (route) => {
      visited.push(route.routeId);
      if (route.providerId === 'p1') throw new ProviderExecutionError('flaky', 'transient_provider', 503);
      return 'done';
    });
    expect(value).toBe('done');
    // p1 attempted twice (original + one retry), then p2 succeeds.
    expect(visited).toEqual(['p1:tester', 'p1:tester', 'p2:tester']);
  });

  it('records retryAfterMs cooldown and immediately falls back without sleeping', async () => {
    const harness = makeRouterHarness(['p1', 'p2']);
    await harness.router.execute('tester', async (route) => {
      if (route.providerId === 'p1') throw new ProviderExecutionError('slow down', 'rate_limit', 429, 5_000);
      return 'ok';
    });
    expect(harness.sleeps).toEqual([]);
    const h = harness.health.get('p1', 'p1:tester');
    expect(h?.state).toBe('open');
    expect(h?.cooldownUntil).toBe(1_000 + 5_000);
  });

  it('resets health to closed on success', async () => {
    const harness = makeRouterHarness(['p1']);
    harness.health.upsert({
      providerId: 'p1', routeId: 'p1:coder', state: 'open',
      consecutiveFailures: 3, cooldownUntil: 0, updatedAt: 0,
    });
    await harness.router.execute('coder', async () => 'ok');
    const h = harness.health.get('p1', 'p1:coder');
    expect(h?.state).toBe('closed');
    expect(h?.consecutiveFailures).toBe(0);
  });

  it('atomically allows only one concurrent half-open probe per route', async () => {
    const harness = makeRouterHarness(['p1', 'p2']);
    harness.health.upsert({
      providerId: 'p1', routeId: 'p1:coder', state: 'open',
      consecutiveFailures: 2, cooldownUntil: 900, updatedAt: 0,
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
    expect(harness.health.get('p1', 'p1:coder')?.state).toBe('half_open');

    const secondVisited: string[] = [];
    await expect(harness.router.execute('coder', async (route) => {
      secondVisited.push(route.routeId);
      return 'second';
    })).resolves.toBe('second');
    expect(secondVisited[0]).toBe('p2:coder');

    releaseProbe();
    await expect(first).resolves.toBe('first');
    expect(firstVisited).toEqual(['p1:coder']);
  });

  it('half-open probes only the earliest-expiring route when all are cooling down', async () => {
    const harness = makeRouterHarness(['p1', 'p2']);
    // now() === 1000; both routes cooling, p2 expires earlier.
    harness.health.upsert({ providerId: 'p1', routeId: 'p1:coder', state: 'open', consecutiveFailures: 1, cooldownUntil: 9_000, updatedAt: 0 });
    harness.health.upsert({ providerId: 'p2', routeId: 'p2:coder', state: 'open', consecutiveFailures: 1, cooldownUntil: 5_000, updatedAt: 0 });
    const routes = harness.router.routesFor('coder');
    expect(routes.map((r) => r.routeId)).toEqual(['p2:coder']);
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
