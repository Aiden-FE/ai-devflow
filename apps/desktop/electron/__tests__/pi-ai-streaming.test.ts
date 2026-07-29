import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProductionTextExecutor } from '../pi-ai.js';
import type { ProductionExecutorDeps } from '../pi-ai.js';
import type { ProviderRoute, ProviderUsageSink } from '@ai-devflow/agents';

const here = dirname(fileURLToPath(import.meta.url));
const ASSETS_ROOT = join(here, '..', '..', '..', '..', 'packages', 'agents', 'assets', 'profiles');

const ROUTE: ProviderRoute = {
  providerId: 'provider-1',
  providerRevision: 1,
  providerKind: 'anthropic',
  providerName: 'p',
  routeId: 'provider-1:chat',
  model: 'm',
  models: ['m'],
  thinking: 'off',
  secret: 's',
  baseURL: 'https://example.test',
} as unknown as ProviderRoute;

/** 与 ai.test.ts 的 productionHarness 同构：提供最小可用 ProductionExecutorDeps 桩。 */
function harness(stdout: string[], exitCode = 0) {
  const supervisor = {
    spawn() {
      return {
        lines: (async function* () {
          for (const text of stdout) yield { stream: 'stdout' as const, text };
        })(),
        cancel: async () => undefined,
        done: async () => ({ exitCode, signal: null }),
        send: () => false,
        onMessage: () => {},
      };
    },
  };
  const deps = {
    locator: { verify: async () => ({ version: '0.80.10', entry: '/verified/pi.js' }) },
    router: { execute: async (_w: unknown, op: (r: ProviderRoute) => Promise<string>) => op(ROUTE) },
    supervisor,
    sessionsBaseDir: mkdtempSync(join(tmpdir(), 'pi-ai-streaming-')),
    projectToolPath: '/usr/bin:/bin',
    assetsRoot: ASSETS_ROOT,
  } as unknown as ProductionExecutorDeps;
  return createProductionTextExecutor(deps);
}

const SUCCESS_EVENTS = [
  JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'ok' } }),
  JSON.stringify({
    type: 'message_end',
    message: {
      id: 'assistant-1', role: 'assistant', content: [{ type: 'text', text: 'ok' }],
      usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 17 },
    },
  }),
  JSON.stringify({
    type: 'agent_end',
    messages: [{
      id: 'assistant-1', role: 'assistant',
      usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 17 },
    }],
  }),
];

function controlledHarness(stdout: string[], block = false) {
  const spawnOptions: Array<{ timeoutMs: number }> = [];
  let releaseLines = () => {};
  let markSpawned = () => {};
  const released = new Promise<void>((resolve) => { releaseLines = resolve; });
  const spawned = new Promise<void>((resolve) => { markSpawned = resolve; });
  const cancel = vi.fn(async () => { releaseLines(); });
  let routeCalls = 0;
  const supervisor = {
    spawn(_plan: unknown, options: { timeoutMs: number }) {
      spawnOptions.push(options);
      markSpawned();
      return {
        lines: (async function* () {
          if (block) await released;
          for (const text of stdout) yield { stream: 'stdout' as const, text };
        })(),
        cancel,
        done: async () => {
          if (block) await released;
          return { exitCode: 0, signal: null };
        },
        send: () => false,
        onMessage: () => {},
      };
    },
  };
  const deps = {
    locator: { verify: async () => ({ version: '0.80.10', entry: '/verified/pi.js' }) },
    router: {
      execute: async (_w: unknown, op: (r: ProviderRoute) => Promise<string>) => {
        routeCalls += 1;
        return op(ROUTE);
      },
    },
    supervisor,
    sessionsBaseDir: mkdtempSync(join(tmpdir(), 'pi-ai-streaming-controlled-')),
    projectToolPath: '/usr/bin:/bin',
    assetsRoot: ASSETS_ROOT,
  } as unknown as ProductionExecutorDeps;
  return {
    executor: createProductionTextExecutor(deps),
    spawnOptions,
    spawned,
    release: releaseLines,
    cancel,
    get routeCalls() { return routeCalls; },
  };
}

