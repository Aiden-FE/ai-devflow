import { describe, it, expect } from 'vitest';
import {
  isLegalTransition,
  legalTargets,
  isTerminal,
  illegalTransitions,
  ALL_STATUSES,
} from '../state-machine.js';

describe('state machine', () => {
  it('allows the happy path backlog -> ... -> archived', () => {
    expect(isLegalTransition('backlog', 'ready')).toBe(true);
    expect(isLegalTransition('ready', 'in_progress')).toBe(true);
    expect(isLegalTransition('in_progress', 'awaiting_input')).toBe(true);
    expect(isLegalTransition('awaiting_input', 'in_progress')).toBe(true);
    expect(isLegalTransition('in_progress', 'in_review')).toBe(true);
    expect(isLegalTransition('in_review', 'archived')).toBe(true);
  });

  it('allows test-fail return in_review -> in_progress', () => {
    expect(isLegalTransition('in_review', 'in_progress')).toBe(true);
  });

  it('rejects self transitions', () => {
    for (const s of ALL_STATUSES) expect(isLegalTransition(s, s)).toBe(false);
  });

  it('rejects illegal jumps', () => {
    expect(isLegalTransition('backlog', 'archived')).toBe(false);
    expect(isLegalTransition('backlog', 'in_progress')).toBe(false);
    expect(isLegalTransition('ready', 'archived')).toBe(false);
    expect(isLegalTransition('in_review', 'ready')).toBe(false);
    expect(isLegalTransition('archived', 'in_progress')).toBe(false);
    expect(isLegalTransition('archived', 'backlog')).toBe(false);
  });

  it('legalTargets only returns legal next states', () => {
    expect(legalTargets('backlog')).toEqual(['ready']);
    expect(legalTargets('archived')).toEqual([]);
    expect(legalTargets('in_progress').sort()).toEqual(
      ['awaiting_input', 'in_review', 'ready'].sort(),
    );
  });

  it('marks archived as terminal', () => {
    expect(isTerminal('archived')).toBe(true);
    for (const s of ALL_STATUSES) if (s !== 'archived') expect(isTerminal(s)).toBe(false);
  });

  it('illegalTransitions is non-empty and all entries truly illegal', () => {
    const ill = illegalTransitions();
    expect(ill.length).toBeGreaterThan(0);
    for (const { from, to } of ill) expect(isLegalTransition(from, to)).toBe(false);
  });
});
