import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProductionTextExecutor } from '../pi-ai.js';
import type { ProductionExecutorDeps } from '../pi-ai.js';
import type { ProviderRoute } from '@ai-devflow/agents';

const here = dirname(fileURLToPath(import.meta.url));
const ASSETS_ROOT = join(here, '..', '..', '..', '..', 'packages', 'agents', 'assets', 'profiles');

const ROUTE: ProviderRoute = {
  providerName: 'p',
  model: 'm',
  thinking: 'off',
  secret: 's',
  baseURL: 'https://example.test',
  kind: 'anthropic',
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

describe('executeTextOnRoute streaming', () => {
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

  it('不转发 thinking_delta（思维链抑制）', async () => {
    const calls: string[] = [];
    const executor = harness([
      JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '内部思考' } }),
      JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '正文' } }),
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '正文' }] } }),
      JSON.stringify({ type: 'agent_end', messages: [] }),
    ]);
    await executor('task_chat', [{ role: 'user', content: 'hi' }], (d) => calls.push(d));
    expect(calls).toEqual(['正文']);
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
