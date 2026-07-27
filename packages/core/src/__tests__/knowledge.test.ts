import { describe, it, expect } from 'vitest';
import {
  KNOWLEDGE_TYPES,
  isKnowledgeFrontmatter,
  isKnowledgeAssessment,
  isKnowledgeAgentPayload,
  type KnowledgeAssessment,
  type KnowledgeAgentPayload,
  type KnowledgeFrontmatter,
  type KnowledgeHealthSnapshot,
  type KnowledgeRetrievalManifest,
  type KnowledgeDepositionRecord,
  type IterationChangelogVerification,
} from '../knowledge.js';

describe('KNOWLEDGE_TYPES', () => {
  it('exposes the six required types in order', () => {
    expect(KNOWLEDGE_TYPES).toEqual(['context', 'adr', 'feature', 'runbook', 'product', 'ux']);
  });
});

describe('isKnowledgeFrontmatter', () => {
  const valid = (over: Partial<KnowledgeFrontmatter> = {}): KnowledgeFrontmatter => ({
    id: 'feature:task-review-gate',
    type: 'feature',
    status: 'active',
    owner: 'project',
    updated: '2026-07-27',
    confidence: 0.85,
    sources: ['packages/scheduler/src/orchestrator.ts'],
    related: ['adr:iteration-branching'],
    ...over,
  });

  it('accepts a well-formed frontmatter', () => {
    expect(isKnowledgeFrontmatter(valid())).toBe(true);
  });

  it('rejects empty ids', () => {
    expect(isKnowledgeFrontmatter(valid({ id: '' }))).toBe(false);
  });

  it('rejects unknown types and statuses', () => {
    expect(isKnowledgeFrontmatter(valid({ type: 'random' as never }))).toBe(false);
    expect(isKnowledgeFrontmatter(valid({ status: 'weird' as never }))).toBe(false);
  });

  it('rejects invalid dates', () => {
    expect(isKnowledgeFrontmatter(valid({ updated: '2026/07/27' }))).toBe(false);
    expect(isKnowledgeFrontmatter(valid({ updated: 'not-a-date' }))).toBe(false);
  });

  it('rejects confidence outside 0..1', () => {
    expect(isKnowledgeFrontmatter(valid({ confidence: 1.5 }))).toBe(false);
    expect(isKnowledgeFrontmatter(valid({ confidence: -0.1 }))).toBe(false);
  });

  it('rejects non-array sources/related', () => {
    expect(isKnowledgeFrontmatter(valid({ sources: 'x' as unknown as string[] }))).toBe(false);
    expect(isKnowledgeFrontmatter(valid({ related: 3 as unknown as string[] }))).toBe(false);
  });
});

describe('isKnowledgeAssessment', () => {
  it('accepts a valuable assessment with evidence and rejects an empty none assessment', () => {
    expect(
      isKnowledgeAssessment({
        verdict: 'valuable',
        candidates: [
          {
            type: 'feature',
            summary: 'Task review now has a knowledge gate',
            evidence: ['packages/scheduler/src/orchestrator.ts'],
            reuseScenario: 'Future task finalization changes',
          },
        ],
      }),
    ).toBe(true);
    expect(isKnowledgeAssessment({ verdict: 'none', reason: '', evidence: [] })).toBe(false);
  });

  it('accepts a none assessment with non-empty reason and evidence', () => {
    expect(
      isKnowledgeAssessment({
        verdict: 'none',
        reason: '纯重构，无稳定知识新增',
        evidence: ['packages/core/src/types.ts'],
      }),
    ).toBe(true);
  });

  it('rejects valuable with empty candidates or empty evidence', () => {
    expect(
      isKnowledgeAssessment({
        verdict: 'valuable',
        candidates: [
          {
            type: 'feature',
            summary: '',
            evidence: [],
            reuseScenario: '',
          },
        ],
      }),
    ).toBe(false);
  });
});

describe('isKnowledgeAgentPayload', () => {
  const validAssessment: KnowledgeAssessment = {
    verdict: 'none',
    reason: '无沉淀价值',
    evidence: ['packages/core/src/types.ts'],
  };

  it('accepts each discriminant with matching fields', () => {
    const cases: KnowledgeAgentPayload[] = [
      {
        kind: 'task_review',
        review: { pass: true, summary: 'ok' },
        knowledgeAssessment: validAssessment,
      },
      { kind: 'knowledge_initialization', changedPaths: ['docs/knowledge/index.md'], knowledgeIds: [] },
      { kind: 'knowledge_audit', findings: [] },
      {
        kind: 'knowledge_repair',
        changedPaths: ['docs/knowledge/feature/a.md'],
        knowledgeIds: ['feature:a'],
        resolvedFindingIds: ['finding-1'],
      },
      {
        kind: 'knowledge_deposition',
        changedPaths: ['docs/knowledge/feature/b.md'],
        knowledgeIds: ['feature:b'],
        assessment: { verdict: 'none', reason: 'x', evidence: ['y'] },
      },
      { kind: 'iteration_changelog', changedPaths: [], coveredTaskIds: ['t1'] },
    ];
    for (const payload of cases) {
      expect(isKnowledgeAgentPayload(payload)).toBe(true);
    }
  });

  it('rejects payloads whose fields do not match the discriminant', () => {
    expect(
      isKnowledgeAgentPayload({ kind: 'task_review', review: { pass: true, summary: 'ok' } }),
    ).toBe(false);
    expect(
      isKnowledgeAgentPayload({
        kind: 'knowledge_audit',
        findings: 'nope' as unknown as never[],
      }),
    ).toBe(false);
    expect(
      isKnowledgeAgentPayload({ kind: 'iteration_changelog', changedPaths: [], coveredTaskIds: 't1' as unknown as string[] }),
    ).toBe(false);
  });
});

describe('type surface', () => {
  it('exports the required domain shapes (compile-time evidence)', () => {
    // 这些变量仅用于确保类型已导出可被引用。
    const snapshot: KnowledgeHealthSnapshot = {
      projectId: 'p1',
      state: 'healthy',
      checkedAt: 0,
      counts: { context: 0, adr: 0, feature: 0, runbook: 0, product: 0, ux: 0 },
      findings: [],
    };
    const manifest: KnowledgeRetrievalManifest = {
      id: 'r1',
      projectId: 'p1',
      expert: 'project_lead',
      stage: 'development',
      level: 3,
      state: 'planned',
      candidates: [],
      reads: [],
      skipped: [],
      differences: [],
      budget: { maxFiles: 5, maxChars: 1000 },
      used: { files: 0, chars: 0 },
      createdAt: 0,
    };
    const deposition: KnowledgeDepositionRecord = {
      id: 'd1',
      projectId: 'p1',
      taskId: 't1',
      assessment: { verdict: 'none', reason: 'x', evidence: ['y'] },
      state: 'succeeded',
      relatedKnowledgeIds: [],
      changedPaths: [],
      gatePassed: true,
      diagnostics: [],
      startedAt: 0,
    };
    const verification: IterationChangelogVerification = {
      iterationId: 'i1',
      state: 'pending',
      coveredTaskIds: [],
      missingTaskIds: [],
      changedPaths: [],
      findings: [],
    };
    expect(snapshot).toBeDefined();
    expect(manifest).toBeDefined();
    expect(deposition).toBeDefined();
    expect(verification).toBeDefined();
  });
});
