import type { DatabaseSync } from './db.js';
import type {
  Project,
  ProjectSettings,
  Iteration,
  Requirement,
  Task,
  TaskStatus,
  TaskRole,
  AgentType,
  Stage,
  ExecutionRecord,
  Checkpoint,
  LogEntry,
  PendingQuestion,
  NotificationRule,
  NotificationChannel,
  NotificationDelivery,
  WebhookConfig,
  WebhookDelivery,
  TaskMessage,
  PendingInteraction,
  InteractionKind,
  InteractionStatus,
} from '@ai-devflow/core';
import { tx } from './tx.js';

// ---------- 行映射辅助 ----------

function parseJSON<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function mapProject(r: Record<string, unknown>): Project {
  return {
    id: r.id as string,
    name: r.name as string,
    path: r.path as string,
    defaultBranch: r.default_branch as string,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    settings: parseJSON<ProjectSettings>(r.settings_json as string, {}),
  };
}

function mapIteration(r: Record<string, unknown>): Iteration {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    name: r.name as string,
    version: r.version as string,
    status: r.status as 'active' | 'archived',
    createdAt: r.created_at as number,
  };
}

function mapRequirement(r: Record<string, unknown>): Requirement {
  return {
    id: r.id as string,
    iterationId: r.iteration_id as string,
    title: r.title as string,
    description: r.description as string,
    priority: r.priority as 'low' | 'medium' | 'high',
    acceptance: r.acceptance as string,
    createdAt: r.created_at as number,
    archived: (r.archived as number | undefined) === 1,
    archivedAt: (r.archived_at as number | null) ?? undefined,
  };
}

function mapTask(r: Record<string, unknown>): Task {
  return {
    id: r.id as string,
    requirementId: r.requirement_id as string,
    iterationId: r.iteration_id as string,
    projectId: r.project_id as string,
    title: r.title as string,
    description: r.description as string,
    status: r.status as TaskStatus,
    agentType: (r.agent_type as AgentType | null) ?? undefined,
    role: r.role as TaskRole,
    stages: parseJSON<Stage[]>(r.stages_json as string, []),
    currentStage: r.current_stage as number,
    statusChangedAt: r.status_changed_at as number,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    worktreePath: (r.worktree_path as string | null) ?? undefined,
    retryCount: r.retry_count as number,
    pausedFrom: (r.paused_from as TaskStatus | null) ?? undefined,
    dependsOn: parseJSON<string[]>(r.depends_on_json as string, []).filter(Boolean),
  };
}

function mapExecution(r: Record<string, unknown>): ExecutionRecord {
  return {
    id: r.id as string,
    taskId: r.task_id as string,
    attempt: r.attempt as number,
    agentType: r.agent_type as AgentType,
    startedAt: r.started_at as number,
    endedAt: (r.ended_at as number | null) ?? undefined,
    status: r.status as ExecutionRecord['status'],
    summary: (r.summary as string | null) ?? undefined,
  };
}

function mapCheckpoint(r: Record<string, unknown>): Checkpoint {
  return {
    id: r.id as string,
    taskId: r.task_id as string,
    stageId: r.stage_id as string,
    stageIndex: r.stage_index as number,
    context: r.context as string,
    createdAt: r.created_at as number,
  };
}

function mapLog(r: Record<string, unknown>): LogEntry {
  return {
    id: r.id as string,
    taskId: r.task_id as string,
    executionId: r.execution_id as string,
    level: r.level as 'info' | 'warn' | 'error',
    text: r.text as string,
    t: r.t as number,
  };
}

function mapNotificationRule(r: Record<string, unknown>): NotificationRule {
  return {
    id: r.id as string,
    projectId: (r.project_id as string | null) ?? undefined,
    status: r.status as TaskStatus,
    minutes: r.minutes as number,
    channels: parseJSON<NotificationChannel[]>(r.channels_json as string, []),
    enabled: (r.enabled as number) === 1,
  };
}

