// 自动更新：基于 electron-updater（electron-builder GitHub Provider）。
// 仅打包环境（app.isPackaged）时启用；开发/E2E 下为 no-op，不影响应用。
// 更新失败、无更新、校验失败均只更新状态，不抛出影响应用。
//
// 关键修复（v0.0.2 静默下载 v0.0.3 后点「立即升级」无反应）：
// - 旧实现 installUpdate() 里 `if (state !== 'downloaded') return;` + `autoUpdater?.quitAndInstall()`
//   存在两处静默 no-op：状态漂移时直接 return、autoUpdater 为空时可选链吞掉。配合
//   autoInstallOnAppQuit=false，导致更新永远装不上且 UI 无任何反馈。
// - 现：installUpdate() 返回 InstallUpdateResult；不可安装时进入可见 error 状态并给出可诊断信息；
//   下载完成后点击「立即升级」会进入 installing 状态并真正调用 quitAndInstall（打包环境退出并安装重启）。
// - createUpdater 支持注入 autoUpdater 加载器与 quitAndInstall 副作用，便于对状态机与事件做单元测试
//   （开发环境 no-op 不再作为唯一验收依据）。
import { app } from 'electron';
import { createRequire } from 'node:module';
import type { UpdateStatus, UpdateState, UpdateProgress, InstallUpdateResult } from '@ai-devflow/core';

// 兼容 esbuild CJS 打包（import.meta 为空）与 vitest/vite ESM：
// 优先用 CJS 的 require，缺失时回退到 createRequire(import.meta.url)。
declare const require: NodeRequire | undefined;
const _require: NodeRequire =
  typeof require !== 'undefined' ? require : createRequire(import.meta.url);

/** electron-updater autoUpdater 的最小结构（便于注入测试桩）。 */
export interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(ev: string, cb: (info?: unknown) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
}

/** createUpdater 可注入依赖（测试用；生产缺省走 electron / electron-updater）。 */
export interface UpdaterDeps {
  isPackaged?: boolean;
  currentVersion?: string;
  /** 懒加载 autoUpdater；缺省 require('electron-updater').autoUpdater。 */
  loadAutoUpdater?: () => AutoUpdaterLike;
  /** 退出并安装副作用；缺省调用 au.quitAndInstall()。 */
  quitAndInstall?: (au: AutoUpdaterLike) => void;
  /** 启动后延迟检查更新的毫秒数（测试可调小/调大）。默认 3000。 */
  startDelayMs?: number;
}

export interface Updater {
  /** 启动：注册状态回调，并在启动后异步检查更新（发现则静默下载）。 */
  start(onStatus: (s: UpdateStatus) => void): void;
  /** 手动检查更新。 */
  check(): Promise<void>;
  /** 下载完成后退出并安装。返回结果；不可安装时给出可诊断错误（不静默 no-op）。 */
  installUpdate(): Promise<InstallUpdateResult>;
  /** 当前更新状态。 */
  status(): UpdateStatus;
}

function noopUpdater(currentVersion: string): Updater {
  const status: UpdateStatus = { state: 'idle', currentVersion };
  return {
    start(onStatus) { onStatus(status); },
    async check() { /* dev: no-op */ },
    async installUpdate() {
      return { ok: false, error: '当前为开发/未打包环境，自动更新不可用。' };
    },
    status() { return status; },
  };
}

/**
 * 创建自动更新器。未打包时返回 no-op（开发/E2E 不受影响）。
 * electron-updater 在打包后才可用（读取 resources/app-update.yml）。
 */
export function createUpdater(deps: UpdaterDeps = {}): Updater {
  const currentVersion = deps.currentVersion ?? app.getVersion();
  const isPackaged = deps.isPackaged ?? app.isPackaged;
  if (!isPackaged) return noopUpdater(currentVersion);

  let state: UpdateState = 'idle';
  let version: string | undefined;
  let progress: UpdateProgress | undefined;
  let error: string | undefined;
  let onStatusCb: ((s: UpdateStatus) => void) | undefined;
  let autoUpdater: AutoUpdaterLike | undefined;

  const emit = () => onStatusCb?.({ state, version, currentVersion, progress, error });

  const load = deps.loadAutoUpdater ?? (() => {
    const mod = _require('electron-updater') as { autoUpdater: AutoUpdaterLike };
    return mod.autoUpdater;
  });

  try {
    autoUpdater = load();
    autoUpdater.autoDownload = true; // 发现版本后静默下载
    autoUpdater.autoInstallOnAppQuit = false; // 仅用户点击“立即升级”才退出安装
    autoUpdater.on('checking-for-update', () => { state = 'checking'; emit(); });
    autoUpdater.on('update-available', (info: unknown) => {
      state = 'available'; version = (info as { version?: string })?.version; emit();
    });
    autoUpdater.on('update-not-available', () => { state = 'no-update'; emit(); });
    autoUpdater.on('download-progress', (p: unknown) => {
      const pr = p as { percent: number; transferred: number; total: number; bytesPerSecond: number };
      state = 'downloading';
      progress = { percent: pr.percent, transferred: pr.transferred, total: pr.total, bytesPerSecond: pr.bytesPerSecond };
      emit();
    });
    autoUpdater.on('update-downloaded', (info: unknown) => {
      state = 'downloaded'; version = (info as { version?: string })?.version ?? version; emit();
    });
    autoUpdater.on('error', (e: unknown) => {
      // 更新失败不得影响应用：仅记录错误状态。
      state = 'error'; error = (e as Error)?.message ?? String(e); emit();
    });
  } catch {
    // electron-updater 不可用 -> 降级为 no-op，应用照常运行。
    return noopUpdater(currentVersion);
  }

  const doQuitInstall = deps.quitAndInstall ?? ((au: AutoUpdaterLike) => au.quitAndInstall());
  const startDelayMs = deps.startDelayMs ?? 3000;

  return {
    start(onStatus) {
      onStatusCb = onStatus;
      onStatus({ state, version, currentVersion, progress, error });
      // 启动后异步检查（不阻塞 ready），发现版本则静默下载。
      setTimeout(() => {
        autoUpdater?.checkForUpdates().catch(() => { /* 错误已由 error 事件处理 */ });
      }, startDelayMs).unref?.();
    },
    async check() {
      state = 'checking'; emit();
      try {
        await autoUpdater?.checkForUpdates();
      } catch (e) {
        state = 'error'; error = (e as Error)?.message ?? String(e); emit();
      }
    },
    async installUpdate(): Promise<InstallUpdateResult> {
      if (!autoUpdater) {
        state = 'error'; error = '更新模块不可用，无法安装。'; emit();
        return { ok: false, error };
      }
      // 仅在下载完成后安装；否则进入可见 error 状态并返回可诊断信息（绝不静默 no-op）。
      if (state !== 'downloaded') {
        const msg = `当前更新状态为「${state}」，尚未下载完成，无法立即升级。请等待下载完成或点击“检查更新”重试。`;
        state = 'error'; error = msg; emit();
        return { ok: false, error: msg };
      }
      state = 'installing'; error = undefined; emit();
      try {
        doQuitInstall(autoUpdater); // 打包环境：退出并安装，随后重启
        return { ok: true };
      } catch (e) {
        state = 'error'; error = `安装失败：${(e as Error)?.message ?? String(e)}`; emit();
        return { ok: false, error };
      }
    },
    status() {
      return { state, version, currentVersion, progress, error };
    },
  };
}
