// 单测 executeTextOnRoute 的失败根因还原：用假 supervisor 喂入 stderr / 未知事件 / 异常退出，
// 断言 protocol 与 runtime 失败的 detail 携带真实根因（stderr、原因、未处理事件），
// 而不是只剩无信息的「Pi 返回的终止协议无效」。不依赖真实 Pi 二进制，确定性、快速。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ProviderExecutionError,
  type PiProcessSupervisor,
  type ProviderRoute,
  type RuntimeLocator,
  type SpawnedPi,
  type SupervisorRawLine,
} from '@ai-devflow/agents';
import { executeTextOnRoute, type ProductionExecutorDeps } from '../pi-ai.js';

const route: ProviderRoute = {
  providerId: 'p1',
  providerRevision: 1,
  providerKind: 'openai',
  providerName: 'openai',
  routeId: 'p1:task_chat',
  model: 'gpt-test',
  models: ['gpt-test'],
  thinking: 'medium',
  secret: 'test-secret',
};

const fakeLocator: RuntimeLocator = { verify: async () => ({ version: '0.0.0', entry: '/fake/pi' }) };

function fakeSpawned(lines: SupervisorRawLine[], exitCode: number | null): SpawnedPi {
  return {
    pid: 12345,
    lines: (async function* gen() {
      for (const l of lines) yield l;
    })(),
    cancel: async () => undefined,
    done: async () => ({ exitCode, signal: null }),
  };
}

function makeDeps(lines: SupervisorRawLine[], exitCode: number | null): ProductionExecutorDeps {
  const supervisor = { spawn: () => fakeSpawned(lines, exitCode) } as unknown as PiProcessSupervisor;
  return {
    locator: fakeLocator,
    router: undefined as never, // executeTextOnRoute 不使用 router
    supervisor,
    sessionsBaseDir: mkdtempSync(join(tmpdir(), 'pi-ai-protocol-')),
    projectToolPath: '/usr/bin:/bin',
  } as ProductionExecutorDeps;
}

async function captureFailure(
  lines: SupervisorRawLine[],
  exitCode: number | null,
): Promise<ProviderExecutionError> {
  try {
    await executeTextOnRoute(route, [{ role: 'user', content: 'ping' }], undefined, makeDeps(lines, exitCode), 'task_chat');
  } catch (err) {
    return err as ProviderExecutionError;
  }
  throw new Error('expected executeTextOnRoute to throw');
}

describe('executeTextOnRoute failure detail', () => {
  it('surfaces stderr and the missing-agent_end reason on a protocol failure', async () => {
    const lines: SupervisorRawLine[] = [
      { stream: 'stderr', text: 'Error: model "gpt-test" not found in gateway' },
      { stream: 'stdout', text: JSON.stringify({ type: 'session' }) },
    ];
    const err = await captureFailure(lines, 0);
    expect(err).toBeInstanceOf(ProviderExecutionError);
    expect(err.kind).toBe('protocol');
    expect(err.message).toBe('Pi 返回的终止协议无效');
    expect(err.detail).toContain('model "gpt-test" not found in gateway');
    expect(err.detail).toContain('缺少 agent_end 终态事件');
    expect(err.detail).toContain('Pi stderr：');
  });

  it('surfaces stderr and the exit code on a runtime (nonzero exit) failure', async () => {
    const lines: SupervisorRawLine[] = [
      { stream: 'stderr', text: 'Error: ECONNREFUSED 127.0.0.1:443' },
    ];
    const err = await captureFailure(lines, 1);
    expect(err.kind).toBe('runtime');
    expect(err.status).toBe(1);
    expect(err.detail).toContain('exit=1');
    expect(err.detail).toContain('ECONNREFUSED 127.0.0.1:443');
  });

  it('records unrecognized stdout event types in the detail', async () => {
    const lines: SupervisorRawLine[] = [
      { stream: 'stdout', text: JSON.stringify({ type: 'system_error', message: 'boom' }) },
      { stream: 'stderr', text: 'config invalid' },
    ];
    const err = await captureFailure(lines, 0);
    expect(err.kind).toBe('protocol');
    expect(err.detail).toContain('system_error');
    expect(err.detail).toContain('收到未处理事件');
    expect(err.detail).toContain('config invalid');
  });

  it('still succeeds when assistant text arrives via message_update deltas', async () => {
    const lines: SupervisorRawLine[] = [
      { stream: 'stdout', text: JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'pong' } }) },
      { stream: 'stdout', text: JSON.stringify({ type: 'agent_end' }) },
    ];
    const result = await executeTextOnRoute(
      route,
      [{ role: 'user', content: 'ping' }],
      undefined,
      makeDeps(lines, 0),
      'task_chat',
    );
    expect(result).toBe('pong');
  });

  it('recovers full text from terminal message_end even when deltas are missed', async () => {
    // 防回归：早期实现误读 event.delta（顶层），导致任何能正常返回的提供商都被判为「未收到任何文本输出」。
    // Pi 的完整助手文本在 terminal 事件的 message.content[].text。
    const lines: SupervisorRawLine[] = [
      { stream: 'stdout', text: JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'pong' }], stopReason: 'stop' } }) },
      { stream: 'stdout', text: JSON.stringify({ type: 'agent_end' }) },
    ];
    const result = await executeTextOnRoute(
      route,
      [{ role: 'user', content: 'ping' }],
      undefined,
      makeDeps(lines, 0),
      'task_chat',
    );
    expect(result).toBe('pong');
  });
});
