// 类型化 IPC 契约：Renderer 只能通过此接口访问主进程能力。
// 每个方法对应一个显式 IPC 通道；不存在任意命令执行入口。
import type {
  Project,
  Iteration,
  Requirement,
  Task,
  TaskStatus,
  TaskRole,
  AgentType,
  AgentDetection,
  LogEntry,
  ExecutionRecord,
  NotificationRule,
  WebhookConfig,
  WebhookDelivery,
  ProjectSettings,
  Locale,
  ThemeMode,
  AiProviderConfig,
  AiChatMessage,
  AiTaskProposal,
  AiRequirementProposal,
  TaskMessage,
  PendingInteraction,
  UpdateStatus,
  InstallUpdateResult,
  RejectTaskInput,
  GlobalAgentConfig,
  TestConnectionResult,
  ProviderSummary,
  ProviderInput,
  ProviderTestResult,
  ProviderHealthSummary,
} from '@ai-devflow/core';

export interface CreateProjectInput {
  name: string;
  path: string;
  defaultBranch: string;
}

/** 在指定父目录下新建项目（可选 git init）。 */
export interface CreateProjectAtInput {
  name: string;
  parentDir: string;
  gitInit: boolean;
  defaultBranch?: string;
}

export interface PickedFolder {
  path: string;
  /** 由路径或 URL 推导的项目名（大驼峰，如 "Project A"）。 */
  name: string;
}

export interface CreateTaskInput {
  requirementId: string;
  title: string;
  description: string;
  role: TaskRole;
  agentType?: AgentType;
  /** 串行依赖：前置任务 ID 列表（同需求兄弟任务）。 */
  dependsOn?: string[];
}

/** 任务可编辑字段（仅 ready 允许编辑）。agentType 为 null 表示清除（按角色默认）；dependsOn 为 null 表示清空依赖。 */
export interface UpdateTaskInput {
  id: string;
  title?: string;
  description?: string;
  role?: TaskRole;
  agentType?: AgentType | null;
  dependsOn?: string[] | null;
}

/** 批量创建任务（AI 提议）：proposals 携带 draftId 与 dependsOn（草稿引用），主进程映射为真实 taskId 并事务化落库。 */
export interface CreateBatchInput {
  requirementId: string;
  proposals: AiTaskProposal[];
}

/** AI 流式事件（chat 增量/完成/出错）。 */
export type AiStreamEvent =
  | { type: 'delta'; sessionId: string; text: string }
  | { type: 'done'; sessionId: string; fullText: string }
  | { type: 'error'; sessionId: string; error: string };

export interface StreamEvent {
  kind:
    | 'task-event'
    | 'log'
    | 'task-status'
    | 'task-canceled'
    | 'task-failed'
    | 'task-awaiting'
    | 'task-message'
    | 'task-interaction'
    | 'theme-changed'
    | 'update-status';
  taskId: string;
  data: unknown;
}