describe('executeTextOnRoute streaming', () => {
  it('records chat usage with project attribution and deduplicated terminal usage', async () => {
    const starts: Parameters<ProviderUsageSink['start']>[0][] = [];
    const finishes: Array<Parameters<ProviderUsageSink['finish']>> = [];
    const usage: ProviderUsageSink = {
      start(value) { starts.push(value); return 'call-1'; },
      finish(id, value) { finishes.push([id, value]); },
    };
    const supervisor = {
      spawn: () => ({
        lines: (async function* () {
          for (const text of SUCCESS_EVENTS) yield { stream: 'stdout' as const, text };
        })(),
        cancel: async () => undefined,
        done: async () => ({ exitCode: 0, signal: null }),
        send: () => false,
        onMessage: () => undefined,
      }),
    };
    const deps = {
      locator: { verify: async () => ({ version: '0.80.10', entry: '/verified/pi.js' }) },
      router: { execute: async (_w: unknown, op: (r: ProviderRoute, ordinal: number) => Promise<string>) => op(ROUTE, 1) },
      supervisor,
      sessionsBaseDir: mkdtempSync(join(tmpdir(), 'pi-ai-usage-')),
      projectToolPath: '/usr/bin:/bin',
      assetsRoot: ASSETS_ROOT,
      usage,
    } as unknown as ProductionExecutorDeps;
    const executor = createProductionTextExecutor(deps);

    await executor('task_chat', [{ role: 'user', content: 'hi' }], undefined, {
      projectId: 'project-1', logicalRequestId: 'session-1',
    });

    expect(starts).toEqual([expect.objectContaining({
      logicalRequestId: 'session-1', providerId: ROUTE.providerId, model: ROUTE.model,
      projectId: 'project-1', source: 'task_chat', attemptOrdinal: 1,
    })]);
    expect(finishes).toEqual([[
      'call-1',
      expect.objectContaining({
        status: 'succeeded',
        usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, total: 17 },
      }),
    ]]);
  });

  it('task_proposal 使用 task_proposer 配置的 15 分钟超时', async () => {
    const h = controlledHarness(SUCCESS_EVENTS);

    await h.executor('task_proposal', [{ role: 'user', content: '拆解任务' }]);

    expect(h.spawnOptions[0]?.timeoutMs).toBe(15 * 60_000);
  });

  it('task_chat 保留 120 秒回退超时', async () => {
    const h = controlledHarness(SUCCESS_EVENTS);

    await h.executor('task_chat', [{ role: 'user', content: 'hello' }]);

    expect(h.spawnOptions[0]?.timeoutMs).toBe(120_000);
  });

  it('取消时终止当前 Pi 进程且不进入 Provider 降级', async () => {
    const controller = new AbortController();
    const h = controlledHarness([], true);
    const result = h.executor(
      'task_proposal',
      [{ role: 'user', content: '拆解任务' }],
      undefined,
      { signal: controller.signal },
    );
    await h.spawned;

    controller.abort();
    h.release();

    await expect(result).rejects.toMatchObject({ kind: 'interaction' });
    expect(h.cancel).toHaveBeenCalledTimes(1);
    expect(h.routeCalls).toBe(1);
  });

  // 设计需求 2：message_update 的 text_delta 必须立即转发给 onDelta，而非缓冲到进程结束。
  // 本用例固化 happy path 的调用次数/顺序契约；立即转发的判据是 ai.test.ts 中「错误前 partial delta」
  // 用例（构造 text_delta 后非零 exit）预期 deltas 含 partial，而非被丢弃。
  it('立即转发 text_delta，保持顺序', async () => {
    const calls: string[] = [];
    const executor = harness([
      JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '你好' } }),
      JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '世界' } }),
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '你好世界' }] } }),
      JSON.stringify({ type: 'agent_end', messages: [] }),
    ]);
    await executor('task_chat', [{ role: 'user', content: 'hi' }], (d) => calls.push(d));
    expect(calls).toEqual(['你好', '世界']);
  });

  it('thinking_delta 经 onThinking 单独转发，不计入 onDelta（思考与正文分离）', async () => {
    const deltas: string[] = [];
    const thinkings: string[] = [];
    const executor = harness([
      JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '内部' } }),
      JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '思考' } }),
      JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '正文' } }),
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '正文' }] } }),
      JSON.stringify({ type: 'agent_end', messages: [] }),
    ]);
    await executor('task_chat', [{ role: 'user', content: 'hi' }], (d) => deltas.push(d), undefined, undefined, undefined, undefined, undefined, (th) => thinkings.push(th));
    // 正文增量仅含 text_delta；思考增量经 onThinking 单独投递且保持顺序。
    expect(deltas).toEqual(['正文']);
    expect(thinkings).toEqual(['内部', '思考']);
  });

  it('错误前已发的 text_delta 已投递给 onDelta（立即转发的判据）', async () => {
    // 与 ai.test.ts 的「非零 exit 丢弃 partial delta」用例不同：那些用例的事件用顶层 delta
    // （无 assistantMessageEvent），在新守卫下根本不会被转发。本用例构造真正的 text_delta，
    // 断言它在进程异常退出前已被立即投递--这才是「立即转发 vs 缓冲」的判据。
    const calls: string[] = [];
    const executor = harness(
      [JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'partial' } })],
      7,
    );
    await expect(executor('task_chat', [{ role: 'user', content: 'hi' }], (d) => calls.push(d)))
      .rejects.toMatchObject({ kind: 'runtime' });
    expect(calls).toEqual(['partial']);
  });
});
