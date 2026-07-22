import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 仅用于让 updater.ts 的顶层 `import { app } from 'electron'` 可解析；
// 测试通过 deps 注入 isPackaged/currentVersion，运行时并不访问 app/shell/child_process。
vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', isPackaged: false },
  shell: { openExternal: vi.fn() },
}));

// defaultCheckSignature 通过 execFile 调用真实 codesign；测试中桩掉以覆盖 Ad hoc 判定。
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { createUpdater, defaultCheckSignature, MANUAL_DOWNLOAD_URL, type AutoUpdaterLike } from '../updater.js';
import { execFile } from 'node:child_process';
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

function makeUpdater(opts: {
  platform?: 'darwin' | 'win32' | 'linux';
  isPackaged?: boolean;
  checkSignature?: () => Promise<boolean>;
  openExternal?: (url: string) => Promise<void>;
  quitAndInstall?: (au: AutoUpdaterLike) => void;
  installTimeoutMs?: number;
} = {}) {
  const fake = new FakeAutoUpdater();
  const statuses: UpdateStatus[] = [];
  const updater = createUpdater({
    isPackaged: opts.isPackaged ?? true,
    currentVersion: '0.0.2',
    loadAutoUpdater: () => fake,
    startDelayMs: 1_000_000, // 不在测试期间自动触发检查
    platform: opts.platform ?? 'win32',
    checkSignature: opts.checkSignature,
    openExternal: opts.openExternal,
    quitAndInstall: opts.quitAndInstall,
    installTimeoutMs: opts.installTimeoutMs,
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
    expect(r.action).toBe('install-started');
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

describe('updater installUpdate platform-specific behavior', () => {
  it('signed macOS: calls quitAndInstall, does not open browser, returns install-started', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const { fake, updater } = makeUpdater({
      platform: 'darwin',
      checkSignature: async () => true,
      openExternal,
    });
    fake.emit('update-downloaded', { version: '0.0.3' });
    const r = await updater.installUpdate();
    expect(r.ok).toBe(true);
    expect(r.action).toBe('install-started');
    expect(fake.quitCalled).toBe(true);
    expect(openExternal).not.toHaveBeenCalled();
    expect(updater.status().state).toBe('installing');
  });

  it('unsigned macOS: does not call quitAndInstall; opens fixed Releases URL once; returns manual-download; stays downloaded', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const { fake, updater } = makeUpdater({
      platform: 'darwin',
      checkSignature: async () => false,
      openExternal,
    });
    fake.emit('update-downloaded', { version: '0.0.3' });
    const r = await updater.installUpdate();
    expect(r.ok).toBe(true);
    expect(r.action).toBe('manual-download');
    expect(r.arch).toBe(process.arch);
    expect(fake.quitCalled).toBe(false);
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(MANUAL_DOWNLOAD_URL);
    expect(updater.status().state).toBe('downloaded');
  });

  it('codesign error: falls back to manual download path', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const { fake, updater } = makeUpdater({
      platform: 'darwin',
      checkSignature: async () => { throw new Error('codesign crashed'); },
      openExternal,
    });
    fake.emit('update-downloaded', { version: '0.0.3' });
    const r = await updater.installUpdate();
    expect(r.ok).toBe(true);
    expect(r.action).toBe('manual-download');
    expect(fake.quitCalled).toBe(false);
    expect(openExternal).toHaveBeenCalledWith(MANUAL_DOWNLOAD_URL);
    expect(updater.status().state).toBe('downloaded');
  });

  it('Windows/Linux: does not run macOS signature check and still calls quitAndInstall', async () => {
    const checkSignature = vi.fn().mockResolvedValue(false);
    const openExternal = vi.fn().mockResolvedValue(undefined);
    for (const platform of ['win32', 'linux'] as const) {
      const { fake, updater } = makeUpdater({ platform, checkSignature, openExternal });
      fake.emit('update-downloaded', { version: '0.0.3' });
      const r = await updater.installUpdate();
      expect(r.ok).toBe(true);
      expect(r.action).toBe('install-started');
      expect(fake.quitCalled).toBe(true);
      expect(checkSignature).not.toHaveBeenCalled();
      expect(openExternal).not.toHaveBeenCalled();
      expect(updater.status().state).toBe('installing');
    }
  });
});

