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
  AiProviderConfig,
  AiChatMessage,
  AiTaskProposal,
  AiRequirementProposal,
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

/** 任务可编辑字段（仅 backlog/ready 允许编辑）。agentType 为 null 表示清除（按角色默认）；dependsOn 为 null 表示清空依赖。 */
export interface UpdateTaskInput {
  id: string;
  title?: string;
  description?: string;
  role?: TaskRole;
  agentType?: AgentType | null;
  dependsOn?: string[] | null;
}

/** AI 流式事件（chat 增量/完成/出错）。 */
export type AiStreamEvent =
  | { type: 'delta'; sessionId: string; text: string }
  | { type: 'done'; sessionId: string; fullText: string }
  | { type: 'error'; sessionId: string; error: string };

export interface StreamEvent {
  kind: 'task-event' | 'log' | 'task-status' | 'task-canceled' | 'task-failed' | 'task-awaiting';
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
    /** 编辑任务（仅 backlog/ready）。 */
    update(input: UpdateTaskInput): Promise<Task>;
    updateStatus(id: string, target: TaskStatus): Promise<void>;
    /** 手动标记待沟通（暂停，等待用户澄清）。 */
    pause(id: string): Promise<void>;
    start(id: string): Promise<void>;
    resume(id: string, answer: string): Promise<void>;
    cancel(id: string): Promise<void>;
    retry(id: string): Promise<void>;
    logs(id: string): Promise<LogEntry[]>;
    executions(id: string): Promise<ExecutionRecord[]>;
    pendingQuestion(id: string): Promise<import('@ai-devflow/core').PendingQuestion | undefined>;
  };
  // ---- Agent ----
  agents: {
    detectAll(): Promise<AgentDetection[]>;
    detect(type: AgentType): Promise<AgentDetection>;
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
    getAiProvider(): Promise<AiProviderConfig | undefined>;
    setAiProvider(cfg: AiProviderConfig | undefined): Promise<void>;
    getProjectSettings(projectId: string): Promise<ProjectSettings>;
    updateProjectSettings(projectId: string, settings: ProjectSettings): Promise<void>;
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
