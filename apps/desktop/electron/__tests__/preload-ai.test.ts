import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopApi } from '../api.js';

const { send, removeListener, listeners, exposed } = vi.hoisted(() => ({
  send: vi.fn(),
  removeListener: vi.fn((channel: string) => listeners.delete(channel)),
  listeners: new Map<string, (...args: unknown[]) => void>(),
  exposed: {} as { api?: DesktopApi },
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, value: DesktopApi) => {
      if (name === 'api') exposed.api = value;
    },
  },
  ipcRenderer: {
    invoke: vi.fn(),
    send,
    sendSync: vi.fn(() => undefined),
    on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => listeners.set(channel, listener)),
    removeListener,
  },
}));

beforeAll(async () => {
  await import('../preload.js');
});

beforeEach(() => {
  send.mockClear();
  removeListener.mockClear();
});

describe('preload AI session lifecycle', () => {
  it('在发送 chat 前回传生成的 sessionId', () => {
    const sessions: string[] = [];
    const ai: DesktopApi['ai'] = exposed.api!.ai;

    void ai.chat(
      [{ role: 'user', content: '拆解任务' }],
      () => {},
      { onSession: (sessionId: string) => sessions.push(sessionId) },
    );

    expect(sessions).toEqual([expect.any(String)]);
    expect(send).toHaveBeenCalledWith('ai-devflow:ai:chat', expect.objectContaining({ sessionId: sessions[0] }));
  });

  it('取消时只发送目标 sessionId', async () => {
    const ai: DesktopApi['ai'] = exposed.api!.ai;

    await ai.cancel('session-1');

    expect(send).toHaveBeenCalledWith('ai-devflow:ai:cancel', { sessionId: 'session-1' });
  });

  it('取消活动会话时移除监听并以 AbortError 结束 chat Promise', async () => {
    let sessionId = '';
    const promise = exposed.api!.ai.chat(
      [{ role: 'user', content: '拆解任务' }],
      () => {},
      { onSession: (id) => { sessionId = id; } },
    );

    await exposed.api!.ai.cancel(sessionId);
    const state = await Promise.race([
      promise.then(() => 'resolved', (error: Error) => error.name),
      new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 0)),
    ]);

    expect(state).toBe('AbortError');
    expect(removeListener).toHaveBeenCalledWith('ai-devflow:ai-stream', expect.any(Function));
  });

  it('onSession 同步取消时不启动 chat 并以 AbortError 结束 Promise', async () => {
    const ai: DesktopApi['ai'] = exposed.api!.ai;
    const promise = ai.chat(
      [{ role: 'user', content: '拆解任务' }],
      () => {},
      { onSession: (sessionId) => { void ai.cancel(sessionId); } },
    );

    const state = await Promise.race([
      promise.then(() => 'resolved', (error: Error) => error.name),
      new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 0)),
    ]);

    expect(state).toBe('AbortError');
    expect(send).toHaveBeenCalledWith('ai-devflow:ai:cancel', { sessionId: expect.any(String) });
    expect(send).not.toHaveBeenCalledWith('ai-devflow:ai:chat', expect.anything());
  });
});
