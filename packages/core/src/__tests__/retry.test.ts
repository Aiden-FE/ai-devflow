import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RETRY_POLICY,
  backoffDelay,
  decideRetry,
  planRecovery,
} from '../retry.js';

describe('retry & recovery', () => {
  it('backoffDelay grows exponentially and caps at max', () => {
    const p = { ...DEFAULT_RETRY_POLICY, baseDelayMs: 1000, maxDelayMs: 10_000 };
    expect(backoffDelay(p, 1)).toBe(1000);
    expect(backoffDelay(p, 2)).toBe(2000);
    expect(backoffDelay(p, 3)).toBe(4000);
    expect(backoffDelay(p, 10)).toBe(10_000); // capped
  });

  it('backoffDelay with jitter stays within bounds', () => {
    const p = { ...DEFAULT_RETRY_POLICY, baseDelayMs: 1000, maxDelayMs: 10_000 };
    const d = backoffDelay(p, 2, 0.2);
    expect(d).toBeGreaterThanOrEqual(2000);
    expect(d).toBeLessThanOrEqual(10_000);
  });

  it('decideRetry refuses non-recoverable errors', () => {
    const r = decideRetry(DEFAULT_RETRY_POLICY, 1, false);
    expect(r.retry).toBe(false);
    expect(r.reason).toMatch(/不可恢复/);
  });

  it('decideRetry stops at maxAttempts', () => {
    const r = decideRetry(DEFAULT_RETRY_POLICY, DEFAULT_RETRY_POLICY.maxAttempts, true);
    expect(r.retry).toBe(false);
    expect(r.reason).toMatch(/最大尝试次数/);
  });

  it('decideRetry retries with increasing delay', () => {
    const r1 = decideRetry(DEFAULT_RETRY_POLICY, 1, true);
    const r2 = decideRetry(DEFAULT_RETRY_POLICY, 2, true);
    expect(r1.retry).toBe(true);
    expect(r2.retry).toBe(true);
    expect(r2.delayMs).toBeGreaterThan(r1.delayMs);
  });

  it('planRecovery: running + dead process -> fail', () => {
    const a = planRecovery({ status: 'running' }, 'in_progress', false, 1);
    expect(a.kind).toBe('fail');
  });

  it('planRecovery: running + alive process -> resume', () => {
    const a = planRecovery({ status: 'running' }, 'in_progress', true, 2);
    expect(a.kind).toBe('resume');
    if (a.kind === 'resume') expect(a.fromStageIndex).toBe(2);
  });

  it('planRecovery: paused -> wait', () => {
    const a = planRecovery({ status: 'paused' }, 'in_progress', false, 0);
    expect(a.kind).toBe('wait');
  });

  it('planRecovery: awaiting_input -> wait (survives restart)', () => {
    const a = planRecovery({ status: 'running' }, 'awaiting_input', false, 1);
    expect(a.kind).toBe('wait');
  });

  it('planRecovery: succeeded/canceled -> noop', () => {
    expect(planRecovery({ status: 'succeeded' }, 'in_progress', false, 0).kind).toBe('noop');
    expect(planRecovery({ status: 'canceled' }, 'in_progress', false, 0).kind).toBe('noop');
  });
});
