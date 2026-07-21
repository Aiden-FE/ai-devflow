import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProjectInstructionLoader } from '../project-instructions.js';

function setup(): { root: string; pkg: string } {
  const root = mkdtempSync(join(tmpdir(), 'agents-md-'));
  const pkg = join(root, 'packages', 'app');
  mkdirSync(pkg, { recursive: true });
  return { root, pkg };
}

describe('ProjectInstructionLoader', () => {
  it('merges AGENTS.md root-to-leaf and never reads CLAUDE.md', () => {
    const { root, pkg } = setup();
    writeFileSync(join(root, 'AGENTS.md'), 'ROOT_INSTRUCTIONS');
    writeFileSync(join(root, 'CLAUDE.md'), 'CLAUDE_SECRET_ROOT');
    writeFileSync(join(pkg, 'AGENTS.md'), 'PKG_INSTRUCTIONS');
    writeFileSync(join(pkg, 'CLAUDE.md'), 'CLAUDE_SECRET_PKG');
    const res = new ProjectInstructionLoader().load(root, pkg);
    const rootIdx = res.content.indexOf('ROOT_INSTRUCTIONS');
    const pkgIdx = res.content.indexOf('PKG_INSTRUCTIONS');
    expect(rootIdx).toBeGreaterThanOrEqual(0);
    expect(pkgIdx).toBeGreaterThan(rootIdx); // parent before leaf
    expect(res.content).not.toContain('CLAUDE_SECRET');
    expect(res.files).toHaveLength(2);
    expect(res.truncated).toBe(false);
  });

  it('returns empty content when no AGENTS.md applies', () => {
    const { root, pkg } = setup();
    const res = new ProjectInstructionLoader().load(root, pkg);
    expect(res.content).toBe('');
    expect(res.files).toEqual([]);
  });

  it('rejects when the work dir escapes the repo root', () => {
    const { root } = setup();
    const elsewhere = mkdtempSync(join(tmpdir(), 'elsewhere-'));
    expect(() => new ProjectInstructionLoader().load(root, elsewhere)).toThrow(/越出/);
  });

  it('caps at eight AGENTS.md files', () => {
    const root = mkdtempSync(join(tmpdir(), 'agents-many-'));
    let dir = root;
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(dir, 'AGENTS.md'), `LEVEL_${i}`);
      const next = join(dir, `d${i}`);
      mkdirSync(next, { recursive: true });
      dir = next;
    }
    const res = new ProjectInstructionLoader().load(root, dir);
    expect(res.files).toHaveLength(8);
    expect(res.truncated).toBe(true);
  });

  it('caps a single file at 64 KiB', () => {
    const { root, pkg } = setup();
    writeFileSync(join(pkg, 'AGENTS.md'), 'x'.repeat(70 * 1024));
    const res = new ProjectInstructionLoader().load(root, pkg);
    expect(res.truncated).toBe(true);
    const xCount = (res.content.match(/x/g) ?? []).length;
    expect(xCount).toBeLessThanOrEqual(64 * 1024);
  });

  it('caps total at 256 KiB', () => {
    const root = mkdtempSync(join(tmpdir(), 'agents-total-'));
    let dir = root;
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(dir, 'AGENTS.md'), 'y'.repeat(60 * 1024)); // 5 * 60KiB = 300KiB
      const next = join(dir, `d${i}`);
      mkdirSync(next, { recursive: true });
      dir = next;
    }
    const res = new ProjectInstructionLoader().load(root, dir);
    expect(res.truncated).toBe(true);
    const yCount = (res.content.match(/y/g) ?? []).length;
    expect(yCount).toBeLessThanOrEqual(256 * 1024);
  });
});