describe('updater installUpdate error recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('quitAndInstall synchronous throw enters error and returns ok:false', async () => {
    const { fake, updater } = makeUpdater({
      quitAndInstall: () => { throw new Error('quit failed'); },
    });
    fake.emit('update-downloaded', { version: '0.0.3' });
    const r = await updater.installUpdate();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/quit failed/);
    expect(updater.status().state).toBe('error');
    expect(updater.status().error).toMatch(/quit failed/);
  });

  it('updater async error during installing moves to error and clears the install timer', async () => {
    const { fake, updater } = makeUpdater({ installTimeoutMs: 5_000 });
    fake.emit('update-downloaded', { version: '0.0.3' });
    await updater.installUpdate();
    expect(updater.status().state).toBe('installing');
    fake.emit('error', new Error('installer died'));
    expect(updater.status().state).toBe('error');
    expect(updater.status().error).toMatch(/installer died/);
    // 确认计时器已被清理：推进时间后状态应保持 error，不应被超时覆盖为其它信息
    vi.advanceTimersByTime(10_000);
    expect(updater.status().state).toBe('error');
    expect(updater.status().error).toMatch(/installer died/);
  });

  it('install timeout moves installing to error and allows retry', async () => {
    const { fake, updater } = makeUpdater({ installTimeoutMs: 2_000 });
    fake.emit('update-downloaded', { version: '0.0.3' });
    await updater.installUpdate();
    expect(updater.status().state).toBe('installing');
    vi.advanceTimersByTime(2_001);
    expect(updater.status().state).toBe('error');
    expect(updater.status().error).toMatch(/超时|未在预期时间内/);
    // 错误后可再次点击（状态回到 downloaded 后重试）
    fake.emit('update-downloaded', { version: '0.0.3' });
    expect(updater.status().state).toBe('downloaded');
  });

  it('openExternal failure enters error and does not enter installing', async () => {
    const openExternal = vi.fn().mockRejectedValue(new Error('no browser'));
    const { fake, updater } = makeUpdater({
      platform: 'darwin',
      checkSignature: async () => false,
      openExternal,
    });
    fake.emit('update-downloaded', { version: '0.0.3' });
    const r = await updater.installUpdate();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no browser/);
    expect(updater.status().state).toBe('error');
    expect(fake.quitCalled).toBe(false);
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

describe('defaultCheckSignature (Ad hoc 检测)', () => {
  const realPlatform = process.platform;

  beforeEach(() => {
    // defaultCheckSignature 仅在 darwin 调用 codesign；强制平台以在任意 CI OS 上可测。
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    vi.mocked(execFile).mockReset();
  });

  /** 桩 codesign 两次调用：`--verify`（结构校验）与 `-dv`（身份信息）。 */
  function mockCodesign(result: { verifyOk: boolean; info: string }) {
    // execFile 具多重载，mockImplementation 需宽松匹配（lint=tsc，允许显式 any）。
    const impl = (
      _file: string,
      args: readonly string[],
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (args.includes('--verify')) {
        cb(result.verifyOk ? null : new Error('not signed'), '', '');
      } else if (args.includes('-dv')) {
        cb(null, '', result.info);
      } else {
        cb(new Error('unexpected codesign invocation'), '', '');
      }
    };
    vi.mocked(execFile).mockImplementation(impl as never);
  }

  it('Ad hoc 签名通过 --verify 但返回 false（不可自动安装）', async () => {
    mockCodesign({
      verifyOk: true,
      info: 'Identifier=com.ai-devflow.desktop\nCodeDirectory v=20400 flags=0x2(adhoc)\nSignature=adhoc\nTeamIdentifier=not set\n',
    });
    expect(await defaultCheckSignature('/x/ai-devflow.app')).toBe(false);
  });

  it('真实 Developer ID 签名（有 Authority）返回 true', async () => {
    mockCodesign({
      verifyOk: true,
      info: 'Identifier=com.ai-devflow.desktop\nTeamIdentifier=ABC123DEFG\nAuthority=Developer ID Application: Aiden-FE (ABC123DEFG)\nSignature=valid\n',
    });
    expect(await defaultCheckSignature('/x/ai-devflow.app')).toBe(true);
  });

  it('未签名 bundle（--verify 失败）返回 false', async () => {
    mockCodesign({ verifyOk: false, info: '' });
    expect(await defaultCheckSignature('/x/ai-devflow.app')).toBe(false);
  });

  it('非 darwin 平台直接返回 false 且不调用 codesign', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    vi.mocked(execFile).mockImplementation((() => { throw new Error('should not be called'); }) as never);
    expect(await defaultCheckSignature('/x/ai-devflow.app')).toBe(false);
    expect(execFile).not.toHaveBeenCalled();
  });
});
