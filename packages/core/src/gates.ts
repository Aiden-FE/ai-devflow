import type { GateContext, GateResult, TaskStatus } from './types.js';
import { isLegalTransition, isTerminal } from './state-machine.js';

/**
 * 门禁判定：在状态机合法迁移之上，叠加业务前置条件。
 * Renderer 拖拽与 Main 落库前都应调用，确保不绕过。
 */
export function canTransition(
  task: { status: TaskStatus },
  target: TaskStatus,
  ctx: GateContext,
): GateResult {
  const reasons: string[] = [];

  if (isTerminal(task.status)) {
    return { ok: false, reasons: ['任务已归档，不可再迁移'] };
  }

  if (!isLegalTransition(task.status, target)) {
    return {
      ok: false,
      reasons: [`非法迁移：${task.status} -> ${target}`],
    };
  }

  // 状态特定的门禁
  const gate = STATUS_GATES[target];
  if (gate) {
    const r = gate(ctx);
    if (!r.ok) reasons.push(...r.reasons);
  }

  // 源状态特定门禁（例如进入 in_review 需要产物）
  // 从待沟通恢复到 in_review 时不重复要求产物（任务此前已具备）。
  if (target === 'in_review' && task.status !== 'awaiting_input' && !ctx.hasArtifacts) {
    reasons.push('进入测试中前需有执行产物');
  }
  if (target === 'archived') {
    if (ctx.testPassed !== true) reasons.push('归档前需测试通过');
    if (ctx.auditOk !== true) reasons.push('归档前需状态审计通过');
  }
  if (target === 'in_progress' && task.status === 'ready' && !ctx.hasAgentAssigned) {
    reasons.push('开始执行前需分配 Agent');
  }
  if (target === 'ready' && !ctx.hasAcceptance) {
    reasons.push('进入待开发前需有验收标准');
  }
  // 从待沟通恢复（无论回到开发中还是测试中）都要求先有用户回答。
  if (
    task.status === 'awaiting_input' &&
    (target === 'in_progress' || target === 'in_review') &&
    !ctx.hasUserAnswer
  ) {
    reasons.push('从待沟通恢复前需有用户回答');
  }

  return { ok: reasons.length === 0, reasons };
}

/** 目标状态的通用门禁。 */
const STATUS_GATES: Partial<Record<TaskStatus, (ctx: GateContext) => GateResult>> = {
  archived: (ctx) => ({
    ok: ctx.testPassed === true && ctx.auditOk === true,
    reasons:
      ctx.testPassed === true && ctx.auditOk === true
        ? []
        : ['归档需测试通过且审计通过'],
  }),
};

/** 拖拽校验：Renderer 调用，返回是否允许放置及原因。 */
export function validateTransition(
  task: { status: TaskStatus },
  target: TaskStatus,
  ctx: GateContext,
): { allowed: boolean; reasons: string[] } {
  const r = canTransition(task, target, ctx);
  return { allowed: r.ok, reasons: r.reasons };
}

/** 测试失败退回开发：要求附证据。 */
export function canReturnToDev(ctx: GateContext): GateResult {
  if (ctx.testFailedWithEvidence !== true) {
    return { ok: false, reasons: ['测试失败退回开发需附失败证据'] };
  }
  return { ok: true, reasons: [] };
}

/**
 * 需求验收归档门禁：仅当需求下存在子任务（数量 > 0）且全部子任务已归档时允许归档。
 * @param tasks 该需求下的全部子任务（仅读取 status 字段）。
 */
export function canArchiveRequirement(
  tasks: Array<{ status: TaskStatus }>,
): { ok: boolean; reasons: string[] } {
  if (tasks.length === 0) {
    return { ok: false, reasons: ['需求下无子任务，无法验收归档'] };
  }
  if (!tasks.every((t) => t.status === 'archived')) {
    const pending = tasks.filter((t) => t.status !== 'archived').length;
    return { ok: false, reasons: [`还有 ${pending} 个子任务未完成（需全部归档）`] };
  }
  return { ok: true, reasons: [] };
}

/**
 * 串行依赖门禁：前置任务未完成（未进入 in_review / archived）则禁止启动后继任务。
 * "完成"指开发工作已交付（in_review 起），而非必须归档，以便串行流水可衔接。
 * @param predecessors 本任务 dependsOn 指向的前置任务（需调用方按 ID 取回）。
 */
export function checkTaskDependencies(
  predecessors: Array<{ id: string; title: string; status: TaskStatus }>,
): { ok: boolean; reasons: string[]; blockedBy: Array<{ id: string; title: string; status: TaskStatus }> } {
  const blockedBy = predecessors.filter((p) => p.status !== 'in_review' && p.status !== 'archived');
  if (blockedBy.length === 0) {
    return { ok: true, reasons: [], blockedBy: [] };
  }
  return {
    ok: false,
    reasons: [`前置任务未完成：${blockedBy.map((b) => b.title).join('、')}`],
    blockedBy,
  };
}
