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
    expect(router.routesFor('dev')).toEqual([
      expect.objectContaining({ providerId: 'p1', model: 'integration-model', models: ['integration-model'] }),
    ]);
  });

  it('uses user-configured default model for all experts', () => {
    const harness = makeRouterHarness(['p1']);
    harness.providers[0]!.defaultModel = 'my-default';
    const routes = harness.router.routesFor('dev');
    expect(routes[0]?.model).toBe('my-default');
    expect(routes[0]?.models).toEqual(['my-default']);
  });

  it('uses workload-specific override when set', () => {
    const harness = makeRouterHarness(['p1']);
    harness.providers[0]!.defaultModel = 'my-default';
    harness.providers[0]!.workloadModels = { chat: 'chat-override' };
    const chat = harness.router.routesFor('chat');
    expect(chat[0]?.model).toBe('chat-override');
    const coder = harness.router.routesFor('dev');
    expect(coder[0]?.model).toBe('my-default');
  });

  it('applies per-expert default thinking levels for user-configured models', () => {
    const harness = makeRouterHarness(['p1']);
    harness.providers[0]!.defaultModel = 'my-default';
    expect(harness.router.routesFor('product')[0]?.thinking).toBe('high');
    expect(harness.router.routesFor('ux')[0]?.thinking).toBe('medium');
    expect(harness.router.routesFor('dev_lead')[0]?.thinking).toBe('high');
    expect(harness.router.routesFor('dev')[0]?.thinking).toBe('xhigh');
    expect(harness.router.routesFor('test')[0]?.thinking).toBe('medium');
    expect(harness.router.routesFor('chat')[0]?.thinking).toBe('medium');
  });

  it('skips provider when no model can be resolved for workload', () => {
    const harness = makeRouterHarness(['p1']);
    harness.providers[0]!.defaultModel = undefined;
    harness.providers[0]!.workloadModels = { chat: 'chat-only' };
    expect(harness.router.routesFor('dev')).toHaveLength(0);
    expect(harness.router.routesFor('chat')).toHaveLength(1);
  });

  it('tries the next provider after a model-unavailable failure', async () => {
    const harness = makeRouterHarness(['p1', 'p2', 'p3']);
    const visited: string[] = [];
    const value = await harness.router.execute('dev', async (route) => {
      visited.push(route.routeId);
      if (visited.length < 3) throw new ProviderExecutionError('model unavailable', 'model_unavailable', 404);
      return 'ok';
    });
    expect(value).toBe('ok');
    expect(visited).toEqual(['p1:dev', 'p2:dev', 'p3:dev']);
  });

  it('opens authentication failures provider-wide and skips to the next provider', async () => {
    const harness = makeRouterHarness(['p1', 'p2']);
    const visited: string[] = [];
    await harness.router.execute('test', async (route) => {
      visited.push(route.routeId);
      if (route.providerId === 'p1') throw new ProviderExecutionError('unauthorized', 'authentication', 401);
      return 'ok';
    });
    expect(visited).toEqual(['p1:test', 'p2:test']);
    const authHealth = harness.health.listByProvider('p1')
      .filter((entry) => entry.lastFailureKind === 'authentication');
    expect(authHealth).toHaveLength(1);
    expect(authHealth[0]).toMatchObject({ state: 'open', cooldownUntil: undefined });
    // The same provider is quarantined for every expert until its revision changes.
    expect(harness.router.routesFor('dev').map((route) => route.providerId)).not.toContain('p1');
  });

  it('keeps model-unavailable health route-local across workloads', async () => {
    const harness = makeRouterHarness(['p1', 'p2']);
    await harness.router.execute('dev', async (route) => {
      if (route.providerId === 'p1') throw new ProviderExecutionError('model unavailable', 'model_unavailable', 404);
      return 'ok';
    });

    expect(harness.router.routesFor('test').map((route) => route.providerId)).toContain('p1');
  });

  it('never exceeds eight operation calls', async () => {
    const harness = makeRouterHarness(['p1', 'p2', 'p3', 'p4', 'p5']);
    let calls = 0;
    await expect(harness.router.execute('dev', async () => {
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
      await harness.router.execute('test', async () => {
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
      await harness.router.execute('test', async () => {
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
    await expect(harness.router.execute('test', async () => {
      calls += 1;
      throw new ProviderExecutionError('review evidence invalid', 'task_result');
    })).rejects.toThrow(/review evidence invalid/);
    expect(calls).toBe(1);
    expect(harness.health.listByProvider('p1')).toEqual([]);
  });

  it('retries a transient route once before degrading to the next provider', async () => {
    const harness = makeRouterHarness(['p1', 'p2']);
    const visited: string[] = [];
    const value = await harness.router.execute('test', async (route) => {
      visited.push(route.routeId);
      if (route.providerId === 'p1') throw new ProviderExecutionError('flaky', 'transient_provider', 503);
      return 'done';
    });
    expect(value).toBe('done');
    // p1 attempted twice (original + one retry), then p2 succeeds.
    expect(visited).toEqual(['p1:test', 'p1:test', 'p2:test']);
  });

  it('records retryAfterMs cooldown and immediately falls back without sleeping', async () => {
    const harness = makeRouterHarness(['p1', 'p2']);
    await harness.router.execute('test', async (route) => {
      if (route.providerId === 'p1') throw new ProviderExecutionError('slow down', 'rate_limit', 429, 5_000);
      return 'ok';
    });
    expect(harness.sleeps).toEqual([]);
    const h = harness.health.get('p1', 'p1:test');
    expect(h?.state).toBe('open');
    expect(h?.cooldownUntil).toBe(1_000 + 5_000);
  });

  it('resets health to closed on success', async () => {
    const harness = makeRouterHarness(['p1']);
    harness.health.upsert({
      providerId: 'p1', routeId: 'p1:dev', state: 'open',
      consecutiveFailures: 3, cooldownUntil: 0, updatedAt: 0,
    });
    await harness.router.execute('dev', async () => 'ok');
    const h = harness.health.get('p1', 'p1:dev');
    expect(h?.state).toBe('closed');
    expect(h?.consecutiveFailures).toBe(0);
  });

  it('atomically allows only one concurrent half-open probe per route', async () => {
    const harness = makeRouterHarness(['p1', 'p2']);
    harness.health.upsert({
      providerId: 'p1', routeId: 'p1:dev', state: 'open',
      consecutiveFailures: 2, cooldownUntil: 900, updatedAt: 0,
    });
    let releaseProbe!: () => void;
    const holdProbe = new Promise<void>((resolve) => { releaseProbe = resolve; });
    let probeStarted!: () => void;
    const started = new Promise<void>((resolve) => { probeStarted = resolve; });
    const firstVisited: string[] = [];
    const first = harness.router.execute('dev', async (route) => {
      firstVisited.push(route.routeId);
      if (route.providerId === 'p1') {
        probeStarted();
        await holdProbe;
      }
      return 'first';
    });
    await started;
    expect(harness.health.get('p1', 'p1:dev')?.state).toBe('half_open');

    const secondVisited: string[] = [];
    await expect(harness.router.execute('dev', async (route) => {
      secondVisited.push(route.routeId);
      return 'second';
    })).resolves.toBe('second');
    expect(secondVisited[0]).toBe('p2:dev');

    releaseProbe();
    await expect(first).resolves.toBe('first');
    expect(firstVisited).toEqual(['p1:dev']);
  });

  it.each(['interaction', 'task_result'] as const)('releases a half-open probe after a %s error', async (kind) => {
    const harness = makeRouterHarness(['p1']);
    const priorHealth: ProviderHealth = {
      providerId: 'p1', routeId: 'p1:dev', state: 'open',
      consecutiveFailures: 2, cooldownUntil: 900, lastFailureKind: 'transient_provider', updatedAt: 0,
    };
    harness.health.upsert(priorHealth);

    await expect(harness.router.execute('dev', async () => {
      throw new ProviderExecutionError('execution stopped', kind);
    })).rejects.toThrow(/stopped/);

    expect(harness.health.get('p1', 'p1:dev')).toEqual(priorHealth);
    await expect(harness.router.execute('dev', async () => 'available')).resolves.toBe('available');
  });

  it('half-open probes only the earliest-expiring route when all are cooling down', async () => {
    const harness = makeRouterHarness(['p1', 'p2']);
    // now() === 1000; both routes cooling, p2 expires earlier.
    harness.health.upsert({ providerId: 'p1', routeId: 'p1:dev', state: 'open', consecutiveFailures: 1, cooldownUntil: 9_000, updatedAt: 0 });
    harness.health.upsert({ providerId: 'p2', routeId: 'p2:dev', state: 'open', consecutiveFailures: 1, cooldownUntil: 5_000, updatedAt: 0 });
    const routes = harness.router.routesFor('dev');
    expect(routes.map((r) => r.routeId)).toEqual(['p2:dev']);
  });

  it('onlyProviderId never fails over to another provider', async () => {
    const harness = makeRouterHarness(['p1', 'p2']);
    const visited: string[] = [];
    await expect(harness.router.execute('dev', async (route) => {
      visited.push(route.routeId);
      throw new ProviderExecutionError('down', 'transient_provider', 503);
    }, { onlyProviderId: 'p1' })).rejects.toThrow(/所有已配置 AI 服务/);
    expect(visited.every((id) => id.startsWith('p1:'))).toBe(true);
  });
});

describe('ProviderRouter empty-routes diagnosis', () => {
  function harnessWith(providers: Partial<ProviderConfig>[]) {
    const full: ProviderConfig[] = providers.map((p, i) => ({
      id: p.id ?? `p${i + 1}`,
      kind: 'openai' as const,
      displayName: p.id ?? `p${i + 1}`,
      enabled: p.enabled ?? true,
      priority: i,
      authType: 'api_key' as const,
      credentialRef: `provider:${p.id ?? `p${i + 1}`}`,
      revision: 1,
      defaultModel: p.defaultModel,
      workloadModels: p.workloadModels,
    }));
    const values = new Map<string, ProviderHealth>();
    const key = (providerId: string, routeId: string) => `${providerId}\0${routeId}`;
    const health = {
      get: (providerId: string, routeId: string) => values.get(key(providerId, routeId)),
      listByProvider: (providerId: string) => [...values.values()].filter((v) => v.providerId === providerId),
      upsert: (value: ProviderHealth) => values.set(key(value.providerId, value.routeId), value),
      clearProvider: (providerId: string) => {
        for (const [k, v] of values) if (v.providerId === providerId) values.delete(k);
      },
    };
    const secrets = new Map<string, string | undefined>();
    const router = new ProviderRouter({
      listProviders: () => full,
      resolveSecret: (id) => secrets.get(id),
      health,
      now: () => 1_000,
      sleep: async () => undefined,
    });
    return { router, health, providers: full, secrets };
  }

  it('reports actionable error when no provider has a model for the expert', async () => {
    const h = harnessWith([
      { defaultModel: undefined, workloadModels: { dev: 'dev-model' } },
    ]);
    h.secrets.set('p1', 'secret');
    await expect(h.router.execute('project_lead', async () => 'x')).rejects.toThrow(
      /未为知识治理\(project_lead\)专家配置模型/,
    );
  });

  it('reports missing credential when all enabled providers lack secrets', async () => {
    const h = harnessWith([{ defaultModel: 'm' }, { defaultModel: 'm' }]);
    // 不为任何 provider 设置 secret -> resolveSecret 返回 undefined。
    await expect(h.router.execute('dev', async () => 'x')).rejects.toThrow(/缺少 API Key/);
  });

  it('reports no enabled provider when all are disabled', async () => {
    const h = harnessWith([{ enabled: false, defaultModel: 'm' }]);
    h.secrets.set('p1', 'secret');
    await expect(h.router.execute('dev', async () => 'x')).rejects.toThrow(/尚未配置或启用任何 AI 服务商/);
  });

  it('keeps generic unavailable message when authentication-open excludes the provider', async () => {
    const h = harnessWith([{ defaultModel: 'm' }]);
    h.secrets.set('p1', 'secret');
    h.health.upsert({
      providerId: 'p1',
      routeId: 'provider:authentication',
      state: 'open',
      consecutiveFailures: 1,
      cooldownUntil: undefined,
      lastFailureKind: 'authentication',
      updatedAt: 0,
    });
    await expect(h.router.execute('dev', async () => 'x')).rejects.toThrow(/所有已配置 AI 服务暂时不可用/);
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

function overrideHarness(providers: ProviderConfig[], opts: { secret?: (id: string) => string | undefined; agentOverrideFor?: (e: string) => { providerId: string; model: string } | undefined }) {
  const health = new Map<string, { state: 'closed' | 'open' | 'half_open'; cooldownUntil?: number; lastFailureKind?: string }>();
  const router = new ProviderRouter({
    listProviders: () => providers,
    resolveSecret: opts.secret ?? ((id) => `secret-${id}`),
    health: {
      get: (pid: string, rid: string) => health.get(`${pid}:${rid}`) as any,
      listByProvider: (pid: string) => [...health.entries()].filter(([k]) => k.startsWith(pid + ':')).map(([, v]) => ({ providerId: pid, routeId: '', consecutiveFailures: 0, updatedAt: 0, ...v }) as any),
      upsert: (v: any) => { health.set(`${v.providerId}:${v.routeId}`, { state: v.state, cooldownUntil: v.cooldownUntil, lastFailureKind: v.lastFailureKind }); },
      clearProvider: (pid: string) => { for (const k of [...health.keys()]) if (k.startsWith(pid + ':')) health.delete(k); },
    },
    now: () => 1000,
    sleep: async () => {},
    agentOverrideFor: opts.agentOverrideFor,
  });
  return { router };
}

describe('ProviderRouter agent override', () => {
  const p1: ProviderConfig = { id: 'p1', kind: 'openai', displayName: 'P1', enabled: true, priority: 0, authType: 'api_key', credentialRef: 'provider:p1', defaultModel: 'gpt-4o', revision: 1 };
  const p2: ProviderConfig = { id: 'p2', kind: 'anthropic', displayName: 'P2', enabled: true, priority: 1, authType: 'api_key', credentialRef: 'provider:p2', defaultModel: 'claude-3-5-sonnet', revision: 1 };

  it('覆盖存在时优先返回该 provider 并强制 model', () => {
    const { router } = overrideHarness([p1, p2], { agentOverrideFor: () => ({ providerId: 'p2', model: 'claude-opus' }) });
    const routes = router.routesFor('product');
    expect(routes[0]!.providerId).toBe('p2');
    expect(routes[0]!.model).toBe('claude-opus');
  });

  it('覆盖 provider 被禁用时回退到默认有序路由', () => {
    const p2Disabled = { ...p2, enabled: false };
    const { router } = overrideHarness([p1, p2Disabled], { agentOverrideFor: () => ({ providerId: 'p2', model: 'claude-opus' }) });
    const routes = router.routesFor('product');
    expect(routes.map((r) => r.providerId)).toEqual(['p1']);
    expect(routes[0]!.model).toBe('gpt-4o');
  });

  it('覆盖 provider 无凭证时回退到默认路由', () => {
    const { router } = overrideHarness([p1, p2], { secret: (id) => (id === 'p2' ? undefined : `secret-${id}`), agentOverrideFor: () => ({ providerId: 'p2', model: 'claude-opus' }) });
    const routes = router.routesFor('product');
    expect(routes.map((r) => r.providerId)).toEqual(['p1']);
  });

  it('无覆盖时走默认 workloadModels/defaultModel', () => {
    const { router } = overrideHarness([p1, p2], {});
    const routes = router.routesFor('dev');
    expect(routes.map((r) => r.providerId)).toEqual(['p1', 'p2']);
  });

  it('专用路线优先且保留去重后的默认路线，并隔离健康标识', () => {
    const { router } = overrideHarness([p1, p2], {
      agentOverrideFor: () => ({ providerId: 'p1', model: 'gpt-special' }),
    });

    const routes = router.routesFor('project_lead');
    expect(routes.map((route) => [route.providerId, route.model])).toEqual([
      ['p1', 'gpt-special'],
      ['p1', 'gpt-4o'],
      ['p2', 'claude-3-5-sonnet'],
    ]);
    expect(routes[0]!.routeId).not.toBe(routes[1]!.routeId);
  });

  it('专用模型与默认模型相同时仅执行一次', () => {
    const { router } = overrideHarness([p1, p2], {
      agentOverrideFor: () => ({ providerId: 'p1', model: 'gpt-4o' }),
    });

    expect(router.routesFor('project_lead').filter((route) => (
      route.providerId === 'p1' && route.model === 'gpt-4o'
    ))).toHaveLength(1);
  });

  it('专用模型运行失败后回退同供应商默认模型，且默认成功不清除专用模型熔断', async () => {
    const { router } = overrideHarness([p1, p2], {
      agentOverrideFor: () => ({ providerId: 'p1', model: 'gpt-special' }),
    });
    const visited: Array<[string, string]> = [];

    const result = await router.execute('project_lead', async (route) => {
      visited.push([route.providerId, route.model]);
      if (route.model === 'gpt-special') {
        throw new ProviderExecutionError('missing pinned model', 'model_unavailable', 404);
      }
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(visited).toEqual([
      ['p1', 'gpt-special'],
      ['p1', 'gpt-4o'],
    ]);
    expect(router.routesFor('project_lead').map((route) => route.model)).not.toContain('gpt-special');
  });

  it('专用路线鉴权失败后跳过同供应商默认模型', async () => {
    const { router } = overrideHarness([p1, p2], {
      agentOverrideFor: () => ({ providerId: 'p1', model: 'gpt-special' }),
    });
    const visited: string[] = [];

    const result = await router.execute('project_lead', async (route) => {
      visited.push(route.providerId);
      if (route.providerId === 'p1') {
        throw new ProviderExecutionError('unauthorized', 'authentication', 401);
      }
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(visited).toEqual(['p1', 'p2']);
  });

  it('onlyProviderId 可测试未被 chat 专用配置选中的供应商且不跨供应商', async () => {
    const { router } = overrideHarness([p1, p2], {
      agentOverrideFor: () => ({ providerId: 'p2', model: 'claude-opus' }),
    });
    const visited: string[] = [];

    const result = await router.execute('chat', async (route) => {
      visited.push(route.providerId);
      return 'ok';
    }, { onlyProviderId: 'p1' });

    expect(result).toBe('ok');
    expect(visited).toEqual(['p1']);
  });
});
