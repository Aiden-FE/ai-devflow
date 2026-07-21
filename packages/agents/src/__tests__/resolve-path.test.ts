import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolveAgentPath, envWithAgentPath, _resetResolvedPath } from '../resolve-path.js';

describe('resolveAgentPath (修复 GUI 应用 PATH 缺失)', () => {
  beforeEach(() => _resetResolvedPath());

  it('returns a non-empty PATH that preserves existing entries', () => {
    const orig = process.env.PATH ?? '';
    const p = resolveAgentPath();
    expect(p.length).toBeGreaterThan(0);
    const parts = p.split(':');
    for (const part of orig.split(':').filter(Boolean)) {
      expect(parts).toContain(part);
    }
  });

  it('includes ~/.local/bin when it exists (claude/codex 常装于此)', () => {
    const dir = join(homedir(), '.local', 'bin');
    const p = resolveAgentPath();
    if (existsSync(dir)) {
      expect(p.split(':')).toContain(dir);
    } else {
      expect(p.length).toBeGreaterThan(0);
    }
  });

  it('includes nvm node bin dirs when present (pi 常装于此)', () => {
    const nvmNode = join(homedir(), '.nvm', 'versions', 'node');
    const p = resolveAgentPath();
    if (existsSync(nvmNode)) {
      // 至少包含一个 nvm 版本 bin
      expect(p.split(':').some((x) => x.includes(join('.nvm', 'versions', 'node')))).toBe(true);
    } else {
      expect(p.length).toBeGreaterThan(0);
    }
  });

  it('envWithAgentPath sets PATH to the resolved value and merges extra env', () => {
    const env = envWithAgentPath({ FOO: 'bar' } as NodeJS.ProcessEnv);
    expect(env.PATH).toBe(resolveAgentPath());
    expect(env.FOO).toBe('bar');
  });

  it('is cached and resettable; recomputation is consistent', () => {
    const a = resolveAgentPath();
    const b = resolveAgentPath();
    expect(a).toBe(b); // 缓存命中
    _resetResolvedPath();
    const c = resolveAgentPath();
    expect(c).toBe(a); // 重新计算内容一致
  });

  it('dedups PATH entries', () => {
    const parts = resolveAgentPath().split(':').filter(Boolean);
    expect(new Set(parts).size).toBe(parts.length);
  });
});
