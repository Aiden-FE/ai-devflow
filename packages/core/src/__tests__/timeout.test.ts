import { describe, it, expect } from 'vitest';
import {
  computeTriggerAt,
  ruleApplies,
  applicableRules,
  nextTrigger,
  findOverdue,
} from '../timeout.js';
import type { NotificationRule, Task } from '../types.js';

const rule = (over: Partial<NotificationRule> = {}): NotificationRule => ({
  id: 'r1',
  status: 'in_progress',
  minutes: 10,
  channels: ['desktop'],
  enabled: true,
  ...over,
});

const task = (over: Partial<Pick<Task, 'id' | 'projectId' | 'status' | 'statusChangedAt'>> = {}) => ({
  id: 't1',
  projectId: 'p1',
  status: 'in_progress' as Task['status'],
  statusChangedAt: 1000,
  ...over,
});

describe('timeout rules', () => {
  it('computeTriggerAt adds minutes as ms', () => {
    expect(computeTriggerAt(1000, 10)).toBe(1000 + 10 * 60_000);
    expect(computeTriggerAt(1000, 0)).toBe(1000);
  });

  it('ruleApplies respects status, project scope, enabled', () => {
    expect(ruleApplies(rule(), task())).toBe(true);
    expect(ruleApplies(rule({ enabled: false }), task())).toBe(false);
    expect(ruleApplies(rule({ status: 'ready' }), task())).toBe(false);
    expect(ruleApplies(rule({ projectId: 'other' }), task())).toBe(false);
    expect(ruleApplies(rule({ projectId: 'p1' }), task())).toBe(true);
  });

  it('applicableRules filters correctly', () => {
    const rules = [rule({ id: 'a' }), rule({ id: 'b', enabled: false }), rule({ id: 'c', status: 'ready' })];
    expect(applicableRules(rules, task()).map((r) => r.id)).toEqual(['a']);
  });

  it('nextTrigger returns earliest and overdue flag', () => {
    const rules = [rule({ id: 'a', minutes: 30 }), rule({ id: 'b', minutes: 5 })];
    const r = nextTrigger(rules, task(), 1000 + 6 * 60_000);
    expect(r).not.toBeNull();
    expect(r!.ruleId).toBe('b');
    expect(r!.overdue).toBe(true);
  });

  it('nextTrigger returns null when nothing overdue-not-required but not yet triggered', () => {
    const r = nextTrigger([rule({ minutes: 10 })], task(), 1000 + 60_000);
    expect(r).not.toBeNull();
    expect(r!.overdue).toBe(false);
  });

  it('nextTrigger returns null when no applicable rules', () => {
    expect(nextTrigger([rule({ status: 'ready' })], task(), 9999)).toBeNull();
  });

  it('findOverdue lists all overdue (rule,task) pairs', () => {
    const rules = [rule({ id: 'a', minutes: 1 }), rule({ id: 'b', minutes: 60 })];
    const tasks = [
      task({ id: 't1', statusChangedAt: 0 }),
      task({ id: 't2', statusChangedAt: 1000 }),
    ];
    const overdue = findOverdue(rules, tasks, 120_000); // 2min
    // t1: rule a (1min) overdue, rule b (60min) not; t2: rule a overdue, rule b not
    expect(overdue).toContainEqual({ taskId: 't1', ruleId: 'a', triggerAt: 60_000 });
    expect(overdue).toContainEqual({ taskId: 't2', ruleId: 'a', triggerAt: 1000 + 60_000 });
    expect(overdue.some((o) => o.ruleId === 'b')).toBe(false);
  });

  it('timing survives restart: trigger is a pure function of statusChangedAt', () => {
    // 重启前后只要 statusChangedAt 不变，triggerAt 一致。
    const a = computeTriggerAt(5000, 7);
    const b = computeTriggerAt(5000, 7);
    expect(a).toBe(b);
  });
});
