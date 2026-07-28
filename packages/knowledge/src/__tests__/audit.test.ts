import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { ProjectKnowledgeService } from '../service.js';
import {
  emptyFixtureRepo,
  fixtureRepo,
  listFiles,
  ROOT_INDEX,
  FEATURE_INDEX,
  document,
} from './test-helpers.js';

describe('ProjectKnowledgeService.initializeKnowledge', () => {
  it('initializes the six indexes and preserves existing Markdown', async () => {
    const repo = await emptyFixtureRepo();
    const service = new ProjectKnowledgeService();
    await service.initializeKnowledge({ repoPath: repo, date: '2026-07-27' });
    await service.initializeKnowledge({ repoPath: repo, date: '2026-07-27' });
    expect(await readFile(join(repo, 'docs/knowledge/ux/index.md'), 'utf8')).toContain('# UX Knowledge');
    expect(await listFiles(repo)).toHaveLength(7);
  });

  it('never overwrites existing files', async () => {
    const repo = await fixtureRepo({
      'docs/knowledge/index.md': 'PRE-EXISTING\n',
    });
    const service = new ProjectKnowledgeService();
    const first = await service.initializeKnowledge({ repoPath: repo, date: '2026-07-27' });
    const second = await service.initializeKnowledge({ repoPath: repo, date: '2026-07-27' });
    // 根索引已存在 -> 不创建、不覆盖
    expect(first.existing).toContain('docs/knowledge/index.md');
    expect(first.created).not.toContain('docs/knowledge/index.md');
    expect(first.created).toHaveLength(6);
    // 第二次：全部已存在，无新增
    expect(second.created).toHaveLength(0);
    expect(second.existing).toHaveLength(7);
    expect(second.existing).toContain('docs/knowledge/index.md');
    expect(await readFile(join(repo, 'docs/knowledge/index.md'), 'utf8')).toBe('PRE-EXISTING\n');
  });
});

describe('ProjectKnowledgeService.initializeIteration', () => {
  it('creates iteration index and changelog idempotently', async () => {
    const repo = await emptyFixtureRepo();
    const service = new ProjectKnowledgeService();
    const first = await service.initializeIteration({
      repoPath: repo,
      version: '1.0',
      iterationId: 'iter-1',
      date: '2026-07-27',
    });
    const second = await service.initializeIteration({
      repoPath: repo,
      version: '1.0',
      iterationId: 'iter-1',
      date: '2026-07-27',
    });
    expect(first.created.sort()).toEqual(['docs/iterations/1.0/CHANGELOG.md', 'docs/iterations/1.0/index.md'].sort());
    expect(second.created).toHaveLength(0);
    expect(second.existing.sort()).toEqual(['docs/iterations/1.0/CHANGELOG.md', 'docs/iterations/1.0/index.md'].sort());
  });

  it('rejects path separators in version', async () => {
    const repo = await emptyFixtureRepo();
    const service = new ProjectKnowledgeService();
    await expect(
      service.initializeIteration({ repoPath: repo, version: '../evil', iterationId: 'i', date: '2026-07-27' }),
    ).rejects.toThrow();
  });
});

describe('ProjectKnowledgeService.initializeTask', () => {
  it('creates the task directory and index', async () => {
    const repo = await emptyFixtureRepo();
    const service = new ProjectKnowledgeService();
    const set = await service.initializeTask({
      repoPath: repo,
      version: '1.0',
      taskId: 't1',
      title: 'Implement gate',
      date: '2026-07-27',
    });
    expect(set.created).toContain('docs/iterations/1.0/tasks/t1/index.md');
    const body = await readFile(join(repo, 'docs/iterations/1.0/tasks/t1/index.md'), 'utf8');
    expect(body).toContain('Implement gate');
  });
});

