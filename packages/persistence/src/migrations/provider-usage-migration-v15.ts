import type { Migration } from '../migrations.js';

export const PROVIDER_USAGE_MIGRATION_V15: Migration = {
  version: 15,
  description: 'provider usage analytics and daily retention rollups',
  sql: `
    CREATE TABLE provider_usage (
      id TEXT PRIMARY KEY,
      logical_request_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      provider_name TEXT NOT NULL,
      route_id TEXT NOT NULL,
      model TEXT,
      workload TEXT NOT NULL,
      source TEXT NOT NULL,
      execution_id TEXT,
      task_id TEXT,
      project_id TEXT,
      attempt_ordinal INTEGER NOT NULL,
      status TEXT NOT NULL,
      failure_kind TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      duration_ms INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      total_tokens INTEGER
    );
    CREATE INDEX idx_provider_usage_started ON provider_usage(started_at);
    CREATE INDEX idx_provider_usage_provider_started ON provider_usage(provider_id, started_at);
    CREATE INDEX idx_provider_usage_project_started ON provider_usage(project_id, started_at);
    CREATE INDEX idx_provider_usage_logical_request ON provider_usage(logical_request_id);

    CREATE TABLE provider_usage_daily (
      day TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      provider_name TEXT NOT NULL,
      model TEXT NOT NULL,
      project_id TEXT NOT NULL,
      workload TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      failure_kind TEXT NOT NULL,
      call_count INTEGER NOT NULL,
      duration_sum INTEGER NOT NULL,
      duration_count INTEGER NOT NULL,
      input_tokens_sum INTEGER NOT NULL,
      input_known_count INTEGER NOT NULL,
      output_tokens_sum INTEGER NOT NULL,
      output_known_count INTEGER NOT NULL,
      cache_read_tokens_sum INTEGER NOT NULL,
      cache_read_known_count INTEGER NOT NULL,
      cache_write_tokens_sum INTEGER NOT NULL,
      cache_write_known_count INTEGER NOT NULL,
      total_tokens_sum INTEGER NOT NULL,
      total_known_count INTEGER NOT NULL,
      PRIMARY KEY(day, provider_id, provider_name, model, project_id, workload, source, status, failure_kind)
    );

    CREATE TABLE logical_request_daily (
      day TEXT NOT NULL,
      logical_request_id TEXT NOT NULL,
      grain TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      provider_name TEXT NOT NULL,
      model TEXT NOT NULL,
      project_id TEXT NOT NULL,
      workload TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      failure_kind TEXT NOT NULL,
      PRIMARY KEY(day, logical_request_id, grain, provider_id, provider_name, model, project_id, workload, source, status, failure_kind)
    );
    CREATE INDEX idx_logical_request_daily_day ON logical_request_daily(day);
    CREATE INDEX idx_logical_request_daily_provider_day ON logical_request_daily(provider_id, day);

    INSERT OR IGNORE INTO provider_usage(
      id, logical_request_id, provider_id, provider_name, route_id, model,
      workload, source, execution_id, task_id, project_id, attempt_ordinal,
      status, failure_kind, started_at, ended_at, duration_ms,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens
    )
    SELECT
      'legacy:' || a.id,
      a.execution_id,
      CASE WHEN instr(a.route_id, ':') > 0 THEN substr(a.route_id, 1, instr(a.route_id, ':') - 1) ELSE a.route_id END,
      CASE WHEN instr(a.route_id, ':') > 0 THEN substr(a.route_id, 1, instr(a.route_id, ':') - 1) ELSE a.route_id END,
      a.route_id,
      NULL,
      CASE WHEN instr(a.route_id, ':') > 0 THEN substr(a.route_id, instr(a.route_id, ':') + 1) ELSE 'unknown' END,
      CASE
        WHEN a.route_id LIKE '%:test' THEN 'review_agent'
        WHEN a.route_id LIKE '%:project_lead' THEN 'knowledge_agent'
        ELSE 'task_agent'
      END,
      a.execution_id,
      e.task_id,
      t.project_id,
      a.ordinal,
      CASE a.state
        WHEN 'running' THEN 'running'
        WHEN 'succeeded' THEN 'succeeded'
        WHEN 'canceled' THEN 'canceled'
        ELSE 'failed'
      END,
      NULL,
      a.started_at,
      a.ended_at,
      CASE WHEN a.ended_at IS NULL THEN NULL ELSE MAX(0, a.ended_at - a.started_at) END,
      NULL, NULL, NULL, NULL, NULL
    FROM execution_attempts a
    LEFT JOIN execution_records e ON e.id = a.execution_id
    LEFT JOIN tasks t ON t.id = e.task_id;
  `,
};
