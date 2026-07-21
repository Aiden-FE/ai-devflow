// 自动更新：基于 electron-updater（electron-builder GitHub Provider）。
// 仅 app.isPackaged 时启用；开发/E2E 下为 no-op，不影响应用。
// 更新失败、无更新、校验失败均只更新状态，不抛出影响应用。
import { app } from 'electron';
import { createRequire } from 'node:module';
import type { UpdateStatus, UpdateState, UpdateProgress } from '@ai-devflow/core';

// 兼容 esbuild CJS 打包（import.meta 为空）与 vitest/vite ESM：
// 优先用 CJS 的 require，缺失时回退到 createRequire(import.meta.url)。
declare const require: NodeRequire | undefined;
const _require: NodeRequire =
  typeof require !== 'undefined' ? require : createRequire(import.meta.url);

export interface Updater {
  /** 启动：注册状态回调，并在启动后异步检查更新（发现则静默下载）。 */
  start(onStatus: (s: UpdateStatus) => void): void;
  /** 手动检查更新。 */
  check(): Promise<void>;
  /** 下载完成后退出并安装。仅当状态为 downloaded 时有效。 */
  installUpdate(): Promise<void>;
  /** 当前更新状态。 */
  status(): UpdateStatus;
}

function noopUpdater(currentVersion: string): Updater {
  const status: UpdateStatus = { state: 'idle', currentVersion };
  return {
    start(onStatus) { onStatus(status); },
    async check() { /* dev: no-op */ },
    async installUpdate() { /* dev: no-op */ },
    status() { return status; },
  };
}

/**
 * 创建自动更新器。未打包时返回 no-op（开发/E2E 不受影响）。
 * electron-updater 在打包后才可用（读取 resources/app-update.yml）。
 */
export function createUpdater(): Updater {
  const currentVersion = app.getVersion();
  if (!app.isPackaged) return noopUpdater(currentVersion);

  let state: UpdateState = 'idle';
  let version: string | undefined;
  let progress: UpdateProgress | undefined;
  let error: string | undefined;
  let onStatusCb: ((s: UpdateStatus) => void) | undefined;
  let autoUpdater: {
    autoDownload: boolean;
    autoInstallOnAppQuit: boolean;
    on(ev: string, cb: (info?: unknown) => void): unknown;
    checkForUpdates(): Promise<unknown>;
    quitAndInstall(): void;
  } | undefined;

  const emit = () => onStatusCb?.({ state, version, currentVersion, progress, error });

  try {
    // 懒加载：dev 下不会执行到此（isPackaged=false）。
    const mod = _require('electron-updater') as { autoUpdater: typeof autoUpdater };
    autoUpdater = mod.autoUpdater;
    autoUpdater!.autoDownload = true; // 发现版本后静默下载
    autoUpdater!.autoInstallOnAppQuit = false; // 仅用户点击“立即升级”才退出安装
    autoUpdater!.on('checking-for-update', () => { state = 'checking'; emit(); });
    autoUpdater!.on('update-available', (info: unknown) => {
      state = 'available'; version = (info as { version?: string })?.version; emit();
    });
    autoUpdater!.on('update-not-available', () => { state = 'no-update'; emit(); });
    autoUpdater!.on('download-progress', (p: unknown) => {
      const pr = p as { percent: number; transferred: number; total: number; bytesPerSecond: number };
      state = 'downloading';
      progress = { percent: pr.percent, transferred: pr.transferred, total: pr.total, bytesPerSecond: pr.bytesPerSecond };
      emit();
    });
    autoUpdater!.on('update-downloaded', (info: unknown) => {
      state = 'downloaded'; version = (info as { version?: string })?.version ?? version; emit();
    });
    autoUpdater!.on('error', (e: unknown) => {
      // 更新失败不得影响应用：仅记录错误状态。
      state = 'error'; error = (e as Error)?.message ?? String(e); emit();
    });
  } catch {
    // electron-updater 不可用 -> 降级为 no-op，应用照常运行。
    return noopUpdater(currentVersion);
  }

  return {
    start(onStatus) {
      onStatusCb = onStatus;
      onStatus({ state, version, currentVersion, progress, error });
      // 启动后异步检查（不阻塞 ready），发现版本则静默下载。
      setTimeout(() => {
        autoUpdater?.checkForUpdates().catch(() => { /* 错误已由 error 事件处理 */ });
      }, 3000).unref?.();
    },
    async check() {
      state = 'checking'; emit();
      try {
        await autoUpdater?.checkForUpdates();
      } catch (e) {
        state = 'error'; error = (e as Error)?.message ?? String(e); emit();
      }
    },
    async installUpdate() {
      if (state !== 'downloaded') return;
      autoUpdater?.quitAndInstall();
    },
    status() {
      return { state, version, currentVersion, progress, error };
    },
  };
}
