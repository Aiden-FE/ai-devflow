// Electron 主进程入口。
// 安全：nodeIntegration=false、contextIsolation=true、sandbox=true、严格 CSP、显式 IPC。
import { app, BrowserWindow, session, protocol, shell, nativeTheme } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { createServices } from './services.js';
import { registerIpc } from './ipc.js';
import { ElectronNotifier, parseDeepLink } from './notifier.js';
import type { Services } from './services.js';
import type { StreamEvent, AiStreamEvent } from './api.js';
import type { ThemeMode } from '@ai-devflow/core';

// esbuild 打包为 CJS，__dirname 指向 dist-electron/。
declare const __dirname: string;
const isDev = !app.isPackaged && process.env.AI_DEVFLOW_DEV === '1';

let mainWindow: BrowserWindow | undefined;
let services: Services | undefined;
let pendingDeepLinkTaskId: string | undefined;

/** 读取持久化主题模式（默认 system）。 */
function readThemeMode(svc: Services): ThemeMode {
  const raw = svc.repos.credentials.get('theme');
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system';
}

function createWindow(backgroundColor: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => win.show());

  if (isDev) {
    win.loadURL('http://127.0.0.1:5174');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(join(__dirname, '../dist/index.html'));
  }

  // 拦截外部链接，用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  return win;
}

function installCsp(): void {
  // 严格 CSP：禁止远程脚本与内联脚本；开发模式放宽以支持 vite HMR。
  const csp = isDev
    ? "default-src 'self' 'unsafe-inline' http://127.0.0.1:5174 ws://127.0.0.1:5174; img-src 'self' data: blob:;"
    : "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline';";
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });
}

function registerDeepLinkProtocol(): void {
  // 注册 ai-devflow:// 协议，用于桌面通知深链定位任务。
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('ai-devflow', process.execPath, [existsSync(process.argv[1]!) ? process.argv[1]! : '']);
    }
  } else {
    app.setAsDefaultProtocolClient('ai-devflow');
  }
  protocol.handle('ai-devflow', (request) => {
    const parsed = parseDeepLink(request.url);
    if (parsed?.taskId) {
      handleDeepLink(parsed.taskId);
    }
    return new Response('', { status: 200 });
  });
}

function handleDeepLink(taskId: string): void {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    mainWindow.webContents.send('ai-devflow:deep-link', { taskId });
  } else {
    pendingDeepLinkTaskId = taskId;
  }
}

app.whenReady().then(async () => {
  // 支持自定义 userData 目录（E2E 隔离用）
  if (process.env.AI_DEVFLOW_USER_DATA) {
    app.setPath('userData', process.env.AI_DEVFLOW_USER_DATA);
  }
  // Pi-only：内置 Pi 经绝对入口启动，不依赖 PATH 中的外部 CLI，故不再增强 PATH。
  installCsp();
  registerDeepLinkProtocol();

  const notifier = new ElectronNotifier(() => mainWindow, (taskId) => handleDeepLink(taskId));
  services = createServices(notifier);

  // 主题：在创建窗口前应用 nativeTheme.themeSource 与窗口背景，避免亮色启动闪黑。
  const mode = readThemeMode(services);
  nativeTheme.themeSource = mode;
  const bg = (mode === 'dark' || (mode === 'system' && nativeTheme.shouldUseDarkColors)) ? '#0f1115' : '#ffffff';
  mainWindow = createWindow(bg);

  const send = (e: StreamEvent) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ai-devflow:stream', e);
    }
  };
  const sendAi = (e: AiStreamEvent) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ai-devflow:ai-stream', e);
    }
  };
  registerIpc(services, send, sendAi);

  // 应用重启后恢复运行中/待沟通任务
  try {
    await services.orchestrator.recover();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[recover] error:', (err as Error).message);
  }

  if (pendingDeepLinkTaskId) {
    handleDeepLink(pendingDeepLinkTaskId);
    pendingDeepLinkTaskId = undefined;
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const m = services ? readThemeMode(services) : 'system';
      const bg = (m === 'dark' || (m === 'system' && nativeTheme.shouldUseDarkColors)) ? '#0f1115' : '#ffffff';
      createWindow(bg);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// macOS 深链触发
app.on('open-url', (event, url) => {
  event.preventDefault();
  const parsed = parseDeepLink(url);
  if (parsed?.taskId) handleDeepLink(parsed.taskId);
});
