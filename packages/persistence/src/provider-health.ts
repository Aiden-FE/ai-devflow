// 路线健康状态持久化仓储（设计 §9.3）。
// 结构化满足 agents 包 ProviderRouter 的 ProviderHealthStore 接口（Task 9 由 Electron 注入）。
import type { ProviderHealth, FailureKind } from '@ai-devflow/core';
import type { DatabaseSync } from './db.js';

export interface ProviderHealthRepo {
  get(providerId: string, routeId: string): ProviderHealth | undefined;
  listByProvider(providerId: string): ProviderHealth[];
  upsert(value: ProviderHealth): void;
  clearProvider(providerId: string): void;
}

function mapHealth(r: Record<string, unknown>): ProviderHealth {
  return {
    providerId: r.provider_id as string,
    routeId: r.route_id as string,
    state: r.state as ProviderHealth['state'],
    consecutiveFailures: r.consecutive_failures as number,
    cooldownUntil: (r.cooldown_until as number | null) ?? undefined,
    lastFailureKind: (r.last_failure_kind as FailureKind | null) ?? undefined,
    updatedAt: r.updated_at as number,
  };
}

export function createProviderHealthRepo(db: DatabaseSync): ProviderHealthRepo {
  return {
    get(providerId, routeId) {
      const r = db
        .prepare('SELECT * FROM provider_health WHERE provider_id=? AND route_id=?')
        .get(providerId, routeId) as Record<string, unknown> | undefined;
      return r ? mapHealth(r) : undefined;
    },
    listByProvider(providerId) {
      return (
        db.prepare('SELECT * FROM provider_health WHERE provider_id=?').all(providerId) as Record<string, unknown>[]
      ).map(mapHealth);
    },
    upsert(value) {
      db.prepare(
        `INSERT INTO provider_health(provider_id,route_id,state,consecutive_failures,cooldown_until,last_failure_kind,updated_at)
         VALUES(?,?,?,?,?,?,?)
         ON CONFLICT(provider_id,route_id) DO UPDATE SET state=excluded.state,
           consecutive_failures=excluded.consecutive_failures, cooldown_until=excluded.cooldown_until,
           last_failure_kind=excluded.last_failure_kind, updated_at=excluded.updated_at`,
      ).run(
        value.providerId, value.routeId, value.state, value.consecutiveFailures,
        value.cooldownUntil ?? null, value.lastFailureKind ?? null, value.updatedAt,
      );
    },
    clearProvider(providerId) {
      db.prepare('DELETE FROM provider_health WHERE provider_id=?').run(providerId);
    },
  };
}
