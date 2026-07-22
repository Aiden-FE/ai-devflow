#!/usr/bin/env node
// 对已打包的 release 目录中 pi-runtime 的绝对路径符号链接进行规范化（Windows）。
// electron-builder 复制 extraResources 时可能将 stage 阶段已规范化的相对符号链接重新解析为绝对路径。
// 此脚本在 electron-builder --dir 后、verify-packaged-pi 前运行，确保 manifest 校验通过。
import {
  existsSync, lstatSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

function normalizedRelative(root, path) {
  return relative(root, path).split(sep).join('/');
}

function isWithin(root, path) {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function normalizeAbsoluteSymlinks(root) {
  if (process.platform !== 'win32') return;
  const realRoot = realpathSync(root);
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const st = lstatSync(abs);
      if (st.isDirectory()) { walk(abs); continue; }
      if (!st.isSymbolicLink()) continue;
      const target = readlinkSync(abs);
      if (!isAbsolute(target)) continue;
      const resolved = realpathSync(abs);
      if (!isWithin(realRoot, resolved)) {
        throw new Error(`发现指向 runtime 外部的绝对符号链接 ${normalizedRelative(root, abs)} -> ${target}`);
      }
      const relTarget = normalizedRelative(dirname(abs), resolved);
      rmSync(abs);
      const isDir = statSync(resolved).isDirectory();
      symlinkSync(relTarget, abs, isDir ? 'dir' : 'file');
    }
  };
  walk(realRoot);
}

const arg = process.argv[2];
if (!arg) { console.error('用法：node normalize-pi-symlinks.mjs <release-root>'); process.exit(1); }

const releaseRoot = arg;
const dirs = readdirSync(releaseRoot, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => join(releaseRoot, d.name));

for (const dir of dirs) {
  const runtimeDir = join(dir, 'resources', 'pi-runtime');
  if (existsSync(runtimeDir)) {
    normalizeAbsoluteSymlinks(runtimeDir);
    console.log(`[normalize-pi-symlinks] 已规范化 ${runtimeDir}`);
  }
}
