import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  KnowledgeDocumentRef,
  KnowledgeRetrievalManifest,
} from '@ai-devflow/core';
import * as knowledge from '../index.js';
import { fixtureRepo } from './test-helpers.js';

type Materialize = (
  repoPath: string,
  manifest: KnowledgeRetrievalManifest,
) => Promise<{
  content: string;
  reads: Array<{ knowledgeId: string; path: string; reason: string; chars: number }>;
  skipped: Array<{ knowledgeId: string; reason: string }>;
}>;

const materializeKnowledgeContext = (knowledge as unknown as {
  materializeKnowledgeContext?: Materialize;
}).materializeKnowledgeContext;

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function candidate(id: string, path: string): KnowledgeDocumentRef {
  return {
    id,
    type: 'context',
    status: 'active',
    owner: 'project',
    updated: '2026-07-28',
    confidence: 0.9,
    sources: [],
    related: [],
    title: id,
    summary: `${id} summary`,
    path,
  };
}

function manifest(input: {
  candidates: KnowledgeDocumentRef[];
  maxFiles?: number;
  maxChars?: number;
}): KnowledgeRetrievalManifest {
  return {
    id: 'retrieval-1',
    projectId: 'project-1',
    expert: 'product',
    stage: 'requirement_chat',
    level: 4,
    state: 'planned',
    candidates: input.candidates,
    reads: [],
    skipped: [],
    differences: [],
    budget: { maxFiles: input.maxFiles ?? 5, maxChars: input.maxChars ?? 5000 },
    used: { files: input.candidates.length, chars: 0 },
    createdAt: 1,
  };
}

describe('materializeKnowledgeContext', () => {
  it('reads only manifest candidates and returns bounded evidence', async () => {
    expect(materializeKnowledgeContext).toBeTypeOf('function');
    if (!materializeKnowledgeContext) return;
    const repo = await fixtureRepo({
      'docs/knowledge/context/index.md': 'project context body',
      'docs/knowledge/feature/login.md': 'login implementation body',
    });

    const result = await materializeKnowledgeContext(repo, manifest({
      maxFiles: 1,
      maxChars: 12,
      candidates: [
        candidate('context:root', 'docs/knowledge/context/index.md'),
        candidate('feature:login', 'docs/knowledge/feature/login.md'),
      ],
    }));

    expect(result.content).toContain('project cont');
    expect(result.content).not.toContain('login implementation body');
    expect(result.reads).toEqual([{
      knowledgeId: 'context:root',
      path: 'docs/knowledge/context/index.md',
      reason: 'host_prompt_context',
      chars: 12,
    }]);
    expect(result.skipped.map((item) => item.knowledgeId)).toEqual(['feature:login']);
  });

  it('skips missing and repository-traversing candidates', async () => {
    expect(materializeKnowledgeContext).toBeTypeOf('function');
    if (!materializeKnowledgeContext) return;
    const repo = await fixtureRepo({ 'docs/knowledge/context/index.md': 'safe' });

    const result = await materializeKnowledgeContext(repo, manifest({
      candidates: [
        candidate('missing', 'docs/knowledge/missing.md'),
        candidate('escape', '../outside.md'),
      ],
    }));

    expect(result.content).toBe('');
    expect(result.reads).toEqual([]);
    expect(result.skipped.map((item) => item.knowledgeId)).toEqual(['missing', 'escape']);
  });

  it('rejects a manifest candidate whose symlink escapes the repository', async () => {
    expect(materializeKnowledgeContext).toBeTypeOf('function');
    if (!materializeKnowledgeContext) return;
    const repo = await fixtureRepo({ 'docs/knowledge/context/index.md': 'safe' });
    const outside = await mkdtemp(join(tmpdir(), 'kb-outside-'));
    cleanupRoots.push(outside);
    await writeFile(join(outside, 'secret.md'), 'SECRET OUTSIDE CONTENT', 'utf8');
    await mkdir(join(repo, 'docs/knowledge'), { recursive: true });
    await symlink(join(outside, 'secret.md'), join(repo, 'docs/knowledge/escape.md'));

    const result = await materializeKnowledgeContext(repo, manifest({
      candidates: [candidate('escape', 'docs/knowledge/escape.md')],
    }));

    expect(result.content).not.toContain('SECRET OUTSIDE CONTENT');
    expect(result.reads).toEqual([]);
    expect(result.skipped.map((item) => item.knowledgeId)).toEqual(['escape']);
  });
});
