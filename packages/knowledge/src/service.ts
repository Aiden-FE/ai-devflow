// 项目知识服务外观：编排目录初始化、目录加载与结构巡检。
import type {
  KnowledgeHealthSnapshot,
  KnowledgeRetrievalManifest,
} from '@ai-devflow/core';
import {
  initializeKnowledgeLayout,
  initializeIterationLayout,
  initializeTaskLayout,
  type LayoutChangeSet,
} from './layout.js';
import { loadKnowledgeCatalog, type KnowledgeCatalog } from './catalog.js';
import { auditKnowledgeLayout, type KnowledgeGitProbe } from './audit.js';
import { planKnowledgeRetrieval, type RetrievalPlanInput } from './retrieval.js';
import { verifyIterationChangelog, type VerifyChangelogInput } from './changelog.js';

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

  /** 规划渐进检索 manifest；知识库未初始化时返回 not_initialized。 */
  async planRetrieval(
    input: Omit<RetrievalPlanInput, 'catalog'> & { repoPath: string },
  ): Promise<KnowledgeRetrievalManifest> {
    const catalog = await this.loadCatalog(input.repoPath);
    if (!catalog.initialized) {
      return {
        id: input.id,
        projectId: input.projectId,
        taskId: input.taskId,
        executionId: input.executionId,
        expert: input.expert,
        stage: input.stage,
        level: 1,
        state: 'not_initialized',
        candidates: [],
        reads: [],
        skipped: [],
        differences: [],
        budget: input.budget ?? { maxFiles: 5, maxChars: 5000 },
        used: { files: 0, chars: 0 },
        createdAt: input.createdAt,
      };
    }
    return planKnowledgeRetrieval({
      id: input.id,
      projectId: input.projectId,
      taskId: input.taskId,
      executionId: input.executionId,
      expert: input.expert,
      stage: input.stage,
      query: input.query,
      typeLabel: input.typeLabel,
      dependencyTaskIds: input.dependencyTaskIds,
      changedFiles: input.changedFiles,
      catalog: Array.from(catalog.documents.values()),
      budget: input.budget,
      createdAt: input.createdAt,
    });
  }

  /** 校验迭代 CHANGELOG 覆盖与 Git 跟踪。 */
  async verifyIterationChangelog(input: Omit<VerifyChangelogInput, 'tracked'> & { git: KnowledgeGitProbe }): Promise<import('@ai-devflow/core').IterationChangelogVerification> {
    return verifyIterationChangelog({
      repoPath: input.repoPath,
      version: input.version,
      iterationId: input.iterationId,
      expectedTaskIds: input.expectedTaskIds,
      tracked: input.git,
      verifiedAt: input.verifiedAt,
    });
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
export { planKnowledgeRetrieval, inferRetrievalLevel } from './retrieval.js';

export type { LayoutChangeSet } from './layout.js';
export type { KnowledgeCatalog, LoadedCatalog } from './catalog.js';
export type { KnowledgeGitProbe, AuditInput } from './audit.js';
export type { ParsedKnowledgeMarkdown } from './frontmatter.js';
export type { RetrievalPlanInput } from './retrieval.js';
