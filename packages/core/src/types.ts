// @ai-devflow/core —— 领域类型契约（纯 TS，零 Node 依赖，Renderer 与 Main 共享）

/** Agent 类型。新增自定义 Agent 在此追加字面量并在 agents 包注册。 */
export type AgentType = 'claude_code' | 'codex' | 'pi' | 'test';

/** 六泳道状态。 */
export type TaskStatus =
  | 'backlog'
  | 'ready'
  | 'in_progress'
  | 'awaiting_input'
  | 'in_review'
  | 'archived';

/** 任务角色，映射到 AgentType。 */
export type TaskRole = 'planner' | 'coder' | 'reviewer' | 'tester';

/** 流水线阶段定义。 */
export interface Stage {
  id: string;
  name: string;
  role: TaskRole;
  /** 进入此阶段需要的产物 checkpoint 类型；空数组表示无前置依赖。 */
  dependsOn?: string[];
}

export interface Project {
  id: string;
  name: string;
  /** 本地 Git 仓库绝对路径。 */
  path: string;
  defaultBranch: string;
  createdAt: number;
  updatedAt: number;
  settings: ProjectSettings;
}

export interface ProjectSettings {
  /** 角色 -> AgentType 映射覆盖。 */
  agentRoles?: Partial<Record<TaskRole, AgentType>>;
  /** 该项目并发上限覆盖。 */
  maxConcurrent?: number;
}

export interface Iteration {
  id: string;
  projectId: string;
  name: string;
  version: string;
  status: 'active' | 'archived';
  createdAt: number;
}

export interface Requirement {
  id: string;
  iterationId: string;
  title: string;
  description: string;
  priority: 'low' | 'medium' | 'high';
  acceptance: string; // 验收标准
  createdAt: number;
  /** 是否已验收归档（归档后默认不出现在需求列表中）。 */
  archived: boolean;
  archivedAt?: number;
}

export interface Task {
  id: string;
  requirementId: string;
  iterationId: string;
  projectId: string;
  title: string;
  description: string;
  status: TaskStatus;
  agentType?: AgentType;
  role: TaskRole;
  stages: Stage[];
  /** 当前阶段索引。 */
  currentStage: number;
  statusChangedAt: number;
  createdAt: number;
  updatedAt: number;
  /** worktree 路径（运行时）。 */
  worktreePath?: string;
  /** 重试次数。 */
  retryCount: number;
  /** 待沟通暂停前的来源状态（in_progress / in_review），用于在原泳道内以"待沟通"标识展示。 */
  pausedFrom?: TaskStatus;
  /**
   * 串行依赖：本任务启动前必须先完成的前置任务 ID 列表（通常为同一需求下的兄弟任务）。
   * 前置任务进入 in_review 或 archived 视为"完成"（开发工作已交付），其后继任务方可启动。
   */
  dependsOn?: string[];
}

/** Agent 执行事件（与 agents 包一致，但定义在 core 以便 Renderer 订阅）。 */
export type AgentEvent =
  | { type: 'log'; level: 'info' | 'warn' | 'error'; text: string; t: number }
  | { type: 'file_change'; path: string; action: 'create' | 'modify' | 'delete'; t: number }
  | { type: 'test_result'; passed: boolean; summary: string; evidence: string; t: number }
  | { type: 'ask_user'; question: string; context: string; t: number }
  | { type: 'status'; stage: string; detail?: string; t: number }
  | { type: 'done'; summary: string; t: number }
  | { type: 'error'; message: string; recoverable: boolean; t: number };

export interface Checkpoint {
  id: string;
  taskId: string;
  stageId: string;
  stageIndex: number;
  /** 序列化的上下文快照（由 adapter 产出）。 */
  context: string;
  createdAt: number;
}

export interface ExecutionRecord {
  id: string;
  taskId: string;
  attempt: number;
  agentType: AgentType;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'paused' | 'succeeded' | 'failed' | 'canceled';
  /** 末尾事件摘要。 */
  summary?: string;
}

export interface LogEntry {
  id: string;
  taskId: string;
  executionId: string;
  level: 'info' | 'warn' | 'error';
  text: string;
  t: number;
}

/** 通知超时规则。 */
export interface NotificationRule {
  id: string;
  projectId?: string; // 缺省为全局
  status: TaskStatus;
  minutes: number;
  channels: NotificationChannel[];
  enabled: boolean;
}

export type NotificationChannel = 'desktop' | 'webhook';

export interface NotificationDelivery {
  id: string;
  ruleId: string;
  taskId: string;
  channel: NotificationChannel;
  sentAt: number;
  status: 'sent' | 'failed' | 'suppressed';
  detail?: string;
}

export interface WebhookConfig {
  id: string;
  name: string;
  url: string;
  /** HMAC 密钥（落盘前由 safeStorage 加密）。内存中为明文。 */
  secret: string;
  events: string[];
  enabled: boolean;
  createdAt: number;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  taskId?: string;
  event: string;
  payload: string;
  status: number; // HTTP 状态码，0 表示网络失败
  attempt: number;
  sentAt: number;
  durationMs: number;
  responseSnippet?: string;
  ok: boolean;
}

/** 桥接器检测结果。 */
export interface AgentDetection {
  agentType: AgentType;
  available: boolean;
  version?: string;
  path?: string;
  reason?: string;
}

/** Agent 运行请求。 */
export interface AgentRunRequest {
  taskId: string;
  prompt: string;
  cwd: string;
  resumeFrom?: Checkpoint;
  userInput?: string;
  env?: Record<string, string>;
}

/** 门禁上下文：判定迁移所需的外部事实。 */
export interface GateContext {
  hasAcceptance: boolean;
  hasAgentAssigned: boolean;
  hasArtifacts: boolean;
  testPassed?: boolean;
  testFailedWithEvidence?: boolean;
  auditOk?: boolean;
  hasUserAnswer?: boolean;
}

export interface GateResult {
  ok: boolean;
  reasons: string[];
}

/** 待沟通提问记录。 */
export interface PendingQuestion {
  taskId: string;
  question: string;
  context: string;
  askedAt: number;
  answeredAt?: number;
  answer?: string;
}

/** 状态审计结果。 */
export interface AuditFinding {
  taskId: string;
  severity: 'info' | 'warn' | 'error';
  message: string;
}

/** 界面语言。 */
export type Locale = 'zh' | 'en';

/** AI 服务商配置（用于"AI 沟通生成任务"）。密钥落盘前由 safeStorage 加密。 */
export interface AiProviderConfig {
  provider: 'anthropic' | 'openai';
  /** 明文 API Key（内存中）；落盘前由主进程加密。 */
  apiKey: string;
  /** 可选自定义 baseURL（兼容 OpenAI 协议的网关/自托管服务）。 */
  baseURL?: string;
  /** 模型名，例如 claude-sonnet-5 / gpt-4o。 */
  model: string;
}

/** AI 对话消息（与 ai-sdk 协议对齐）。 */
export interface AiChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** AI 提议的任务草稿（用户确认后落库）。 */
export interface AiTaskProposal {
  title: string;
  description: string;
  role: TaskRole;
}

/** AI 提议的需求草稿（用户确认后落库）。 */
export interface AiRequirementProposal {
  title: string;
  description: string;
  /** 验收标准 / 门禁条件。 */
  acceptance: string;
  priority: 'low' | 'medium' | 'high';
}
