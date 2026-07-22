import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPiAiService,
  createProductionTextExecutor,
} from '../pi-ai.js';
import type {
  ChatWorkload,
  PiTextExecutor,
  ProductionExecutorDeps,
} from '../pi-ai.js';
import type { ProviderRoute } from '@ai-devflow/agents';

function makeFakeExecutor(scenario: { texts?: string[]; error?: Error }): PiTextExecutor {
  const outputs = [...(scenario.texts ?? [])];
  return async (_workload, _messages, onDelta) => {
    if (scenario.error) throw scenario.error;
    const text = outputs.shift() ?? '';
    onDelta?.(text);
    return text;
  };
}

describe('PiAiService', () => {
  it('streams task_chat deltas and returns full text', async () => {
    const service = createPiAiService(makeFakeExecutor({ texts: ['hello'] }));
    const deltas: string[] = [];
    const full = await service.chat([{ role: 'user', content: 'hi' }], (d) => deltas.push(d), { mode: 'task' });
    expect(full).toBe('hello');
    expect(deltas).toEqual(['hello']);
  });

  it('uses requirement_chat workload for requirement mode', async () => {
    const workloads: ChatWorkload[] = [];
    const service = createPiAiService(async (workload, _messages, onDelta) => {
      workloads.push(workload);
      onDelta?.('ok');
      return 'ok';
    });
    await service.chat([{ role: 'user', content: 'hi' }], () => {}, { mode: 'requirement' });
    expect(workloads).toEqual(['requirement_chat']);
  });

  it('retries an invalid proposal response on the same workload', async () => {
    const service = createPiAiService(makeFakeExecutor({ texts: ['not-json', '{"tasks":[]}'] }));
    const result = await service.propose([{ role: 'user', content: 'split' }]);
    expect(result).toEqual([]);
  });

  it('parses a structured requirement proposal', async () => {
    const service = createPiAiService(
      makeFakeExecutor({ texts: ['{"title":"T","description":"D","acceptance":"A","priority":"high"}'] }),
    );
    const req = await service.proposeRequirement([{ role: 'user', content: 'x' }]);
    expect(req).toEqual({ title: 'T', description: 'D', acceptance: 'A', priority: 'high' });
  });

  it('validates task proposal DAG', async () => {
    const service = createPiAiService(
      makeFakeExecutor({ texts: ['{"tasks":[{"draftId":"a","title":"A","description":"","role":"coder","dependsOn":["b"]},{"draftId":"b","title":"B","description":"","role":"coder","dependsOn":["a"]}]}'] }),
    );
    await expect(service.propose([{ role: 'user', content: 'x' }])).rejects.toThrow(/依赖/);
  });

  it('reports test connection failure when executor throws', async () => {
    const service = createPiAiService(makeFakeExecutor({ error: new Error('offline') }));
    const r = await service.testConnection('p1');
    expect(r.ok).toBe(false);
    expect(r.providerId).toBe('p1');
    expect(r.error).toMatch(/offline/);
  });

  it('redacts secret-shaped error messages in test connection failures (§8.2)', async () => {
    const secret = 'sk-ant-api03-1234567890abcdefgh';
    const service = createPiAiService(makeFakeExecutor({ error: new Error(`auth failed for key ${secret}`) }));
    const r = await service.testConnection('p1');
    expect(r.ok).toBe(false);
    expect(r.error).not.toContain(secret);
    expect(r.error).toContain('sk-***');
  });

  it('reports test connection success when executor returns', async () => {
    const service = createPiAiService(makeFakeExecutor({ texts: ['pong'] }));
    const r = await service.testConnection('p1');
    expect(r.ok).toBe(true);
    expect(r.providerId).toBe('p1');
  });

  it('restricts connection testing to the selected provider', async () => {
    const options: Array<{ onlyProviderId?: string } | undefined> = [];
    const service = createPiAiService(async (_workload, _messages, _onDelta, routeOptions) => {
      options.push(routeOptions);
      return 'pong';
    });
    await expect(service.testConnection('selected-provider')).resolves.toMatchObject({ ok: true });
    expect(options).toEqual([{ onlyProviderId: 'selected-provider' }]);
  });
});

