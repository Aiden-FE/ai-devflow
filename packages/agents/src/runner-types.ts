// 单一 AgentRunner 协议（设计 §5）。生产实现是 PiRunner；测试注入 FakeAgentRunner。
// 调度器只依赖此接口，不再有 Agent 类型选择/注册表/能力合并。
import type {
  AgentEvent,
  Checkpoint,
  ExpertKey,
  InteractionKind,
  KnowledgeRetrievalManifest,
} from '@ai-devflow/core';

/** 运行作用域：任务 / 项目 / 迭代。`resumeFrom` 仅在任务作用域允许。 */
export type AgentRunScope =
  | { kind: 'task'; taskId: string }
  | { kind: 'project'; projectId: string }
  | { kind: 'iteration'; projectId: string; iterationId: string };

/** 运行结果判别值：对应 `KnowledgeAgentPayload` 的判别值（task_execution 无载荷）。 */
export type AgentResultKind =
  | 'task_execution'
  | 'task_review'
  | 'knowledge_initialization'
  | 'knowledge_audit'
  | 'knowledge_repair'
  | 'knowledge_deposition'
  | 'iteration_changelog';

export interface AgentRunRequest {
  scope: AgentRunScope;
  executionId: string;
  /** 执行专家键（取代旧 role：TaskRole）。专家由当前泳道决定（laneToExpert）。 */
  expert: Exclude<ExpertKey, 'chat'>;
  /** 期望的结果判别值：决定 done 事件 payload 校验。 */
  resultKind: AgentResultKind;
  prompt: string;
  cwd: string;
  /** 宿主生成的检索 manifest（仅 ID/路径/原因/预算，不含正文），注入初始消息。 */
  knowledgeManifest?: KnowledgeRetrievalManifest;
  /** 仅任务作用域允许恢复检查点。 */
  resumeFrom?: Checkpoint;
  userInput?: string;
  interactionResponse?: { kind: InteractionKind; value: string };
}

export interface AgentRun {
  events: AsyncIterable<AgentEvent>;
  cancel(): Promise<void>;
  done(): Promise<{ exitCode: number | null; ok: boolean }>;
  pid?: number;
}

export interface AgentRunner {
  /** 校验内置运行时（manifest/摘要/入口/版本）。失败即「应用运行组件损坏」。 */
  verifyRuntime(): Promise<{ version: string; entry: string }>;
  run(request: AgentRunRequest): Promise<AgentRun>;
}
