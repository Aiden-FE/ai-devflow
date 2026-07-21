// 开发脚本：先构建 main/preload，再启动 vite 渲染器，就绪后启动 Electron。
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);
const electronBin = require.resolve('electron/cli.js');
const env = { ...process.env, AI_DEVFLOW_DEV: '1' };

// 1. 先构建 electron main/preload（一次性，确保 dist-electron 就绪）
console.log('[dev] building electron main/preload...');
const build = spawnSync('node', ['build-electron.mjs'], { stdio: 'inherit', env });
if (build.status !== 0) { console.error('[dev] electron build failed'); process.exit(build.status ?? 1); }

// 2. 启动 vite 渲染器
const vite = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', '--port', '5174', '--strictPort'], {
  stdio: 'inherit',
  env,
  shell: false,
});

// 3. 等待 vite 可访问后启动 electron
const waitFor = (url) => new Promise((resolve) => {
  const check = () => http.get(url, () => resolve(true)).on('error', () => setTimeout(check, 200));
  check();
});

let electron;
const launch = async () => {
  await waitFor('http://127.0.0.1:5174').catch(() => true);
  console.log('[dev] launching electron...');
  electron = spawn(process.execPath, [electronBin, '.'], { stdio: 'inherit', env });
  electron.on('exit', (code) => {
    vite.kill();
    process.exit(code ?? 0);
  });
};
launch();

const cleanup = () => { vite.kill(); electron?.kill(); };
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
