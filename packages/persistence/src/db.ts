import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { MIGRATIONS } from './migrations.js';
import { backupBeforeMigration } from './pi-only-migration-v9.js';

// 兼容两种运行时：
// - esbuild 打包的 CJS（Electron main）：`require` 可用，直接用，避免 import.meta 为空。
// - vitest/vite ESM：`require` 不可用，回退到 createRequire(import.meta.url)。
declare const require: NodeRequire | undefined;
const _require: NodeRequire =
  typeof require !== 'undefined' ? require : createRequire(import.meta.url);

const { DatabaseSync: DatabaseSyncCtor } = _require('node:sqlite') as {
  DatabaseSync: new (location: string) => DatabaseSyncType;
};

export type DatabaseSync = DatabaseSyncType;

export interface OpenDatabaseOptions {
  /** 测试用：最多应用到的 schema 版本。缺省为全部（最新）。 */
  maxVersion?: number;
}

export function openDatabase(path: string, opts: OpenDatabaseOptions = {}): DatabaseSync {
  const db = new DatabaseSyncCtor(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  maybeBackupBeforeMigration(db, path, opts.maxVersion);
  runMigrations(db, opts.maxVersion);
  return db;
}

/**
 * 迁移前一致性备份（设计 §12.3）：只要文件型旧库存在待应用迁移，
 * 先 `VACUUM INTO` 到 <dbDir>/backups（保留最近三份），再执行迁移。':memory:' 库跳过。
 */
function maybeBackupBeforeMigration(db: DatabaseSync, path: string, maxVersion?: number): void {
  if (path === ':memory:') return;
  const current = getCurrentVersion(db);
  if (current === 0) return; // 全新库无需备份
  const target = maxVersion ?? MIGRATIONS[MIGRATIONS.length - 1]!.version;
  const hasPending = MIGRATIONS.some((m) => m.version > current && m.version <= target);
  if (!hasPending) return;
  backupBeforeMigration(db, path, join(dirname(path), 'backups'), current, Date.now());
}

/** 运行未应用的迁移（≤ target，缺省全部），记录版本号。事务包裹保证原子。 */
export function runMigrations(db: DatabaseSync, target?: number): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
  const max = target ?? MIGRATIONS[MIGRATIONS.length - 1]!.version;
  const current = getCurrentVersion(db);
  for (const m of MIGRATIONS) {
    if (m.version <= current || m.version > max) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_version(version, applied_at) VALUES (?, ?)').run(
        m.version,
        Date.now(),
      );
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

export function getCurrentVersion(db: DatabaseSync): number {
  try {
    const row = db
      .prepare('SELECT MAX(version) AS v FROM schema_version')
      .get() as { v: number | null } | undefined;
    return row?.v ?? 0;
  } catch {
    return 0; // schema_version 尚未创建（全新库）
  }
}
