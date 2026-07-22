#!/usr/bin/env node
// 真实 Pi 集成测试入口（设计 §16.5）。由根 `pnpm test:real:pi` 调用（node --env-file=.env）。
// 职责：预检四变量与 .env ignore；以子进程运行 vitest 真实测试并对输出做与生产一致的脱敏；
// 在内存中检测原始输出是否泄露 DEV_API_KEY；finally 中扫描产物。绝不打印密钥/响应正文/env 快照。
import { execFileSync, execSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED = ['DEV_API_KEY', 'DEV_API_URL', 'DEV_API_DEFAULT_MODEL', 'DEV_API_TYPE'];

function fail(msg) {
  process.stderr.write(`[test:real:pi] ${msg}\n`);
  process.exitCode = 1;
}

// 预检 1：四变量非空（不打印值）。
for (const v of REQUIRED) {
  if (!process.env[v] || !process.env[v].trim()) {
    fail(`缺少必需环境变量 ${v}（见 .env.example）`);
  }
}
// 预检 2：.env 仍被 Git ignore。
try {
  const ignored = execSync('git check-ignore .env', { cwd: REPO_ROOT }).toString().trim();
  if (!ignored.includes('.env')) fail('.env 未被 Git ignore，禁止运行真实测试');
} catch {
  fail('.env 未被 Git ignore（git check-ignore 失败），禁止运行真实测试');
}
if (process.exitCode) process.exit(process.exitCode);

const KEY = process.env.DEV_API_KEY;
const outDir = mkdtempSync(join(tmpdir(), 'real-pi-out-'));
const redactedLog = join(outDir, 'redacted.log');
let rawLeaked = false;
let logBuf = '';

function redact(text) {
  // 先精确替换密钥，再做通用脱敏（与生产 redactText 同源策略的简化版）。
  let out = KEY ? text.split(KEY).join('***') : text;
  out = out.replace(/sk-[A-Za-z0-9_\-]{16,}/g, 'sk-***');
  out = out.replace(/Bearer\s+[A-Za-z0-9._\-]{8,}/gi, 'Bearer ***');
  out = out.replace(/[A-Za-z0-9_\-]{32,}/g, (m) => (m === KEY ? '***' : m));
  return out;
}

console.log(`[test:real:pi] 运行真实内置 Pi 端到端测试（输出目录 ${outDir}）`);

const child = spawn(
  process.execPath,
  [join(REPO_ROOT, 'node_modules/vitest/vitest.mjs'), 'run', 'packages/agents/src/__tests__/real-pi.test.ts', '--no-file-parallelism', '--reporter=basic'],
  { cwd: REPO_ROOT, env: { ...process.env, REAL_PI_OUTPUT_DIR: outDir } },
);

child.stdout.on('data', (chunk) => {
  const raw = chunk.toString('utf8');
  if (KEY && raw.includes(KEY)) rawLeaked = true;
  const safe = redact(raw);
  process.stdout.write(safe);
  logBuf += safe;
});
child.stderr.on('data', (chunk) => {
  const raw = chunk.toString('utf8');
  if (KEY && raw.includes(KEY)) rawLeaked = true;
  const safe = redact(raw);
  process.stderr.write(safe);
  logBuf += safe;
});

let code = 1;
let scanFailed = false;
try {
  code = await new Promise((resolveExit) => {
    child.once('error', () => resolveExit(1));
    child.once('exit', (exitCode) => resolveExit(exitCode ?? 1));
  });
} finally {
  writeFileSync(redactedLog, logBuf);
  // 保留并递归扫描整棵真实测试产物（journal/SQLite/流日志/profile/session/fixture），
  // 以及 staging runtime；扫描完成前不得清理任何测试产物。
  try {
    execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts/verify-real-pi-secrets.mjs'),
        outDir,
        join(REPO_ROOT, 'apps/desktop/build/pi-runtime'),
      ],
      { cwd: REPO_ROOT, stdio: 'inherit', env: process.env },
    );
  } catch {
    scanFailed = true;
  }
}

if (rawLeaked) fail('原始测试输出中检测到 DEV_API_KEY 泄露');
if (scanFailed) fail('产物密钥扫描未通过');
if (code !== 0) fail(`真实测试失败（vitest 退出码 ${code}）`);
if (!rawLeaked && !scanFailed && code === 0) {
  console.log('[test:real:pi] 通过：四角色/交互/真实路由降级/并发隔离验证成功，完整产物无密钥泄露');
}
process.exit(process.exitCode ?? code);
