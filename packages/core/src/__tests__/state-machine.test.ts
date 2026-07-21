import { describe, it, expect } from 'vitest';
import {
  isLegalTransition,
  legalTargets,
  isTerminal,
  illegalTransitions,
  ALL_STATUSES,
} from '../state-machine.js';

describe('state machine', () => {
  it('allows the happy path backlog -> ... -> archived (via testing)', () => {
    expect(isLegalTransition('backlog', 'ready')).toBe(true);
    expect(isLegalTransition('ready', 'in_progress')).toBe(true);
    expect(isLegalTransition('in_progress', 'awaiting_input')).toBe(true);
    expect(isLegalTransition('awaiting_input', 'in_progress')).toBe(true);
    // 开发完成进入测试中，审查通过再进入待验收
    expect(isLegalTransition('in_progress', 'testing')).toBe(true);
    expect(isLegalTransition('testing', 'in_review')).toBe(true);
    expect(isLegalTransition('in_review', 'archived')).toBe(true);
  });

  it('forbids dev tasks from skipping testing (in_progress -/-> in_review)', () => {
    // 开发任务禁止直接进入待验收，必须经过 testing
    expect(isLegalTransition('in_progress', 'in_review')).toBe(false);
  });

  it('allows review-fail return testing -> in_progress and reject in_review -> ready', () => {
    expect(isLegalTransition('testing', 'in_progress')).toBe(true);
    expect(isLegalTransition('in_review', 'in_progress')).toBe(true);
    // 验收不通过退回待开发
    expect(isLegalTransition('in_review', 'ready')).toBe(true);
  });

  it('rejects self transitions', () => {
    for (const s of ALL_STATUSES) expect(isLegalTransition(s, s)).toBe(false);
  });

  it('rejects illegal jumps', () => {
    expect(isLegalTransition('backlog', 'archived')).toBe(false);
    expect(isLegalTransition('backlog', 'in_progress')).toBe(false);
    expect(isLegalTransition('ready', 'archived')).toBe(false);
    expect(isLegalTransition('ready', 'testing')).toBe(false);
    expect(isLegalTransition('testing', 'archived')).toBe(false);
    expect(isLegalTransition('archived', 'in_progress')).toBe(false);
    expect(isLegalTransition('archived', 'backlog')).toBe(false);
  });

  it('removes backlog as a target (需求池 removed)', () => {
    // ready 不再可退回 backlog；awaiting_input 退回 ready 而非 backlog
    expect(isLegalTransition('ready', 'backlog')).toBe(false);
    expect(isLegalTransition('awaiting_input', 'backlog')).toBe(false);
    expect(isLegalTransition('awaiting_input', 'ready')).toBe(true);
  });

  it('legalTargets only returns legal next states', () => {
    expect(legalTargets('backlog')).toEqual(['ready']);
    expect(legalTargets('archived')).toEqual([]);
    expect(legalTargets('in_progress').sort()).toEqual(
      ['awaiting_input', 'testing', 'ready'].sort(),
    );
    expect(legalTargets('testing').sort()).toEqual(
      ['in_review', 'in_progress', 'awaiting_input', 'ready'].sort(),
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
