import type { RetentionPolicy } from '@ai-devflow/core';
import { DEFAULT_RETENTION_POLICY } from '@ai-devflow/core';
import type { DatabaseSync, Repositories } from '@ai-devflow/persistence';

const POLICY_KEY = 'data-retention:v1';
const LAST_RUN_KEY = 'data-retention:last-run';
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionRunResult {
  skipped: boolean;
  ranAt: number;
  logsDeleted: number;
  attemptsDeleted: number;
  messagesDeleted: number;
  providerRowsRolledUp: number;
}

export interface RetentionServiceOptions {
  now?: () => number;
  batchSize?: number;
  intervalMs?: number;
}

function validatePolicy(policy: RetentionPolicy): RetentionPolicy {
  const limits: Array<[keyof RetentionPolicy, number]> = [
    ['executionDetailDays', 7],
    ['archivedConversationDays', 30],
    ['providerRawDays', 30],
  ];
  for (const [key, minimum] of limits) {
    if (!Number.isSafeInteger(policy[key]) || policy[key] < minimum) {
      throw new Error(`${key} 必须是不小于 ${minimum} 的整数天数`);
    }
  }
  return { ...policy };
}

function emptyResult(ranAt: number, skipped: boolean): RetentionRunResult {
  return {
    skipped,
    ranAt,
    logsDeleted: 0,
    attemptsDeleted: 0,
    messagesDeleted: 0,
    providerRowsRolledUp: 0,
  };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export class RetentionService {
  private timer?: NodeJS.Timeout;
  private running?: Promise<RetentionRunResult>;
  private readonly now: () => number;
  private readonly batchSize: number;
  private readonly intervalMs: number;

  constructor(
    private readonly db: DatabaseSync,
    private readonly repos: Repositories,
    options: RetentionServiceOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.batchSize = options.batchSize ?? 250;
    this.intervalMs = options.intervalMs ?? DAY_MS;
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize <= 0) {
      throw new Error('清理批量必须是正整数');
    }
  }

  getPolicy(): RetentionPolicy {
    const raw = this.repos.credentials.get(POLICY_KEY);
    if (!raw) return { ...DEFAULT_RETENTION_POLICY };
    try {
      return validatePolicy(JSON.parse(raw) as RetentionPolicy);
    } catch {
      return { ...DEFAULT_RETENTION_POLICY };
    }
  }

  setPolicy(policy: RetentionPolicy): RetentionPolicy {
    const validated = validatePolicy(policy);
    this.repos.credentials.upsert(POLICY_KEY, JSON.stringify(validated));
    return validated;
  }

  getLastRunAt(): number | undefined {
    const value = Number(this.repos.credentials.get(LAST_RUN_KEY));
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }

  runIfDue(force = false): Promise<RetentionRunResult> {
    if (this.running) return this.running;
    const promise = this.run(force).finally(() => {
      if (this.running === promise) this.running = undefined;
    });
    this.running = promise;
    return promise;
  }

  start(): void {
    if (this.timer) return;
    void this.runIfDue().catch(() => undefined);
    this.timer = setInterval(() => {
      void this.runIfDue().catch(() => undefined);
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  compact(): void {
    this.db.exec('VACUUM');
  }

  private async run(force: boolean): Promise<RetentionRunResult> {
    const ranAt = this.now();
    const lastRunAt = this.getLastRunAt();
    if (!force && lastRunAt !== undefined && ranAt - lastRunAt < DAY_MS) {
      return emptyResult(ranAt, true);
    }

    const policy = this.getPolicy();
    const result = emptyResult(ranAt, false);
    const executionCutoff = Math.max(0, ranAt - policy.executionDetailDays * DAY_MS);
    const conversationCutoff = Math.max(0, ranAt - policy.archivedConversationDays * DAY_MS);
    const providerCutoff = Math.max(0, ranAt - policy.providerRawDays * DAY_MS);

    result.logsDeleted = await this.drain(() => this.deleteOldLogs(executionCutoff));
    result.attemptsDeleted = await this.drain(() => this.deleteOldAttempts(executionCutoff));
    result.messagesDeleted = await this.drain(() => this.deleteOldArchivedMessages(conversationCutoff));

    for (;;) {
      const batch = this.repos.providerUsage.rollupAndPrune(providerCutoff, this.batchSize);
      result.providerRowsRolledUp += batch.rolledUp;
      if (batch.deleted === 0) break;
      await yieldToEventLoop();
    }

    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.repos.credentials.upsert(LAST_RUN_KEY, String(ranAt));
    return result;
  }

  private async drain(deleteBatch: () => number): Promise<number> {
    let total = 0;
    for (;;) {
      const deleted = deleteBatch();
      total += deleted;
      if (deleted === 0) return total;
      await yieldToEventLoop();
    }
  }

  private deleteOldLogs(before: number): number {
    const result = this.db.prepare(`
      DELETE FROM log_entries WHERE rowid IN (
        SELECT l.rowid FROM log_entries l
        JOIN execution_records e ON e.id=l.execution_id
        WHERE e.status IN ('succeeded','failed','canceled')
          AND COALESCE(e.ended_at, e.started_at) < ?
        ORDER BY l.t, l.rowid LIMIT ?
      )
    `).run(before, this.batchSize);
    return Number(result.changes);
  }

  private deleteOldAttempts(before: number): number {
    const result = this.db.prepare(`
      DELETE FROM execution_attempts WHERE rowid IN (
        SELECT a.rowid FROM execution_attempts a
        JOIN execution_records e ON e.id=a.execution_id
        WHERE e.status IN ('succeeded','failed','canceled')
          AND COALESCE(e.ended_at, e.started_at) < ?
        ORDER BY a.started_at, a.rowid LIMIT ?
      )
    `).run(before, this.batchSize);
    return Number(result.changes);
  }

  private deleteOldArchivedMessages(before: number): number {
    const result = this.db.prepare(`
      DELETE FROM task_messages WHERE rowid IN (
        SELECT m.rowid FROM task_messages m
        JOIN tasks t ON t.id=m.task_id
        WHERE t.status='archived' AND t.archived_at IS NOT NULL AND t.archived_at < ?
        ORDER BY m.t, m.rowid LIMIT ?
      )
    `).run(before, this.batchSize);
    return Number(result.changes);
  }
}
