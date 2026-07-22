#!/usr/bin/env node
// 构建期内置 Pi staging（设计 §6.2）。
//
// 1. 仅删除 apps/desktop/build/pi-runtime（不动其它构建产物）。
// 2. pnpm deploy --prod --legacy 把 @ai-devflow/pi-runtime-bundle 的精确 Pi 依赖闭包部署到 staging。
//    保留 pnpm 的 .pnpm 符号链接结构（Node 依 realpath 解析 Pi 的传递依赖）。
// 3. 从已部署 Pi 的 package.json 解析 bin.pi，禁止硬编码内部路径。
// 4. 对 staging 内所有常规文件计算 sha256，并绑定全部符号链接的归一化路径与原始 target。
// 5. 生成 runtime-manifest.json：schemaVersion / piVersion / entry / profilesDigest / files / links。
//    profiles 资源（Task 6 起存在）复制到 profiles/ 并对全部角色文件计算 digest；缺失则 profilesDigest=null。
//
// 该脚本只在显式构建命令中运行；应用启动、普通测试、打包不得调用它读取 .env。
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync,
  readlinkSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPiCatalogGate } from './pi-catalog-gate.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = resolve(SCRIPT_DIR, '..');
const REPO_ROOT = resolve(DESKTOP_ROOT, '../..');
const STAGE_DIR = join(DESKTOP_ROOT, 'build', 'pi-runtime');
const PROFILES_SRC = join(REPO_ROOT, 'packages', 'agents', 'assets', 'profiles');
const ROLES = ['planner', 'coder', 'reviewer', 'tester'];

function log(msg) {
  process.stdout.write(`[stage-pi] ${msg}\n`);
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * 为嵌套调用的 pnpm 构造干净环境：stage:pi 常由 `pnpm ... stage:pi` 触发，父 pnpm 注入的
 * npm_config_、npm_lifecycle_、npm_package_、PNPM_ 前缀变量会让 deploy 内部的 install --production
 * 误判 modules 目录并弹交互式清理确认（无 TTY 即失败）。剥离这些变量并设 CI=true，使其等价于
 * 干净 shell 调用。PATH/HOME 等保留；electron 镜像由仓库 .npmrc 提供，无需经 env。
 */
function cleanEnvForPnpm() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('npm_config_') || k.startsWith('npm_lifecycle_') || k.startsWith('npm_package_') || k.startsWith('PNPM_')) continue;
    env[k] = v;
  }
  env.CI = 'true';
  return env;
}

function normalizedRelative(root, path) {
  return relative(root, path).split(sep).join('/');
}

function isWithin(root, path) {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** 递归收集常规文件和符号链接条目；不跟随链接重复遍历目标。 */
function collectRuntimeEntries(root) {
  const files = [];
  const links = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) {
        links.set(normalizedRelative(root, abs), readlinkSync(abs));
        continue;
      }
      if (st.isDirectory()) walk(abs);
      else if (st.isFile()) files.push(abs);
    }
  };
  walk(root);
  return { files, links };
}

function validateLinkGraph(root, links) {
  const realRoot = realpathSync(root);
  for (const rel of links.keys()) {
    const abs = join(root, rel);
    let target;
    try {
      target = realpathSync(abs);
    } catch {
      throw new Error(`staging 失败：符号链接目标不存在 ${rel}`);
    }
    if (!isWithin(realRoot, target)) throw new Error(`staging 失败：符号链接逃逸运行时根 ${rel}`);
  }
}

