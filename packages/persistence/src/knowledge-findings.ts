// knowledge_findings 仓储：巡检发现问题，事务批量插入。
import type { DatabaseSync } from './db.js';
import type { KnowledgeSeverity } from '@ai-devflow/core';
import { tx } from './tx.js';

export interface KnowledgeFindingRecord {
  id: string;
  runId: string;
  severity: KnowledgeSeverity;
  code: string;
  path?: string;
  knowledgeId?: string;
  message: string;
  evidenceJson: string;
  createdAt: number;
}

function mapFinding(r: Record<string, unknown>): KnowledgeFindingRecord {
  return {
    id: r.id as string,
    runId: r.run_id as string,
    severity: r.severity as KnowledgeSeverity,
    code: r.code as string,
    path: (r.path as string | null) ?? undefined,
    knowledgeId: (r.knowledge_id as string | null) ?? undefined,
    message: r.message as string,
    evidenceJson: r.evidence_json as string,
    createdAt: r.created_at as number,
  };
}

export interface KnowledgeFindingsRepo {
  insertMany(values: KnowledgeFindingRecord[]): void;
  listByRun(runId: string): KnowledgeFindingRecord[];
}

export function createKnowledgeFindingsRepo(db: DatabaseSync): KnowledgeFindingsRepo {
  return {
    insertMany(values) {
      if (values.length === 0) return;
      tx(db, () => {
        const stmt = db.prepare(
          `INSERT INTO knowledge_findings(
             id, run_id, severity, code, path, knowledge_id, message, evidence_json, created_at
           ) VALUES(?,?,?,?,?,?,?,?,?)`,
        );
        for (const v of values) {
          stmt.run(
            v.id,
            v.runId,
            v.severity,
            v.code,
            v.path ?? null,
            v.knowledgeId ?? null,
            v.message,
            v.evidenceJson,
            v.createdAt,
          );
        }
      });
    },
    listByRun(runId) {
      const rows = db
        .prepare('SELECT * FROM knowledge_findings WHERE run_id=? ORDER BY created_at ASC, id ASC')
        .all(runId) as Record<string, unknown>[];
      return rows.map(mapFinding);
    },
  };
}
