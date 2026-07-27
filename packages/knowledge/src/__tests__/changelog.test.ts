import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { ProjectKnowledgeService } from '../service.js';
import { emptyFixtureRepo } from './test-helpers.js';

function gitProbe(tracked: Set<string>): { isTracked: (r: string, rel: string) => Promise<boolean>; isIgnored: (r: string, rel: string) => Promise<boolean> } {
  return {
    isTracked: async (_r, rel) => tracked.has(rel),
    isIgnored: async () => false,
  };
}

describe('verifyIterationChangelog', () => {
  it('is valid when every task is covered and CHANGELOGs are tracked', async () => {
    const repo = await emptyFixtureRepo();
    await mkdir(join(repo, 'docs/iterations/1.0/tasks/t1'), { recursive: true });
    await mkdir(join(repo, 'docs/iterations/1.0/tasks/t2'), { recursive: true });
    await writeFile(join(repo, 'docs/iterations/1.0/CHANGELOG.md'), '# Changelog\n\n- t1: done\n- t2: done\n');
    await writeFile(join(repo, 'docs/iterations/1.0/tasks/t1/CHANGELOG.md'), '# t1\n');
    await writeFile(join(repo, 'docs/iterations/1.0/tasks/t2/CHANGELOG.md'), '# t2\n');
    const service = new ProjectKnowledgeService();
    const v = await service.verifyIterationChangelog({
      repoPath: repo, version: '1.0', iterationId: 'it', expectedTaskIds: ['t1', 't2'],
      git: gitProbe(new Set(['docs/iterations/1.0/CHANGELOG.md', 'docs/iterations/1.0/tasks/t1/CHANGELOG.md', 'docs/iterations/1.0/tasks/t2/CHANGELOG.md'])),
      verifiedAt: 100,
    });
    expect(v.state).toBe('valid');
    expect(v.coveredTaskIds.sort()).toEqual(['t1', 't2']);
    expect(v.missingTaskIds).toEqual([]);
  });

  it('is invalid when a task is missing from the changelog', async () => {
    const repo = await emptyFixtureRepo();
    await mkdir(join(repo, 'docs/iterations/1.0/tasks/t1'), { recursive: true });
    await writeFile(join(repo, 'docs/iterations/1.0/CHANGELOG.md'), '# Changelog\n\n- t1: done\n');
    await writeFile(join(repo, 'docs/iterations/1.0/tasks/t1/CHANGELOG.md'), '# t1\n');
    const service = new ProjectKnowledgeService();
    const v = await service.verifyIterationChangelog({
      repoPath: repo, version: '1.0', iterationId: 'it', expectedTaskIds: ['t1', 't2'],
      git: gitProbe(new Set(['docs/iterations/1.0/CHANGELOG.md', 'docs/iterations/1.0/tasks/t1/CHANGELOG.md'])),
      verifiedAt: 100,
    });
    expect(v.state).toBe('invalid');
    expect(v.missingTaskIds).toEqual(['t2']);
  });

  it('is invalid when CHANGELOG is untracked', async () => {
    const repo = await emptyFixtureRepo();
    await mkdir(join(repo, 'docs/iterations/1.0/tasks/t1'), { recursive: true });
    await writeFile(join(repo, 'docs/iterations/1.0/CHANGELOG.md'), '# Changelog\n\n- t1\n');
    await writeFile(join(repo, 'docs/iterations/1.0/tasks/t1/CHANGELOG.md'), '# t1\n');
    const service = new ProjectKnowledgeService();
    const v = await service.verifyIterationChangelog({
      repoPath: repo, version: '1.0', iterationId: 'it', expectedTaskIds: ['t1'],
      git: gitProbe(new Set()), // nothing tracked
      verifiedAt: 100,
    });
    expect(v.state).toBe('invalid');
    expect(v.findings.map((f) => f.code)).toContain('untracked_changelog');
  });

  it('rejects a missing iteration changelog', async () => {
    const repo = await emptyFixtureRepo();
    const service = new ProjectKnowledgeService();
    const v = await service.verifyIterationChangelog({
      repoPath: repo, version: '1.0', iterationId: 'it', expectedTaskIds: ['t1'],
      git: gitProbe(new Set()), verifiedAt: 100,
    });
    expect(v.state).toBe('invalid');
    expect(v.findings.map((f) => f.code)).toContain('missing_changelog');
  });

  it('sorts covered and missing task ids ascending', async () => {
    const repo = await emptyFixtureRepo();
    await mkdir(join(repo, 'docs/iterations/1.0/tasks/t2'), { recursive: true });
    await mkdir(join(repo, 'docs/iterations/1.0/tasks/t10'), { recursive: true });
    await writeFile(join(repo, 'docs/iterations/1.0/CHANGELOG.md'), '# Changelog\n\n- t10\n- t2\n');
    await writeFile(join(repo, 'docs/iterations/1.0/tasks/t2/CHANGELOG.md'), '# t2\n');
    await writeFile(join(repo, 'docs/iterations/1.0/tasks/t10/CHANGELOG.md'), '# t10\n');
    const service = new ProjectKnowledgeService();
    const v = await service.verifyIterationChangelog({
      repoPath: repo, version: '1.0', iterationId: 'it', expectedTaskIds: ['t10', 't2', 't3'],
      git: gitProbe(new Set(['docs/iterations/1.0/CHANGELOG.md', 'docs/iterations/1.0/tasks/t2/CHANGELOG.md', 'docs/iterations/1.0/tasks/t10/CHANGELOG.md'])),
      verifiedAt: 1,
    });
    expect(v.coveredTaskIds).toEqual(['t10', 't2']);
    expect(v.missingTaskIds).toEqual(['t3']);
  });
});
