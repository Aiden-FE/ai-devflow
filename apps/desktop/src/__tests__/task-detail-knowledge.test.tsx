import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TaskKnowledgeEvidence } from '@ai-devflow/core';

Object.assign(globalThis, { window: { api: {} } });
const { LocaleProvider } = await import('../i18n/index.js');
const KE = (await import('../components/KnowledgeEvidence.js')) as { KnowledgeEvidence: React.ComponentType<{ evidence: TaskKnowledgeEvidence }> };

const evidence: TaskKnowledgeEvidence = {
  retrievals: [
    {
      id: 'r1', projectId: 'p', expert: 'dev', stage: 'development', level: 3, state: 'completed',
      candidates: [{ id: 'feature:a', path: 'docs/knowledge/feature/a.md', title: 'A', summary: '', type: 'feature', status: 'active', owner: 'project', updated: '2026-07-27', confidence: 0.8, sources: [], related: [] }],
      reads: [], skipped: [], differences: [],
      budget: { maxFiles: 5, maxChars: 1000 }, used: { files: 1, chars: 100 }, createdAt: 1,
    },
  ],
  assessment: { verdict: 'none', reason: '纯重构', evidence: ['x.ts'] },
};

describe('KnowledgeEvidence', () => {
  it('renders the retrieval level and none verdict', () => {
    const html = renderToStaticMarkup(
      <LocaleProvider>
        <KE.KnowledgeEvidence evidence={evidence} />
      </LocaleProvider>,
    );
    expect(html).toContain('L3');
    expect(html).toContain('无沉淀价值');
    expect(html).toContain('feature:a');
  });
});
