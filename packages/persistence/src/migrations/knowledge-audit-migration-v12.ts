import type { Migration } from '../migrations.js';

/**
 * v12：渐进式知识库闭环——新增四张知识运行元数据表。
 *
 * 仅保存 ID、路径、计数器、问题与证据引用；不保存 Markdown 正文、prompt 或知识内容。
 * - knowledge_runs：初始化 / 巡检 / 修复 / 迭代 CHANGELOG 运行。
 * - knowledge_findings：结构巡检发现问题（事务批量插入）。
 * - knowledge_retrievals：检索 manifest 的候选引用、实际读取与预算。
 * - knowledge_depositions：知识价值评估与沉淀运行。
 */
export const KNOWLEDGE_AUDIT_MIGRATION_V12: Migration = {
  version: 12,
  description: 'progressive knowledge base: knowledge_runs/findings/retrievals/depositions metadata',
  sql: `
    CREATE TABLE IF NOT EXISTS knowledge_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      iteration_id TEXT REFERENCES iterations(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      draft_branch TEXT,
      confirmation_state TEXT NOT NULL DEFAULT 'not_required',
      changed_paths_json TEXT NOT NULL DEFAULT '[]',
      diagnostics_json TEXT NOT NULL DEFAULT '[]',
      result_json TEXT NOT NULL DEFAULT '{}',
      started_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_runs_project ON knowledge_runs(project_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_knowledge_runs_iteration ON knowledge_runs(iteration_id, started_at);

    CREATE TABLE IF NOT EXISTS knowledge_findings (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES knowledge_runs(id) ON DELETE CASCADE,
      severity TEXT NOT NULL,
      code TEXT NOT NULL,
      path TEXT,
      knowledge_id TEXT,
      message TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_findings_run ON knowledge_findings(run_id, created_at);

    CREATE TABLE IF NOT EXISTS knowledge_retrievals (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      execution_id TEXT REFERENCES execution_records(id) ON DELETE SET NULL,
      expert_key TEXT NOT NULL,
      stage TEXT NOT NULL,
      level INTEGER NOT NULL,
      state TEXT NOT NULL,
      candidate_refs_json TEXT NOT NULL DEFAULT '[]',
      read_evidence_json TEXT NOT NULL DEFAULT '[]',
      skipped_refs_json TEXT NOT NULL DEFAULT '[]',
      differences_json TEXT NOT NULL DEFAULT '[]',
      budget_files INTEGER NOT NULL,
      budget_chars INTEGER NOT NULL,
      used_files INTEGER NOT NULL DEFAULT 0,
      used_chars INTEGER NOT NULL DEFAULT 0,
      confidence REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_retrievals_project ON knowledge_retrievals(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_knowledge_retrievals_task ON knowledge_retrievals(task_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_knowledge_retrievals_execution ON knowledge_retrievals(execution_id);

    CREATE TABLE IF NOT EXISTS knowledge_depositions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      execution_id TEXT REFERENCES execution_records(id) ON DELETE SET NULL,
      retrieval_id TEXT REFERENCES knowledge_retrievals(id) ON DELETE SET NULL,
      verdict TEXT NOT NULL,
      state TEXT NOT NULL,
      assessment_json TEXT NOT NULL,
      related_knowledge_ids_json TEXT NOT NULL DEFAULT '[]',
      changed_paths_json TEXT NOT NULL DEFAULT '[]',
      gate_passed INTEGER NOT NULL DEFAULT 0,
      diagnostics_json TEXT NOT NULL DEFAULT '[]',
      started_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_depositions_task ON knowledge_depositions(task_id, started_at);
  `,
};
