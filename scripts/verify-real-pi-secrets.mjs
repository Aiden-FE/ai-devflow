#!/usr/bin/env node
// 真实测试密钥扫描器（设计 §16.5/§19.2）。从环境变量读取 DEV_API_KEY（缺省则报错退出），
// 递归扫描给定路径下的文件字节是否含该精确密钥。只打印文件名与 PASS/FAIL，绝不打印密钥或匹配内容。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const KEY = process.env.DEV_API_KEY;
if (!KEY) {
  process.stderr.write('[verify-secrets] 缺少 DEV_API_KEY，无法扫描\n');
  process.exit(2);
}
const needle = Buffer.from(KEY, 'utf8');
const targets = process.argv.slice(2);
if (targets.length === 0) {
  process.stderr.write('[verify-secrets] 未提供扫描路径\n');
  process.exit(2);
}

let leaked = false;
let scanned = 0;

function scanFile(file) {
  try {
    const buf = readFileSync(file);
    scanned += 1;
    if (buf.includes(needle)) {
      leaked = true;
      process.stdout.write(`LEAK  ${file}\n`);
    }
  } catch {
    // 跳过不可读文件
  }
}

function walk(p) {
  let st;
  try {
    st = statSync(p);
  } catch {
    return;
  }
  if (st.isFile()) {
    scanFile(p);
    return;
  }
  if (st.isDirectory()) {
    for (const name of readdirSync(p)) {
      // 跳过符号链接指向的 .pnpm 大目录中的 node_modules 二进制（仅扫描文本类产物即可覆盖泄露面）。
      walk(join(p, name));
    }
  }
}

for (const t of targets) walk(t);

if (leaked) {
  process.stdout.write(`[verify-secrets] FAIL：在 ${scanned} 个文件中检测到密钥泄露\n`);
  process.exit(1);
}
process.stdout.write(`[verify-secrets] PASS：扫描 ${scanned} 个文件，未发现密钥泄露\n`);
