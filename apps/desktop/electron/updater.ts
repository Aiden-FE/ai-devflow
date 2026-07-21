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
//
// 关键修复（未签名 macOS 无法自动安装）：
// - Squirrel.Mac 要求应用已代码签名；未签名应用调用 quitAndInstall 会静默失败或无限等待。
// - 在 darwin + app.isPackaged 时检测当前 .app bundle 签名；未签名/检测异常时改为打开 GitHub Releases
//   手动下载，不进入 installing，保持 downloaded 状态允许再次点击。
// - 安装请求发起后增加可注入超时；异步 error 或超时时从 installing 回到可恢复 error，并清理计时器。
import { app, shell } from 'electron';
import { execFile } from 'node:child_process';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import type { UpdateStatus, UpdateState, UpdateProgress, InstallUpdateResult } from '@ai-devflow/core';

// 兼容 esbuild CJS 打包（import.meta 为空）与 vitest/vite ESM：
// 优先用 CJS 的 require，缺失时回退到 createRequire(import.meta.url)。
declare const require: NodeRequire | undefined;
const _require: NodeRequire =
  typeof require !== 'undefined' ? require : createRequire(import.meta.url);

/** 未签名 macOS 应用的固定手动下载地址（主进程常量，Renderer 无法传入任意 URL）。 */
export const MANUAL_DOWNLOAD_URL = 'https://github.com/Aiden-FE/ai-devflow/releases/latest';

/** electron-updater autoUpdater 的最小结构（便于注入测试桩）。 */
export interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(ev: string, cb: (info?: unknown) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
}

/** createUpdater 可注入依赖（测试用；生产缺省走 electron / electron-updater / codesign / shell）。 */
export interface UpdaterDeps {
  isPackaged?: boolean;
  currentVersion?: string;
  /** 懒加载 autoUpdater；缺省 require('electron-updater').autoUpdater。 */
  loadAutoUpdater?: () => AutoUpdaterLike;
  /** 退出并安装副作用；缺省调用 au.quitAndInstall()。 */
  quitAndInstall?: (au: AutoUpdaterLike) => void;
  /** 启动后延迟检查更新的毫秒数（测试可调小/调大）。默认 3000。 */
  startDelayMs?: number;
  /** 当前平台；缺省 process.platform。 */
  platform?: NodeJS.Platform;
  /** 当前可执行文件路径；缺省 process.execPath，仅用于 macOS 签名检测推导 .app bundle。 */
  execPath?: string;
  /** macOS 代码签名检测器；缺省用 /usr/bin/codesign 检测当前完整 .app bundle。 */
  checkSignature?: (appPath: string) => Promise<boolean>;
  /** 手动下载时打开外部浏览器；缺省 shell.openExternal。 */
  openExternal?: (url: string) => Promise<void>;
  /** 调用 quitAndInstall 后等待应用退出的超时（毫秒）。默认 60000。 */
  installTimeoutMs?: number;
}

export interface Updater {
  /** 启动：注册状态回调，并在启动后异步检查更新（发现则静默下载）。 */
  start(onStatus: (s: UpdateStatus) => void): void;
  /** 手动检查更新。 */
  check(): Promise<void>;
  /** 下载完成后退出并安装，或未签名 macOS 时打开 GitHub Releases。返回结果；不可安装时给出可诊断错误（不静默 no-op）。 */
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

/** 从 process.execPath 安全推导 .app bundle 根路径；找不到时返回 undefined。 */
function deriveAppBundlePath(execPath: string): string | undefined {
  let dir = execPath;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const parent = dirname(dir);
    if (parent === dir) break;
    if (dir.endsWith('.app')) return dir;
    dir = parent;
  }
  return undefined;
}

/** 默认 macOS 签名检测：使用参数数组调用 /usr/bin/codesign，退出码 0 视为已签名。 */
async function defaultCheckSignature(appPath: string): Promise<boolean> {
  if (process.platform !== 'darwin' || !appPath) return false;
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/codesign',
      ['--verify', '--deep', '--strict', '--verbose=2', appPath],
      (err) => resolve(err === null),
    );
  });
}

/**
 * 创建自动更新器。未打包时返回 no-op（开发/E2E 不受影响）。
 * electron-updater 在打包后才可用（读取 resources/app-update.yml）。
 */
export function createUpdater(deps: UpdaterDeps = {}): Updater {
  const currentVersion = deps.currentVersion ?? app.getVersion();
  const isPackaged = deps.isPackaged ?? app.isPackaged;
  if (!isPackaged) return noopUpdater(currentVersion);

  const platform = deps.platform ?? process.platform;
  const startDelayMs = deps.startDelayMs ?? 3000;
  const installTimeoutMs = deps.installTimeoutMs ?? 60_000;

  let state: UpdateState = 'idle';
  let version: string | undefined;
  let progress: UpdateProgress | undefined;
  let error: string | undefined;
  let onStatusCb: ((s: UpdateStatus) => void) | undefined;
  let autoUpdater: AutoUpdaterLike | undefined;
  let installTimer: ReturnType<typeof setTimeout> | undefined;

  const emit = () => onStatusCb?.({ state, version, currentVersion, progress, error });

  const clearInstallTimer = () => {
    if (installTimer) {
      clearTimeout(installTimer);
      installTimer = undefined;
    }
  };

  const load = deps.loadAutoUpdater ?? (() => {
    const mod = _require('electron-updater') as { autoUpdater: AutoUpdaterLike };
    return mod.autoUpdater;
  });

  const doQuitInstall = deps.quitAndInstall ?? ((au: AutoUpdaterLike) => au.quitAndInstall());
  const doOpenExternal = deps.openExternal ?? ((url: string) => shell.openExternal(url));
  const checkSignature = deps.checkSignature ?? defaultCheckSignature;

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
      // 安装过程中收到异步错误时清理计时器，避免超时覆盖具体错误。
      clearInstallTimer();
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
      clearInstallTimer();
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

      // macOS 打包环境：未签名应用无法自动安装，引导用户手动下载。
      if (platform === 'darwin') {
        const appPath = deriveAppBundlePath(deps.execPath ?? process.execPath);
        const signed = await checkSignature(appPath ?? '').catch(() => false);
        if (!signed) {
          try {
            await doOpenExternal(MANUAL_DOWNLOAD_URL);
            // 保持 downloaded 状态，允许用户再次点击。
            return { ok: true, action: 'manual-download', arch: process.arch };
          } catch (e) {
            const msg = `打开 GitHub Releases 失败：${(e as Error)?.message ?? String(e)}`;
            state = 'error'; error = msg; emit();
            return { ok: false, error: msg };
          }
        }
      }

      // 自动安装路径（已签名 macOS / Windows / Linux）。
      state = 'installing'; error = undefined; emit();
      try {
        doQuitInstall(autoUpdater); // 打包环境：请求退出并安装，随后重启
        installTimer = setTimeout(() => {
          installTimer = undefined;
          if (state === 'installing') {
            state = 'error';
            error = `安装超时：应用未在 ${installTimeoutMs}ms 内退出，可能安装器未正常运行。请检查更新包或稍后重试。`;
            emit();
          }
        }, installTimeoutMs);
        installTimer.unref?.();
        return { ok: true, action: 'install-started' };
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
