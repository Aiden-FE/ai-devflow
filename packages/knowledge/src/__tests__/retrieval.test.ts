import { describe, it, expect } from 'vitest';
import { inferRetrievalLevel, planKnowledgeRetrieval, type RetrievalPlanInput } from '../retrieval.js';
import type { KnowledgeDocumentRef } from '@ai-devflow/core';

function ref(over: Partial<KnowledgeDocumentRef> & { id: string }): KnowledgeDocumentRef {
  return {
    type: 'feature',
    status: 'active',
    owner: 'project',
    updated: '2026-07-27',
    confidence: 0.8,
    sources: [],
    related: [],
    title: '',
    summary: '',
    path: `docs/knowledge/${over.type ?? 'feature'}/${over.id.replace(':', '-')}.md`,
    ...over,
  } as KnowledgeDocumentRef;
}

function fixtureInput(over: Partial<RetrievalPlanInput> & { maxFiles?: number; maxChars?: number } = {}): RetrievalPlanInput {
  const { maxFiles, maxChars, ...rest } = over;
  const candidates: KnowledgeDocumentRef[] = [
    ref({
      id: 'feature:task-review',
      type: 'feature',
      title: 'Task review gate',
      summary: 'Task finalization requires a knowledge assessment before review',
      confidence: 0.9,
      sources: ['packages/scheduler/src/orchestrator.ts'],
      related: ['adr:iteration-branch'],
    }),
    ref({
      id: 'adr:iteration-branch',
      type: 'adr',
      title: 'Iteration branching',
      summary: 'Sprint branch lifecycle and merge rules',
      confidence: 0.7,
      related: ['feature:task-review'],
    }),
    ref({
      id: 'context:runtime',
      type: 'context',
      title: 'Runtime architecture',
      summary: 'Pi runner and scheduler runtime',
      confidence: 0.6,
      related: [],
    }),
    ref({
      id: 'product:policy',
      type: 'product',
      title: 'Product policy',
      summary: 'Product scope and rules',
      confidence: 0.5,
      related: [],
    }),
  ];
  return {
    id: 'r1',
    projectId: 'p1',
    expert: 'dev',
    stage: 'development',
    query: 'fix task finalization',
    catalog: candidates,
    budget: { maxFiles: 5, maxChars: 5000 },
    createdAt: 1000,
    ...rest,
    ...(maxFiles !== undefined || maxChars !== undefined
      ? { budget: { maxFiles: maxFiles ?? 5, maxChars: maxChars ?? 5000 } }
      : {}),
  };
}

describe('inferRetrievalLevel', () => {
  it.each([
    ['product', 'product policy', 4],
    ['ux', 'keyboard navigation', 4],
    ['dev_lead', 'split scheduler work', 3],
    ['dev', 'fix task finalization', 3],
    ['test', 'review task finalization', 3],
    ['project_lead', 'audit project knowledge', 4],
    ['chat', 'show project overview', 1],
  ] as const)('infers %s disclosure', (expert, query, expected) => {
    expect(inferRetrievalLevel({ expert, query })).toBe(expected);
  });
});

describe('planKnowledgeRetrieval', () => {
  it('uses stable tie breakers and never exceeds file or character budgets', () => {
    const manifest = planKnowledgeRetrieval(fixtureInput({ maxFiles: 2, maxChars: 900 }));
    expect(manifest.candidates.map((candidate) => candidate.id)).toEqual([
      'feature:task-review',
      'adr:iteration-branch',
    ]);
    expect(manifest.candidates).toHaveLength(2);
    expect(manifest.used.chars).toBeLessThanOrEqual(900);
  });

  it('admits only context at L1 for chat', () => {
    const manifest = planKnowledgeRetrieval(
      fixtureInput({ expert: 'chat', budget: { maxFiles: 5, maxChars: 5000 } }),
    );
    expect(manifest.level).toBe(1);
    expect(manifest.candidates.map((c) => c.type)).toEqual(['context']);
  });

  it('admits product/ux at L4', () => {
    const manifest = planKnowledgeRetrieval(
      fixtureInput({ expert: 'product', budget: { maxFiles: 10, maxChars: 10000 } }),
    );
    expect(manifest.level).toBe(4);
    expect(manifest.candidates.map((c) => c.id)).toContain('product:policy');
  });

  it('records skipped candidates rejected by budget with a reason', () => {
    const manifest = planKnowledgeRetrieval(
      fixtureInput({ budget: { maxFiles: 1, maxChars: 10000 } }),
    );
    expect(manifest.candidates).toHaveLength(1);
    expect(manifest.skipped.length).toBeGreaterThan(0);
    expect(manifest.skipped[0]!.reason).toBeTruthy();
  });

  it('sets state planned and records budget counters', () => {
    const manifest = planKnowledgeRetrieval(fixtureInput());
    expect(manifest.state).toBe('planned');
    expect(manifest.used.files).toBe(manifest.candidates.length);
    expect(manifest.budget).toEqual({ maxFiles: 5, maxChars: 5000 });
  });

  it('orders by score then confidence then stable id (descending confidence tie-break)', () => {
    // 两个文档关键词命中相同，confidence 不同 -> 高 confidence 在前
    const a = ref({ id: 'feature:aaa', title: 'task', summary: 'task', confidence: 0.5 });
    const b = ref({ id: 'feature:bbb', title: 'task', summary: 'task', confidence: 0.9 });
    const manifest = planKnowledgeRetrieval(
      fixtureInput({
        expert: 'dev',
        query: 'task',
        catalog: [a, b],
        budget: { maxFiles: 5, maxChars: 10000 },
      }),
    );
    expect(manifest.candidates.map((c) => c.id)).toEqual(['feature:bbb', 'feature:aaa']);
  });
});