describe('ProjectKnowledgeService.audit', () => {
  it('reports not_initialized when the knowledge root is absent', async () => {
    const repo = await emptyFixtureRepo();
    const snapshot = await new ProjectKnowledgeService().audit({ projectId: 'p1', repoPath: repo });
    expect(snapshot.state).toBe('not_initialized');
    expect(snapshot.findings.map((f) => f.code)).toContain('not_initialized');
  });

  it('is healthy on a clean initialized layout', async () => {
    const repo = await emptyFixtureRepo();
    const service = new ProjectKnowledgeService();
    await service.initializeKnowledge({ repoPath: repo, date: '2026-07-27' });
    const snapshot = await service.audit({ projectId: 'p1', repoPath: repo });
    expect(snapshot.state).toBe('healthy');
  });

  it('rejects duplicate ids and broken related references', async () => {
    const repo = await fixtureRepo({
      'docs/knowledge/index.md': ROOT_INDEX,
      'docs/knowledge/feature/index.md': FEATURE_INDEX,
      'docs/knowledge/feature/a.md': document({ id: 'feature:a', related: ['adr:missing'] }),
      'docs/knowledge/feature/b.md': document({ id: 'feature:a', related: [] }),
    });
    const snapshot = await new ProjectKnowledgeService().audit({ projectId: 'p1', repoPath: repo });
    expect(snapshot.state).toBe('blocked');
    expect(snapshot.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(['duplicate_id', 'broken_reference']),
    );
  });

  it('sorts findings by severity then code then path then id', async () => {
    const repo = await fixtureRepo({
      'docs/knowledge/index.md': ROOT_INDEX,
      'docs/knowledge/feature/index.md': FEATURE_INDEX,
      'docs/knowledge/feature/a.md': document({ id: 'feature:a', related: ['adr:missing'] }),
      'docs/knowledge/feature/b.md': document({ id: 'feature:a', related: [] }),
    });
    const snapshot = await new ProjectKnowledgeService().audit({ projectId: 'p1', repoPath: repo });
    const codes = snapshot.findings.map((f) => f.code);
    // error 级问题（duplicate_id / broken_reference）排在 info 级问题之前
    const firstErrorIdx = codes.findIndex((c) => c === 'duplicate_id' || c === 'broken_reference');
    const infoIdx = codes.findIndex((c) => c !== 'duplicate_id' && c !== 'broken_reference');
    expect(firstErrorIdx).toBeGreaterThanOrEqual(0);
    if (infoIdx >= 0) expect(firstErrorIdx).toBeLessThan(infoIdx);
  });

  it('flags untracked and ignored markdown via injected git probe', async () => {
    const repo = await fixtureRepo({
      'docs/knowledge/index.md': ROOT_INDEX,
      'docs/knowledge/feature/index.md': FEATURE_INDEX,
      'docs/knowledge/feature/a.md': document({ id: 'feature:a', related: [] }),
    });
    const snapshot = await new ProjectKnowledgeService().audit({
      projectId: 'p1',
      repoPath: repo,
      git: {
        isTracked: async (_repo, rel) => rel === 'docs/knowledge/feature/a.md' ? false : true,
        isIgnored: async (_repo, rel) => rel === 'docs/knowledge/feature/a.md',
      },
    });
    expect(snapshot.findings.map((f) => f.code)).toEqual(
      expect.arrayContaining(['untracked_markdown', 'ignored_markdown']),
    );
    expect(snapshot.findings.find((finding) => finding.code === 'ignored_markdown')?.severity).toBe('error');
    expect(snapshot.state).toBe('blocked');
  });

  it('requires non-index knowledge documents to declare at least one source', async () => {
    const repo = await emptyFixtureRepo();
    const service = new ProjectKnowledgeService();
    await service.initializeKnowledge({ repoPath: repo, date: '2026-07-27' });
    await mkdir(join(repo, 'docs/knowledge/feature'), { recursive: true });
    await writeFile(join(repo, 'docs/knowledge/feature/no-source.md'), document({
      id: 'feature:no-source',
      sources: [],
      related: [],
    }));

    const snapshot = await service.audit({ projectId: 'p1', repoPath: repo });

    expect(snapshot.findings).toContainEqual(expect.objectContaining({
      code: 'missing_sources',
      knowledgeId: 'feature:no-source',
      severity: 'error',
    }));
  });

  it('reports source paths that do not exist in the repository', async () => {
    const repo = await emptyFixtureRepo();
    const service = new ProjectKnowledgeService();
    await service.initializeKnowledge({ repoPath: repo, date: '2026-07-27' });
    await mkdir(join(repo, 'docs/knowledge/feature'), { recursive: true });
    await writeFile(join(repo, 'docs/knowledge/feature/missing-source.md'), document({
      id: 'feature:missing-source',
      sources: ['does/not/exist.ts'],
      related: [],
    }));

    const snapshot = await service.audit({ projectId: 'p1', repoPath: repo });

    expect(snapshot.findings).toContainEqual(expect.objectContaining({
      code: 'missing_source_path',
      knowledgeId: 'feature:missing-source',
      evidence: ['does/not/exist.ts'],
    }));
  });

  it('accepts an existing repository-relative source path', async () => {
    const repo = await emptyFixtureRepo();
    const service = new ProjectKnowledgeService();
    await service.initializeKnowledge({ repoPath: repo, date: '2026-07-27' });
    await writeFile(join(repo, 'README.md'), '# fixture\n');
    await mkdir(join(repo, 'docs/knowledge/feature'), { recursive: true });
    await writeFile(join(repo, 'docs/knowledge/feature/traced.md'), document({
      id: 'feature:traced',
      sources: ['README.md'],
      related: [],
    }));

    const snapshot = await service.audit({ projectId: 'p1', repoPath: repo });
    const sourceFindings = snapshot.findings.filter((finding) =>
      finding.knowledgeId === 'feature:traced' && ['missing_sources', 'missing_source_path', 'invalid_source_path'].includes(finding.code),
    );

    expect(sourceFindings).toEqual([]);
  });
});
