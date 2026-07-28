// knowledge_depositions 仓储：知识价值评估与沉淀运行。
import type { DatabaseSync } from './db.js';
import type { KnowledgeAssessment, KnowledgeDepositionRecord } from '@ai-devflow/core';

export interface KnowledgeDepositionRecordRow {
  id: string;
  projectId: string;
  taskId: string;
  executionId?: string;
  retrievalId?: string;
  verdict: 'none' | 'valuable';
  state: KnowledgeDepositionRecord['state'];
  assessmentJson: string;
  relatedKnowledgeIdsJson: string;
  changedPathsJson: string;
  gatePassed: boolean;
  diagnosticsJson: string;
  progressJson?: string;
  startedAt: number;
  endedAt?: number;
}

export interface KnowledgeDepositionCompletion {
  state: KnowledgeDepositionRecord['state'];
  relatedKnowledgeIdsJson: string;
  changedPathsJson: string;
  gatePassed: boolean;
  diagnosticsJson: string;
  endedAt: number;
}

export interface KnowledgeDepositionProgressUpdate {
  relatedKnowledgeIdsJson: string;
  changedPathsJson: string;
  progressJson: string;
}

function mapDeposition(r: Record<string, unknown>): KnowledgeDepositionRecordRow {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    taskId: r.task_id as string,
    executionId: (r.execution_id as string | null) ?? undefined,
    retrievalId: (r.retrieval_id as string | null) ?? undefined,
    verdict: r.verdict as 'none' | 'valuable',
    state: r.state as KnowledgeDepositionRecord['state'],
    assessmentJson: r.assessment_json as string,
    relatedKnowledgeIdsJson: r.related_knowledge_ids_json as string,
    changedPathsJson: r.changed_paths_json as string,
    gatePassed: (r.gate_passed as number) === 1,
    diagnosticsJson: r.diagnostics_json as string,
    progressJson: (r.progress_json as string | null) ?? '{}',
    startedAt: r.started_at as number,
    endedAt: (r.ended_at as number | null) ?? undefined,
  };
}

export interface KnowledgeDepositionsRepo {
  create(value: KnowledgeDepositionRecordRow): void;
  get(id: string): KnowledgeDepositionRecordRow | undefined;
  finish(id: string, value: KnowledgeDepositionCompletion): void;
  updateProgress(id: string, value: KnowledgeDepositionProgressUpdate): void;
  getLatestByTask(taskId: string): KnowledgeDepositionRecordRow | undefined;
  listByTask(taskId: string): KnowledgeDepositionRecordRow[];
}

export function createKnowledgeDepositionsRepo(db: DatabaseSync): KnowledgeDepositionsRepo {
  return {
    create(value) {
      db.prepare(
        `INSERT INTO knowledge_depositions(
           id, project_id, task_id, execution_id, retrieval_id, verdict, state,
           assessment_json, related_knowledge_ids_json, changed_paths_json,
           gate_passed, diagnostics_json, progress_json, started_at, ended_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        value.id,
        value.projectId,
        value.taskId,
        value.executionId ?? null,
        value.retrievalId ?? null,
        value.verdict,
        value.state,
        value.assessmentJson,
        value.relatedKnowledgeIdsJson,
        value.changedPathsJson,
        value.gatePassed ? 1 : 0,
        value.diagnosticsJson,
        value.progressJson ?? '{}',
        value.startedAt,
        value.endedAt ?? null,
      );
    },
    get(id) {
      const r = db.prepare('SELECT * FROM knowledge_depositions WHERE id=?').get(id) as
        | Record<string, unknown>
        | undefined;
      return r ? mapDeposition(r) : undefined;
    },
    finish(id, value) {
      db.prepare(
        `UPDATE knowledge_depositions
           SET state=?, related_knowledge_ids_json=?, changed_paths_json=?,
               gate_passed=?, diagnostics_json=?, ended_at=?
         WHERE id=?`,
      ).run(
        value.state,
        value.relatedKnowledgeIdsJson,
        value.changedPathsJson,
        value.gatePassed ? 1 : 0,
        value.diagnosticsJson,
        value.endedAt,
        id,
      );
    },
    updateProgress(id, value) {
      db.prepare(
        `UPDATE knowledge_depositions
           SET related_knowledge_ids_json=?, changed_paths_json=?, progress_json=?
         WHERE id=?`,
      ).run(value.relatedKnowledgeIdsJson, value.changedPathsJson, value.progressJson, id);
    },
    getLatestByTask(taskId) {
      const r = db
        .prepare(
          'SELECT * FROM knowledge_depositions WHERE task_id=? ORDER BY started_at DESC, id DESC LIMIT 1',
        )
        .get(taskId) as Record<string, unknown> | undefined;
      return r ? mapDeposition(r) : undefined;
    },
    listByTask(taskId) {
      const rows = db
        .prepare('SELECT * FROM knowledge_depositions WHERE task_id=? ORDER BY started_at DESC, id DESC')
        .all(taskId) as Record<string, unknown>[];
      return rows.map(mapDeposition);
    },
  };
}

export type { KnowledgeAssessment };
