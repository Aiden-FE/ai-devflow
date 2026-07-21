// 生产启动脚本：构建 renderer + electron，然后启动 Electron 加载打包产物。
import { spawnSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electronBin = require.resolve('electron/cli.js');

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) { process.exit(r.status ?? 1); }
}

console.log('[1/3] build renderer');
run('npx', ['vite', 'build']);
console.log('[2/3] build electron');
run('node', ['build-electron.mjs']);
console.log('[3/3] launch electron');
const env = { ...process.env };
const child = spawn(process.execPath, [electronBin, '.'], { stdio: 'inherit', env });
child.on('exit', (c) => process.exit(c ?? 0));
