import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { createRequire } from 'node:module';
import { MIGRATIONS } from './migrations.js';

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

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSyncCtor(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);
  return db;
}

/** 运行所有未应用的迁移，记录版本号。事务包裹保证原子。 */
export function runMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
  const current = getCurrentVersion(db);
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
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
  const row = db
    .prepare('SELECT MAX(version) AS v FROM schema_version')
    .get() as { v: number | null } | undefined;
  return row?.v ?? 0;
}
