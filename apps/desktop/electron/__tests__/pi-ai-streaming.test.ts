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
  // （旧的缓冲实现末尾一次性 flush，最终 onDelta 调用次数/顺序相同，无法仅凭计数区分；
  //   立即转发的判据见「错误前已发 delta 应保留」的 ai.test.ts 用例：partial delta 在
  //   exit/protocol 失败时仍被投递。本用例固化 happy path 的调用次数/顺序契约。）
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
});
