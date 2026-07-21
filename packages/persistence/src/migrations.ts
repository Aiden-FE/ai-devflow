// 版本化迁移。每个迁移是一段幂等 DDL（IF NOT EXISTS），按顺序执行并记录版本号。

export interface Migration {
  version: number;
  description: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'initial schema',
    sql: `
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        settings_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS iterations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_iterations_project ON iterations(project_id);

      CREATE TABLE IF NOT EXISTS requirements (
        id TEXT PRIMARY KEY,
        iteration_id TEXT NOT NULL REFERENCES iterations(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        priority TEXT NOT NULL DEFAULT 'medium',
        acceptance TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_requirements_iteration ON requirements(iteration_id);

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
        iteration_id TEXT NOT NULL REFERENCES iterations(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'backlog',
        agent_type TEXT,
        role TEXT NOT NULL DEFAULT 'coder',
        stages_json TEXT NOT NULL DEFAULT '[]',
        current_stage INTEGER NOT NULL DEFAULT 0,
        status_changed_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        worktree_path TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_iteration ON tasks(iteration_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

      CREATE TABLE IF NOT EXISTS execution_records (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        attempt INTEGER NOT NULL,
        agent_type TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        status TEXT NOT NULL DEFAULT 'running',
        summary TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_exec_task ON execution_records(task_id);

      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        stage_id TEXT NOT NULL,
        stage_index INTEGER NOT NULL,
        context TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_checkpoints_task ON checkpoints(task_id);

      CREATE TABLE IF NOT EXISTS log_entries (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        execution_id TEXT NOT NULL REFERENCES execution_records(id) ON DELETE CASCADE,
        level TEXT NOT NULL DEFAULT 'info',
        text TEXT NOT NULL,
        t INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_logs_task ON log_entries(task_id);
      CREATE INDEX IF NOT EXISTS idx_logs_exec ON log_entries(execution_id);

      CREATE TABLE IF NOT EXISTS pending_questions (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        question TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '',
        asked_at INTEGER NOT NULL,
        answered_at INTEGER,
        answer TEXT
      );

      CREATE TABLE IF NOT EXISTS notification_rules (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        status TEXT NOT NULL,
        minutes INTEGER NOT NULL,
        channels_json TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS notification_deliveries (
        id TEXT PRIMARY KEY,
        rule_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        sent_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_notif_deliv_rule_task ON notification_deliveries(rule_id, task_id);

      CREATE TABLE IF NOT EXISTS webhook_configs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        secret_enc TEXT NOT NULL,
        events_json TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id TEXT PRIMARY KEY,
        webhook_id TEXT NOT NULL REFERENCES webhook_configs(id) ON DELETE CASCADE,
        task_id TEXT,
        event TEXT NOT NULL,
        payload TEXT NOT NULL,
        status INTEGER NOT NULL,
        attempt INTEGER NOT NULL,
        sent_at INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        response_snippet TEXT,
        ok INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_webhook_deliv ON webhook_deliveries(webhook_id);

      CREATE TABLE IF NOT EXISTS credentials (
        key TEXT PRIMARY KEY,
        value_enc TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 2,
    description: 'add archived_at for traceability',
    sql: `
      ALTER TABLE tasks ADD COLUMN archived_at INTEGER;
    `,
  },
  {
    version: 3,
    description: 'requirement archive + task paused_from (待沟通暂停来源)',
    sql: `
      ALTER TABLE requirements ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE requirements ADD COLUMN archived_at INTEGER;
      ALTER TABLE tasks ADD COLUMN paused_from TEXT;
    `,
  },
  {
    version: 4,
    description: 'task serial dependencies (depends_on)',
    sql: `
      ALTER TABLE tasks ADD COLUMN depends_on_json TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    version: 5,
    description: 'purge legacy thinking_tokens log spam (suppressed in parser since)',
    sql: `
      DELETE FROM log_entries WHERE text = 'system: thinking_tokens';
    `,
  },
];
