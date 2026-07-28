// 渐进式知识库领域契约（设计 §9.2）。
// 本文件仅承载纯领域类型、schema 与确定性谓词，不依赖文件系统或 SQLite。
import type { AgentKey } from './provider.js';
import type { ReviewVerdict } from './types.js';

/** 六类知识类型（固定顺序，用于索引与展示）。 */
export const KNOWLEDGE_TYPES = ['context', 'adr', 'feature', 'runbook', 'product', 'ux'] as const;
export type KnowledgeType = (typeof KNOWLEDGE_TYPES)[number];

/** 知识状态：草稿 / 待审 / 活跃 / 被取代 / 归档。 */
export type KnowledgeStatus = 'draft' | 'review' | 'active' | 'superseded' | 'archived';

/** 巡检问题严重级别。 */
export type KnowledgeSeverity = 'info' | 'warn' | 'error';

/** 渐进检索披露层级（L1-L4）。 */
export type KnowledgeRetrievalLevel = 1 | 2 | 3 | 4;

/** 知识文档 frontmatter（唯一事实源为仓库 Markdown）。 */
export interface KnowledgeFrontmatter {
  id: string;
  type: KnowledgeType;
  status: KnowledgeStatus;
  owner: string;
  /** 更新日期（YYYY-MM-DD）。 */
  updated: string;
  confidence: number;
  sources: string[];
  related: string[];
}

/** 文档引用：frontmatter 加可读标题、摘要与路径。 */
export interface KnowledgeDocumentRef extends KnowledgeFrontmatter {
  title: string;
  summary: string;
  path: string;
}

/** 结构巡检发现问题。 */
export interface KnowledgeFinding {
  id: string;
  severity: KnowledgeSeverity;
  code: string;
  path?: string;
  knowledgeId?: string;
  message: string;
  evidence: string[];
}

/** 项目知识库健康快照。 */
export interface KnowledgeHealthSnapshot {
  projectId: string;
  state: 'not_initialized' | 'healthy' | 'warning' | 'blocked';
  checkedAt: number;
  counts: Record<KnowledgeType, number>;
  findings: KnowledgeFinding[];
  latestRunId?: string;
}

/** 实际读取证据：记录 Agent 真实读取的文档与原因。 */
export interface KnowledgeReadEvidence {
  knowledgeId: string;
  path: string;
  reason: string;
  chars: number;
}

/** 检索 manifest：宿主生成、注入 Agent、执行后回填。 */
export interface KnowledgeRetrievalManifest {
  id: string;
  projectId: string;
  taskId?: string;
  executionId?: string;
  expert: AgentKey;
  stage: string;
  level: KnowledgeRetrievalLevel;
  state: 'not_initialized' | 'planned' | 'completed' | 'failed';
  candidates: KnowledgeDocumentRef[];
  reads: KnowledgeReadEvidence[];
  skipped: Array<{ knowledgeId: string; reason: string }>;
  differences: KnowledgeFinding[];
  budget: { maxFiles: number; maxChars: number };
  used: { files: number; chars: number };
  createdAt: number;
  completedAt?: number;
}

/**
 * 知识价值评估（测试审查通过后的强结构化结果）。
 * - none：允许任务继续，但需持久化非空理由与证据。
 * - valuable：触发条件式强门禁，必须完成沉淀并校验。
 */
export type KnowledgeAssessment =
  | { verdict: 'none'; reason: string; evidence: string[] }
  | {
      verdict: 'valuable';
      candidates: Array<{
        type: KnowledgeType;
        summary: string;
        evidence: string[];
        suggestedTarget?: string;
        reuseScenario: string;
      }>;
    };

/**
 * 跨 Pi runner 边界的领域载荷（通过 structured-result 校验）。
 * 每个判别值对应一种专家运行结果。
 */
export type KnowledgeAgentPayload =
  | { kind: 'task_review'; review: ReviewVerdict; knowledgeAssessment: KnowledgeAssessment }
  | { kind: 'knowledge_initialization'; changedPaths: string[]; knowledgeIds: string[] }
  | { kind: 'knowledge_audit'; findings: KnowledgeFinding[] }
  | { kind: 'knowledge_repair'; changedPaths: string[]; knowledgeIds: string[]; resolvedFindingIds: string[] }
  | {
      kind: 'knowledge_deposition';
      changedPaths: string[];
      knowledgeIds: string[];
      candidateKnowledge: Array<{ candidateIndex: number; knowledgeId: string }>;
      assessment: KnowledgeAssessment;
    }
  | { kind: 'iteration_changelog'; changedPaths: string[]; coveredTaskIds: string[] };

/** 沉淀记录：一次 knowledge_deposition 运行的持久化状态。 */
export interface KnowledgeDepositionRecord {
  id: string;
  projectId: string;
  taskId: string;
  executionId?: string;
  retrievalId?: string;
  assessment: KnowledgeAssessment;
  state: 'running' | 'awaiting_initialization' | 'succeeded' | 'failed';
  relatedKnowledgeIds: string[];
  changedPaths: string[];
  gatePassed: boolean;
  diagnostics: string[];
  startedAt: number;
  endedAt?: number;
}

/** 迭代 CHANGELOG 校验结果。 */
export interface IterationChangelogVerification {
  iterationId: string;
  state: 'pending' | 'valid' | 'invalid';
  coveredTaskIds: string[];
  missingTaskIds: string[];
  changedPaths: string[];
  findings: KnowledgeFinding[];
  verifiedAt?: number;
}

/** 知识运行种类。 */
export type KnowledgeRunKind =
  | 'initialization'
  | 'light_audit'
  | 'full_audit'
  | 'repair'
  | 'iteration_changelog';

