#!/usr/bin/env node
// Inspect unpacked Electron applications and prove the bundled Pi runtime is complete and isolated.
// Usage: node apps/desktop/scripts/verify-packaged-pi.mjs <release-root>
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { arch as hostArch, platform as hostPlatform } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

const EXPECTED_PI_VERSION = '0.80.10';
const DEV_KEY_NAME = Buffer.from('DEV_API_KEY');
// Assemble these signatures so the inspector itself does not trip the source-tree
// legacy-reference audit that it helps enforce on packaged bytes.
const LEGACY_PAYLOAD_SIGNATURES = [
  ['Claude', 'CodeAdapter'].join(''),
  ['Codex', 'Adapter'].join(''),
  ['Agent', 'Registry'].join(''),
  ['claude', '_code'].join(''),
  ['createDefault', 'Registry'].join(''),
  ['detect', 'All'].join(''),
  ['detectByCommand("', 'claude', '_code"'].join(''),
  ['detectByCommand("', 'codex"'].join(''),
  ['detectByCommand("', 'pi"'].join(''),
  ['DEFAULT_CMD = "', 'claude"'].join(''),
  ['DEFAULT_CMD = "', 'codex"'].join(''),
  ['DEFAULT_CMD = "', 'pi"'].join(''),
].map((value) => Buffer.from(value));

function fail(message) {
  throw new Error(message);
}

function ok(message) {
  process.stdout.write(`[verify-packaged-pi] ✓ ${message}\n`);
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function inferArch(name) {
  const value = name.toLowerCase();
  if (value.includes('arm64') || value.includes('aarch64')) return 'arm64';
  if (value.includes('universal')) return 'universal';
  // electron-builder's unqualified mac/win/linux unpacked output is x64.
  return 'x64';
}

function appDescriptor(root, dir, platform, resourcesDir, executable) {
  return {
    dir,
    platform,
    arch: inferArch(relative(root, dir)),
    resourcesDir,
    executable,
    asar: join(resourcesDir, 'app.asar'),
    runtimeDir: join(resourcesDir, 'pi-runtime'),
  };
}

function findUnpackedApps(root) {
  const apps = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (!isDirectory(path)) continue;
      const macResources = join(path, 'Contents', 'Resources');
      if (existsSync(join(macResources, 'app.asar'))) {
        apps.push(appDescriptor(root, path, 'darwin', macResources, join(path, 'Contents', 'MacOS', 'ai-devflow')));
        continue;
      }
      const resources = join(path, 'resources');
      if (existsSync(join(resources, 'app.asar'))) {
        const platform = name.toLowerCase().includes('win')
          ? 'win32'
          : name.toLowerCase().includes('linux')
            ? 'linux'
            : process.platform;
        const executable = platform === 'win32' ? join(path, 'ai-devflow.exe') : join(path, 'ai-devflow');
        apps.push(appDescriptor(root, path, platform, resources, executable));
        continue;
      }
      walk(path);
    }
  };
  walk(root);
  return apps.sort((a, b) => a.dir.localeCompare(b.dir));
}

function collectRegularFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const status = lstatSync(path);
      if (status.isSymbolicLink()) continue;
      if (status.isDirectory()) walk(path);
      else if (status.isFile()) files.push(path);
    }
  };
  walk(root);
  return files;
}

function safeRuntimePath(runtimeDir, rel) {
  const path = resolve(runtimeDir, rel);
  if (path !== runtimeDir && !path.startsWith(`${runtimeDir}${sep}`)) fail(`manifest 包含越界路径：${rel}`);
  return path;
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function verifyManifest(app) {
  const manifestPath = join(app.runtimeDir, 'runtime-manifest.json');
  if (!existsSync(manifestPath)) fail(`runtime manifest 不存在：${manifestPath}`);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    fail(`runtime manifest 无法解析：${manifestPath}`);
  }
  if (manifest.schemaVersion !== 1) fail(`runtime manifest schemaVersion 不匹配：${manifest.schemaVersion}`);
  if (manifest.piVersion !== EXPECTED_PI_VERSION) fail(`Pi 版本不匹配：${manifest.piVersion}`);
  if (typeof manifest.entry !== 'string' || manifest.entry.length === 0) fail('runtime manifest 缺少 entry');
  if (!manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) fail('runtime manifest 缺少 files');

  const entry = safeRuntimePath(app.runtimeDir, manifest.entry);
  if (!existsSync(entry) || !statSync(entry).isFile()) fail(`Pi 入口不存在：${manifest.entry}`);

  const actualFiles = collectRegularFiles(app.runtimeDir)
    .map((path) => relative(app.runtimeDir, path).split(sep).join('/'))
    .filter((rel) => rel !== 'runtime-manifest.json')
    .sort();
  const listedFiles = Object.keys(manifest.files).sort();
  for (const rel of actualFiles) {
    if (!Object.hasOwn(manifest.files, rel)) fail(`runtime manifest 缺少依赖文件：${rel}`);
  }
  for (const rel of listedFiles) {
    const path = safeRuntimePath(app.runtimeDir, rel);
    if (!existsSync(path) || !statSync(path).isFile()) fail(`runtime 依赖文件缺失：${rel}`);
    const expected = manifest.files[rel];
    const actual = sha256File(path);
    if (typeof expected !== 'string' || actual !== expected) fail(`runtime 摘要校验失败：${rel}`);
  }
  ok(`${relative(process.cwd(), app.dir)}: Pi ${manifest.piVersion}，${listedFiles.length} 个摘要通过`);
  return { entry, manifest };
}

