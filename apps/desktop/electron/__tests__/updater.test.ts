import { describe, it, expect, vi } from 'vitest';

// 仅用于让 updater.ts 的顶层 `import { app } from 'electron'` 可解析；
// 测试通过 deps 注入 isPackaged/currentVersion，运行时并不访问 app。
vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', isPackaged: false },
}));

import { createUpdater, type AutoUpdaterLike } from '../updater.js';
import type { UpdateStatus } from '@ai-devflow/core';

/** 可控 autoUpdater 桩：记录事件处理器，支持手动触发事件与断言 quitAndInstall。 */
class FakeAutoUpdater implements AutoUpdaterLike {
  autoDownload = false;
  autoInstallOnAppQuit = true;
  quitCalled = false;
  private handlers = new Map<string, (info?: unknown) => void>();
  on(ev: string, cb: (info?: unknown) => void): unknown {
    this.handlers.set(ev, cb);
    return this;
  }
  async checkForUpdates(): Promise<unknown> {
    this.handlers.get('checking-for-update')?.();
    return undefined;
  }
  quitAndInstall(): void {
    this.quitCalled = true;
  }
  emit(ev: string, info?: unknown): void {
    this.handlers.get(ev)?.(info);
  }
}

function makeUpdater() {
  const fake = new FakeAutoUpdater();
  const statuses: UpdateStatus[] = [];
  const updater = createUpdater({
    isPackaged: true,
    currentVersion: '0.0.2',
    loadAutoUpdater: () => fake,
    startDelayMs: 1_000_000, // 不在测试期间自动触发检查
  });
  updater.start((s) => statuses.push(s));
  return { fake, statuses, updater };
}

describe('updater (injected autoUpdater)', () => {
  it('configures silent download + manual install and starts idle', () => {
    const { fake, statuses, updater } = makeUpdater();
    expect(fake.autoDownload).toBe(true);
    expect(fake.autoInstallOnAppQuit).toBe(false);
    expect(updater.status().state).toBe('idle');
    expect(statuses[0]?.state).toBe('idle');
    expect(statuses[0]?.currentVersion).toBe('0.0.2');
  });

  it('transitions available -> downloading -> downloaded via events', () => {
    const { fake, updater } = makeUpdater();
    fake.emit('update-available', { version: '0.0.3' });
    expect(updater.status().state).toBe('available');
    expect(updater.status().version).toBe('0.0.3');
    fake.emit('download-progress', { percent: 42, transferred: 42, total: 100, bytesPerSecond: 10 });
    expect(updater.status().state).toBe('downloading');
    expect(updater.status().progress?.percent).toBe(42);
    fake.emit('update-downloaded', { version: '0.0.3' });
    expect(updater.status().state).toBe('downloaded');
  });

  it('installUpdate after download calls quitAndInstall and enters installing', async () => {
    const { fake, updater } = makeUpdater();
    fake.emit('update-downloaded', { version: '0.0.3' });
    const r = await updater.installUpdate();
    expect(r.ok).toBe(true);
    expect(fake.quitCalled).toBe(true); // 打包环境真正退出并安装
    expect(updater.status().state).toBe('installing');
  });

  it('installUpdate before download is NOT a silent no-op: returns error + visible error state', async () => {
    const { fake, updater } = makeUpdater();
    // 仍处于 idle（未下载完成）
    const r = await updater.installUpdate();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/尚未下载完成|状态/);
    expect(updater.status().state).toBe('error');
    expect(updater.status().error).toBeTruthy();
    expect(fake.quitCalled).toBe(false);
  });

  it('error event surfaces a visible error state', () => {
    const { fake, updater } = makeUpdater();
    fake.emit('error', new Error('signature mismatch'));
    expect(updater.status().state).toBe('error');
    expect(updater.status().error).toMatch(/signature mismatch/);
  });
});

describe('updater (dev / not packaged)', () => {
  it('returns a no-op whose installUpdate still reports a visible result', async () => {
    const updater = createUpdater({ isPackaged: false, currentVersion: '0.0.2' });
    expect(updater.status().state).toBe('idle');
    const r = await updater.installUpdate();
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy(); // 开发环境也给出可见信息，而非静默
  });
});
