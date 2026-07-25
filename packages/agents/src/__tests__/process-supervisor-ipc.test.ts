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

  it('问答挂起期间暂停超时；收到答案后恢复，超时再会计时', async () => {
    vi.useFakeTimers();
    try {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const kill = vi.fn();
      const fakeChild = {
        pid: 999,
        stdin: new PassThrough(),
        stdout,
        stderr,
        killed: false,
        kill,
        once: vi.fn(),
        on: vi.fn(),
        send: vi.fn(() => true),
        disconnect: vi.fn(),
      };
      const spawnFn = vi.fn((): ChildProcess => fakeChild as unknown as ChildProcess);
      const supervisor = new PiProcessSupervisor({ platform: 'linux', spawnFn } as ConstructorParameters<typeof PiProcessSupervisor>[0]);
      const plan: PiRunPlan = { command: 'node', args: ['x'], env: {} } as unknown as PiRunPlan;
      const spawned = supervisor.spawn(plan, { cwd: '/tmp', timeoutMs: 5_000 });
      spawned.onMessage(() => {});
      const onCall = fakeChild.on.mock.calls.find((c) => c[0] === 'message')!;
      // 子进程发 ask：暂停主超时，上 10 分钟看门狗。
      onCall[1]({ kind: 'ask', toolUseId: 't1' });
      // 越过原 timeoutMs，主超时已暂停 -> 不应杀进程。
      await vi.advanceTimersByTimeAsync(6_000);
      expect(kill).not.toHaveBeenCalled();
      // 收到答案：清除看门狗，刷新主超时。
      onCall[1]({ kind: 'ask_answer', toolUseId: 't1', answers: {} });
      // 越过 timeoutMs（刷新后重新计时）-> 触发 killProcess。
      await vi.advanceTimersByTimeAsync(6_000);
      // killProcess 先 process.kill(-pid) 抛错（无此进程组），回退 child.kill('SIGTERM')。
      expect(kill).toHaveBeenCalled();
      stdout.end();
      stderr.end();
      // 不 await cancel：fakeChild.once('close') 为 no-op，settledPromise 不会 resolve，
      // killProcess 的 2000ms 宽限在假定时器下无法自然走完；kill 断言已达成，余下清理交由测试拆解。
      void spawned.cancel();
    } finally {
      vi.useRealTimers();
    }
  });
});