function fileContainsAny(path, needles) {
  const longest = Math.max(...needles.map((needle) => needle.length));
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let carry = Buffer.alloc(0);
  const fd = openSync(path, 'r');
  try {
    for (;;) {
      const bytes = readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) return undefined;
      const window = Buffer.concat([carry, buffer.subarray(0, bytes)]);
      const match = needles.find((needle) => window.indexOf(needle) !== -1);
      if (match) return match;
      carry = window.subarray(Math.max(0, window.length - longest + 1));
    }
  } finally {
    closeSync(fd);
  }
}

function verifyPayload(app) {
  const files = collectRegularFiles(app.dir);
  const envFile = files.find((path) => basename(path) === '.env');
  if (envFile) fail(`打包产物包含 .env：${relative(app.dir, envFile)}`);

  for (const path of files) {
    if (fileContainsAny(path, [DEV_KEY_NAME])) fail(`打包产物包含禁止的开发密钥变量字节：${relative(app.dir, path)}`);
  }

  const unpackedPayload = join(app.resourcesDir, 'app.asar.unpacked');
  const payloadFiles = [app.asar, ...(isDirectory(unpackedPayload) ? collectRegularFiles(unpackedPayload) : [])];
  for (const path of payloadFiles) {
    const match = fileContainsAny(path, LEGACY_PAYLOAD_SIGNATURES);
    if (match) fail(`打包应用仍包含旧适配器源码或命令字符串：${match.toString('utf8')}`);
  }
  ok(`${relative(process.cwd(), app.dir)}: 无 .env、DEV_API_KEY 字节或旧适配器负载`);
}

function verifyHostExecutable(app, entry) {
  if (!existsSync(app.executable)) fail(`Electron 可执行文件不存在：${app.executable}`);
  const result = spawnSync(app.executable, [entry, '--version'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    shell: false,
    timeout: 30_000,
  });
  const version = (result.stdout ?? '').trim();
  if (result.error || result.status !== 0 || version !== EXPECTED_PI_VERSION) {
    fail(`主机架构 Pi --version 校验失败（status=${result.status ?? 'null'}）`);
  }
  ok(`${relative(process.cwd(), app.dir)}: 主机 ${process.platform}/${process.arch} Pi ${version}`);
}

function main() {
  const arg = process.argv[2];
  if (!arg || process.argv.length !== 3) fail('用法：node verify-packaged-pi.mjs <release-root>');
  const releaseRoot = resolve(arg);
  if (!isDirectory(releaseRoot)) fail(`release root 不存在：${releaseRoot}`);
  const apps = findUnpackedApps(releaseRoot);
  if (apps.length === 0) fail(`未在 ${releaseRoot} 找到包含 resources/app.asar 的 unpacked 应用`);

  const hostMatches = apps.filter((app) => app.platform === hostPlatform() && app.arch === hostArch());
  if (hostMatches.length !== 1) {
    fail(`与主机 ${hostPlatform()}/${hostArch()} 匹配的 unpacked 应用必须恰好一个，实际 ${hostMatches.length} 个`);
  }

  for (const app of apps) {
    process.stdout.write(`[verify-packaged-pi] 校验 ${app.dir} (${app.platform}/${app.arch})\n`);
    const { entry } = verifyManifest(app);
    verifyPayload(app);
    if (app === hostMatches[0]) verifyHostExecutable(app, entry);
  }
  process.stdout.write(`[verify-packaged-pi] ALL PASSED (${apps.length} unpacked application${apps.length === 1 ? '' : 's'})\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`[verify-packaged-pi] ✗ ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
