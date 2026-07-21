// @ai-devflow/core —— 领域类型契约（纯 TS，零 Node 依赖，Renderer 与 Main 共享）

/** Agent 类型。新增自定义 Agent 在此追加字面量并在 agents 包注册。 */
export type AgentType = 'claude_code' | 'codex' | 'pi' | 'test';

/**
 * 任务状态（内部值）。
 *
 * 可见泳道：ready -> in_progress -> in_review -> archived。
 * `awaiting_input` 不是独立泳道，而是开发中/待验收任务的暂停标识（保留 pausedFrom 在原泳道展示）。
 * `backlog`（需求池）已移除：新建任务直接进入 ready；历史 backlog 任务由迁移改为 ready。
 * 保留为联合成员仅供迁移与类型兼容，运行时不再产生该状态。
 */
export type TaskStatus =
  | 'backlog'
  | 'ready'
  | 'in_progress'
  | 'awaiting_input'
  | 'in_review'
  | 'archived';

/** 可见泳道状态（不含 backlog 与暂停标识 awaiting_input）。 */
export const VISIBLE_LANES: TaskStatus[] = ['ready', 'in_progress', 'in_review', 'archived'];

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
  /** 角色 -> AgentType 映射覆盖（旧字段，向后兼容；仅控制默认 Agent）。 */
  agentRoles?: Partial<Record<TaskRole, AgentType>>;
  /**
   * 角色 -> 能力配置（新字段，优先于 agentRoles）。
   * 兼容旧数据：缺省时回退到 agentRoles + 角色默认。
   */
  roleConfigs?: Partial<Record<TaskRole, RoleAgentConfig>>;
  /** 该项目并发上限覆盖。 */
  maxConcurrent?: number;
}

/**
 * 单个角色（planner/coder/reviewer/tester）的 Agent 能力配置。
 * 各字段缺省表示“不限制 / 按角色默认”。配置存入 projects.settings_json。
 */
export interface RoleAgentConfig {
  /** 默认 Agent（覆盖角色默认映射）。缺省=按角色默认。 */
  agentType?: AgentType;
  /** 插件白名单（本地目录路径或 URL）。空数组=不加载额外插件；缺省=不限制。 */
  plugins?: string[];
  /** Skills 白名单。适配器声明支持范围：Claude Code 仅支持“全开 / 全关（--disable-slash-commands）”。 */
  skills?: string[];
  /** 工具白名单（如 Bash,Edit,Read）。空数组=禁用全部工具；缺省=不限制。 */
  tools?: string[];
  /** 工具黑名单（禁用的工具名）。 */
  disallowedTools?: string[];
  /**
   * 是否要求把需授权的工具调用转为人工 approval_request。
   * true=不无条件绕过权限，每个工具调用暂停等待用户批准/拒绝；缺省=false（沿用各 CLI 的非绕过默认）。
   */
  requireApproval?: boolean;
}

/**
 * 由 Orchestrator 解析后传给 Adapter 的最终能力配置。
 * 任务显式 agentType 优先于角色默认；其余字段来自角色 RoleAgentConfig。
 */
export interface AgentCapabilities {
  agentType: AgentType;
  plugins?: string[];
  skills?: string[];
  tools?: string[];
  disallowedTools?: string[];
  /**
   * 是否要求把需授权的工具调用转为人工 approval_request。
   * true=不无条件绕过权限，真实权限请求暂停等待用户处理；false=沿用各 CLI 默认。
   */
  requireApproval?: boolean;
}