function computeDirDigest(root) {
  const files = collectRuntimeEntries(root).files.sort();
  const hash = createHash('sha256');
  for (const f of files) {
    hash.update(relative(root, f));
    hash.update('\0');
    hash.update(sha256File(f));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function main() {
  // 1. 仅清理既有 staging。
  if (existsSync(STAGE_DIR)) {
    log(`清理旧 staging：${STAGE_DIR}`);
    rmSync(STAGE_DIR, { recursive: true, force: true });
  }
  mkdirSync(STAGE_DIR, { recursive: true });

  // 2. 部署精确 Pi 依赖闭包（保留符号链接结构）。
  log('部署 @ai-devflow/pi-runtime-bundle 依赖闭包…');
  execSync(`pnpm --filter @ai-devflow/pi-runtime-bundle deploy --prod --legacy "${STAGE_DIR}"`, {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: cleanEnvForPnpm(),
  });

  // legacy deploy 会在虚拟存储的公共 node_modules 中留下指回 workspace 源码的“根包自身”链接。
  // 它不是 Pi 依赖闭包的一部分（根 package.json 已在 STAGE_DIR），打包后也会变成断链，故在入清单前删除。
  const workspaceBacklink = join(STAGE_DIR, 'node_modules', '.pnpm', 'node_modules', '@ai-devflow', 'pi-runtime-bundle');
  if (existsSync(workspaceBacklink) && lstatSync(workspaceBacklink).isSymbolicLink()) rmSync(workspaceBacklink);

  // 3. 解析 bin.pi（禁止硬编码）。
  const piTopPkg = join(STAGE_DIR, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json');
  if (!existsSync(piTopPkg)) throw new Error('staging 失败：未找到 @earendil-works/pi-coding-agent');
  const piPkg = JSON.parse(readFileSync(realpathSync(piTopPkg), 'utf8'));
  const bin = typeof piPkg.bin === 'string' ? piPkg.bin : piPkg.bin?.pi;
  if (!bin) throw new Error('staging 失败：Pi 包缺少 bin.pi');
  const entry = `node_modules/@earendil-works/pi-coding-agent/${bin.replace(/^\.?\//, '')}`;
  const piVersion = piPkg.version;
  log(`Pi 版本 ${piVersion}，入口 ${entry}`);

  const compatibility = runPiCatalogGate(join(STAGE_DIR, entry));
  log(`离线兼容门禁通过（${compatibility.modelCount} 个模型，${compatibility.toolCount} 个内置工具）`);

  // 4. 角色资源（Task 6 起存在则复制并计算 digest）。
  let profilesDigest = null;
  if (existsSync(PROFILES_SRC)) {
    const missing = ROLES.filter((r) => !existsSync(join(PROFILES_SRC, r)));
    if (missing.length > 0) throw new Error(`staging 失败：角色资源不完整，缺少 ${missing.join(', ')}`);
    const profilesDest = join(STAGE_DIR, 'profiles');
    cpSync(PROFILES_SRC, profilesDest, { recursive: true });
    profilesDigest = computeDirDigest(profilesDest);
    log(`角色资源摘要 ${profilesDigest}`);
  } else {
    log('角色资源尚不存在（Task 6 之前），profilesDigest=null');
  }

  // 5. 计算全部常规文件摘要，并绑定完整符号链接图后写 manifest。
  log('计算运行时文件摘要…');
  const entries = collectRuntimeEntries(STAGE_DIR);
  validateLinkGraph(STAGE_DIR, entries.links);
  const files = {};
  for (const f of entries.files.sort()) {
    const rel = normalizedRelative(STAGE_DIR, f);
    if (rel === 'runtime-manifest.json') continue;
    files[rel] = sha256File(f);
  }
  const links = Object.fromEntries([...entries.links.entries()].sort(([a], [b]) => a.localeCompare(b)));
  // schemaVersion 1 的增量字段：旧读取器会忽略 links，新包装门禁强制它存在并精确匹配。
  const manifest = { schemaVersion: 1, piVersion, entry, profilesDigest, files, links };
  writeFileSync(join(STAGE_DIR, 'runtime-manifest.json'), JSON.stringify(manifest, null, 2));
  const count = Object.keys(files).length;
  log(`已生成 runtime-manifest.json（${count} 个文件摘要，${entries.links.size} 个符号链接，入口 ${entry}，版本 ${piVersion}）`);

  // 构建期入口与版本快速校验（不依赖 Electron）。
  execSync(`node "${join(STAGE_DIR, entry)}" --version`, { stdio: ['ignore', 'inherit', 'inherit'] });
  log('staging 完成并通过入口 --version 校验');
}

main();