function mapNotificationDelivery(r: Record<string, unknown>): NotificationDelivery {
  return {
    id: r.id as string,
    ruleId: r.rule_id as string,
    taskId: r.task_id as string,
    channel: r.channel as NotificationChannel,
    sentAt: r.sent_at as number,
    status: r.status as NotificationDelivery['status'],
    detail: (r.detail as string | null) ?? undefined,
  };
}

function mapWebhookConfig(r: Record<string, unknown>): WebhookConfig {
  return {
    id: r.id as string,
    name: r.name as string,
    url: r.url as string,
    secret: r.secret_enc as string, // 调用方负责加解密；DB 存密文
    events: parseJSON<string[]>(r.events_json as string, []),
    enabled: (r.enabled as number) === 1,
    createdAt: r.created_at as number,
  };
}

function mapWebhookDelivery(r: Record<string, unknown>): WebhookDelivery {
  return {
    id: r.id as string,
    webhookId: r.webhook_id as string,
    taskId: (r.task_id as string | null) ?? undefined,
    event: r.event as string,
    payload: r.payload as string,
    status: r.status as number,
    attempt: r.attempt as number,
    sentAt: r.sent_at as number,
    durationMs: r.duration_ms as number,
    responseSnippet: (r.response_snippet as string | null) ?? undefined,
    ok: (r.ok as number) === 1,
  };
}

function mapTaskMessage(r: Record<string, unknown>): TaskMessage {
  return {
    id: r.id as string,
    taskId: r.task_id as string,
    executionId: (r.execution_id as string | null) ?? undefined,
    role: r.role as TaskMessage['role'],
    kind: r.kind as TaskMessage['kind'],
    text: (r.text as string | null) ?? undefined,
    toolName: (r.tool_name as string | null) ?? undefined,
    toolUseId: (r.tool_use_id as string | null) ?? undefined,
    toolInput: (r.tool_input as string | null) ?? undefined,
    toolResult: (r.tool_result as string | null) ?? undefined,
    isError: (r.is_error as number) === 1,
    t: r.t as number,
  };
}

function mapPendingInteraction(r: Record<string, unknown>): PendingInteraction {
  return {
    id: r.id as string,
    taskId: r.task_id as string,
    kind: r.kind as InteractionKind,
    messageId: (r.message_id as string | null) ?? undefined,
    title: r.title as string,
    detail: (r.detail as string | null) ?? undefined,
    toolName: (r.tool_name as string | null) ?? undefined,
    toolUseId: (r.tool_use_id as string | null) ?? undefined,
    requestId: (r.request_id as string | null) ?? undefined,
    status: r.status as InteractionStatus,
    response: (r.response as string | null) ?? undefined,
    createdAt: r.created_at as number,
    resolvedAt: (r.resolved_at as number | null) ?? undefined,
  };
}

// ---------- Repositories ----------

export interface Repositories {
  projects: ProjectsRepo;
  iterations: IterationsRepo;
  requirements: RequirementsRepo;
  tasks: TasksRepo;
  executions: ExecutionsRepo;
  checkpoints: CheckpointsRepo;
  logs: LogsRepo;
  pendingQuestions: PendingQuestionsRepo;
  notificationRules: NotificationRulesRepo;
  notificationDeliveries: NotificationDeliveriesRepo;
  webhookConfigs: WebhookConfigsRepo;
  webhookDeliveries: WebhookDeliveriesRepo;
  credentials: CredentialsRepo;
  taskMessages: TaskMessagesRepo;
  pendingInteractions: PendingInteractionsRepo;
}

export function createRepositories(db: DatabaseSync): Repositories {
  return {
    projects: projectsRepo(db),
    iterations: iterationsRepo(db),
    requirements: requirementsRepo(db),
    tasks: tasksRepo(db),
    executions: executionsRepo(db),
    checkpoints: checkpointsRepo(db),
    logs: logsRepo(db),
    pendingQuestions: pendingQuestionsRepo(db),
    notificationRules: notificationRulesRepo(db),
    notificationDeliveries: notificationDeliveriesRepo(db),
    webhookConfigs: webhookConfigsRepo(db),
    webhookDeliveries: webhookDeliveriesRepo(db),
    credentials: credentialsRepo(db),
    taskMessages: taskMessagesRepo(db),
    pendingInteractions: pendingInteractionsRepo(db),
  };
}