/** Adapter 声明自身支持的能力（不支持的字段在 UI 禁用并说明，不静默忽略）。 */
export interface AgentCapabilitySupport {
  /** 工具白名单限制（Claude Code --allowedTools/--tools；Codex 沙箱）。 */
  tools: boolean;
  /** 插件加载（Claude Code --plugin-dir/--plugin-url）。 */
  plugins: boolean;
  /** Skills 控制：'all-or-none' 仅支持全开/全关；false 不支持。 */
  skills: 'all-or-none' | false;
  /** 把权限请求转为人工 approval_request。 */
  approval: boolean;
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
  | { type: 'error'; message: string; recoverable: boolean; t: number }
  | {
      type: 'approval_request';
      /** 需授权的工具名（如 Bash、Write）。 */
      toolName: string;
      /** 工具调用 ID（用于关联 tool_call 消息与响应）。 */
      toolUseId: string;
      /** 适配器/CLI 的请求标识（如 Claude Code 的 request_id），用于恢复时定位。 */
      requestId?: string;
      /** 人类可读的授权描述。 */
      description: string;
      /** 工具入参（JSON 字符串，便于展示）。 */
      input?: string;
      t: number;
    };

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
  /** 由 Orchestrator 解析的最终能力配置（角色配置 + 任务显式 agentType 覆盖）。 */
  capabilities?: AgentCapabilities;
  /**
   * 恢复待处理交互时携带的决策：
   * - clarification/confirmation: 用户文本回答。
   * - approval: 'allow' | 'deny'。
   * 适配器据此决定恢复后是否放行对应工具。
   */
  interactionResponse?: { kind: InteractionKind; value: string };
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
  /** 归档门禁：是否经过显式人工验收（tasks.accept）。 */
  accepted?: boolean;
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

// ---- 主题（Part 1） ----

/** 主题模式：亮色 / 深色 / 跟随系统（UI 显示“自动”）。默认 system。 */
export type ThemeMode = 'light' | 'dark' | 'system';

// ---- 任务对话消息与待处理交互（Part 3） ----

export type TaskMessageRole = 'user' | 'assistant' | 'system' | 'tool';

/**
 * 任务对话消息种类。
 * - text: 普通文本消息（user/assistant/system）
 * - tool_call: 工具调用（assistant 发起）
 * - tool_result: 工具结果（tool）
 * - clarification_request: 澄清请求（ask_user）
 * - approval_request: 授权请求（需用户批准/拒绝的工具调用）
 * - confirmation_request: 确认请求（是/否）
 * - error / status: 错误与状态
 */
export type TaskMessageKind =
  | 'text'
  | 'tool_call'
  | 'tool_result'
  | 'clarification_request'
  | 'approval_request'
  | 'confirmation_request'
  | 'error'
  | 'status';

/** 持久化任务对话消息（task_messages 表）。旧 log_entries 保留并兼容显示。 */
export interface TaskMessage {
  id: string;
  taskId: string;
  /** 关联执行记录（可空，如用户消息）。 */
  executionId?: string;
  role: TaskMessageRole;
  kind: TaskMessageKind;
  text?: string;
  /** 工具调用/结果附带的结构化数据。 */
  toolName?: string;
  toolUseId?: string;
  /** 工具入参（JSON 字符串）。 */
  toolInput?: string;
  /** 工具结果（文本）。 */
  toolResult?: string;
  /** 是否为错误结果（tool_result 失败）。 */
  isError?: boolean;
  t: number;
}

/** 通用待处理交互种类。 */
export type InteractionKind = 'clarification' | 'approval' | 'confirmation';
export type InteractionStatus =
  | 'pending'
  | 'answered'
  | 'approved'
  | 'denied'
  | 'confirmed'
  | 'cancelled';

/**
 * 通用待处理交互（pending_interactions 表）。
 * 等待交互时任务进入 awaiting_input（保留 pausedFrom）；解决后从 checkpoint / Agent session 恢复。
 */
export interface PendingInteraction {
  id: string;
  taskId: string;
  kind: InteractionKind;
  /** 关联的对话消息 ID（如 approval_request 消息）。 */
  messageId?: string;
  /** 标题（问题 / 授权工具名 / 确认提示）。 */
  title: string;
  detail?: string;
  /** 授权相关：工具名 / 工具调用 ID / CLI 请求 ID。 */
  toolName?: string;
  toolUseId?: string;
  requestId?: string;
  status: InteractionStatus;
  /** 用户回答 / 决策结果。 */
  response?: string;
  createdAt: number;
  resolvedAt?: number;
}

// ---- 自动更新（Part 6） ----

export type UpdateState = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error' | 'no-update';

export interface UpdateProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export interface UpdateStatus {
  state: UpdateState;
  /** 新版本号（available/downloaded 时）。 */
  version?: string;
  /** 当前版本号。 */
  currentVersion: string;
  /** 下载进度（downloading 时）。 */
  progress?: UpdateProgress;
  /** 错误信息（error 时）。 */
  error?: string;
}
