// UX 子咨询桥接：产品专家经 ai_devflow_consult_ux 工具调用时，主进程启动一次 UX专家 run，
// 把结构化 UX 建议回灌给产品专家合并进需求草稿。机制对称于 ai_devflow_ask，但桥接到另一个专家而非用户。
import type { AiChatMessage } from '@ai-devflow/core';
import type { PiTextExecutor } from './pi-ai.js';

/** UX专家咨询用的系统提示（只读研读，产出结构化建议，不改代码）。 */
export const UX_CONSULT_SYSTEM = [
  '# UX专家系统提示（子咨询）',
  '',
  '你是 ai-devflow 的 UX专家，被产品专家经 ai_devflow_consult_ux 子咨询调用。针对需求中的 UX 面，产出结构化建议：交互要点、视觉/结构约束、可访问性、响应式。',
  '',
  '原则：',
  '- 只读研读项目代码与现有 UX 知识，不改代码。',
  '- 输出结构化建议供产品专家合并，按四个维度组织：',
  '  1. 交互流程：关键路径状态流转、主要操作与反馈。',
  '  2. 视觉/结构要点：布局、组件层级、信息密度、空/错/载态。',
  '  3. 可访问性：键盘可达、读屏、对比度、焦点管理。',
  '  4. 响应式：断点与适配策略。',
  '- 不要输出思考过程，直接产出建议正文。',
].join('\n');

export interface UxConsultDeps {
  /** 生产级文本执行器（由 createProductionTextExecutor 构造）。 */
  executeText: PiTextExecutor;
}

/**
 * 运行一次 UX专家子咨询：以需求上下文为输入，返回 UX专家的文本建议。
 * 不带工具/技能（只读对话），用 UX_CONSULT_SYSTEM 作为系统提示覆盖默认 chat prompt。
 */
export async function runUxConsultation(
  requirementContext: string,
  deps: UxConsultDeps,
  projectId?: string,
): Promise<string> {
  const messages: AiChatMessage[] = [
    {
      role: 'user',
      content: [
        '【需求上下文】',
        requirementContext,
        '',
        '请针对其中的 UX 面产出结构化建议，按四个维度组织：交互流程、视觉/结构要点、可访问性、响应式。无 UX 面时简短说明无需 UX 约束。',
      ].join('\n'),
    },
  ];
  // 用 'task_chat' workload（无步骤 agent、无工具），以 UX_CONSULT_SYSTEM 覆盖系统提示。
  return deps.executeText(
    'task_chat',
    messages,
    undefined,
    { source: 'ux_consultation', projectId },
    undefined,
    undefined,
    undefined,
    UX_CONSULT_SYSTEM,
  );
}
