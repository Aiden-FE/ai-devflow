import type { AuditFinding, Task } from './types.js';

export interface AuditContext {
  /** worktree 是否存在。 */
  worktreeExists: boolean;
  /** 是否有执行记录。 */
  hasExecutionRecord: boolean;
  /** 是否有检查点。 */
  hasCheckpoint: boolean;
  /** 是否有测试结果。 */
  hasTestResult?: boolean;
  /** 测试是否通过。 */
  testPassed?: boolean;
  /** 是否有产物文件。 */
  hasArtifacts: boolean;
}

/**
 * 状态审计：比对任务记录状态与实际产物/记录，输出不一致项。
 * 用于归档门禁与拖拽审计。
 */
export function auditTask(task: Task, ctx: AuditContext): AuditFinding[] {
  const out: AuditFinding[] = [];
  const t = (severity: AuditFinding['severity'], message: string) =>
    out.push({ taskId: task.id, severity, message });

  if (task.status === 'in_progress' || task.status === 'in_review') {
    if (!ctx.worktreeExists) t('warn', '任务进行中但 worktree 不存在');
    if (!ctx.hasExecutionRecord) t('warn', '任务进行中但无执行记录');
  }
  if (task.status === 'in_review') {
    if (ctx.hasTestResult === false) t('warn', '待验收但无测试结果');
    if (ctx.testPassed === undefined) t('info', '待验收但测试结果未知');
  }
  if (task.status === 'archived') {
    // 归档（验收通过并归档）必须有产物；不再用 testPassed 作为硬门禁。
    if (!ctx.hasArtifacts) t('error', '已归档但无执行产物');
  }
  // 手动暂停（来自 in_review）无需检查点；Agent 运行中暂停（来自 in_progress）需要检查点才能恢复。
  if (task.status === 'awaiting_input' && task.pausedFrom !== 'in_review' && !ctx.hasCheckpoint) {
    t('error', '待沟通但无检查点，无法恢复');
  }
  if (task.status === 'backlog' && ctx.hasExecutionRecord) {
    t('info', '需求池中存在历史执行记录（backlog 已弃用，应迁移为 ready）');
  }
  return out;
}

export function auditOk(findings: AuditFinding[]): boolean {
  return !findings.some((f) => f.severity === 'error');
}
