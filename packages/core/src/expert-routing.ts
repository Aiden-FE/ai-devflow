// 专家派发契约：任务执行专家由当前泳道决定（非任务 role 字段）。
import type { TaskStatus } from './types.js';
import type { AgentKey } from './provider.js';

/** 专家键：与 AgentKey 同集合，语义化别名。 */
export type ExpertKey = AgentKey;

/**
 * 泳道 -> 执行专家。仅执行泳道（in_progress/testing）返回专家；
 * ready/in_review/archived 无 agent（待开发/人工验收/终态）。
 * awaiting_input 是暂停标识，恢复后回原泳道由原专家继续（此处不映射）。
 */
export function laneToExpert(status: TaskStatus): ExpertKey | undefined {
  switch (status) {
    case 'in_progress':
      return 'dev';
    case 'testing':
      return 'test';
    default:
      return undefined;
  }
}
