import type { DatabaseSync } from 'node:sqlite';

/** 事务封装：BEGIN/COMMIT，异常 ROLLBACK。支持嵌套（用 savepoint）。 */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  // node:sqlite 不支持嵌套 BEGIN；用计数模拟嵌套以避免重复 BEGIN 错误。
  const n = (txDepth.get(db) ?? 0);
  if (n === 0) {
    db.exec('BEGIN');
  } else {
    db.exec(`SAVEPOINT sp${n}`);
  }
  txDepth.set(db, n + 1);
  try {
    const result = fn();
    const d = txDepth.get(db)! - 1;
    txDepth.set(db, d);
    if (d === 0) db.exec('COMMIT');
    else db.exec(`RELEASE sp${d}`);
    return result;
  } catch (err) {
    const d = txDepth.get(db)! - 1;
    txDepth.set(db, d);
    if (d === 0) db.exec('ROLLBACK');
    else db.exec(`ROLLBACK TO sp${d}`);
    throw err;
  }
}

const txDepth = new WeakMap<DatabaseSync, number>();
