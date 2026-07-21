// Agent 桥接器协议。事件与请求类型复用 @ai-devflow/core，保证 Renderer/Main/Agent 三方一致。
import type {
  AgentType,
  AgentDetection,
  AgentRunRequest,
  AgentEvent,
  Checkpoint,
} from '@ai-devflow/core';

export type { AgentType, AgentDetection, AgentRunRequest, AgentEvent, Checkpoint };

export interface AgentRun {
  /** 事件流：调度器逐条消费并落库/转发 Renderer。 */
  events: AsyncIterable<AgentEvent>;
  /** 取消运行：终止子进程。 */
  cancel(): Promise<void>;
  /** 子进程 PID（启动后可用）。 */
  pid?: number;
  /** 等待结束并返回退出摘要。 */
  done(): Promise<{ exitCode: number | null; ok: boolean }>;
}

export interface AgentAdapter {
  readonly id: AgentType;
  /** 检测本机是否具备运行条件。 */
  detect(): Promise<AgentDetection>;
  /** 启动一次执行。resumeFrom/userInput 用于待沟通恢复。 */
  run(req: AgentRunRequest): Promise<AgentRun>;
}

/** 适配器构造时可读的配置。 */
export interface AgentAdapterConfig {
  /** 覆盖可执行文件路径；缺省从 PATH 解析。 */
  executable?: string;
  /** 额外环境变量。 */
  env?: Record<string, string>;
  /** 透传给 CLI 的额外参数。 */
  extraArgs?: string[];
}
