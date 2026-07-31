import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeKnowledgeDraftMetadata, parseKnowledgeMarkdown } from '../index.js';
import { fixtureRepo } from './test-helpers.js';

describe('normalizeKnowledgeDraftMetadata', () => {
  it('normalizes accepted ADR status and safe trailing source slashes', async () => {
    const repo = await fixtureRepo({
      'docs/knowledge/adr/decision.md': `---
id: adr:decision
type: adr
status: accepted
owner: project
updated: 2026-07-30
confidence: 0.8
sources:
  - entrypoints/options/
  - entrypoints/popup///
related: []
---

# Decision

Decision summary.
`,
    });

    await expect(normalizeKnowledgeDraftMetadata(repo)).resolves.toEqual({
      changed: ['docs/knowledge/adr/decision.md'],
    });
    const content = await readFile(join(repo, 'docs/knowledge/adr/decision.md'), 'utf8');
    const parsed = parseKnowledgeMarkdown('docs/knowledge/adr/decision.md', content);
    expect(parsed.frontmatter.status).toBe('active');
    expect(parsed.frontmatter.sources).toEqual(['entrypoints/options', 'entrypoints/popup']);
    expect(parsed.body).toContain('Decision summary.');

    await expect(normalizeKnowledgeDraftMetadata(repo)).resolves.toEqual({ changed: [] });
  });

  it('leaves unknown statuses and unsafe source paths for audit to reject', async () => {
    const original = `---
id: adr:unsafe
type: adr
status: proposed
owner: project
updated: 2026-07-30
confidence: 0.8
sources:
  - ../outside/
  - /absolute/
related: []
---

# Unsafe

Unsafe metadata.
`;
    const repo = await fixtureRepo({ 'docs/knowledge/adr/unsafe.md': original });

    await expect(normalizeKnowledgeDraftMetadata(repo)).resolves.toEqual({ changed: [] });
    await expect(readFile(join(repo, 'docs/knowledge/adr/unsafe.md'), 'utf8')).resolves.toBe(original);
  });
});
