// 项目知识服务外观：编排目录初始化、目录加载与结构巡检。
import type {
  KnowledgeHealthSnapshot,
} from '@ai-devflow/core';
import {
  initializeKnowledgeLayout,
  initializeIterationLayout,
  initializeTaskLayout,
  type LayoutChangeSet,
} from './layout.js';
import { loadKnowledgeCatalog, type KnowledgeCatalog } from './catalog.js';
import { auditKnowledgeLayout, type KnowledgeGitProbe } from './audit.js';

export class ProjectKnowledgeService {
  /** 初始化 docs/knowledge 骨架（幂等）。 */
  async initializeKnowledge(input: { repoPath: string; date: string }): Promise<LayoutChangeSet> {
    return initializeKnowledgeLayout(input);
  }

  /** 初始化迭代文档目录（幂等）。 */
  async initializeIteration(input: {
    repoPath: string;
    version: string;
    iterationId: string;
    date: string;
  }): Promise<LayoutChangeSet> {
    return initializeIterationLayout(input);
  }

  /** 初始化任务文档目录（幂等）。 */
  async initializeTask(input: {
    repoPath: string;
    version: string;
    taskId: string;
    title: string;
    date: string;
  }): Promise<LayoutChangeSet> {
    return initializeTaskLayout(input);
  }

  /** 加载知识目录。 */
  async loadCatalog(repoPath: string): Promise<KnowledgeCatalog> {
    return loadKnowledgeCatalog(repoPath);
  }

  /** 执行结构巡检。 */
  async audit(input: {
    projectId: string;
    repoPath: string;
    git?: KnowledgeGitProbe;
  }): Promise<KnowledgeHealthSnapshot> {
    return auditKnowledgeLayout(input);
  }
}

export {
  initializeKnowledgeLayout,
  initializeIterationLayout,
  initializeTaskLayout,
  sanitizePathSegment,
} from './layout.js';
export { parseKnowledgeMarkdown } from './frontmatter.js';
export { loadKnowledgeCatalog, loadAllDocuments } from './catalog.js';
export { auditKnowledgeLayout } from './audit.js';

export type { LayoutChangeSet } from './layout.js';
export type { KnowledgeCatalog, LoadedCatalog } from './catalog.js';
export type { KnowledgeGitProbe, AuditInput } from './audit.js';
export type { ParsedKnowledgeMarkdown } from './frontmatter.js';
