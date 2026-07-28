import type { Migration } from '../migrations.js';
import { isCanonicalGitBranchSegment, sanitizeGitBranchSegment } from '@ai-devflow/core';

function legacyBranchSegment(version: string): string {
  return sanitizeGitBranchSegment(version);
}

function assertNoLegacyVersionCollisions(db: import('../db.js').DatabaseSync): void {
  const rows = db.prepare(
    'SELECT id, project_id, version FROM iterations ORDER BY project_id, created_at, id',
  ).all() as Array<{ id: string; project_id: string; version: string }>;
  const groups = new Map<string, Array<{ id: string; version: string }>>();
  const noncanonical: string[] = [];
  for (const row of rows) {
    const branchSegment = legacyBranchSegment(row.version);
    if (!isCanonicalGitBranchSegment(row.version)) {
      noncanonical.push(`${row.project_id}: ${row.id}=${JSON.stringify(row.version)} -> ${JSON.stringify(branchSegment)}`);
    }
    const key = `${row.project_id}\0${branchSegment}`;
    const group = groups.get(key) ?? [];
    group.push({ id: row.id, version: row.version });
    groups.set(key, group);
  }
  const collisions = [...groups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([key, group]) => {
      const projectId = key.slice(0, key.indexOf('\0'));
      return `${projectId}: ${group.map((item) => `${item.id}=${JSON.stringify(item.version)}`).join(', ')}`;
    });
  if (collisions.length > 0 || noncanonical.length > 0) {
    throw new Error(
      `无法升级迭代版本唯一约束：` +
      (collisions.length > 0 ? `以下历史迭代映射到同一 sprint 分支：${collisions.join('; ')}。` : '') +
      (noncanonical.length > 0 ? `以下历史版本号不是规范分支片段：${noncanonical.join('; ')}。` : '') +
      '请先在备份数据库中为冲突迭代指定不同的规范版本号，并同步对应 docs/iterations 路径与 sprint 分支。',
    );
  }
}

/** 数据库兜底：同一项目的迭代版本必须唯一，避免并发创建映射到同一 sprint 分支。 */
export const ITERATION_VERSION_UNIQUE_V13: Migration = {
  version: 13,
  description: 'unique iteration version per project',
  preflight: assertNoLegacyVersionCollisions,
  sql: `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_iterations_project_version_unique
      ON iterations(project_id, version);
  `,
};
