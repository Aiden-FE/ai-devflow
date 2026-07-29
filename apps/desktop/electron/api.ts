// 类型化 IPC 契约：Renderer 只能通过此接口访问主进程能力。
// 每个方法对应一个显式 IPC 通道；不存在任意命令执行入口。
import type {
  Project,
  Iteration,
  Requirement,
  Task,
  TaskStatus,
  TaskRole,
  TaskTypeLabel,
  LogEntry,
  ExecutionRecord,
  NotificationRule,
  WebhookConfig,
  WebhookDelivery,
  ProjectSettings,
  Locale,
  ThemeMode,
  AiChatMessage,
  AiTaskProposal,
  AiRequirementProposal,
  TaskMessage,
  PendingInteraction,
  UpdateStatus,
  InstallUpdateResult,
  RejectTaskInput,
  ProviderSummary,
  ProviderInput,
  ProviderTestResult,
  ProviderHealthSummary,
  ProviderMigrationStatus,
  AgentModelOverride,
  AgentKey,
  KnowledgeHealthSnapshot,
  KnowledgeRunView,
  TaskKnowledgeEvidence,
  IterationChangelogVerification,
  UsageAnalytics,
  UsageFilters,
  RetentionPolicy,
} from '@ai-devflow/core';

export interface RetentionRunView {
  skipped: boolean;
  ranAt: number;
  logsDeleted: number;
  attemptsDeleted: number;
  messagesDeleted: number;
  providerRowsRolledUp: number;
}

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
  /** @deprecated 按泳道派发，不再使用；保留兼容旧客户端。 */
  role?: TaskRole;
  /** 任务类型标签（前端/后端/全栈/联调），仅展示。 */
  typeLabel?: TaskTypeLabel;
  /** 串行依赖：前置任务 ID 列表（同需求兄弟任务）。 */
  dependsOn?: string[];
}

/** 任务可编辑字段（仅 ready 允许编辑）。dependsOn 为 null 表示清空依赖。 */
export interface UpdateTaskInput {
  id: string;
  title?: string;
  description?: string;
  /** @deprecated 按泳道派发，不再使用；保留兼容旧客户端。 */
  role?: TaskRole;
  /** 任务类型标签（前端/后端/全栈/联调），仅展示。 */
  typeLabel?: TaskTypeLabel;
  dependsOn?: string[] | null;
}

/** 批量创建任务（AI 提议）：proposals 携带 draftId 与 dependsOn（草稿引用），主进程映射为真实 taskId 并事务化落库。 */
export interface CreateBatchInput {
  requirementId: string;
  proposals: AiTaskProposal[];
}

/** AI 任务草稿（多轮沟通后由研发负责人经工具产出；description 为实施计划）。 */
export type AiTaskProposalDraft = {
  draftId: string;
  title: string;
  description: string;
  /** @deprecated 按泳道派发，不再使用；保留兼容。 */
  role?: TaskRole;
  /** 任务类型标签（前端/后端/全栈/联调），仅展示。 */
  typeLabel?: TaskTypeLabel;
  dependsOn: string[];
};

/** AI 流式事件（chat 增量/完成/出错）。 */
export type AiRequirementProposalDraft = {
  title: string;
  description: string;
  acceptance: string;
  priority: 'low' | 'medium' | 'high';
};

/** 问答工具的问题结构（多 tab）。 */
export type AskTabs = Array<{
  id: string;
  title: string;
  questions: Array<{
    id: string;
    kind: 'single' | 'multi' | 'text';
    question: string;
    options?: Array<{ value: string; label: string }>;
    required?: boolean;
  }>;
}>;

/** 问答工具的答案结构。 */
export type AskAnswer = Array<{
  tabId: string;
  answers: Array<{ questionId: string; value: string | string[] }>;
}>;

