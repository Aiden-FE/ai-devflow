// 渐进式 L1-L4 检索规划：层级推断、确定性排序与预算控制。
import type {
  AgentKey,
  KnowledgeDocumentRef,
  KnowledgeRetrievalLevel,
  KnowledgeRetrievalManifest,
  TaskTypeLabel,
} from '@ai-devflow/core';

export interface RetrievalPlanInput {
  id: string;
  projectId: string;
  taskId?: string;
  executionId?: string;
  expert: AgentKey;
  stage: string;
  query: string;
  typeLabel?: TaskTypeLabel;
  dependencyTaskIds?: string[];
  changedFiles?: string[];
  catalog: KnowledgeDocumentRef[];
  budget?: { maxFiles: number; maxChars: number };
  createdAt: number;
}

const STATUS_WEIGHT: Record<string, number> = {
  active: 10,
  review: 5,
  draft: 0,
  superseded: -20,
  archived: -30,
};

function primaryType(expert: AgentKey): string {
  switch (expert) {
    case 'product':
      return 'product';
    case 'ux':
      return 'ux';
    case 'dev':
    case 'dev_lead':
    case 'test':
    case 'project_lead':
      return 'feature';
    case 'chat':
      return 'context';
    default:
      return 'feature';
  }
}

/** 推断披露层级：chat=L1；product/ux/project_lead=L4；dev/dev_lead/test=L3。 */
export function inferRetrievalLevel(input: Pick<RetrievalPlanInput, 'expert' | 'query'>): KnowledgeRetrievalLevel {
  switch (input.expert) {
    case 'chat':
      return 1;
    case 'dev':
    case 'dev_lead':
    case 'test':
      return 3;
    case 'product':
    case 'ux':
    case 'project_lead':
      return 4;
    default:
      return 2;
  }
}

function allowedTypes(level: KnowledgeRetrievalLevel, expert: AgentKey): Set<string> {
  const primary = primaryType(expert);
  switch (level) {
    case 1:
      return new Set(['context']);
    case 2:
      return new Set(['context', primary]);
    case 3:
      return new Set(['context', 'adr', 'feature', 'runbook']);
    case 4:
      return new Set(['context', 'adr', 'feature', 'runbook', 'product', 'ux']);
    default:
      return new Set(['context']);
  }
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/)
    .filter((t) => t.length > 0);
}

function charCost(ref: KnowledgeDocumentRef): number {
  return (ref.title ?? '').length + (ref.summary ?? '').length + 1;
}

/** 生成检索 manifest：层级过滤 -> 评分排序 -> 预算裁剪。 */
export function planKnowledgeRetrieval(input: RetrievalPlanInput): KnowledgeRetrievalManifest {
  const level = inferRetrievalLevel(input);
  const allowed = allowedTypes(level, input.expert);
  const budget = input.budget ?? { maxFiles: 5, maxChars: 5000 };
  const tokens = tokenize(input.query);
  const changedFiles = new Set(input.changedFiles ?? []);
  const idSet = new Set(input.catalog.map((c) => c.id));

  const eligible = input.catalog.filter((c) => allowed.has(c.type));

  const scored = eligible
    .map((ref) => {
      const haystack = `${ref.id} ${ref.title} ${ref.summary}`.toLowerCase();
      const keywordMatches = tokens.filter((t) => haystack.includes(t)).length;
      const sourcePathMatches = ref.sources.filter((s) => changedFiles.has(s)).length;
      const relatedIdMatches = ref.related.filter((r) => idSet.has(r)).length;
      const statusWeight = STATUS_WEIGHT[ref.status] ?? 0;
      const confidenceTerm = Math.round(ref.confidence * 20);
      const score =
        keywordMatches * 100 +
        sourcePathMatches * 80 +
        relatedIdMatches * 40 +
        confidenceTerm +
        statusWeight;
      return { ref, score };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.ref.confidence !== a.ref.confidence) return b.ref.confidence - a.ref.confidence;
      return a.ref.id < b.ref.id ? -1 : a.ref.id > b.ref.id ? 1 : 0;
    });

  const candidates: KnowledgeDocumentRef[] = [];
  const skipped: Array<{ knowledgeId: string; reason: string }> = [];
  let usedChars = 0;
  for (const { ref } of scored) {
    if (candidates.length >= budget.maxFiles) {
      skipped.push({ knowledgeId: ref.id, reason: `超出文件预算 ${budget.maxFiles}` });
      continue;
    }
    const cost = charCost(ref);
    if (usedChars + cost > budget.maxChars) {
      skipped.push({ knowledgeId: ref.id, reason: `超出字符预算 ${budget.maxChars}` });
      continue;
    }
    candidates.push(ref);
    usedChars += cost;
  }

  return {
    id: input.id,
    projectId: input.projectId,
    taskId: input.taskId,
    executionId: input.executionId,
    expert: input.expert,
    stage: input.stage,
    level,
    state: 'planned',
    candidates,
    reads: [],
    skipped,
    differences: [],
    budget,
    used: { files: candidates.length, chars: usedChars },
    createdAt: input.createdAt,
  };
}
