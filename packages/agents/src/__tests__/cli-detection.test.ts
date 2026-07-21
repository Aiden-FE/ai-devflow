import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { detectByCommand } from '../detect.js';
import { envWithCliPriority, resolveCommand, _resetResolvedPath } from '../resolve-path.js';

let dir: string;

beforeEach(() => {
  _resetResolvedPath();
  dir = mkdtempSync(join(tmpdir(), 'aidf-cli-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 写一个可执行脚本文件（自动创建父目录）。 */
function writeExec(file: string, content: string): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
  chmodSync(file, 0o755);
  return file;
}

describe('envWithCliPriority / resolveCommand', () => {
  it('puts the CLI bin dir first in PATH', () => {
    const env = envWithCliPriority('/some/bin/pi');
    const parts = (env.PATH as string).split(':');
    expect(parts[0]).toBe('/some/bin');
  });

  it('resolveCommand picks the first match in the given PATH (multi-Node)', () => {
    const dirA = join(dir, 'nodeA');
    const dirB = join(dir, 'nodeB');
    writeExec(join(dirA, 'node'), '#!/bin/sh\necho vA\n');
    writeExec(join(dirB, 'node'), '#!/bin/sh\necho vB\n');
    // dirB 优先 -> 命中 dirB/node
    expect(resolveCommand('node', `${dirB}:${dirA}`)).toBe(join(dirB, 'node'));
    // dirA 优先 -> 命中 dirA/node
    expect(resolveCommand('node', `${dirA}:${dirB}`)).toBe(join(dirA, 'node'));
  });

  it('returns the command unchanged when it already contains a dir', () => {
    expect(resolveCommand('/abs/path/pi')).toBe('/abs/path/pi');
  });
});

describe('detectByCommand', () => {
  it('reports not-found (errorKind) for a missing binary', async () => {
    const d = await detectByCommand('pi', join(dir, 'definitely-not-there-xyz'), ['--version']);
    expect(d.available).toBe(false);
    expect(d.errorKind).toBe('not-found');
    expect(d.reason).toMatch(/ENOENT|未找到/);
  });

  it('runs a shebang (env node) CLI using the prioritized PATH node and reports versions', async () => {
    // pi 以 #!/usr/bin/env node 为 shebang；其 bin 目录无 node，env 将解析到 PATH 中真实 node。
    const bin = join(dir, 'bin');
    const pi = writeExec(join(bin, 'pi'), '#!/usr/bin/env node\nconsole.log("pi 9.9.9");\n');
    const d = await detectByCommand('pi', pi, ['--version']);
    expect(d.available).toBe(true);
    expect(d.version).toContain('pi 9.9.9');
    expect(d.path).toBe(pi);
    expect(d.errorKind).toBeUndefined();
    // 诊断信息：Node 版本应可用
    expect(d.nodeVersion).toBeTruthy();
  });

  it('distinguishes incompatible-node when the CLI exists but PATH node is too old', async () => {
    const bin = join(dir, 'oldbin');
    // 旧 node：--version 返回 v0.12.0，但执行 `??=` 探针失败（模拟不支持）。
    writeExec(join(bin, 'node'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "v0.12.0"; exit 0; fi\nexit 1\n');
    // pi 启动即失败（模拟旧 node 解析新语法报错）。
    const pi = writeExec(join(bin, 'pi'), '#!/bin/sh\necho "SyntaxError: Unexpected token ??=" >&2\nexit 1\n');
    const d = await detectByCommand('pi', pi, ['--version']);
    expect(d.available).toBe(false);
    expect(d.errorKind).toBe('incompatible-node');
    expect(d.path).toBe(pi);
    expect(d.nodeVersion).toBe('v0.12.0');
    expect(d.nodePath).toBe(join(bin, 'node'));
    expect(d.reason).toMatch(/Node 运行时|过旧|\?\?=/);
  });

  it('uses the node in the CLI bin dir first (shebang runtime consistency)', async () => {
    // CLI bin 目录内放一个“新 node”（探针通过）；即便系统 PATH 有其它 node，也应优先命中此目录的 node。
    const bin = join(dir, 'newbin');
    writeExec(join(bin, 'node'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "v24.0.0"; exit 0; fi\nexit 0\n');
    const pi = writeExec(join(bin, 'pi'), '#!/bin/sh\necho "pi 1.0.0"\nexit 1\n'); // 仍失败以触发 node 诊断
    const d = await detectByCommand('pi', pi, ['--version']);
    // 命中的是 bin 目录内的 v24.0.0（探针 exit 0 -> 兼容），故不应判为 incompatible-node。
    expect(d.nodeVersion).toBe('v24.0.0');
    expect(d.nodePath).toBe(join(bin, 'node'));
    expect(d.errorKind).not.toBe('incompatible-node');
  });
});