export interface ProjectsRepo {
  insert(p: Project): void;
  get(id: string): Project | undefined;
  list(): Project[];
  update(p: Project): void;
  updateSettings(id: string, settings: ProjectSettings): void;
  delete(id: string): void;
}
function projectsRepo(db: DatabaseSync): ProjectsRepo {
  return {
    insert(p) {
      db.prepare(
        `INSERT INTO projects(id,name,path,default_branch,created_at,updated_at,settings_json)
         VALUES(?,?,?,?,?,?,?)`,
      ).run(p.id, p.name, p.path, p.defaultBranch, p.createdAt, p.updatedAt, JSON.stringify(p.settings));
    },
    get(id) {
      const r = db.prepare('SELECT * FROM projects WHERE id=?').get(id) as Record<string, unknown> | undefined;
      return r ? mapProject(r) : undefined;
    },
    list() {
      return (db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as Record<string, unknown>[]).map(mapProject);
    },
    update(p) {
      db.prepare(
        `UPDATE projects SET name=?,path=?,default_branch=?,updated_at=?,settings_json=? WHERE id=?`,
      ).run(p.name, p.path, p.defaultBranch, p.updatedAt, JSON.stringify(p.settings), p.id);
    },
    updateSettings(id, settings) {
      db.prepare('UPDATE projects SET settings_json=?, updated_at=? WHERE id=?').run(
        JSON.stringify(settings),
        Date.now(),
        id,
      );
    },
    delete(id) {
      db.prepare('DELETE FROM projects WHERE id=?').run(id);
    },
  };
}

export interface IterationsRepo {
  insert(i: Iteration): void;
  get(id: string): Iteration | undefined;
  listByProject(projectId: string): Iteration[];
  archive(id: string): void;
}
function iterationsRepo(db: DatabaseSync): IterationsRepo {
  return {
    insert(i) {
      db.prepare(
        `INSERT INTO iterations(id,project_id,name,version,status,created_at) VALUES(?,?,?,?,?,?)`,
      ).run(i.id, i.projectId, i.name, i.version, i.status, i.createdAt);
    },
    get(id) {
      const r = db.prepare('SELECT * FROM iterations WHERE id=?').get(id) as Record<string, unknown> | undefined;
      return r ? mapIteration(r) : undefined;
    },
    listByProject(projectId) {
      return (db.prepare('SELECT * FROM iterations WHERE project_id=? ORDER BY created_at DESC').all(projectId) as Record<string, unknown>[]).map(mapIteration);
    },
    archive(id) {
      db.prepare("UPDATE iterations SET status='archived' WHERE id=?").run(id);
    },
  };
}

export interface RequirementsRepo {
  insert(r: Requirement): void;
  get(id: string): Requirement | undefined;
  listByIteration(iterationId: string): Requirement[];
  update(r: Requirement): void;
  archive(id: string, at: number): void;
}
function requirementsRepo(db: DatabaseSync): RequirementsRepo {
  return {
    insert(r) {
      db.prepare(
        `INSERT INTO requirements(id,iteration_id,title,description,priority,acceptance,created_at,archived)
         VALUES(?,?,?,?,?,?,?,?)`,
      ).run(r.id, r.iterationId, r.title, r.description, r.priority, r.acceptance, r.createdAt, r.archived ? 1 : 0);
    },
    get(id) {
      const r = db.prepare('SELECT * FROM requirements WHERE id=?').get(id) as Record<string, unknown> | undefined;
      return r ? mapRequirement(r) : undefined;
    },
    listByIteration(iterationId) {
      return (db.prepare('SELECT * FROM requirements WHERE iteration_id=? ORDER BY created_at ASC').all(iterationId) as Record<string, unknown>[]).map(mapRequirement);
    },
    update(r) {
      db.prepare(
        `UPDATE requirements SET title=?,description=?,priority=?,acceptance=?,archived=? WHERE id=?`,
      ).run(r.title, r.description, r.priority, r.acceptance, r.archived ? 1 : 0, r.id);
    },
    archive(id, at) {
      db.prepare('UPDATE requirements SET archived=1, archived_at=? WHERE id=?').run(at, id);
    },
  };
}

