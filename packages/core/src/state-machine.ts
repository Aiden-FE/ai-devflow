import type { TaskStatus } from './types.js';

/** 全部状态（含已弃用的 backlog、测试中 testing 与暂停标识 awaiting_input）。 */
export const ALL_STATUSES: TaskStatus[] = [
  'backlog',
  'ready',
  'in_progress',
  'testing',
  'awaiting_input',
  'in_review',
  'archived',
];

/**
 * 合法迁移表。键为源状态，值为可达目标状态集合。
 *
 * 可见泳道：ready -> in_progress -> testing -> in_review -> archived。
 * - 开发任务禁止直接进入待验收：in_progress 不提供 -> in_review 的迁移，
 *   开发 Agent 完成后只能进入 testing（测试中），由 reviewer 审查。
 * - testing：审查通过 -> in_review（合并并待验收）；不通过 -> in_progress（携反馈修复）。
 * - backlog（需求池）已移除：新建任务直接进入 ready，仅保留 backlog->ready 供迁移兜底。
 * - awaiting_input 不是独立泳道，而是 in_progress/testing/in_review 的暂停标识，
 *   回答/授权/确认后恢复到来源状态；也可退回 ready 重新开发。
 * - in_review -> ready：验收不通过退回待开发（仅改状态）。
 * - in_review -> archived 仅在显式人工验收（tasks.accept）时允许，由门禁 accepted 强制。
 */
export const LEGAL_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  backlog: ['ready'],
  ready: ['in_progress'],
  in_progress: ['awaiting_input', 'testing', 'ready'],
  testing: ['in_review', 'in_progress', 'awaiting_input', 'ready'],
  awaiting_input: ['in_progress', 'testing', 'in_review', 'ready'],
  in_review: ['in_progress', 'ready', 'awaiting_input', 'archived'],
  archived: [],
};

// awaiting_input（待沟通/待授权）不是独立泳道，而是开发中/测试中/待验收任务的一个暂停标识。
// 允许从 in_progress、testing 与 in_review 暂停到 awaiting_input，回答后恢复到来源状态。
export const LEGAL_TRANSITIONS_STRICT: Record<TaskStatus, TaskStatus[]> = {
  backlog: ['ready'],
  ready: ['in_progress'],
  in_progress: ['awaiting_input', 'testing', 'ready'],
  testing: ['in_review', 'in_progress', 'awaiting_input', 'ready'],
  awaiting_input: ['in_progress', 'testing', 'in_review', 'ready'],
  in_review: ['in_progress', 'ready', 'awaiting_input', 'archived'],
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
