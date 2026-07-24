import { describe, it, expect, vi } from 'vitest';
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

// 验证 executeTextOnRoute 的 onMessage 桥接：子进程发 { kind:'ask', toolUseId, payload }
// 时，onAsk 回调携带 (toolUseId, tabs, send) 被调用；send 回灌答案时委托到 spawned.send。
describe('ask IPC bridge (executeTextOnRoute onAsk)', () => {
  it('onAsk 回调携带 send 函数，send 回灌 spawned.send', async () => {
    let messageCb: ((msg: unknown) => void) | null = null;
    const events = [
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '正在提问' } },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '正在提问' }] } },
      { type: 'agent_end', messages: [] },
    ];
    const stdout = events.map((e) => JSON.stringify(e));
    const mockSpawned = {
      lines: (async function* () { for (const text of stdout) yield { stream: 'stdout' as const, text }; })(),
      done: async () => ({ exitCode: 0, signal: null }),
      cancel: async () => undefined,
      pid: 1,
      send: vi.fn(() => true),
      onMessage: vi.fn((cb: (msg: unknown) => void) => { messageCb = cb; }),
    };
    const supervisor = { spawn: () => mockSpawned };
    const deps = {
      locator: { verify: async () => ({ version: '0.80.10', entry: '/verified/pi.js' }) },
      router: { execute: async (_w: unknown, op: (r: ProviderRoute) => Promise<string>) => op(ROUTE) },
      supervisor,
      sessionsBaseDir: mkdtempSync(join(tmpdir(), 'pi-ai-ask-')),
      projectToolPath: '/usr/bin:/bin',
      assetsRoot: ASSETS_ROOT,
    } as unknown as ProductionExecutorDeps;
    const executor = createProductionTextExecutor(deps);
    const onAsk = vi.fn();
    const promise = executor(
      'task_proposal',
      [{ role: 'user', content: 'hi' }],
      undefined,
      undefined,
      undefined,
      onAsk,
    );
    // 模拟子进程经 IPC 发来 ask 请求（spawned.onMessage 已捕获回调）。
    // executeTextOnRoute 在首个 await（locator.verify）后才 spawn+注册 onMessage，需让出微任务。
    await new Promise((r) => setTimeout(r, 0));
    expect(messageCb).not.toBeNull();
    messageCb!({ kind: 'ask', toolUseId: 'tu1', payload: { tabs: [] } });
    expect(onAsk).toHaveBeenCalledWith('tu1', { tabs: [] }, expect.any(Function));
    // 调用 send 应回灌到 spawned.send
    const sendFn = onAsk.mock.calls[0]![2] as (msg: unknown) => boolean;
    sendFn({ kind: 'ask_answer', toolUseId: 'tu1', answers: [] });
    expect(mockSpawned.send).toHaveBeenCalledWith({ kind: 'ask_answer', toolUseId: 'tu1', answers: [] });
    await promise;
  });
});
