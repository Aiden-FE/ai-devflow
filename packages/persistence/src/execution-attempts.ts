// 执行尝试（attempt）持久化仓储（设计 §10 AttemptJournal 的存储）。
// 结构化满足 agents 包 AttemptJournalWriter 的 ExecutionAttemptStore 窄接口（Task 9 注入）。
import type { DatabaseSync } from './db.js';

export interface ExecutionAttemptRecord {
  id: string;
  executionId: string;
  ordinal: number;
  routeId: string;
  state: 'running' | 'succeeded' | 'failed' | 'canceled';
  mutationsObserved: boolean;
  journalJson: string;
  startedAt: number;
  endedAt?: number;
}

export interface ExecutionAttemptsRepo {
  create(value: ExecutionAttemptRecord): void;
  updateJournal(id: string, journalJson: string, mutationsObserved: boolean): void;
  finish(id: string, state: 'succeeded' | 'failed' | 'canceled', endedAt: number): void;
  listByExecution(executionId: string): ExecutionAttemptRecord[];
}

function mapAttempt(r: Record<string, unknown>): ExecutionAttemptRecord {
  return {
    id: r.id as string,
    executionId: r.execution_id as string,
    ordinal: r.ordinal as number,
    routeId: r.route_id as string,
    state: r.state as ExecutionAttemptRecord['state'],
    mutationsObserved: (r.mutations_observed as number) === 1,
    journalJson: r.journal_json as string,
    startedAt: r.started_at as number,
    endedAt: (r.ended_at as number | null) ?? undefined,
  };
}

export function createExecutionAttemptsRepo(db: DatabaseSync): ExecutionAttemptsRepo {
  return {
    create(value) {
      db.prepare(
        `INSERT INTO execution_attempts(id,execution_id,ordinal,route_id,state,mutations_observed,journal_json,started_at,ended_at)
         VALUES(?,?,?,?,?,?,?,?,?)`,
      ).run(
        value.id, value.executionId, value.ordinal, value.routeId, value.state,
        value.mutationsObserved ? 1 : 0, value.journalJson, value.startedAt, value.endedAt ?? null,
      );
    },
    updateJournal(id, journalJson, mutationsObserved) {
      db.prepare('UPDATE execution_attempts SET journal_json=?, mutations_observed=? WHERE id=?').run(
        journalJson, mutationsObserved ? 1 : 0, id,
      );
    },
    finish(id, state, endedAt) {
      db.prepare('UPDATE execution_attempts SET state=?, ended_at=? WHERE id=?').run(state, endedAt, id);
    },
    listByExecution(executionId) {
      return (
        db.prepare('SELECT * FROM execution_attempts WHERE execution_id=? ORDER BY ordinal ASC').all(executionId) as Record<string, unknown>[]
      ).map(mapAttempt);
    },
  };
}