const ROUTE: ProviderRoute = {
  providerId: 'p1',
  providerRevision: 3,
  providerKind: 'openai',
  providerName: 'openai',
  routeId: 'p1:task_chat:primary',
  model: 'gpt-5.6-luna',
  models: ['gpt-5.6-luna', 'gpt-5.4-mini'],
  thinking: 'medium',
  secret: 'route-secret',
};

function productionHarness(input: {
  stdout: string[];
  exitCode: number | null;
}) {
  const routerOptions: Array<{ onlyProviderId?: string } | undefined> = [];
  const router = {
    async execute<T>(
      _workload: string,
      operation: (route: ProviderRoute, ordinal: number) => Promise<T>,
      options?: { onlyProviderId?: string },
    ): Promise<T> {
      routerOptions.push(options);
      return operation(ROUTE, 1);
    },
  };
  const supervisor = {
    spawn() {
      return {
        lines: (async function* () {
          for (const text of input.stdout) yield { stream: 'stdout' as const, text };
        })(),
        cancel: async () => undefined,
        done: async () => ({ exitCode: input.exitCode, signal: null }),
      };
    },
  };
  const deps = {
    locator: { verify: async () => ({ version: '0.80.10', entry: '/verified/pi.js' }) },
    router,
    supervisor,
    sessionsBaseDir: mkdtempSync(join(tmpdir(), 'pi-ai-production-')),
    projectToolPath: '/usr/bin:/bin',
  } as unknown as ProductionExecutorDeps;
  return { executor: createProductionTextExecutor(deps), routerOptions };
}

describe('production Pi text executor', () => {
  it('commits buffered deltas only after exit 0 and agent_end', async () => {
    const harness = productionHarness({
      stdout: [
        JSON.stringify({ type: 'message_update', delta: 'hello' }),
        JSON.stringify({ type: 'agent_end', messages: [] }),
      ],
      exitCode: 0,
    });
    const deltas: string[] = [];
    await expect(harness.executor('task_chat', [{ role: 'user', content: 'hi' }], (d) => deltas.push(d)))
      .resolves.toBe('hello');
    expect(deltas).toEqual(['hello']);
  });

  it('classifies nonzero exit as runtime and discards partial deltas', async () => {
    const harness = productionHarness({
      stdout: [JSON.stringify({ type: 'message_update', delta: 'partial' })],
      exitCode: 7,
    });
    const deltas: string[] = [];
    await expect(harness.executor('task_chat', [{ role: 'user', content: 'hi' }], (d) => deltas.push(d)))
      .rejects.toMatchObject({ kind: 'runtime' });
    expect(deltas).toEqual([]);
  });

  it.each([
    {
      label: 'malformed stdout',
      stdout: ['not-json', JSON.stringify({ type: 'message_update', delta: 'partial' }), JSON.stringify({ type: 'agent_end' })],
    },
    {
      label: 'missing agent_end',
      stdout: [JSON.stringify({ type: 'message_update', delta: 'partial' })],
    },
  ])('classifies $label as protocol and discards partial deltas', async ({ stdout }) => {
    const harness = productionHarness({ stdout, exitCode: 0 });
    const deltas: string[] = [];
    await expect(harness.executor('task_chat', [{ role: 'user', content: 'hi' }], (d) => deltas.push(d)))
      .rejects.toMatchObject({ kind: 'protocol' });
    expect(deltas).toEqual([]);
  });

  it('classifies provider terminal errors for router failover', async () => {
    const harness = productionHarness({
      stdout: [JSON.stringify({ type: 'provider_error', status: 401, message: 'unauthorized' })],
      exitCode: 1,
    });
    await expect(harness.executor('task_chat', [{ role: 'user', content: 'hi' }]))
      .rejects.toMatchObject({ kind: 'authentication', status: 401 });
  });

  it('passes onlyProviderId through to ProviderRouter', async () => {
    const harness = productionHarness({
      stdout: [JSON.stringify({ type: 'message_update', delta: 'pong' }), JSON.stringify({ type: 'agent_end' })],
      exitCode: 0,
    });
    await harness.executor(
      'task_chat',
      [{ role: 'user', content: 'ping' }],
      undefined,
      { onlyProviderId: 'p1' },
    );
    expect(harness.routerOptions).toEqual([{ onlyProviderId: 'p1' }]);
  });
});
