// Agent 桥接器协议。事件与请求类型复用 @ai-devflow/core，保证 Renderer/Main/Agent 三方一致。
import type {
  AgentType,
  AgentDetection,
  AgentRunRequest,
  AgentEvent,
  AgentCapabilitySupport,
  Checkpoint,
} from '@ai-devflow/core';

export type { AgentType, AgentDetection, AgentRunRequest, AgentEvent, AgentCapabilitySupport, Checkpoint };

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
  /** 启动一次执行。resumeFrom/userInput 用于待沟通恢复；capabilities 为解析后的能力配置。 */
  run(req: AgentRunRequest): Promise<AgentRun>;
  /**
   * 声明本适配器支持的能力。不支持的字段在 UI 禁用并说明，不静默忽略。
   * - tools: 是否支持工具白名单限制
   * - plugins: 是否支持插件加载
   * - skills: 'all-or-none' 仅支持全开/全关；false 不支持
   * - approval: 是否支持把权限请求转为人工 approval_request
   */
  capabilities(): AgentCapabilitySupport;
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
