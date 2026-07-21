import type { TaskStatus } from './types.js';

/** 全部六泳道状态。 */
export const ALL_STATUSES: TaskStatus[] = [
  'backlog',
  'ready',
  'in_progress',
  'awaiting_input',
  'in_review',
  'archived',
];

/** 合法迁移表。键为源状态，值为可达目标状态集合。 */
export const LEGAL_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  backlog: ['ready'],
  ready: ['in_progress', 'backlog'],
  in_progress: ['awaiting_input', 'in_review', 'ready'],
  awaiting_input: ['in_progress', 'in_review', 'backlog'],
  in_review: ['in_progress', 'awaiting_input', 'archived'],
  archived: [],
};

// awaiting_input（待沟通）不再是独立泳道，而是开发中/测试中任务的一个暂停标识。
// 允许从 in_progress 与 in_review 暂停到 awaiting_input，回答后恢复到来源状态。
export const LEGAL_TRANSITIONS_STRICT: Record<TaskStatus, TaskStatus[]> = {
  backlog: ['ready'],
  ready: ['in_progress', 'backlog'],
  in_progress: ['awaiting_input', 'in_review', 'ready'],
  awaiting_input: ['in_progress', 'in_review', 'backlog'],
  in_review: ['in_progress', 'awaiting_input', 'archived'],
  archived: [],
};

export function isLegalTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return false;
  const targets = LEGAL_TRANSITIONS_STRICT[from] ?? [];
  return targets.includes(to);
}

export function legalTargets(from: TaskStatus): TaskStatus[] {
  return [...(LEGAL_TRANSITIONS_STRICT[from] ?? [])];
}

export function isTerminal(status: TaskStatus): boolean {
  return status === 'archived';
}

/** 列出非法迁移样本（用于测试与诊断）。 */
export function illegalTransitions(): Array<{ from: TaskStatus; to: TaskStatus }> {
  const out: Array<{ from: TaskStatus; to: TaskStatus }> = [];
  for (const from of ALL_STATUSES) {
    for (const to of ALL_STATUSES) {
      if (!isLegalTransition(from, to)) out.push({ from, to });
    }
  }
  return out;
}
