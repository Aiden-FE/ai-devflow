// 单一 AgentRunner 协议（设计 §5）。生产实现是 PiRunner；测试注入 FakeAgentRunner。
// 调度器只依赖此接口，不再有 Agent 类型选择/注册表/能力合并。
import type { AgentEvent, Checkpoint, InteractionKind, TaskRole } from '@ai-devflow/core';

export interface AgentRunRequest {
  taskId: string;
  executionId: string;
  role: TaskRole;
  prompt: string;
  cwd: string;
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
