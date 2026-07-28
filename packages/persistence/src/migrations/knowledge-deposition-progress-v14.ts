import type { Migration } from '../migrations.js';

/** 沉淀 Git/DB 对账日志：只保存阶段、分支和 commit OID，不保存知识正文。 */
export const KNOWLEDGE_DEPOSITION_PROGRESS_V14: Migration = {
  version: 14,
  description: 'knowledge deposition git integration progress',
  sql: `
    ALTER TABLE knowledge_depositions
      ADD COLUMN progress_json TEXT NOT NULL DEFAULT '{}';
  `,
};