/** 知识运行状态。 */
export type KnowledgeRunState =
  | 'running'
  | 'awaiting_confirmation'
  | 'succeeded'
  | 'failed'
  | 'canceled';

/** 用户确认状态。 */
export type KnowledgeConfirmationState = 'not_required' | 'pending' | 'confirmed' | 'canceled';

/** UI 可见的知识运行视图（不携带正文 diff 字符串以外的 Markdown 正文）。 */
export interface KnowledgeRunView {
  id: string;
  projectId: string;
  iterationId?: string;
  kind: KnowledgeRunKind;
  state: KnowledgeRunState;
  draftBranch?: string;
  confirmationState: KnowledgeConfirmationState;
  changedPaths: string[];
  diff?: string;
  findings: KnowledgeFinding[];
  diagnostics: string[];
  startedAt: number;
  endedAt?: number;
}

/** 任务知识证据聚合（任务详情视图）。 */
export interface TaskKnowledgeEvidence {
  retrievals: KnowledgeRetrievalManifest[];
  assessment?: KnowledgeAssessment;
  deposition?: KnowledgeDepositionRecord;
}

// ---- 确定性谓词 ----

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KNOWLEDGE_TYPE_SET: ReadonlySet<string> = new Set(KNOWLEDGE_TYPES);
const STATUS_SET: ReadonlySet<string> = new Set(['draft', 'review', 'active', 'superseded', 'archived']);

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/** 校验知识文档 frontmatter。 */
export function isKnowledgeFrontmatter(value: unknown): value is KnowledgeFrontmatter {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    v.id.length > 0 &&
    typeof v.type === 'string' &&
    KNOWLEDGE_TYPE_SET.has(v.type) &&
    typeof v.status === 'string' &&
    STATUS_SET.has(v.status) &&
    typeof v.owner === 'string' &&
    typeof v.updated === 'string' &&
    ISO_DATE_RE.test(v.updated) &&
    typeof v.confidence === 'number' &&
    Number.isFinite(v.confidence) &&
    v.confidence >= 0 &&
    v.confidence <= 1 &&
    isStringArray(v.sources) &&
    isStringArray(v.related)
  );
}

/** 校验知识价值评估。 */
export function isKnowledgeAssessment(value: unknown): value is KnowledgeAssessment {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.verdict === 'none') {
    return (
      typeof v.reason === 'string' &&
      (v.reason as string).trim().length > 0 &&
      isStringArray(v.evidence) &&
      (v.evidence as string[]).length > 0
    );
  }
  if (v.verdict === 'valuable') {
    if (!Array.isArray(v.candidates) || v.candidates.length === 0) return false;
    return (v.candidates as unknown[]).every((c) => {
      if (typeof c !== 'object' || c === null) return false;
      const cand = c as Record<string, unknown>;
      return (
        typeof cand.type === 'string' &&
        KNOWLEDGE_TYPE_SET.has(cand.type) &&
        typeof cand.summary === 'string' &&
        (cand.summary as string).trim().length > 0 &&
        isStringArray(cand.evidence) &&
        (cand.evidence as string[]).length > 0 &&
        (cand.suggestedTarget === undefined || typeof cand.suggestedTarget === 'string') &&
        typeof cand.reuseScenario === 'string' &&
        (cand.reuseScenario as string).trim().length > 0
      );
    });
  }
  return false;
}

function isReviewVerdict(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.pass === 'boolean' &&
    typeof v.summary === 'string' &&
    (v.summary as string).trim().length > 0 &&
    (v.feedback === undefined || typeof v.feedback === 'string') &&
    (v.checks === undefined || isStringArray(v.checks))
  );
}

function isKnowledgeFinding(value: unknown): value is KnowledgeFinding {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    v.id.length > 0 &&
    typeof v.severity === 'string' &&
    ['info', 'warn', 'error'].includes(v.severity) &&
    typeof v.code === 'string' &&
    typeof v.message === 'string' &&
    isStringArray(v.evidence) &&
    (v.path === undefined || typeof v.path === 'string') &&
    (v.knowledgeId === undefined || typeof v.knowledgeId === 'string')
  );
}

function isCandidateKnowledge(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.candidateIndex === 'number' &&
    Number.isInteger(v.candidateIndex) &&
    v.candidateIndex >= 0 &&
    typeof v.knowledgeId === 'string' &&
    v.knowledgeId.trim().length > 0
  );
}

/** 校验跨边界的领域载荷：字段必须与判别值匹配。 */
export function isKnowledgeAgentPayload(value: unknown): value is KnowledgeAgentPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  switch (v.kind) {
    case 'task_review':
      return (
        isReviewVerdict(v.review) &&
        isKnowledgeAssessment(v.knowledgeAssessment)
      );
    case 'knowledge_initialization':
      return isStringArray(v.changedPaths) && isStringArray(v.knowledgeIds);
    case 'knowledge_audit':
      return Array.isArray(v.findings) && v.findings.every((f) => isKnowledgeFinding(f));
    case 'knowledge_repair':
      return (
        isStringArray(v.changedPaths) &&
        isStringArray(v.knowledgeIds) &&
        isStringArray(v.resolvedFindingIds)
      );
    case 'knowledge_deposition':
      return (
        isStringArray(v.changedPaths) &&
        isStringArray(v.knowledgeIds) &&
        Array.isArray(v.candidateKnowledge) &&
        v.candidateKnowledge.every((mapping) => isCandidateKnowledge(mapping)) &&
        isKnowledgeAssessment(v.assessment)
      );
    case 'iteration_changelog':
      return isStringArray(v.changedPaths) && isStringArray(v.coveredTaskIds);
    default:
      return false;
  }
}
