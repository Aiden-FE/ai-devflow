// 重试与恢复策略：计算退避延迟、判定是否可重试、恢复语义。

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** 是否对可恢复错误启用指数退避。 */
  backoff: boolean;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  backoff: true,
};

/** 指数退避 + 抖动（用 attempt 作为确定性因子，避免 Math.random 以便测试）。 */
export function backoffDelay(policy: RetryPolicy, attempt: number, jitterFactor = 0): number {
  const exp = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * Math.pow(2, Math.max(0, attempt - 1)),
  );
  const jitter = Math.round(exp * jitterFactor);
  return Math.max(0, Math.min(policy.maxDelayMs, exp + jitter));
}

export interface RetryDecision {
  retry: boolean;
  delayMs: number;
  reason: string;
}

/** 判定一次失败是否应重试。attempt 从 1 开始。 */
export function decideRetry(
  policy: RetryPolicy,
  attempt: number,
  recoverable: boolean,
): RetryDecision {
  if (!recoverable) {
    return { retry: false, delayMs: 0, reason: '错误不可恢复，不重试' };
  }
  if (attempt >= policy.maxAttempts) {
    return { retry: false, delayMs: 0, reason: `已达最大尝试次数 ${policy.maxAttempts}` };
  }
  const delay = policy.backoff ? backoffDelay(policy, attempt + 1) : policy.baseDelayMs;
  return { retry: true, delayMs: delay, reason: `第 ${attempt + 1} 次尝试，延迟 ${delay}ms` };
}

/**
 * 恢复策略：应用重启后，根据执行记录状态决定如何恢复一个任务。
 * - running 但子进程已死 -> 标记 failed，可重试
 * - paused -> 等待用户恢复
 * - awaiting_input -> 保留待沟通，等待回答
 * - succeeded/failed/canceled -> 不动
 */
export type RecoveryAction =
  | { kind: 'resume'; fromStageIndex: number }
  | { kind: 'fail'; reason: string }
  | { kind: 'wait'; reason: string }
  | { kind: 'noop'; reason: string };

export function planRecovery(
  execution: { status: 'running' | 'paused' | 'succeeded' | 'failed' | 'canceled' },
  taskStatus: 'in_progress' | 'awaiting_input' | 'paused',
  processAlive: boolean,
  lastStageIndex: number,
): RecoveryAction {
  if (execution.status === 'succeeded' || execution.status === 'canceled') {
    return { kind: 'noop', reason: '执行已结束' };
  }
  if (execution.status === 'failed') {
    return { kind: 'noop', reason: '执行已失败，等待显式重试' };
  }
  if (taskStatus === 'awaiting_input') {
    return { kind: 'wait', reason: '任务待沟通，等待用户回答后从检查点恢复' };
  }
  if (execution.status === 'paused') {
    return { kind: 'wait', reason: '执行已暂停，等待用户恢复' };
  }
  // running
  if (processAlive) {
    return { kind: 'resume', fromStageIndex: lastStageIndex };
  }
  return { kind: 'fail', reason: '重启后发现运行中任务子进程已死，标记失败' };
}
