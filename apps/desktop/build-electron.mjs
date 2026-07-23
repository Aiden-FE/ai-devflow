// 用 esbuild 打包 main + preload 为 CommonJS，供 Electron 加载。
// 工作区包（TS 源码）被打包进 bundle；electron 与 node 内建模块外部化。
import { build } from 'esbuild';

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

console.log('electron build done -> dist-electron/');
