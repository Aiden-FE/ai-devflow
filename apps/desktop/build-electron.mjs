// 用 esbuild 打包 main + preload 为 CommonJS，供 Electron 加载。
// 工作区包（TS 源码）被打包进 bundle；electron 与 node 内建模块外部化。
import { build } from 'esbuild';
import { cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  // electron: 运行时提供；electron-updater: 由 electron-builder 打包进 asar，运行时从 node_modules require（懒加载）。
  external: ['electron', 'electron-updater'],
  sourcemap: 'linked',
  logLevel: 'info',
  outExtension: { '.js': '.cjs' },
  outdir: 'dist-electron',
};

await build({
  ...shared,
  entryPoints: ['electron/main.ts'],
});

await build({
  ...shared,
  entryPoints: ['electron/preload.ts'],
});

// 静态资源（对话路径技能 assets/chat/skills/ 等）随产物拷贝到 dist-electron/assets，
// 与 pi-ai.ts 中基于 import.meta.url 解析的 CHAT_ASSETS_ROOT 对齐（dev 与打包一致）。
cpSync(join(here, 'electron', 'assets'), join(here, 'dist-electron', 'assets'), { recursive: true });

console.log('electron build done -> dist-electron/');
