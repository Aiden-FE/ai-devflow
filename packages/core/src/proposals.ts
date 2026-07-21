// AI 子任务提议的依赖 DAG 校验（纯函数，零依赖，Renderer 与 Main 共享）。
import type { AiTaskProposal } from './types.js';

export interface ProposalDagResult {
  ok: boolean;
  reasons: string[];
}

type DraftRef = { draftId: string; dependsOn?: string[] };

/**
 * 检测草稿依赖是否成环（DFS 三色标记：白=未访问、灰=访问中、黑=已完成）。
 * 遇到指向「灰色」节点的后向边即为环。
 */
export function proposalHasCycle(proposals: DraftRef[]): boolean {
  const adj = new Map<string, string[]>();
  for (const p of proposals) adj.set(p.draftId, p.dependsOn ?? []);
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const p of proposals) color.set(p.draftId, WHITE);
  const dfs = (id: string): boolean => {
    color.set(id, GRAY);
    for (const dep of adj.get(id) ?? []) {
      const c = color.get(dep);
      if (c === GRAY) return true;
      if (c === WHITE && dfs(dep)) return true;
    }
    color.set(id, BLACK);
    return false;
  };
  for (const p of proposals) {
    if (color.get(p.draftId) === WHITE && dfs(p.draftId)) return true;
  }
  return false;
}

/**
 * 校验 AI 提议草稿构成合法 DAG：
 * - 列表非空；
 * - draftId 唯一且非空；
 * - dependsOn 引用的 draftId 必须存在；
 * - 无自依赖；
 * - 无环。
 */
export function validateProposalDag(proposals: DraftRef[]): ProposalDagResult {
  const reasons: string[] = [];
  if (!Array.isArray(proposals) || proposals.length === 0) {
    return { ok: false, reasons: ['提议列表为空'] };
  }
  const ids = new Set<string>();
  for (const p of proposals) {
    if (!p.draftId || !p.draftId.trim()) {
      reasons.push('存在缺少 draftId 的草稿');
    } else if (ids.has(p.draftId)) {
      reasons.push(`草稿标识重复：${p.draftId}`);
    } else {
      ids.add(p.draftId);
    }
  }
  for (const p of proposals) {
    for (const dep of p.dependsOn ?? []) {
      if (dep === p.draftId) reasons.push(`任务「${p.draftId}」不能依赖自身`);
      else if (!ids.has(dep)) reasons.push(`任务「${p.draftId}」依赖了不存在的草稿「${dep}」`);
    }
  }
  if (proposalHasCycle(proposals)) reasons.push('依赖关系存在环，无法构成 DAG');
  return { ok: reasons.length === 0, reasons };
}

/**
 * 拓扑排序草稿（依赖在前），便于按序落库时先创建被依赖任务。
 * 假定已通过 validateProposalDag；若仍有环则返回尽力排序（不抛错）。
 */
export function topoSortProposals<T extends DraftRef>(proposals: T[]): T[] {
  const byId = new Map(proposals.map((p) => [p.draftId, p]));
  const visited = new Set<string>();
  const out: T[] = [];
  const visit = (p: T, stack: Set<string>): void => {
    if (visited.has(p.draftId) || stack.has(p.draftId)) return;
    stack.add(p.draftId);
    for (const dep of p.dependsOn ?? []) {
      const d = byId.get(dep);
      if (d) visit(d, stack);
    }
    stack.delete(p.draftId);
    visited.add(p.draftId);
    out.push(p);
  };
  for (const p of proposals) visit(p, new Set());
  return out;
}

/** 类型守卫：判断对象是否携带 draftId（用于兼容旧版无 draftId 的提议）。 */
export function hasDraftIds(list: AiTaskProposal[]): boolean {
  return list.every((p) => typeof p.draftId === 'string' && p.draftId.trim().length > 0);
}
