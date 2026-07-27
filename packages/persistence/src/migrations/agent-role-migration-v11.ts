import type { Migration } from '../migrations.js';

/**
 * v11：Agent 角色重构——新增 tasks.type_label（前端/后端/全栈/联调）。
 *
 * 类型标签仅用于展示与研发负责人拆分自检，不影响执行者派发（执行者恒由泳道决定）。
 * 旧任务的 role/stages 字段保留兼容（编排器忽略），不在此迁移删除。
 */
export const AGENT_ROLE_MIGRATION_V11: Migration = {
  version: 11,
  description: 'agent role restructure: add tasks.type_label (前端/后端/全栈/联调)',
  sql: `
    ALTER TABLE tasks ADD COLUMN type_label TEXT;
  `,
};
