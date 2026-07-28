// knowledge_runs 仓储：初始化 / 巡检 / 修复 / 迭代 CHANGELOG 运行元数据。
import type { DatabaseSync } from './db.js';
import type {
  KnowledgeRunKind,
  KnowledgeRunState,
  KnowledgeConfirmationState,
} from '@ai-devflow/core';

export interface KnowledgeRunRecord {
  id: string;
  projectId: string;
  iterationId?: string;
  kind: KnowledgeRunKind;
  state: KnowledgeRunState;
  draftBranch?: string;
  confirmationState: KnowledgeConfirmationState;
  changedPathsJson: string;
  diagnosticsJson: string;
  resultJson: string;
  startedAt: number;
  endedAt?: number;
}

function mapRun(r: Record<string, unknown>): KnowledgeRunRecord {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    iterationId: (r.iteration_id as string | null) ?? undefined,
    kind: r.kind as KnowledgeRunKind,
    state: r.state as KnowledgeRunState,
    draftBranch: (r.draft_branch as string | null) ?? undefined,
    confirmationState: r.confirmation_state as KnowledgeConfirmationState,
    changedPathsJson: r.changed_paths_json as string,
    diagnosticsJson: r.diagnostics_json as string,
    resultJson: r.result_json as string,
    startedAt: r.started_at as number,
    endedAt: (r.ended_at as number | null) ?? undefined,
  };
}

export interface KnowledgeRunsRepo {
  create(value: KnowledgeRunRecord): void;
  get(id: string): KnowledgeRunRecord | undefined;
  listByProject(projectId: string, limit?: number): KnowledgeRunRecord[];
  getLatestByIteration(iterationId: string, kind: 'iteration_changelog'): KnowledgeRunRecord | undefined;
  setProgress(id: string, resultJson: string, changedPathsJson: string): void;
  markAwaitingConfirmation(id: string, draftBranch: string, changedPathsJson: string): void;
  setConfirmation(id: string, state: 'pending' | 'confirmed' | 'canceled'): void;
  finish(
    id: string,
    state: 'succeeded' | 'failed' | 'canceled',
    endedAt: number,
    value?: { diagnosticsJson?: string; resultJson?: string; changedPathsJson?: string },
  ): void;
}

export function createKnowledgeRunsRepo(db: DatabaseSync): KnowledgeRunsRepo {
  return {
    create(value) {
      db.prepare(
        `INSERT INTO knowledge_runs(
           id, project_id, iteration_id, kind, state, draft_branch, confirmation_state,
           changed_paths_json, diagnostics_json, result_json, started_at, ended_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        value.id,
        value.projectId,
        value.iterationId ?? null,
        value.kind,
        value.state,
        value.draftBranch ?? null,
        value.confirmationState,
        value.changedPathsJson,
        value.diagnosticsJson,
        value.resultJson,
        value.startedAt,
        value.endedAt ?? null,
      );
    },
    get(id) {
      const r = db.prepare('SELECT * FROM knowledge_runs WHERE id=?').get(id) as
        | Record<string, unknown>
        | undefined;
      return r ? mapRun(r) : undefined;
    },
    listByProject(projectId, limit) {
      const sql = limit
        ? 'SELECT * FROM knowledge_runs WHERE project_id=? ORDER BY started_at DESC, id DESC LIMIT ?'
        : 'SELECT * FROM knowledge_runs WHERE project_id=? ORDER BY started_at DESC, id DESC';
      const rows = (limit
        ? db.prepare(sql).all(projectId, limit)
        : db.prepare(sql).all(projectId)) as Record<string, unknown>[];
      return rows.map(mapRun);
    },
    getLatestByIteration(iterationId, kind) {
      const r = db
        .prepare(
          `SELECT * FROM knowledge_runs WHERE iteration_id=? AND kind=? ORDER BY started_at DESC, id DESC LIMIT 1`,
        )
        .get(iterationId, kind) as Record<string, unknown> | undefined;
      return r ? mapRun(r) : undefined;
    },
    setProgress(id, resultJson, changedPathsJson) {
      db.prepare(
        `UPDATE knowledge_runs SET result_json=?, changed_paths_json=? WHERE id=?`,
      ).run(resultJson, changedPathsJson, id);
    },
    markAwaitingConfirmation(id, draftBranch, changedPathsJson) {
      db.prepare(
        `UPDATE knowledge_runs
           SET state='awaiting_confirmation', confirmation_state='pending',
               draft_branch=?, changed_paths_json=?
         WHERE id=?`,
      ).run(draftBranch, changedPathsJson, id);
    },
    setConfirmation(id, state) {
      db.prepare('UPDATE knowledge_runs SET confirmation_state=? WHERE id=?').run(state, id);
    },
    finish(id, state, endedAt, value) {
      if (value) {
        db.prepare(
          `UPDATE knowledge_runs
             SET state=?, ended_at=?,
                 diagnostics_json=COALESCE(?, diagnostics_json),
                 result_json=COALESCE(?, result_json),
                 changed_paths_json=COALESCE(?, changed_paths_json)
           WHERE id=?`,
        ).run(
          state,
          endedAt,
          value.diagnosticsJson ?? null,
          value.resultJson ?? null,
          value.changedPathsJson ?? null,
          id,
        );
      } else {
        db.prepare('UPDATE knowledge_runs SET state=?, ended_at=? WHERE id=?').run(state, endedAt, id);
      }
    },
  };
}
