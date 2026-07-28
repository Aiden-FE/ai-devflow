// knowledge_retrievals 仓储：检索 manifest 的候选引用、实际读取与预算。
import type { DatabaseSync } from './db.js';
import type {
  AgentKey,
  KnowledgeRetrievalLevel,
  KnowledgeRetrievalManifest,
} from '@ai-devflow/core';

export interface KnowledgeRetrievalRecord {
  id: string;
  projectId: string;
  taskId?: string;
  executionId?: string;
  expertKey: AgentKey;
  stage: string;
  level: KnowledgeRetrievalLevel;
  state: KnowledgeRetrievalManifest['state'];
  candidateRefsJson: string;
  readEvidenceJson: string;
  skippedRefsJson: string;
  differencesJson: string;
  budgetFiles: number;
  budgetChars: number;
  usedFiles: number;
  usedChars: number;
  confidence: number;
  createdAt: number;
  completedAt?: number;
}

export interface KnowledgeRetrievalCompletion {
  state: 'completed' | 'failed';
  readEvidenceJson: string;
  skippedRefsJson: string;
  differencesJson: string;
  usedFiles: number;
  usedChars: number;
  confidence: number;
  completedAt: number;
}

function mapRetrieval(r: Record<string, unknown>): KnowledgeRetrievalRecord {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    taskId: (r.task_id as string | null) ?? undefined,
    executionId: (r.execution_id as string | null) ?? undefined,
    expertKey: r.expert_key as AgentKey,
    stage: r.stage as string,
    level: r.level as KnowledgeRetrievalLevel,
    state: r.state as KnowledgeRetrievalManifest['state'],
    candidateRefsJson: r.candidate_refs_json as string,
    readEvidenceJson: r.read_evidence_json as string,
    skippedRefsJson: r.skipped_refs_json as string,
    differencesJson: r.differences_json as string,
    budgetFiles: r.budget_files as number,
    budgetChars: r.budget_chars as number,
    usedFiles: r.used_files as number,
    usedChars: r.used_chars as number,
    confidence: r.confidence as number,
    createdAt: r.created_at as number,
    completedAt: (r.completed_at as number | null) ?? undefined,
  };
}

export interface KnowledgeRetrievalsRepo {
  create(value: KnowledgeRetrievalRecord): void;
  get(id: string): KnowledgeRetrievalRecord | undefined;
  complete(id: string, value: KnowledgeRetrievalCompletion): void;
  listByState(state: KnowledgeRetrievalManifest['state']): KnowledgeRetrievalRecord[];
  listByTask(taskId: string, limit?: number): KnowledgeRetrievalRecord[];
  listByExecution(executionId: string): KnowledgeRetrievalRecord[];
}

export function createKnowledgeRetrievalsRepo(db: DatabaseSync): KnowledgeRetrievalsRepo {
  return {
    create(value) {
      db.prepare(
        `INSERT INTO knowledge_retrievals(
           id, project_id, task_id, execution_id, expert_key, stage, level, state,
           candidate_refs_json, read_evidence_json, skipped_refs_json, differences_json,
           budget_files, budget_chars, used_files, used_chars, confidence, created_at, completed_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        value.id,
        value.projectId,
        value.taskId ?? null,
        value.executionId ?? null,
        value.expertKey,
        value.stage,
        value.level,
        value.state,
        value.candidateRefsJson,
        value.readEvidenceJson,
        value.skippedRefsJson,
        value.differencesJson,
        value.budgetFiles,
        value.budgetChars,
        value.usedFiles,
        value.usedChars,
        value.confidence,
        value.createdAt,
        value.completedAt ?? null,
      );
    },
    get(id) {
      const r = db.prepare('SELECT * FROM knowledge_retrievals WHERE id=?').get(id) as
        | Record<string, unknown>
        | undefined;
      return r ? mapRetrieval(r) : undefined;
    },
    complete(id, value) {
      db.prepare(
        `UPDATE knowledge_retrievals
           SET state=?, read_evidence_json=?, skipped_refs_json=?, differences_json=?,
               used_files=?, used_chars=?, confidence=?, completed_at=?
         WHERE id=?`,
      ).run(
        value.state,
        value.readEvidenceJson,
        value.skippedRefsJson,
        value.differencesJson,
        value.usedFiles,
        value.usedChars,
        value.confidence,
        value.completedAt,
        id,
      );
    },
    listByState(state) {
      const rows = db
        .prepare('SELECT * FROM knowledge_retrievals WHERE state=? ORDER BY created_at ASC, id ASC')
        .all(state) as Record<string, unknown>[];
      return rows.map(mapRetrieval);
    },
    listByTask(taskId, limit) {
      const sql = limit
        ? 'SELECT * FROM knowledge_retrievals WHERE task_id=? ORDER BY created_at DESC, id DESC LIMIT ?'
        : 'SELECT * FROM knowledge_retrievals WHERE task_id=? ORDER BY created_at DESC, id DESC';
      const rows = (limit
        ? db.prepare(sql).all(taskId, limit)
        : db.prepare(sql).all(taskId)) as Record<string, unknown>[];
      return rows.map(mapRetrieval);
    },
    listByExecution(executionId) {
      const rows = db
        .prepare('SELECT * FROM knowledge_retrievals WHERE execution_id=? ORDER BY created_at DESC, id DESC')
        .all(executionId) as Record<string, unknown>[];
      return rows.map(mapRetrieval);
    },
  };
}