export type AiStreamEvent =
  | { type: 'delta'; sessionId: string; text: string }
  | { type: 'thinking'; sessionId: string; text: string }
  | { type: 'done'; sessionId: string; fullText: string }
  | { type: 'error'; sessionId: string; error: string }
  | { type: 'requirement_proposal'; sessionId: string; draft: AiRequirementProposalDraft }
  | { type: 'task_proposal'; sessionId: string; tasks: AiTaskProposalDraft[] }
  | { type: 'question'; sessionId: string; toolUseId: string; tabs: AskTabs };

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
  // ---- 供应商使用统计 ----
  analytics: {
    query(filters: UsageFilters): Promise<UsageAnalytics>;
  };
  // ---- 项目 ----
  projects: {
    list(): Promise<Project[]>;
    create(input: CreateProjectInput): Promise<Project>;
    /** 选择本地文件夹（导入已有仓库）。 */
    pickFolder(): Promise<PickedFolder | null>;
    /** 在系统文件管理器中打开项目所在文件夹。 */
    openFolder(id: string): Promise<{ ok: boolean; error?: string }>;
    /** 在指定父目录下新建项目目录，可选 git init。 */
    createAtPath(input: CreateProjectAtInput): Promise<Project>;
    update(project: Project): Promise<void>;
    delete(id: string): Promise<void>;
  };
  // ---- 迭代 ----
  iterations: {
    list(projectId: string): Promise<Iteration[]>;
    create(projectId: string, name: string, version: string): Promise<Iteration>;
    archive(id: string): Promise<{ ok: true; merged: boolean; reason?: string } | { ok: false; reasons: string[] }>;
  };
  // ---- 知识库 ----
  knowledge: {
    getProjectSnapshot(projectId: string): Promise<KnowledgeHealthSnapshot>;
    startInitialization(projectId: string): Promise<KnowledgeRunView>;
    startAudit(projectId: string, mode: 'light' | 'full'): Promise<KnowledgeRunView>;
    startRepair(projectId: string, findingIds: string[]): Promise<KnowledgeRunView>;
    getRun(runId: string): Promise<KnowledgeRunView>;
    confirmRun(runId: string): Promise<KnowledgeHealthSnapshot>;
    cancelRun(runId: string): Promise<void>;
    getTaskEvidence(taskId: string): Promise<TaskKnowledgeEvidence>;
    getIterationVerification(iterationId: string): Promise<IterationChangelogVerification>;
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
    /** 删除子任务（硬删除）；被其它任务 dependsOn 引用时拒绝并返回阻塞列表。 */
    delete(id: string): Promise<{ ok: true } | { ok: false; blockedBy: { id: string; title: string }[] }>;
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
    getProjectSettings(projectId: string): Promise<ProjectSettings>;
    updateProjectSettings(projectId: string, settings: ProjectSettings): Promise<void>;
    getRetention(): Promise<{ policy: RetentionPolicy; lastRunAt?: number }>;
    setRetention(policy: RetentionPolicy): Promise<RetentionPolicy>;
    runRetention(): Promise<RetentionRunView>;
    compactDatabase(confirmed: boolean): Promise<void>;
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
    /** Sanitized legacy migration state; contains no provider payload or credential detail. */
    migrationStatus(): Promise<ProviderMigrationStatus>;
    /** Atomically replaces an unreadable legacy record with an explicitly re-entered provider. */
    completeReentry(input: ProviderInput): Promise<ProviderSummary>;
    /**
     * 列出兼容网关可用模型（仅 openai_compatible / anthropic_compatible 会真正请求 /v1/models；
     * 标准提供商返回空数组）。不回显密钥；仅返回 `{ id }` 列表供 Renderer 选择默认模型。
     */
    listModels(providerId: string): Promise<{ id: string }[]>;
  };
  // ---- Agent 模型覆盖 ----
  agentOverrides: {
    list(): Promise<AgentModelOverride[]>;
    save(o: AgentModelOverride): Promise<AgentModelOverride[]>;
    remove(agentKey: AgentKey): Promise<AgentModelOverride[]>;
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
     * mode 决定聚焦：task（任务对话）/ requirement（需求完善）/ task_proposal（研发视角拆解子任务）。
     * context 为附加上下文（如当前需求内容）。requirement / task_proposal 模式传 projectPath 后，
     * AI 会结合项目知识与仓库现状；任务草稿通过 onTaskProposal 回传。
     */
    chat(
      messages: AiChatMessage[],
      onChunk: (delta: string) => void,
      opts?: {
        mode?: 'task' | 'requirement' | 'task_proposal';
        context?: string;
        projectPath?: string;
        projectId?: string;
        onRequirementProposal?: (draft: AiRequirementProposalDraft) => void;
        onTaskProposal?: (tasks: AiTaskProposalDraft[]) => void;
        onQuestion?: (sessionId: string, toolUseId: string, tabs: AskTabs) => void;
        /** 会话创建后、请求发送前回传 sessionId，供调用方精确取消。 */
        onSession?: (sessionId: string) => void;
        /** AI 思维链增量（thinking_delta）：供 UI 展示思考细节，与正文增量分离。 */
        onThinking?: (text: string) => void;
      },
    ): Promise<string>;
    /** 取消指定 AI 对话会话；已结束或未知会话为幂等 no-op。 */
    cancel(sessionId: string): Promise<void>;
    /** 提交问答工具的答案（统一提交所有 tab）。 */
    answer(sessionId: string, toolUseId: string, answers: AskAnswer): Promise<void>;
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
