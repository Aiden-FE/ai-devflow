import { describe, it, expect } from 'vitest';
import { auditTask, auditOk } from '../audit.js';
import type { Task } from '../types.js';

const task = (over: Partial<Task> = {}): Task => ({
  id: 't1',
  requirementId: 'r1',
  iterationId: 'i1',
  projectId: 'p1',
  title: 'T',
  description: '',
  status: 'in_progress',
  role: 'coder',
  stages: [],
  currentStage: 0,
  statusChangedAt: 0,
  createdAt: 0,
  updatedAt: 0,
  retryCount: 0,
  ...over,
});

const ctx = (over: Record<string, unknown> = {}) => ({
  worktreeExists: true,
  hasExecutionRecord: true,
  hasCheckpoint: true,
  hasArtifacts: true,
  ...over,
});

describe('audit', () => {
  it('warns when in_progress task lacks worktree/record', () => {
    const f = auditTask(task({ status: 'in_progress' }), ctx({ worktreeExists: false }));
    expect(f.some((x) => x.message.includes('worktree'))).toBe(true);
  });

  it('errors when archived without artifacts', () => {
    const f = auditTask(task({ status: 'archived' }), ctx({ hasArtifacts: false }));
    expect(f.some((x) => x.severity === 'error')).toBe(true);
    expect(auditOk(f)).toBe(false);
  });

  it('errors when awaiting_input has no checkpoint', () => {
    const f = auditTask(task({ status: 'awaiting_input' }), ctx({ hasCheckpoint: false }));
    expect(f.some((x) => x.severity === 'error' && x.message.includes('检查点'))).toBe(true);
  });

  it('passes clean archived task', () => {
    const f = auditTask(task({ status: 'archived' }), ctx({ testPassed: true, hasArtifacts: true }));
    expect(auditOk(f)).toBe(true);
  });

  it('auditOk false when any error present', () => {
    expect(auditOk([{ taskId: 't', severity: 'error', message: 'x' }])).toBe(false);
    expect(auditOk([{ taskId: 't', severity: 'warn', message: 'x' }])).toBe(true);
  });
});
