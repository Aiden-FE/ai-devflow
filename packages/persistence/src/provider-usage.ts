import { randomUUID } from 'node:crypto';
import type {
  ProviderCallFinish,
  ProviderCallRecord,
  ProviderCallStart,
  TokenUsage,
  UsageAnalytics,
  UsageBreakdown,
  UsageFilters,
  UsageMetric,
  UsageTimeBucket,
} from '@ai-devflow/core';
import type { DatabaseSync } from './db.js';
import { tx } from './tx.js';

export interface ProviderUsageRepo {
  start(input: ProviderCallStart): ProviderCallRecord;
  finish(id: string, input: ProviderCallFinish): void;
  recoverInterrupted(at: number): number;
  query(filters: UsageFilters): UsageAnalytics;
  rollupAndPrune(before: number, batchSize: number): { rolledUp: number; deleted: number };
}

type SqlValue = string | number | null;

interface AttemptAggregateRow {
  bucket_key: string;
  bucket_label: string;
  provider_calls: number;
  succeeded: number;
  failed: number;
  canceled: number;
  interrupted: number;
  duration_sum: number;
  duration_count: number;
  input_sum: number;
  input_known: number;
  output_sum: number;
  output_known: number;
  cache_read_sum: number;
  cache_read_known: number;
  cache_write_sum: number;
  cache_write_known: number;
  total_sum: number;
  total_known: number;
}

interface UsageRawRow {
  id: string;
  logical_request_id: string;
  provider_id: string;
  provider_name: string;
  model: string | null;
  project_id: string | null;
  workload: string;
  source: string;
  status: string;
  failure_kind: string | null;
  started_at: number;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  total_tokens: number | null;
}

const EMPTY_USAGE: TokenUsage = {
  input: null,
  output: null,
  cacheRead: null,
  cacheWrite: null,
  total: null,
};

const FILTER_COLUMNS: ReadonlyArray<[keyof Omit<UsageFilters, 'startAt' | 'endAt'>, string]> = [
  ['projectId', 'project_id'],
  ['providerId', 'provider_id'],
  ['model', 'model'],
  ['workload', 'workload'],
  ['source', 'source'],
  ['status', 'status'],
];

function assertInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} 必须是非负整数`);
}

function validateUsage(usage: TokenUsage): void {
  for (const [key, value] of Object.entries(usage)) {
    if (value !== null) assertInteger(value, `Token ${key}`);
  }
}

function dayOf(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function normalized(value: string | null | undefined): string {
  return value ?? '';
}

function filterSql(filters: UsageFilters, alias: string, daily: boolean): { sql: string; values: SqlValue[] } {
  const clauses: string[] = [];
  const values: SqlValue[] = [];
  if (daily) {
    clauses.push(`${alias}.day >= ?`, `${alias}.day <= ?`);
    values.push(dayOf(filters.startAt), dayOf(Math.max(filters.startAt, filters.endAt - 1)));
  } else {
    clauses.push(`${alias}.started_at >= ?`, `${alias}.started_at < ?`);
    values.push(filters.startAt, filters.endAt);
  }
  for (const [key, column] of FILTER_COLUMNS) {
    const value = filters[key];
    if (value !== undefined) {
      clauses.push(`${alias}.${column} = ?`);
      values.push(value);
    }
  }
  return { sql: clauses.join(' AND '), values };
}

function metric(row: AttemptAggregateRow | undefined, logicalRequests: number): UsageMetric {
  const calls = row?.provider_calls ?? 0;
  const tokenKnownCalls = row?.total_known ?? 0;
  return {
    providerCalls: calls,
    logicalRequests,
    succeeded: row?.succeeded ?? 0,
    failed: row?.failed ?? 0,
    canceled: row?.canceled ?? 0,
    interrupted: row?.interrupted ?? 0,
    averageDurationMs: row && row.duration_count > 0 ? row.duration_sum / row.duration_count : null,
    tokens: {
      input: row && row.input_known > 0 ? row.input_sum : null,
      output: row && row.output_known > 0 ? row.output_sum : null,
      cacheRead: row && row.cache_read_known > 0 ? row.cache_read_sum : null,
      cacheWrite: row && row.cache_write_known > 0 ? row.cache_write_sum : null,
      total: row && row.total_known > 0 ? row.total_sum : null,
    },
    tokenKnownCalls,
    tokenCoverage: calls > 0 ? tokenKnownCalls / calls : 0,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUNTIME_NAME = /^ai-devflow-[0-9a-f]+$/i;

function isInternalSnapshot(providerId: string, value: string): boolean {
  const name = value.trim();
  return !name || name === providerId || UUID.test(name) || RUNTIME_NAME.test(name);
}

function preferredSnapshot(providerId: string, values: readonly string[]): string {
  return values.map((value) => value.trim()).find((value) => !isInternalSnapshot(providerId, value))
    ?? values.map((value) => value.trim()).find(Boolean)
    ?? providerId;
}

function aggregateSelect(groupExpression: string, labelExpression: string): string {
  return `
    SELECT ${groupExpression} AS bucket_key, ${labelExpression} AS bucket_label,
      SUM(call_count) AS provider_calls,
      SUM(CASE WHEN status='succeeded' THEN call_count ELSE 0 END) AS succeeded,
      SUM(CASE WHEN status='failed' THEN call_count ELSE 0 END) AS failed,
      SUM(CASE WHEN status='canceled' THEN call_count ELSE 0 END) AS canceled,
      SUM(CASE WHEN status='interrupted' THEN call_count ELSE 0 END) AS interrupted,
      SUM(duration_sum) AS duration_sum, SUM(duration_count) AS duration_count,
      SUM(input_sum) AS input_sum, SUM(input_known) AS input_known,
      SUM(output_sum) AS output_sum, SUM(output_known) AS output_known,
      SUM(cache_read_sum) AS cache_read_sum, SUM(cache_read_known) AS cache_read_known,
      SUM(cache_write_sum) AS cache_write_sum, SUM(cache_write_known) AS cache_write_known,
      SUM(total_sum) AS total_sum, SUM(total_known) AS total_known
    FROM attempts GROUP BY ${groupExpression}, ${labelExpression}
  `;
}

function attemptCte(filters: UsageFilters): { sql: string; values: SqlValue[] } {
  const raw = filterSql(filters, 'u', false);
  const daily = filterSql(filters, 'd', true);
  return {
    sql: `WITH attempts AS (
      SELECT date(u.started_at / 1000, 'unixepoch') AS day,
        u.provider_id, u.provider_name, COALESCE(u.model, '') AS model,
        COALESCE(u.project_id, '') AS project_id, u.workload, u.source, u.status,
        COALESCE(u.failure_kind, '') AS failure_kind, 1 AS call_count,
        COALESCE(u.duration_ms, 0) AS duration_sum,
        CASE WHEN u.duration_ms IS NULL THEN 0 ELSE 1 END AS duration_count,
        COALESCE(u.input_tokens, 0) AS input_sum, CASE WHEN u.input_tokens IS NULL THEN 0 ELSE 1 END AS input_known,
        COALESCE(u.output_tokens, 0) AS output_sum, CASE WHEN u.output_tokens IS NULL THEN 0 ELSE 1 END AS output_known,
        COALESCE(u.cache_read_tokens, 0) AS cache_read_sum, CASE WHEN u.cache_read_tokens IS NULL THEN 0 ELSE 1 END AS cache_read_known,
        COALESCE(u.cache_write_tokens, 0) AS cache_write_sum, CASE WHEN u.cache_write_tokens IS NULL THEN 0 ELSE 1 END AS cache_write_known,
        COALESCE(u.total_tokens, 0) AS total_sum, CASE WHEN u.total_tokens IS NULL THEN 0 ELSE 1 END AS total_known
      FROM provider_usage u WHERE ${raw.sql}
      UNION ALL
      SELECT d.day, d.provider_id, d.provider_name, d.model, d.project_id, d.workload, d.source, d.status,
        d.failure_kind, d.call_count, d.duration_sum, d.duration_count,
        d.input_tokens_sum, d.input_known_count, d.output_tokens_sum, d.output_known_count,
        d.cache_read_tokens_sum, d.cache_read_known_count, d.cache_write_tokens_sum, d.cache_write_known_count,
        d.total_tokens_sum, d.total_known_count
      FROM provider_usage_daily d WHERE ${daily.sql}
    )`,
    values: [...raw.values, ...daily.values],
  };
}

function logicalCounts(
  db: DatabaseSync,
  filters: UsageFilters,
  groupColumn?: 'provider_id' | 'model' | 'project_id' | 'workload' | 'source' | 'status' | 'failure_kind' | 'day',
): Map<string, number> {
  const raw = filterSql(filters, 'u', false);
  const daily = filterSql(filters, 'l', true);
  const grain = filters.providerId !== undefined || groupColumn === 'provider_id' ? 'provider' : 'global';
  const expression = groupColumn === 'day'
    ? "date(started_at / 1000, 'unixepoch')"
    : groupColumn ? `COALESCE(${groupColumn}, '')` : "''";
  const dailyExpression = groupColumn === 'day' ? 'day' : groupColumn ? `COALESCE(${groupColumn}, '')` : "''";
  const rows = db.prepare(`
    WITH memberships AS (
      SELECT u.logical_request_id, ${expression} AS bucket_key FROM provider_usage u WHERE ${raw.sql}
      UNION ALL
      SELECT l.logical_request_id, ${dailyExpression} AS bucket_key
      FROM logical_request_daily l WHERE l.grain=? AND ${daily.sql}
    )
    SELECT bucket_key, COUNT(DISTINCT logical_request_id) AS count
    FROM memberships GROUP BY bucket_key
  `).all(...raw.values, grain, ...daily.values) as Array<{ bucket_key: string; count: number }>;
  return new Map(rows.map((row) => [row.bucket_key, row.count]));
}

function queryRows(
  db: DatabaseSync,
  filters: UsageFilters,
  groupColumn?: 'provider_id' | 'model' | 'project_id' | 'workload' | 'source' | 'failure_kind' | 'day',
): AttemptAggregateRow[] {
  const cte = attemptCte(filters);
  const key = groupColumn ?? "''";
  const label = groupColumn === 'provider_id' ? 'provider_name' : key;
  return db.prepare(`${cte.sql} ${aggregateSelect(key, label)} ORDER BY bucket_key`).all(...cte.values) as unknown as AttemptAggregateRow[];
}

function providerBreakdowns(db: DatabaseSync, filters: UsageFilters): UsageBreakdown[] {
  const cte = attemptCte(filters);
  const aggregateRows = db.prepare(`${cte.sql}
    SELECT provider_id AS bucket_key, '' AS bucket_label,
      SUM(call_count) AS provider_calls,
      SUM(CASE WHEN status='succeeded' THEN call_count ELSE 0 END) AS succeeded,
      SUM(CASE WHEN status='failed' THEN call_count ELSE 0 END) AS failed,
      SUM(CASE WHEN status='canceled' THEN call_count ELSE 0 END) AS canceled,
      SUM(CASE WHEN status='interrupted' THEN call_count ELSE 0 END) AS interrupted,
      SUM(duration_sum) AS duration_sum, SUM(duration_count) AS duration_count,
      SUM(input_sum) AS input_sum, SUM(input_known) AS input_known,
      SUM(output_sum) AS output_sum, SUM(output_known) AS output_known,
      SUM(cache_read_sum) AS cache_read_sum, SUM(cache_read_known) AS cache_read_known,
      SUM(cache_write_sum) AS cache_write_sum, SUM(cache_write_known) AS cache_write_known,
      SUM(total_sum) AS total_sum, SUM(total_known) AS total_known
    FROM attempts GROUP BY provider_id ORDER BY provider_id
  `).all(...cte.values) as unknown as AttemptAggregateRow[];
  const snapshotRows = db.prepare(`${cte.sql}
    SELECT provider_id, provider_name FROM attempts
  `).all(...cte.values) as Array<{ provider_id: string; provider_name: string }>;
  const snapshots = new Map<string, string[]>();
  for (const row of snapshotRows) {
    const list = snapshots.get(row.provider_id);
    if (list) list.push(row.provider_name);
    else snapshots.set(row.provider_id, [row.provider_name]);
  }
  const counts = logicalCounts(db, filters, 'provider_id');
  return aggregateRows.map((row) => ({
    key: row.bucket_key,
    label: preferredSnapshot(row.bucket_key, snapshots.get(row.bucket_key) ?? []),
    ...metric(row, counts.get(row.bucket_key) ?? 0),
  }));
}

function toBreakdowns(
  db: DatabaseSync,
  filters: UsageFilters,
  column: 'provider_id' | 'model' | 'project_id' | 'workload' | 'source' | 'failure_kind',
): UsageBreakdown[] {
  if (column === 'provider_id') return providerBreakdowns(db, filters);
  const counts = logicalCounts(db, filters, column);
  return queryRows(db, filters, column).map((row) => ({
    key: row.bucket_key,
    label: row.bucket_label || '未知',
    ...metric(row, counts.get(row.bucket_key) ?? 0),
  }));
}

export function createProviderUsageRepo(db: DatabaseSync): ProviderUsageRepo {
  return {
    start(input) {
      assertInteger(input.startedAt, 'startedAt');
      assertInteger(input.attemptOrdinal, 'attemptOrdinal');
      const id = randomUUID();
      db.prepare(`
        INSERT INTO provider_usage(
          id, logical_request_id, provider_id, provider_name, route_id, model, workload, source,
          execution_id, task_id, project_id, attempt_ordinal, status, started_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        id, input.logicalRequestId, input.providerId, input.providerName, input.routeId, input.model,
        input.workload, input.source, input.executionId ?? null, input.taskId ?? null,
        input.projectId ?? null, input.attemptOrdinal, 'running', input.startedAt,
      );
      return { ...input, id, status: 'running', usage: { ...EMPTY_USAGE } };
    },

    finish(id, input) {
      assertInteger(input.endedAt, 'endedAt');
      validateUsage(input.usage);
      const started = db.prepare("SELECT started_at FROM provider_usage WHERE id=? AND status='running'")
        .get(id) as { started_at: number } | undefined;
      if (!started) throw new Error(`提供商调用不存在或已结束: ${id}`);
      const result = db.prepare(`
        UPDATE provider_usage SET status=?, failure_kind=?, ended_at=?, duration_ms=?,
          input_tokens=?, output_tokens=?, cache_read_tokens=?, cache_write_tokens=?, total_tokens=?
        WHERE id=? AND status='running'
      `).run(
        input.status, input.failureKind ?? null, input.endedAt, Math.max(0, input.endedAt - started.started_at),
        input.usage.input, input.usage.output, input.usage.cacheRead, input.usage.cacheWrite,
        input.usage.total, id,
      );
      if (Number(result.changes) !== 1) throw new Error(`提供商调用不存在或已结束: ${id}`);
    },

    recoverInterrupted(at) {
      assertInteger(at, '恢复时间');
      const result = db.prepare(`
        UPDATE provider_usage SET status='interrupted', ended_at=?,
          duration_ms=MAX(0, ? - started_at) WHERE status='running'
      `).run(at, at);
      return Number(result.changes);
    },

    query(filters) {
      if (!Number.isSafeInteger(filters.startAt) || !Number.isSafeInteger(filters.endAt) || filters.endAt <= filters.startAt) {
        throw new Error('统计时间范围无效');
      }
      const summaryRow = queryRows(db, filters)[0];
      const summaryCounts = logicalCounts(db, filters);
      const timeCounts = logicalCounts(db, filters, 'day');
      const timeBuckets: UsageTimeBucket[] = queryRows(db, filters, 'day').map((row) => ({
        day: row.bucket_key,
        ...metric(row, timeCounts.get(row.bucket_key) ?? 0),
      }));
      const raw = filterSql(filters, 'u', false);
      const latestFailures = db.prepare(`
        SELECT id, provider_id, provider_name, model, COALESCE(failure_kind, 'unknown') AS failure_kind, started_at
        FROM provider_usage u WHERE ${raw.sql} AND u.status='failed'
        ORDER BY u.started_at DESC LIMIT 20
      `).all(...raw.values) as Array<{
        id: string; provider_id: string; provider_name: string; model: string | null;
        failure_kind: string; started_at: number;
      }>;
      return {
        filters: { ...filters },
        summary: metric(summaryRow, summaryCounts.get('') ?? 0),
        timeBuckets,
        providers: toBreakdowns(db, filters, 'provider_id'),
        models: toBreakdowns(db, filters, 'model'),
        projects: toBreakdowns(db, filters, 'project_id'),
        workloads: toBreakdowns(db, filters, 'workload'),
        sources: toBreakdowns(db, filters, 'source'),
        failures: toBreakdowns(db, filters, 'failure_kind'),
        latestFailures: latestFailures.map((row) => ({
          id: row.id,
          providerId: row.provider_id,
          providerName: row.provider_name,
          model: row.model,
          failureKind: row.failure_kind,
          startedAt: row.started_at,
        })),
      };
    },

    rollupAndPrune(before, batchSize) {
      assertInteger(before, '清理时间');
      if (!Number.isSafeInteger(batchSize) || batchSize <= 0) throw new Error('清理批量必须是正整数');
      return tx(db, () => {
        const rows = db.prepare(`
          SELECT * FROM provider_usage
          WHERE started_at < ? AND status != 'running'
          ORDER BY started_at, id LIMIT ?
        `).all(before, batchSize) as unknown as UsageRawRow[];
        if (rows.length === 0) return { rolledUp: 0, deleted: 0 };

        const upsertDaily = db.prepare(`
          INSERT INTO provider_usage_daily(
            day, provider_id, provider_name, model, project_id, workload, source, status, failure_kind,
            call_count, duration_sum, duration_count, input_tokens_sum, input_known_count,
            output_tokens_sum, output_known_count, cache_read_tokens_sum, cache_read_known_count,
            cache_write_tokens_sum, cache_write_known_count, total_tokens_sum, total_known_count
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT DO UPDATE SET
            call_count=call_count+excluded.call_count,
            duration_sum=duration_sum+excluded.duration_sum,
            duration_count=duration_count+excluded.duration_count,
            input_tokens_sum=input_tokens_sum+excluded.input_tokens_sum,
            input_known_count=input_known_count+excluded.input_known_count,
            output_tokens_sum=output_tokens_sum+excluded.output_tokens_sum,
            output_known_count=output_known_count+excluded.output_known_count,
            cache_read_tokens_sum=cache_read_tokens_sum+excluded.cache_read_tokens_sum,
            cache_read_known_count=cache_read_known_count+excluded.cache_read_known_count,
            cache_write_tokens_sum=cache_write_tokens_sum+excluded.cache_write_tokens_sum,
            cache_write_known_count=cache_write_known_count+excluded.cache_write_known_count,
            total_tokens_sum=total_tokens_sum+excluded.total_tokens_sum,
            total_known_count=total_known_count+excluded.total_known_count
        `);
        const insertMembership = db.prepare(`
          INSERT OR IGNORE INTO logical_request_daily(
            day, logical_request_id, grain, provider_id, provider_name, model, project_id,
            workload, source, status, failure_kind
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
        `);

        for (const row of rows) {
          const day = dayOf(row.started_at);
          const model = normalized(row.model);
          const project = normalized(row.project_id);
          const failure = normalized(row.failure_kind);
          upsertDaily.run(
            day, row.provider_id, row.provider_name, model, project, row.workload, row.source, row.status, failure,
            1, row.duration_ms ?? 0, row.duration_ms === null ? 0 : 1,
            row.input_tokens ?? 0, row.input_tokens === null ? 0 : 1,
            row.output_tokens ?? 0, row.output_tokens === null ? 0 : 1,
            row.cache_read_tokens ?? 0, row.cache_read_tokens === null ? 0 : 1,
            row.cache_write_tokens ?? 0, row.cache_write_tokens === null ? 0 : 1,
            row.total_tokens ?? 0, row.total_tokens === null ? 0 : 1,
          );
          insertMembership.run(
            day, row.logical_request_id, 'global', '', '', model, project,
            row.workload, row.source, row.status, failure,
          );
          insertMembership.run(
            day, row.logical_request_id, 'provider', row.provider_id, row.provider_name, model, project,
            row.workload, row.source, row.status, failure,
          );
        }

        const placeholders = rows.map(() => '?').join(',');
        const deleted = db.prepare(`DELETE FROM provider_usage WHERE id IN (${placeholders})`)
          .run(...rows.map((row) => row.id));
        return { rolledUp: rows.length, deleted: Number(deleted.changes) };
      });
    },
  };
}
