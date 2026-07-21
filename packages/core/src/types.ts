// @ai-devflow/core —— 领域类型契约（纯 TS，零 Node 依赖，Renderer 与 Main 共享）

/** Agent 类型。新增自定义 Agent 在此追加字面量并在 agents 包注册。 */
export type AgentType = 'claude_code' | 'codex' | 'pi' | 'test';

/**
 * 任务状态（内部值）。
 *
 * 可见泳道：ready -> in_progress -> testing -> in_review -> archived。
 * - `testing`（测试中）：开发 Agent 完成后进入，由 reviewer 角色对应的审查 Agent 自动审查；
 *   审查通过才合并并进入 in_review（待验收），不通过退回 in_progress 携带反馈修复。
 *   开发任务禁止从 in_progress 直接进入 in_review（状态机不提供该迁移），必须经过 testing。
 * - `awaiting_input` 不是独立泳道，而是开发中/测试中/待验收任务的暂停标识（保留 pausedFrom 在原泳道展示）。
 * - `backlog`（需求池）已移除：新建任务直接进入 ready；历史 backlog 任务由迁移改为 ready。
 *   保留为联合成员仅供迁移与类型兼容，运行时不再产生该状态。
 */
export type TaskStatus =
  | 'backlog'
  | 'ready'
  | 'in_progress'
  | 'testing'
  | 'awaiting_input'
  | 'in_review'
  | 'archived';

/** 可见泳道状态（不含 backlog 与暂停标识 awaiting_input）。 */
export const VISIBLE_LANES: TaskStatus[] = ['ready', 'in_progress', 'testing', 'in_review', 'archived'];

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
   * 逐字段继承全局：未配置（undefined）的字段继承 GlobalAgentConfig；显式值（含 []）覆盖全局。
   */
  roleConfigs?: Partial<Record<TaskRole, RoleAgentConfig>>;
  /** 该项目并发上限覆盖。 */
  maxConcurrent?: number;
}

/**
 * 全局 Agent 能力默认配置：角色 -> RoleAgentConfig。
 * 存入 credentials('global_agent_config')（明文 JSON，非密钥）。
 * 运行时合并顺序：项目显式值 > 全局值 > 系统默认（defaultAgentForRole / 适配器默认）。
 */
export type GlobalAgentConfig = Partial<Record<TaskRole, RoleAgentConfig>>;

/**
 * 单个角色（planner/coder/reviewer/tester）的 Agent 能力配置。
 *
 * 字段语义（重要 —— 区分「未配置」与「空数组」）：
 * - `undefined`（未配置）= 继承上一层（项目继承全局；全局继承系统默认），表示「不限制 / 按默认」。
 * - `[]`（显式空数组）= 明确的覆盖值：tools=[] 表示禁用全部工具、skills=[] 表示关闭全部 skills、
 *   plugins=[] 表示不加载额外插件。合并时 `[]` 会覆盖继承值，不会被当成「未配置」。
 * 项目级配置存入 projects.settings_json；全局默认存入 credentials('global_agent_config')。
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
  /**
   * @deprecated Pi-only 运行时不再区分 Agent 类型；该字段仅为旧 Renderer 兼容保留，永不填充。
   * 删除阶段（schema v9 已删列后）连同类型一并移除。
   */
  agentType?: AgentType;
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
  /** 解析到的 CLI 绝对路径（找不到时回退为命令名）。 */
  path?: string;
  reason?: string;
  /**
   * 不可用时的错误类别，便于 UI 区分处置：
   * - 'not-found'：未找到 CLI（ENOENT）。
   * - 'incompatible-node'：CLI 已找到，但其 shebang/PATH 命中的 Node 运行时过旧（如不支持 ??=）。
   * - 'other'：其它检测失败。
   */
  errorKind?: 'not-found' | 'incompatible-node' | 'other';
  /** 解析到的 Node 可执行文件绝对路径（诊断用，incompatible-node 时尤其重要）。 */
  nodePath?: string;
  /** Node 运行时版本（诊断用）。 */
  nodeVersion?: string;
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
  /** 审查门禁：reviewer Agent 审查是否通过（testing -> in_review 必须为 true，拒绝拖拽绕过）。 */
  reviewPassed?: boolean;
  /** 验收不通过退回：必填的退回原因（canReject 要求非空）。 */
  rejectReason?: string;
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

/** 「测试连接」结果：脱敏后的最终请求地址、HTTP 状态与服务端摘要（不含 API Key）。 */
export interface TestConnectionResult {
  ok: boolean;
  /** HTTP 状态码（0 表示网络层失败）。 */
  status: number;
  /** 脱敏后的最终请求地址。 */
  url: string;
  /** 服务端响应摘要（脱敏、截断）。 */
  serverSummary?: string;
  /** 失败原因（脱敏）。 */
  error?: string;
}

/**
 * AI 提议的任务草稿（用户确认后落库）。
 * AI 根据任务间关系自动输出依赖 DAG：每个草稿有稳定 draftId，dependsOn 引用其它草稿的 draftId。
 * 落库时由批量创建把 draftId 映射为真实 taskId（见 validateProposalDag 与 tasks:createBatch）。
 */
export interface AiTaskProposal {
  /** 草稿稳定标识（AI 输出，如 "t1"/"t2"；用于 dependsOn 引用与落库映射）。 */
  draftId: string;
  title: string;
  description: string;
  role: TaskRole;
  /** 依赖的其它草稿 draftId 列表（DAG；无依赖则保持并行）。 */
  dependsOn?: string[];
}

/**
 * 验收不通过退回请求（专用 reject 操作，禁止用无原因的通用 updateStatus 代替）。
 */
export interface RejectTaskInput {
  taskId: string;
  /** 退回原因（必填，写入任务消息/审计）。 */
  reason: string;
  /** 目标状态：'ready'=仅改状态待开发；'in_progress'=立即携原因执行修复。默认 in_progress。 */
  target: 'ready' | 'in_progress';
}

/**
 * 审查结论（reviewer Agent 输出，持久化到执行记录与任务对话）。
 */
export interface ReviewVerdict {
  /** 审查是否通过：通过才合并并进入待验收；不通过退回开发中携带反馈。 */
  pass: boolean;
  /** 结论摘要。 */
  summary: string;
  /** 反馈（不通过时的修复建议；通过时可为空）。 */
  feedback?: string;
  /** 覆盖的规则维度（需求覆盖 / 测试构建 lint / 明显回归 / 安全问题 / 无关改动）。 */
  checks?: string[];
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

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error'
  | 'no-update';

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

/** 「立即升级」安装结果：不允许静默 no-op，失败时返回可诊断信息。
 * - install-started：已请求原生安装器，应用即将退出并安装（仅自动安装平台）。
 * - manual-download：当前为未签名 macOS，已打开 GitHub Releases 请用户手动下载安装。
 */
export interface InstallUpdateResult {
  ok: boolean;
  action?: 'install-started' | 'manual-download';
  /** manual-download 时携带的当前系统架构，用于 UI 提示用户下载对应架构包。 */
  arch?: 'x64' | 'arm64' | string;
  /** 失败/不可安装时的可诊断信息（含当前状态）。 */
  error?: string;
}