export interface DesktopApi {
  // ---- 项目 ----
  projects: {
    list(): Promise<Project[]>;
    create(input: CreateProjectInput): Promise<Project>;
    /** 选择本地文件夹（导入已有仓库）。 */
    pickFolder(): Promise<PickedFolder | null>;
    /** 在指定父目录下新建项目目录，可选 git init。 */
    createAtPath(input: CreateProjectAtInput): Promise<Project>;
    update(project: Project): Promise<void>;
    delete(id: string): Promise<void>;
  };
  // ---- 迭代 ----
  iterations: {
    list(projectId: string): Promise<Iteration[]>;
    create(projectId: string, name: string, version: string): Promise<Iteration>;
    archive(id: string): Promise<void>;
  };
  // ---- 需求 ----
  requirements: {
    list(iterationId: string): Promise<Requirement[]>;
    get(id: string): Promise<Requirement | undefined>;
    create(iterationId: string, title: string, description: string, priority: Requirement['priority'], acceptance: string): Promise<Requirement>;
    update(req: Requirement): Promise<void>;
    /** 验收归档：仅当所有子任务已归档时允许。 */
    archive(id: string): Promise<void>;
  };
  // ---- 任务 ----
  tasks: {
    listByIteration(iterationId: string): Promise<Task[]>;
    listByProject(projectId: string): Promise<Task[]>;
    /** 跨项目全部任务（左下角状态汇总用）。 */
    listAll(): Promise<Task[]>;
    /** 同一需求下的子任务（卡片详情展示关联用）。 */
    listByRequirement(requirementId: string): Promise<Task[]>;
    get(id: string): Promise<Task | undefined>;
    create(input: CreateTaskInput): Promise<Task>;
    /** 批量创建（AI 提议）：把 dependsOn 的草稿引用映射为真实 taskId，事务化原子落库。 */
    createBatch(input: CreateBatchInput): Promise<Task[]>;
    /** 编辑任务（仅 ready）。 */
    update(input: UpdateTaskInput): Promise<Task>;
    updateStatus(id: string, target: TaskStatus): Promise<void>;
    /**
     * 验收通过并归档：唯一进入 archived 的入口。
     * 仅 in_review 且有执行产物时允许；看板拖拽无法绕过（updateStatus 不接受 archived）。
     */
    accept(id: string): Promise<void>;
    /** 验收不通过退回（专用）：原因必填；target=ready 仅改状态，in_progress 立即携原因执行修复。 */
    reject(input: RejectTaskInput): Promise<void>;
    /** 手动标记待沟通（暂停，等待用户澄清）；可附暂停说明。 */
    pause(id: string, note?: string): Promise<void>;
    start(id: string): Promise<void>;
    /** 回答澄清问题后恢复（兼容旧 ask_user 流程）。 */
    resume(id: string, answer: string): Promise<void>;
    /** 解决通用待处理交互（澄清/授权/确认）后恢复。 */
    resolveInteraction(id: string, interactionId: string, response: string): Promise<void>;
    cancel(id: string): Promise<void>;
    retry(id: string): Promise<void>;
    logs(id: string): Promise<LogEntry[]>;
    executions(id: string): Promise<ExecutionRecord[]>;
    pendingQuestion(id: string): Promise<import('@ai-devflow/core').PendingQuestion | undefined>;
    /** 任务对话消息（Part 3 对话窗口）。 */
    messages(id: string): Promise<TaskMessage[]>;
    /** 待处理交互列表。 */
    interactions(id: string): Promise<PendingInteraction[]>;
  };
  // ---- Agent ----
  agents: {
    detectAll(): Promise<AgentDetection[]>;
    detect(type: AgentType): Promise<AgentDetection>;
    /** 各适配器声明支持的能力（UI 据此启用/禁用配置项）。 */
    capabilities(): Promise<Partial<Record<AgentType, import('@ai-devflow/core').AgentCapabilitySupport>>>;
  };
  // ---- 通知规则 ----
  notificationRules: {
    list(): Promise<NotificationRule[]>;
    create(rule: NotificationRule): Promise<NotificationRule>;
    update(rule: NotificationRule): Promise<void>;
    delete(id: string): Promise<void>;
  };
  // ---- Webhook ----
  webhooks: {
    list(): Promise<WebhookConfig[]>;
    create(input: { name: string; url: string; secret: string; events: string[] }): Promise<WebhookConfig>;
    update(wh: WebhookConfig): Promise<void>;
    delete(id: string): Promise<void>;
    test(id: string): Promise<{ ok: boolean; status: number; attempts: number }>;
    deliveries(id: string): Promise<WebhookDelivery[]>;
  };
  // ---- 设置 ----
  settings: {
    getLocale(): Promise<Locale>;
    setLocale(locale: Locale): Promise<void>;
    /** 主题模式：light/dark/system（默认 system，UI 显示“自动”）。 */
    getTheme(): Promise<ThemeMode>;
    setTheme(mode: ThemeMode): Promise<void>;
    /** 同步获取当前解析后的主题（'light'|'dark'），供 preload 在首绘前设置 <html> class，避免闪黑。 */
    getResolvedThemeSync(): 'light' | 'dark';
    getAiProvider(): Promise<AiProviderConfig | undefined>;
    setAiProvider(cfg: AiProviderConfig | undefined): Promise<void>;
    /** 测试 AI 服务商连通性：返回脱敏后的最终地址、HTTP 状态与服务端摘要（不含 API Key）。 */
    testAiProvider(cfg: AiProviderConfig): Promise<TestConnectionResult>;
    /** 全局 Agent 能力默认配置（项目可按角色/字段覆盖）。 */
    getGlobalAgentConfig(): Promise<GlobalAgentConfig>;
    setGlobalAgentConfig(config: GlobalAgentConfig): Promise<void>;
    getProjectSettings(projectId: string): Promise<ProjectSettings>;
    updateProjectSettings(projectId: string, settings: ProjectSettings): Promise<void>;
  };
  // ---- AI 服务商（有序提供商列表，Pi-only） ----
  providers: {
    /** 脱敏摘要列表（hasCredential 布尔；不含模型/密钥/credentialRef）。 */
    list(): Promise<ProviderSummary[]>;
    /** 保存（新增/更新）。apiKey 仅替换或清除（空=沿用），不回显。 */
    save(input: ProviderInput): Promise<ProviderSummary>;
    remove(id: string): Promise<void>;
    /** 按完整 id 列表重排序。 */
    reorder(ids: string[]): Promise<void>;
    /** 测试连接：经 ProviderRouter 解析该提供商可用路线。 */
    test(id: string): Promise<ProviderTestResult>;
    health(): Promise<ProviderHealthSummary[]>;
  };
  // ---- 自动更新（Part 6，仅 app.isPackaged 时可用） ----
  updates: {
    /** 手动检查更新。 */
    check(): Promise<void>;
    /** 下载完成后退出并安装更新。返回结果；不可安装时给出可诊断错误（不静默 no-op）。 */
    installUpdate(): Promise<InstallUpdateResult>;
    /** 当前更新状态。 */
    status(): Promise<UpdateStatus>;
  };
  // ---- AI 沟通（流式对话 + 结构化草稿） ----
  ai: {
    /**
     * 流式对话：onChunk 接收增量文本，resolve 完整文本。
     * mode 决定系统提示聚焦（任务拆分 / 需求完善）；context 为附加上下文（如当前需求内容）。
     */
    chat(
      messages: AiChatMessage[],
      onChunk: (delta: string) => void,
      opts?: { mode?: 'task' | 'requirement'; context?: string },
    ): Promise<string>;
    /** 基于对话生成结构化任务草稿。context 可带入当前需求内容。 */
    propose(messages: AiChatMessage[], context?: string): Promise<AiTaskProposal[]>;
    /** 基于对话生成结构化需求草稿（标题/描述/验收标准/优先级）。 */
    proposeRequirement(messages: AiChatMessage[]): Promise<AiRequirementProposal>;
  };
  // ---- 事件流 ----
  events: {
    subscribe(handler: (e: StreamEvent) => void): () => void;
  };
}

declare global {
  interface Window {
    api: DesktopApi;
  }
}
