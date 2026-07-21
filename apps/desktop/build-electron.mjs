// 用 esbuild 打包 main + preload 为 CommonJS，供 Electron 加载。
// 工作区包（TS 源码）被打包进 bundle；electron 与 node 内建模块外部化。
import { build } from 'esbuild';

const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
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
