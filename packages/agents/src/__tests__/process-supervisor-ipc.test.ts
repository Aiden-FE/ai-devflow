import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { PiProcessSupervisor } from '../process-supervisor.js';
import type { PiRunPlan } from '../run-plan.js';

// 验证 SpawnedPi 暴露 send/onMessage 且 spawn 的 stdio 含 'ipc' 通道（需求 4 进程层）。
describe('PiProcessSupervisor IPC', () => {
  it('spawn 的 stdio 含 ipc 通道，且 SpawnedPi 暴露 send/onMessage', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const fakeChild = {
      pid: 999,
      stdin: new PassThrough(),
      stdout,
      stderr,
      killed: false,
      kill: vi.fn(),
      once: vi.fn(),
      on: vi.fn(),
      send: vi.fn(() => true),
      disconnect: vi.fn(),
    };
    const spawnFn = vi.fn((_cmd: string, _args: string[], opts: { stdio: unknown }): ChildProcess => {
      // 断言 stdio 含 ipc
      expect(Array.isArray(opts.stdio)).toBe(true);
      expect(opts.stdio).toContain('ipc');
      return fakeChild as unknown as ChildProcess;
    });
    const supervisor = new PiProcessSupervisor({ platform: 'linux', spawnFn } as ConstructorParameters<typeof PiProcessSupervisor>[0]);
    const plan: PiRunPlan = { command: 'node', args: ['x'], env: {} } as unknown as PiRunPlan;
    const spawned = supervisor.spawn(plan, { cwd: '/tmp', timeoutMs: 5000 });
    expect(typeof spawned.send).toBe('function');
    expect(typeof spawned.onMessage).toBe('function');
    spawned.send({ kind: 'ask', toolUseId: 't1' });
    expect(fakeChild.send).toHaveBeenCalledWith({ kind: 'ask', toolUseId: 't1' });
    const cb = vi.fn();
    spawned.onMessage(cb);
    // fakeChild.on 被调用注册 'message'
    const onCall = fakeChild.on.mock.calls.find((c) => c[0] === 'message');
    expect(onCall).toBeTruthy();
    onCall![1]({ kind: 'ask_answer', toolUseId: 't1', answers: {} });
    expect(cb).toHaveBeenCalledWith({ kind: 'ask_answer', toolUseId: 't1', answers: {} });
    stdout.end();
    stderr.end();
    await spawned.cancel();
  });
});
