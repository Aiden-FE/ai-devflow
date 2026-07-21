import { describe, it, expect } from 'vitest';
import { validateProposalDag, proposalHasCycle, topoSortProposals } from '../proposals.js';

describe('validateProposalDag', () => {
  it('accepts an empty-dependency parallel set', () => {
    const r = validateProposalDag([
      { draftId: 't1' },
      { draftId: 't2' },
      { draftId: 't3' },
    ]);
    expect(r.ok).toBe(true);
  });

  it('accepts a valid chain t1 <- t2 <- t3', () => {
    const r = validateProposalDag([
      { draftId: 't1', dependsOn: [] },
      { draftId: 't2', dependsOn: ['t1'] },
      { draftId: 't3', dependsOn: ['t2'] },
    ]);
    expect(r.ok).toBe(true);
  });

  it('accepts a diamond DAG', () => {
    const r = validateProposalDag([
      { draftId: 'a' },
      { draftId: 'b', dependsOn: ['a'] },
      { draftId: 'c', dependsOn: ['a'] },
      { draftId: 'd', dependsOn: ['b', 'c'] },
    ]);
    expect(r.ok).toBe(true);
  });

  it('rejects empty list', () => {
    expect(validateProposalDag([]).ok).toBe(false);
  });

  it('rejects duplicate draftId', () => {
    const r = validateProposalDag([{ draftId: 't1' }, { draftId: 't1' }]);
    expect(r.ok).toBe(false);
    expect(r.reasons.join()).toMatch(/重复/);
  });

  it('rejects missing draftId', () => {
    const r = validateProposalDag([{ draftId: '' }, { draftId: 't2' }]);
    expect(r.ok).toBe(false);
  });

  it('rejects self-dependency', () => {
    const r = validateProposalDag([{ draftId: 't1', dependsOn: ['t1'] }]);
    expect(r.ok).toBe(false);
    expect(r.reasons.join()).toMatch(/自身/);
  });

  it('rejects references to non-existent drafts', () => {
    const r = validateProposalDag([{ draftId: 't1', dependsOn: ['ghost'] }]);
    expect(r.ok).toBe(false);
    expect(r.reasons.join()).toMatch(/不存在/);
  });

  it('rejects a direct cycle', () => {
    const r = validateProposalDag([
      { draftId: 'a', dependsOn: ['b'] },
      { draftId: 'b', dependsOn: ['a'] },
    ]);
    expect(r.ok).toBe(false);
    expect(r.reasons.join()).toMatch(/环/);
  });

  it('rejects an indirect cycle', () => {
    const r = validateProposalDag([
      { draftId: 'a', dependsOn: ['c'] },
      { draftId: 'b', dependsOn: ['a'] },
      { draftId: 'c', dependsOn: ['b'] },
    ]);
    expect(r.ok).toBe(false);
  });
});

describe('proposalHasCycle / topoSortProposals', () => {
  it('detects cycles', () => {
    expect(proposalHasCycle([{ draftId: 'a', dependsOn: ['b'] }, { draftId: 'b', dependsOn: ['a'] }])).toBe(true);
    expect(proposalHasCycle([{ draftId: 'a' }, { draftId: 'b', dependsOn: ['a'] }])).toBe(false);
  });

  it('topo-sorts dependencies before dependents', () => {
    const sorted = topoSortProposals([
      { draftId: 'd', dependsOn: ['b', 'c'] },
      { draftId: 'b', dependsOn: ['a'] },
      { draftId: 'c', dependsOn: ['a'] },
      { draftId: 'a' },
    ]);
    const idx = (id: string) => sorted.findIndex((p) => p.draftId === id);
    expect(idx('a')).toBeLessThan(idx('b'));
    expect(idx('a')).toBeLessThan(idx('c'));
    expect(idx('b')).toBeLessThan(idx('d'));
    expect(idx('c')).toBeLessThan(idx('d'));
  });
});