export interface TasksRepo {
  insert(t: Task): void;
  get(id: string): Task | undefined;
  list(): Task[];
  listByIteration(iterationId: string): Task[];
  listByProject(projectId: string): Task[];
  listByRequirement(requirementId: string): Task[];
  listByStatus(status: TaskStatus): Task[];
  listRecoverable(): Task[];
  update(t: Task): void;
  updateStatus(id: string, status: TaskStatus, at: number): void;
  assignAgent(id: string, agentType: AgentType): void;
  setWorktree(id: string, path: string | undefined): void;
  incRetry(id: string): void;
  delete(id: string): void;
}
function tasksRepo(db: DatabaseSync): TasksRepo {
  return {
    insert(t) {
      db.prepare(
        `INSERT INTO tasks(id,requirement_id,iteration_id,project_id,title,description,status,agent_type,role,
           stages_json,current_stage,status_changed_at,created_at,updated_at,worktree_path,retry_count,paused_from,depends_on_json)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        t.id, t.requirementId, t.iterationId, t.projectId, t.title, t.description, t.status,
        t.agentType ?? null, t.role, JSON.stringify(t.stages), t.currentStage, t.statusChangedAt,
        t.createdAt, t.updatedAt, t.worktreePath ?? null, t.retryCount, t.pausedFrom ?? null,
        JSON.stringify(t.dependsOn ?? []),
      );
    },
    get(id) {
      const r = db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as Record<string, unknown> | undefined;
      return r ? mapTask(r) : undefined;
    },
    list() {
      return (db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC').all() as Record<string, unknown>[]).map(mapTask);
    },
    listByIteration(iterationId) {
      return (db.prepare('SELECT * FROM tasks WHERE iteration_id=? ORDER BY created_at ASC').all(iterationId) as Record<string, unknown>[]).map(mapTask);
    },
    listByProject(projectId) {
      return (db.prepare('SELECT * FROM tasks WHERE project_id=? ORDER BY updated_at DESC').all(projectId) as Record<string, unknown>[]).map(mapTask);
    },
    listByRequirement(requirementId) {
      return (db.prepare('SELECT * FROM tasks WHERE requirement_id=? ORDER BY created_at ASC').all(requirementId) as Record<string, unknown>[]).map(mapTask);
    },
    listByStatus(status) {
      return (db.prepare('SELECT * FROM tasks WHERE status=?').all(status) as Record<string, unknown>[]).map(mapTask);
    },
    listRecoverable() {
      return (db.prepare("SELECT * FROM tasks WHERE status IN ('in_progress','awaiting_input')").all() as Record<string, unknown>[]).map(mapTask);
    },
    update(t) {
      db.prepare(
        `UPDATE tasks SET title=?,description=?,status=?,agent_type=?,role=?,stages_json=?,current_stage=?,
           status_changed_at=?,updated_at=?,worktree_path=?,retry_count=?,paused_from=?,depends_on_json=? WHERE id=?`,
      ).run(
        t.title, t.description, t.status, t.agentType ?? null, t.role, JSON.stringify(t.stages),
        t.currentStage, t.statusChangedAt, t.updatedAt, t.worktreePath ?? null, t.retryCount, t.pausedFrom ?? null,
        JSON.stringify(t.dependsOn ?? []), t.id,
      );
    },
    updateStatus(id, status, at) {
      // 进入待沟通时记录来源状态（在原泳道以"待沟通"标识展示）；离开待沟通时清除。
      let pausedFrom: string | null = null;
      if (status === 'awaiting_input') {
        const cur = db.prepare('SELECT status FROM tasks WHERE id=?').get(id) as { status: string } | undefined;
        pausedFrom = cur?.status ?? null;
      }
      const extra = status === 'archived' ? ', archived_at=?' : '';
      const stmt = db.prepare(
        `UPDATE tasks SET status=?, status_changed_at=?, updated_at=?, paused_from=?${extra} WHERE id=?`,
      );
      if (status === 'archived') stmt.run(status, at, at, pausedFrom, at, id);
      else stmt.run(status, at, at, pausedFrom, id);
    },
    assignAgent(id, agentType) {
      db.prepare('UPDATE tasks SET agent_type=?, updated_at=? WHERE id=?').run(agentType, Date.now(), id);
    },
    setWorktree(id, path) {
      db.prepare('UPDATE tasks SET worktree_path=?, updated_at=? WHERE id=?').run(path ?? null, Date.now(), id);
    },
    incRetry(id) {
      db.prepare('UPDATE tasks SET retry_count=retry_count+1, updated_at=? WHERE id=?').run(Date.now(), id);
    },
    delete(id) {
      db.prepare('DELETE FROM tasks WHERE id=?').run(id);
    },
  };
}

export interface ExecutionsRepo {
  insert(e: ExecutionRecord): void;
  update(e: ExecutionRecord): void;
  listByTask(taskId: string): ExecutionRecord[];
  getLatest(taskId: string): ExecutionRecord | undefined;
}
function executionsRepo(db: DatabaseSync): ExecutionsRepo {
  return {
    insert(e) {
      db.prepare(
        `INSERT INTO execution_records(id,task_id,attempt,agent_type,started_at,ended_at,status,summary)
         VALUES(?,?,?,?,?,?,?,?)`,
      ).run(e.id, e.taskId, e.attempt, e.agentType, e.startedAt, e.endedAt ?? null, e.status, e.summary ?? null);
    },
    update(e) {
      db.prepare(
        `UPDATE execution_records SET attempt=?,ended_at=?,status=?,summary=? WHERE id=?`,
      ).run(e.attempt, e.endedAt ?? null, e.status, e.summary ?? null, e.id);
    },
    listByTask(taskId) {
      return (db.prepare('SELECT * FROM execution_records WHERE task_id=? ORDER BY started_at DESC').all(taskId) as Record<string, unknown>[]).map(mapExecution);
    },
    getLatest(taskId) {
      const r = db.prepare('SELECT * FROM execution_records WHERE task_id=? ORDER BY started_at DESC LIMIT 1').get(taskId) as Record<string, unknown> | undefined;
      return r ? mapExecution(r) : undefined;
    },
  };
}

export interface CheckpointsRepo {
  upsert(c: Checkpoint): void;
  getLatest(taskId: string): Checkpoint | undefined;
  listByTask(taskId: string): Checkpoint[];
}
function checkpointsRepo(db: DatabaseSync): CheckpointsRepo {
  return {
    upsert(c) {
      db.prepare(
        `INSERT INTO checkpoints(id,task_id,stage_id,stage_index,context,created_at)
         VALUES(?,?,?,?,?,?)`,
      ).run(c.id, c.taskId, c.stageId, c.stageIndex, c.context, c.createdAt);
    },
    getLatest(taskId) {
      const r = db.prepare('SELECT * FROM checkpoints WHERE task_id=? ORDER BY created_at DESC LIMIT 1').get(taskId) as Record<string, unknown> | undefined;
      return r ? mapCheckpoint(r) : undefined;
    },
    listByTask(taskId) {
      return (db.prepare('SELECT * FROM checkpoints WHERE task_id=? ORDER BY created_at ASC').all(taskId) as Record<string, unknown>[]).map(mapCheckpoint);
    },
  };
}

export interface LogsRepo {
  insert(l: LogEntry): void;
  listByTask(taskId: string, limit?: number): LogEntry[];
  listByExecution(executionId: string): LogEntry[];
}
function logsRepo(db: DatabaseSync): LogsRepo {
  return {
    insert(l) {
      db.prepare(
        `INSERT INTO log_entries(id,task_id,execution_id,level,text,t) VALUES(?,?,?,?,?,?)`,
      ).run(l.id, l.taskId, l.executionId, l.level, l.text, l.t);
    },
    listByTask(taskId, limit = 1000) {
      // 返回最近 N 条（而非最早的 N 条）：任务可能累积大量历史日志，
      // 用 ASC+LIMIT 会截断最近日志导致面板看不到最新进展。先 DESC 取最近 N 再反转为时间正序。
      return (db
        .prepare('SELECT * FROM (SELECT * FROM log_entries WHERE task_id=? ORDER BY t DESC LIMIT ?) ORDER BY t ASC')
        .all(taskId, limit) as Record<string, unknown>[]).map(mapLog);
    },
    listByExecution(executionId) {
      return (db.prepare('SELECT * FROM log_entries WHERE execution_id=? ORDER BY t ASC').all(executionId) as Record<string, unknown>[]).map(mapLog);
    },
  };
}

export interface PendingQuestionsRepo {
  upsert(q: PendingQuestion): void;
  get(taskId: string): PendingQuestion | undefined;
  answer(taskId: string, answer: string, at: number): void;
  delete(taskId: string): void;
}
function pendingQuestionsRepo(db: DatabaseSync): PendingQuestionsRepo {
  return {
    upsert(q) {
      db.prepare(
        `INSERT INTO pending_questions(task_id,question,context,asked_at,answered_at,answer)
         VALUES(?,?,?,?,?,?)
         ON CONFLICT(task_id) DO UPDATE SET question=excluded.question, context=excluded.context,
           asked_at=excluded.asked_at, answered_at=NULL, answer=NULL`,
      ).run(q.taskId, q.question, q.context, q.askedAt, null, null);
    },
    get(taskId) {
      const r = db.prepare('SELECT * FROM pending_questions WHERE task_id=?').get(taskId) as Record<string, unknown> | undefined;
      if (!r) return undefined;
      return {
        taskId: r.task_id as string,
        question: r.question as string,
        context: r.context as string,
        askedAt: r.asked_at as number,
        answeredAt: (r.answered_at as number | null) ?? undefined,
        answer: (r.answer as string | null) ?? undefined,
      };
    },
    answer(taskId, answer, at) {
      db.prepare('UPDATE pending_questions SET answer=?, answered_at=? WHERE task_id=?').run(answer, at, taskId);
    },
    delete(taskId) {
      db.prepare('DELETE FROM pending_questions WHERE task_id=?').run(taskId);
    },
  };
}

export interface NotificationRulesRepo {
  insert(r: NotificationRule): void;
  list(): NotificationRule[];
  listByProject(projectId: string): NotificationRule[];
  update(r: NotificationRule): void;
  delete(id: string): void;
}
function notificationRulesRepo(db: DatabaseSync): NotificationRulesRepo {
  return {
    insert(r) {
      db.prepare(
        `INSERT INTO notification_rules(id,project_id,status,minutes,channels_json,enabled)
         VALUES(?,?,?,?,?,?)`,
      ).run(r.id, r.projectId ?? null, r.status, r.minutes, JSON.stringify(r.channels), r.enabled ? 1 : 0);
    },
    list() {
      return (db.prepare('SELECT * FROM notification_rules').all() as Record<string, unknown>[]).map(mapNotificationRule);
    },
    listByProject(projectId) {
      return (db.prepare('SELECT * FROM notification_rules WHERE project_id IS NULL OR project_id=?').all(projectId) as Record<string, unknown>[]).map(mapNotificationRule);
    },
    update(r) {
      db.prepare('UPDATE notification_rules SET project_id=?,status=?,minutes=?,channels_json=?,enabled=? WHERE id=?').run(
        r.projectId ?? null, r.status, r.minutes, JSON.stringify(r.channels), r.enabled ? 1 : 0, r.id,
      );
    },
    delete(id) {
      db.prepare('DELETE FROM notification_rules WHERE id=?').run(id);
    },
  };
}

export interface NotificationDeliveriesRepo {
  insert(d: NotificationDelivery): void;
  exists(ruleId: string, taskId: string, channel: NotificationChannel): boolean;
  listByTask(taskId: string): NotificationDelivery[];
}
function notificationDeliveriesRepo(db: DatabaseSync): NotificationDeliveriesRepo {
  return {
    insert(d) {
      db.prepare(
        `INSERT INTO notification_deliveries(id,rule_id,task_id,channel,sent_at,status,detail)
         VALUES(?,?,?,?,?,?,?)`,
      ).run(d.id, d.ruleId, d.taskId, d.channel, d.sentAt, d.status, d.detail ?? null);
    },
    exists(ruleId, taskId, channel) {
      const r = db.prepare(
        'SELECT 1 AS x FROM notification_deliveries WHERE rule_id=? AND task_id=? AND channel=? LIMIT 1',
      ).get(ruleId, taskId, channel) as { x: number } | undefined;
      return !!r;
    },
    listByTask(taskId) {
      return (db.prepare('SELECT * FROM notification_deliveries WHERE task_id=? ORDER BY sent_at DESC').all(taskId) as Record<string, unknown>[]).map(mapNotificationDelivery);
    },
  };
}

export interface WebhookConfigsRepo {
  insert(w: WebhookConfig): void;
  get(id: string): WebhookConfig | undefined;
  list(): WebhookConfig[];
  update(w: WebhookConfig): void;
  delete(id: string): void;
}
function webhookConfigsRepo(db: DatabaseSync): WebhookConfigsRepo {
  return {
    insert(w) {
      db.prepare(
        `INSERT INTO webhook_configs(id,name,url,secret_enc,events_json,enabled,created_at)
         VALUES(?,?,?,?,?,?,?)`,
      ).run(w.id, w.name, w.url, w.secret, JSON.stringify(w.events), w.enabled ? 1 : 0, w.createdAt);
    },
    get(id) {
      const r = db.prepare('SELECT * FROM webhook_configs WHERE id=?').get(id) as Record<string, unknown> | undefined;
      return r ? mapWebhookConfig(r) : undefined;
    },
    list() {
      return (db.prepare('SELECT * FROM webhook_configs ORDER BY created_at DESC').all() as Record<string, unknown>[]).map(mapWebhookConfig);
    },
    update(w) {
      db.prepare('UPDATE webhook_configs SET name=?,url=?,secret_enc=?,events_json=?,enabled=? WHERE id=?').run(
        w.name, w.url, w.secret, JSON.stringify(w.events), w.enabled ? 1 : 0, w.id,
      );
    },
    delete(id) {
      db.prepare('DELETE FROM webhook_configs WHERE id=?').run(id);
    },
  };
}

export interface WebhookDeliveriesRepo {
  insert(d: WebhookDelivery): void;
  listByWebhook(webhookId: string, limit?: number): WebhookDelivery[];
}
function webhookDeliveriesRepo(db: DatabaseSync): WebhookDeliveriesRepo {
  return {
    insert(d) {
      db.prepare(
        `INSERT INTO webhook_deliveries(id,webhook_id,task_id,event,payload,status,attempt,sent_at,duration_ms,response_snippet,ok)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(d.id, d.webhookId, d.taskId ?? null, d.event, d.payload, d.status, d.attempt, d.sentAt, d.durationMs, d.responseSnippet ?? null, d.ok ? 1 : 0);
    },
    listByWebhook(webhookId, limit = 100) {
      return (db.prepare('SELECT * FROM webhook_deliveries WHERE webhook_id=? ORDER BY sent_at DESC LIMIT ?').all(webhookId, limit) as Record<string, unknown>[]).map(mapWebhookDelivery);
    },
  };
}

export interface CredentialsRepo {
  upsert(key: string, encryptedValue: string): void;
  get(key: string): string | undefined;
  delete(key: string): void;
}
function credentialsRepo(db: DatabaseSync): CredentialsRepo {
  return {
    upsert(key, encryptedValue) {
      db.prepare(
        'INSERT INTO credentials(key,value_enc,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_enc=excluded.value_enc, updated_at=excluded.updated_at',
      ).run(key, encryptedValue, Date.now());
    },
    get(key) {
      const r = db.prepare('SELECT value_enc FROM credentials WHERE key=?').get(key) as { value_enc: string } | undefined;
      return r?.value_enc;
    },
    delete(key) {
      db.prepare('DELETE FROM credentials WHERE key=?').run(key);
    },
  };
}

export interface TaskMessagesRepo {
  insert(m: TaskMessage): void;
  listByTask(taskId: string, limit?: number): TaskMessage[];
}
function taskMessagesRepo(db: DatabaseSync): TaskMessagesRepo {
  return {
    insert(m) {
      db.prepare(
        `INSERT INTO task_messages(id,task_id,execution_id,role,kind,text,tool_name,tool_use_id,tool_input,tool_result,is_error,t)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        m.id, m.taskId, m.executionId ?? null, m.role, m.kind, m.text ?? null,
        m.toolName ?? null, m.toolUseId ?? null, m.toolInput ?? null, m.toolResult ?? null,
        m.isError ? 1 : 0, m.t,
      );
    },
    listByTask(taskId, limit = 2000) {
      // 时间正序，截断最近 N 条（与 logs 一致策略：DESC 取最近 N 再反转为正序）。
      return (db
        .prepare('SELECT * FROM (SELECT * FROM task_messages WHERE task_id=? ORDER BY t DESC LIMIT ?) ORDER BY t ASC')
        .all(taskId, limit) as Record<string, unknown>[]).map(mapTaskMessage);
    },
  };
}

export interface PendingInteractionsRepo {
  insert(i: PendingInteraction): void;
  get(id: string): PendingInteraction | undefined;
  getPendingForTask(taskId: string): PendingInteraction | undefined;
  listByTask(taskId: string): PendingInteraction[];
  resolve(id: string, status: InteractionStatus, response: string | undefined, at: number): void;
  delete(id: string): void;
}
function pendingInteractionsRepo(db: DatabaseSync): PendingInteractionsRepo {
  return {
    insert(i) {
      db.prepare(
        `INSERT INTO pending_interactions(id,task_id,kind,message_id,title,detail,tool_name,tool_use_id,request_id,status,response,created_at,resolved_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        i.id, i.taskId, i.kind, i.messageId ?? null, i.title, i.detail ?? null,
        i.toolName ?? null, i.toolUseId ?? null, i.requestId ?? null, i.status, i.response ?? null,
        i.createdAt, i.resolvedAt ?? null,
      );
    },
    get(id) {
      const r = db.prepare('SELECT * FROM pending_interactions WHERE id=?').get(id) as Record<string, unknown> | undefined;
      return r ? mapPendingInteraction(r) : undefined;
    },
    getPendingForTask(taskId) {
      const r = db.prepare(
        "SELECT * FROM pending_interactions WHERE task_id=? AND status='pending' ORDER BY created_at ASC LIMIT 1",
      ).get(taskId) as Record<string, unknown> | undefined;
      return r ? mapPendingInteraction(r) : undefined;
    },
    listByTask(taskId) {
      return (db.prepare('SELECT * FROM pending_interactions WHERE task_id=? ORDER BY created_at ASC').all(taskId) as Record<string, unknown>[]).map(mapPendingInteraction);
    },
    resolve(id, status, response, at) {
      db.prepare('UPDATE pending_interactions SET status=?, response=?, resolved_at=? WHERE id=?').run(
        status, response ?? null, at, id,
      );
    },
    delete(id) {
      db.prepare('DELETE FROM pending_interactions WHERE id=?').run(id);
    },
  };
}

/** 事务快捷入口（从 repositories 访问）。 */
export { tx };
