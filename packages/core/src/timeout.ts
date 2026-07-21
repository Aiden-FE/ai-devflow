import type { NotificationRule, Task } from './types.js';

/**
 * 超时规则计算：给定任务在某状态的进入时间与规则分钟数，
 * 计算下次触发时间戳；以及是否已逾期。
 *
 * 计时基于绝对时间戳（statusChangedAt + minutes*60_000），
 * 不依赖进程内存，因此应用重启后可正确恢复（见 notifications 包）。
 */
export function computeTriggerAt(statusChangedAt: number, minutes: number): number {
  return statusChangedAt + Math.max(0, minutes) * 60_000;
}

/** 判定某规则是否适用于该任务（项目范围 + 状态匹配 + 启用）。 */
export function ruleApplies(
  rule: NotificationRule,
  task: { projectId: string; status: Task['status'] },
): boolean {
  if (!rule.enabled) return false;
  if (rule.status !== task.status) return false;
  if (rule.projectId && rule.projectId !== task.projectId) return false;
  return true;
}

/** 为任务挑选所有适用规则。 */
export function applicableRules(
  rules: NotificationRule[],
  task: { projectId: string; status: Task['status'] },
): NotificationRule[] {
  return rules.filter((r) => ruleApplies(r, task));
}

/** 计算给定 now 下任务最接近的触发时间（取最早），无适用规则返回 null。 */
export function nextTrigger(
  rules: NotificationRule[],
  task: { projectId: string; status: Task['status']; statusChangedAt: number },
  now: number,
): { ruleId: string; triggerAt: number; overdue: boolean } | null {
  const apps = applicableRules(rules, task);
  if (apps.length === 0) return null;
  let best: { ruleId: string; triggerAt: number; overdue: boolean } | null = null;
  for (const r of apps) {
    const triggerAt = computeTriggerAt(task.statusChangedAt, r.minutes);
    const overdue = triggerAt <= now;
    if (!best || triggerAt < best.triggerAt) {
      best = { ruleId: r.id, triggerAt, overdue };
    }
  }
  return best;
}

/** 列出所有已逾期但尚未投递的 (rule, task) 组合（防重复由调用方结合投递记录判断）。 */
export function findOverdue(
  rules: NotificationRule[],
  tasks: Array<{ id: string; projectId: string; status: Task['status']; statusChangedAt: number }>,
  now: number,
): Array<{ taskId: string; ruleId: string; triggerAt: number }> {
  const out: Array<{ taskId: string; ruleId: string; triggerAt: number }> = [];
  for (const task of tasks) {
    for (const rule of applicableRules(rules, task)) {
      const triggerAt = computeTriggerAt(task.statusChangedAt, rule.minutes);
      if (triggerAt <= now) out.push({ taskId: task.id, ruleId: rule.id, triggerAt });
    }
  }
  return out;
}
