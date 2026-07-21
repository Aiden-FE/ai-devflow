import { describe, it, expect } from 'vitest';
import { canTransition, validateTransition, canReturnToDev, canArchiveRequirement, checkTaskDependencies } from '../gates.js';
import type { GateContext } from '../types.js';

const ctx = (over: Partial<GateContext> = {}): GateContext => ({
  hasAcceptance: false,
  hasAgentAssigned: false,
  hasArtifacts: false,
  ...over,
});

describe('gates', () => {
  it('blocks illegal transitions regardless of context', () => {
    const r = canTransition({ status: 'backlog' }, 'archived', ctx());
    expect(r.ok).toBe(false);
    expect(r.reasons.join()).toMatch(/非法迁移/);
  });

  it('blocks archived tasks from moving', () => {
    const r = canTransition({ status: 'archived' }, 'in_progress', ctx());
    expect(r.ok).toBe(false);
  });

  it('requires acceptance for backlog -> ready', () => {
    expect(canTransition({ status: 'backlog' }, 'ready', ctx({ hasAcceptance: false })).ok).toBe(false);
    expect(canTransition({ status: 'backlog' }, 'ready', ctx({ hasAcceptance: true })).ok).toBe(true);
  });

  it('requires agent assigned for ready -> in_progress', () => {
    expect(canTransition({ status: 'ready' }, 'in_progress', ctx({ hasAgentAssigned: false })).ok).toBe(false);
    expect(
      canTransition({ status: 'ready' }, 'in_progress', ctx({ hasAgentAssigned: true })).ok,
    ).toBe(true);
  });

  it('requires artifacts for in_progress -> in_review', () => {
    expect(
      canTransition({ status: 'in_progress' }, 'in_review', ctx({ hasArtifacts: false })).ok,
    ).toBe(false);
    expect(
      canTransition({ status: 'in_progress' }, 'in_review', ctx({ hasArtifacts: true })).ok,
    ).toBe(true);
  });

  it('requires explicit acceptance + artifacts for in_review -> archived (no drag bypass)', () => {
    // 普通迁移（如拖拽）无法提供 accepted -> 拒绝，不得绕过人工验收
    expect(canTransition({ status: 'in_review' }, 'archived', ctx({ hasArtifacts: true })).ok).toBe(false);
    // 有验收但无产物 -> 拒绝
    expect(canTransition({ status: 'in_review' }, 'archived', ctx({ accepted: true, hasArtifacts: false })).ok).toBe(false);
    // 验收 + 产物 -> 允许
    expect(canTransition({ status: 'in_review' }, 'archived', ctx({ accepted: true, hasArtifacts: true })).ok).toBe(true);
  });

  it('allows in_progress -> awaiting_input without preconditions', () => {
    expect(canTransition({ status: 'in_progress' }, 'awaiting_input', ctx()).ok).toBe(true);
  });

  it('requires user answer for awaiting_input -> in_progress', () => {
    expect(canTransition({ status: 'awaiting_input' }, 'in_progress', ctx({ hasUserAnswer: false })).ok).toBe(false);
    expect(canTransition({ status: 'awaiting_input' }, 'in_progress', ctx({ hasUserAnswer: true })).ok).toBe(true);
  });

  it('validateTransition exposes allowed flag and reasons for drag UI', () => {
    const r = validateTransition({ status: 'backlog' }, 'ready', ctx({ hasAcceptance: false }));
    expect(r.allowed).toBe(false);
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it('canReturnToDev requires evidence', () => {
    expect(canReturnToDev(ctx({ testFailedWithEvidence: false })).ok).toBe(false);
    expect(canReturnToDev(ctx({ testFailedWithEvidence: true })).ok).toBe(true);
  });

  it('allows in_review <-> awaiting_input (pause/resume from testing)', () => {
    // 测试中任务可暂停到待沟通
    expect(canTransition({ status: 'in_review' }, 'awaiting_input', ctx()).ok).toBe(true);
    // 恢复到测试中需要用户回答
    expect(canTransition({ status: 'awaiting_input' }, 'in_review', ctx({ hasUserAnswer: false })).ok).toBe(false);
    expect(canTransition({ status: 'awaiting_input' }, 'in_review', ctx({ hasUserAnswer: true })).ok).toBe(true);
  });
});

describe('canArchiveRequirement', () => {
  it('rejects when no subtasks', () => {
    expect(canArchiveRequirement([]).ok).toBe(false);
  });
  it('rejects when any subtask not archived', () => {
    const r = canArchiveRequirement([{ status: 'archived' }, { status: 'in_progress' }]);
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/1/);
  });
  it('allows when all subtasks archived', () => {
    expect(canArchiveRequirement([{ status: 'archived' }, { status: 'archived' }]).ok).toBe(true);
  });
});

describe('checkTaskDependencies', () => {
  it('allows when there are no predecessors', () => {
    expect(checkTaskDependencies([]).ok).toBe(true);
    expect(checkTaskDependencies([]).blockedBy).toHaveLength(0);
  });
  it('blocks when a predecessor is still in active dev', () => {
    const r = checkTaskDependencies([{ id: 'a', title: 'A', status: 'in_progress' }]);
    expect(r.ok).toBe(false);
    expect(r.blockedBy).toHaveLength(1);
    expect(r.reasons.join(' ')).toMatch(/前置任务未完成/);
  });
  it('blocks on backlog/ready/awaiting_input predecessors', () => {
    for (const status of ['backlog', 'ready', 'in_progress', 'awaiting_input'] as const) {
      expect(checkTaskDependencies([{ id: 'a', title: 'A', status }]).ok).toBe(false);
    }
  });
  it('allows once every predecessor reached in_review or archived', () => {
    const r = checkTaskDependencies([
      { id: 'a', title: 'A', status: 'in_review' },
      { id: 'b', title: 'B', status: 'archived' },
    ]);
    expect(r.ok).toBe(true);
    expect(r.blockedBy).toHaveLength(0);
  });
});
