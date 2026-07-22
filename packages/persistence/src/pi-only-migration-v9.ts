// Pi-only schema v9 迁移（设计 §12）。
//
// 该迁移是「破坏性切换」：删除 tasks.agent_type / execution_records.agent_type、
// 用 JSON 函数从项目设置移除 agentRoles/roleConfigs、删除 credentials.global_agent_config，
// 并新建 provider_health 与 execution_attempts 表。
//
// 注册状态：v9 已注册进 MIGRATIONS（migrations.ts）并随 openDatabase() 应用，当前已生效。
// 应用前先做一致性备份（§12.3，VACUUM INTO）与 SQLite 版本自检（DROP COLUMN 需 ≥ 3.35），
// 失败回滚且保留备份；重复应用会因列已删除而抛错。删除旧列时 orchestrator/repositories 已不再
// 引用它们——每一阶段保持类型检查与测试通过（设计 §18）。
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from './db.js';

export interface PiOnlyMigration {
  version: number;
  description: string;
  sql: string;
}

export const PI_ONLY_MIGRATION_V9: PiOnlyMigration = {
  version: 9,
  description: 'pi-only runtime, provider health, and execution attempts',
  sql: `
    ALTER TABLE tasks DROP COLUMN agent_type;
    ALTER TABLE execution_records DROP COLUMN agent_type;
    UPDATE projects
      SET settings_json = json_remove(settings_json, '$.agentRoles', '$.roleConfigs')
      WHERE json_valid(settings_json) = 1;
    DELETE FROM credentials WHERE key = 'global_agent_config';
    CREATE TABLE provider_health (
      provider_id TEXT NOT NULL,
      route_id TEXT NOT NULL,
      state TEXT NOT NULL,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      cooldown_until INTEGER,
      last_failure_kind TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(provider_id, route_id)
    );
    CREATE TABLE execution_attempts (
      id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL REFERENCES execution_records(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      route_id TEXT NOT NULL,
      state TEXT NOT NULL,
      mutations_observed INTEGER NOT NULL DEFAULT 0,
      journal_json TEXT NOT NULL DEFAULT '{}',
      started_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    CREATE INDEX idx_execution_attempts_execution ON execution_attempts(execution_id, ordinal);
  `,
};

/** DROP COLUMN / json_remove 需要 SQLite ≥ 3.35。低于则拒绝迁移（设计 §12.2）。 */
export function assertSqliteDropColumnSupport(db: DatabaseSync): void {
  const row = db.prepare('SELECT sqlite_version() AS v').get() as { v: string } | undefined;
  const version = row?.v ?? '0.0.0';
  const [maj = 0, min = 0] = version.split('.').map((n) => Number.parseInt(n, 10));
  if (maj < 3 || (maj === 3 && min < 35)) {
    throw new Error(`内置 SQLite ${version} 不支持 ALTER TABLE ... DROP COLUMN（需 ≥ 3.35），已阻止迁移。`);
  }
}

/**
 * 迁移前一致性备份（设计 §12.3）：校验 SQLite 版本后 `VACUUM INTO` 到
 * `<backupDir>/schema-v<oldVersion>-<timestamp>.db`，只保留最近三份（按时间戳）。
 */
export function backupBeforeMigration(
  db: DatabaseSync,
  _dbPath: string,
  backupDir: string,
  oldVersion: number,
  timestamp: number,
): string {
  assertSqliteDropColumnSupport(db);
  mkdirSync(backupDir, { recursive: true });
  const backupPath = join(backupDir, `schema-v${oldVersion}-${timestamp}.db`);
  db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  pruneBackups(backupDir, 3);
  return backupPath;
}

function pruneBackups(backupDir: string, keep: number): void {
  const files = readdirSync(backupDir)
    .filter((f) => /^schema-v\d+-\d+\.db$/.test(f))
    .map((f) => ({ name: f, ts: Number.parseInt(/-(\d+)\.db$/.exec(f)?.[1] ?? '0', 10) }))
    .sort((a, b) => b.ts - a.ts);
  for (const stale of files.slice(keep)) {
    rmSync(join(backupDir, stale.name), { force: true });
  }
}

/** 在事务中应用 v9；失败回滚且不破坏源库。重复应用会因列已删除而抛错。 */
export function applyPiOnlyMigrationV9(db: DatabaseSync): void {
  assertSqliteDropColumnSupport(db);
  db.exec('BEGIN');
  try {
    db.exec(PI_ONLY_MIGRATION_V9.sql);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
