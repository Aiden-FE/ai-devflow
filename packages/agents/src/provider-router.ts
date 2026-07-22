// ProviderRouter：有序提供商路由 + 熔断/降级（设计 §9）。
//
// - 候选顺序：当前 workload 在提供商 N 的 primary → fallback → 提供商 N+1 …
// - 禁用/无凭证/无该 workload 模型映射/仍处熔断冷却的路线不进入本轮候选；
//   若全部路线都在冷却，仅选最早到期的一条做 half-open 探测（禁止忙循环）。
// - 故障分类驱动熔断：authentication/model_unavailable 开到 revision 变更；rate_limit 用 Retry-After
//   或指数冷却并立即降级；transient/runtime/protocol 当前路线重试一次再冷却降级。
// - 总尝试上限 8 次 operation 调用。Pi 自身 retry 关闭，重试只由本路由控制（§7.5/§9.4）。
//
// ProviderHealthStore 结构化依赖（不 import persistence）；Task 9 由 Electron 注入持久化仓储。
import { createHash } from 'node:crypto';
import type { FailureKind, ProviderConfig, ProviderHealth, ProviderKind, Workload } from '@ai-devflow/core';

export interface ModelChoice {
  model: string;
  thinking: 'low' | 'medium' | 'high' | 'xhigh';
}

export interface ProviderRoute {
  providerId: string;
  providerRevision: number;
  providerKind: ProviderKind;
  /** 传给 Pi 的 provider 名（标准提供商为 catalog 名；兼容网关为生成的 ai-devflow-<hash>）。 */
  providerName: string;
  routeId: string;
  model: string;
  /** 当前 workload 在该提供商下的完整 primary/fallback 模型集合。 */
  models: string[];
  thinking: ModelChoice['thinking'];
  baseURL?: string;
  secret: string;
}

/** 路线执行错误：携带故障分类、HTTP 状态与可选 Retry-After。 */
export class ProviderExecutionError extends Error {
  constructor(
    message: string,
    readonly kind: FailureKind,
    readonly status = 0,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ProviderExecutionError';
  }
}

export interface ProviderHealthStore {
  get(providerId: string, routeId: string): ProviderHealth | undefined;
  listByProvider(providerId: string): ProviderHealth[];
  upsert(value: ProviderHealth): void;
  clearProvider(providerId: string): void;
}

// ---- 内置模型表（设计 §7.2，逐字固定；升级需经真实提供商发布验证） ----

type RoleKey = 'planner' | 'coder' | 'reviewer' | 'tester';
type BaseKind = 'anthropic' | 'openai' | 'google' | 'deepseek' | 'openrouter';

interface ModelRoute {
  primary: ModelChoice;
  fallback?: ModelChoice;
}

const MODEL_TABLE: Record<BaseKind, Record<RoleKey, ModelRoute>> = {
  anthropic: {
    planner: { primary: { model: 'claude-sonnet-5', thinking: 'high' }, fallback: { model: 'claude-sonnet-4-6', thinking: 'high' } },
    coder: { primary: { model: 'claude-sonnet-5', thinking: 'xhigh' }, fallback: { model: 'claude-sonnet-4-6', thinking: 'high' } },
    reviewer: { primary: { model: 'claude-sonnet-5', thinking: 'high' }, fallback: { model: 'claude-sonnet-4-6', thinking: 'high' } },
    tester: { primary: { model: 'claude-sonnet-4-6', thinking: 'medium' }, fallback: { model: 'claude-sonnet-4-5', thinking: 'medium' } },
  },
  openai: {
    planner: { primary: { model: 'gpt-5.6-terra', thinking: 'high' }, fallback: { model: 'gpt-5.4', thinking: 'high' } },
    coder: { primary: { model: 'gpt-5.6-sol', thinking: 'xhigh' }, fallback: { model: 'gpt-5.6-terra', thinking: 'high' } },
    reviewer: { primary: { model: 'gpt-5.6-terra', thinking: 'high' }, fallback: { model: 'gpt-5.4', thinking: 'high' } },
    tester: { primary: { model: 'gpt-5.6-luna', thinking: 'medium' }, fallback: { model: 'gpt-5.4-mini', thinking: 'medium' } },
  },
  google: {
    planner: { primary: { model: 'gemini-3.1-pro-preview', thinking: 'high' }, fallback: { model: 'gemini-2.5-pro', thinking: 'high' } },
    coder: { primary: { model: 'gemini-3.1-pro-preview', thinking: 'high' }, fallback: { model: 'gemini-2.5-pro', thinking: 'high' } },
    reviewer: { primary: { model: 'gemini-3.1-pro-preview', thinking: 'high' }, fallback: { model: 'gemini-2.5-pro', thinking: 'medium' } },
    tester: { primary: { model: 'gemini-3.5-flash', thinking: 'medium' }, fallback: { model: 'gemini-2.5-flash', thinking: 'medium' } },
  },
  deepseek: {
    planner: { primary: { model: 'deepseek-v4-pro', thinking: 'high' }, fallback: { model: 'deepseek-v4-flash', thinking: 'medium' } },
    coder: { primary: { model: 'deepseek-v4-pro', thinking: 'high' }, fallback: { model: 'deepseek-v4-flash', thinking: 'high' } },
    reviewer: { primary: { model: 'deepseek-v4-pro', thinking: 'high' }, fallback: { model: 'deepseek-v4-flash', thinking: 'medium' } },
    tester: { primary: { model: 'deepseek-v4-flash', thinking: 'medium' } },
  },
  openrouter: {
    planner: { primary: { model: 'anthropic/claude-sonnet-5', thinking: 'high' }, fallback: { model: 'anthropic/claude-sonnet-4.6', thinking: 'high' } },
    coder: { primary: { model: 'openai/gpt-5.6-sol', thinking: 'xhigh' }, fallback: { model: 'anthropic/claude-sonnet-5', thinking: 'high' } },
    reviewer: { primary: { model: 'anthropic/claude-sonnet-4.6', thinking: 'high' }, fallback: { model: 'openai/gpt-5.6-terra', thinking: 'high' } },
    tester: { primary: { model: 'deepseek/deepseek-v4-flash', thinking: 'medium' }, fallback: { model: 'google/gemini-3.5-flash', thinking: 'medium' } },
  },
};

const COMPATIBLE_BASE: Partial<Record<ProviderKind, BaseKind>> = {
  openai_compatible: 'openai',
  anthropic_compatible: 'anthropic',
};

function baseKindOf(kind: ProviderKind): BaseKind | undefined {
  if (COMPATIBLE_BASE[kind]) return COMPATIBLE_BASE[kind];
  if (kind === 'anthropic' || kind === 'openai' || kind === 'google' || kind === 'deepseek' || kind === 'openrouter') {
    return kind;
  }
  return undefined;
}

/** workload → 取用哪个角色的模型表（对话=tester，结构化提案=planner）。 */
function roleKeyOf(workload: Workload): RoleKey {
  switch (workload) {
    case 'planner':
    case 'coder':
    case 'reviewer':
    case 'tester':
      return workload;
    case 'task_chat':
    case 'requirement_chat':
      return 'tester';
    case 'task_proposal':
    case 'requirement_proposal':
      return 'planner';
  }
}

function providerNameFor(provider: ProviderConfig): string {
  const base = COMPATIBLE_BASE[provider.kind];
  if (base) {
    const digest = createHash('sha256').update(provider.id).digest('hex').slice(0, 12);
    return `ai-devflow-${digest}`;
  }
  return provider.kind;
}

const MAX_ATTEMPTS = 8;
const MINUTE = 60_000;

/** 故障分类：把任意错误映射为 FailureKind（ProviderExecutionError 自带 kind，不经此函数）。 */
export function classifyProviderFailure(err: unknown): FailureKind {
  const e = (err ?? {}) as { status?: number; code?: string; message?: string };
  const status = typeof e.status === 'number' ? e.status : 0;
  const msg = (e.message ?? String(err)).toLowerCase();
  const code = e.code ?? '';
  if (status === 401 || status === 403 || /unauthorized|forbidden|invalid (api )?key|missing.*key|api key|authentication/.test(msg)) {
    return 'authentication';
  }
  if (status === 429 || /rate.?limit|too many requests|quota|429/.test(msg)) {
    return 'rate_limit';
  }
  if (status === 404 || /model.*(not found|unavailable|unsupported|does not exist)|not found|unsupported/.test(msg)) {
    return 'model_unavailable';
  }
  if (/malformed|invalid json|unexpected token|missing.*event|jsonl|protocol/.test(msg)) {
    return 'protocol';
  }
  if (code === 'ENOENT' || /spawn|enoent|exit code|process exited|crash|sigterm|sigkill/.test(msg)) {
    return 'runtime';
  }
  return 'transient_provider';
}

function rateLimitCooldownMs(failures: number, retryAfterMs?: number): number {
  if (retryAfterMs && retryAfterMs > 0) {
    return Math.min(Math.max(retryAfterMs, 1_000), 15 * MINUTE);
  }
  return Math.min(60_000 * 2 ** (failures - 1), 15 * MINUTE);
}

function transientCooldownMs(failures: number): number {
  return Math.min(5_000 * 2 ** (failures - 1), 2 * MINUTE);
}

export interface ProviderRouterDeps {
  listProviders(): ProviderConfig[];
  resolveSecret(providerId: string): string | undefined;
  health: ProviderHealthStore;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export class ProviderRouter {
  constructor(private deps: ProviderRouterDeps) {}

  /** 生成某 workload 的候选路线（primary→fallback→下一提供商），跳过冷却路线；全冷却时仅 half-open 探测最早到期者。 */
  routesFor(workload: Workload, now = this.deps.now()): ProviderRoute[] {
    const roleKey = roleKeyOf(workload);
    const providers = this.deps
      .listProviders()
      .filter((p) => p.enabled)
      .sort((a, b) => a.priority - b.priority);

    interface Candidate {
      route: ProviderRoute;
      cooling: boolean;
      cooldownUntil?: number;
    }
    const candidates: Candidate[] = [];
    for (const provider of providers) {
      const secret = this.deps.resolveSecret(provider.id);
      if (!secret) continue;
      const base = baseKindOf(provider.kind);
      const modelRoute = base ? MODEL_TABLE[base][roleKey] : undefined;
      if (!modelRoute) continue;
      const providerName = providerNameFor(provider);
      const models = [modelRoute.primary.model, modelRoute.fallback?.model]
        .filter((model): model is string => model !== undefined);
      const tiers: Array<['primary' | 'fallback', ModelChoice | undefined]> = [
        ['primary', modelRoute.primary],
        ['fallback', modelRoute.fallback],
      ];
      for (const [tier, choice] of tiers) {
        if (!choice) continue;
        const routeId = `${provider.id}:${workload}:${tier}`;
        const h = this.deps.health.get(provider.id, routeId);
        const isOpen = h?.state === 'open';
        // open 且无到期（auth/model 直到 revision 变更）或到期未到 → 冷却中。
        const cooling = !!isOpen && (h!.cooldownUntil === undefined || h!.cooldownUntil > now);
        candidates.push({
          route: {
            providerId: provider.id,
            providerRevision: provider.revision,
            providerKind: provider.kind,
            providerName,
            routeId,
            model: choice.model,
            models,
            thinking: choice.thinking,
            baseURL: provider.baseURL,
            secret,
          },
          cooling,
          cooldownUntil: h?.cooldownUntil,
        });
      }
    }

    const active = candidates.filter((c) => !c.cooling).map((c) => c.route);
    if (active.length > 0) return active;
    // 全部冷却：仅选最早到期的一条 half-open 探测（无到期者如 auth 不可探测）。
    const probes = candidates
      .filter((c) => c.cooldownUntil !== undefined)
      .sort((a, b) => (a.cooldownUntil ?? 0) - (b.cooldownUntil ?? 0));
    if (probes.length > 0) return [probes[0]!.route];
    return [];
  }

  /**
   * 在候选路线上执行 operation，按故障分类重试/降级；成功即返回并重置该路线健康。
   * 总 operation 调用上限 8 次；耗尽后抛错（由调度器有界退避，§9.5）。
   */
  async execute<T>(
    workload: Workload,
    operation: (route: ProviderRoute, ordinal: number) => Promise<T>,
    options?: { onlyProviderId?: string },
  ): Promise<T> {
    let routes = this.routesFor(workload);
    if (options?.onlyProviderId) {
      routes = routes.filter((r) => r.providerId === options.onlyProviderId);
    }
    if (routes.length === 0) {
      throw new ProviderExecutionError('所有已配置 AI 服务均不可用，请检查提供商设置', 'transient_provider');
    }
    let calls = 0;
    const retriedSame = new Set<string>();
    for (const route of routes) {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (calls >= MAX_ATTEMPTS) {
          throw new ProviderExecutionError('所有已配置 AI 服务暂时不可用，请稍后重试', 'transient_provider');
        }
        calls += 1;
        try {
          const result = await operation(route, calls);
          this.recordSuccess(route);
          return result;
        } catch (err) {
          const kind = err instanceof ProviderExecutionError ? err.kind : classifyProviderFailure(err);
          const retryAfterMs = err instanceof ProviderExecutionError ? err.retryAfterMs : undefined;
          if (kind === 'task_result' || kind === 'interaction') {
            throw err;
          }
          this.recordFailure(route, kind, retryAfterMs);
          const retryableSame = kind === 'transient_provider' || kind === 'runtime' || kind === 'protocol';
          if (retryableSame && !retriedSame.has(route.routeId)) {
            retriedSame.add(route.routeId);
            continue; // 当前路线重试一次
          }
          if (kind === 'rate_limit' && retryAfterMs && retryAfterMs > 0) {
            await this.deps.sleep(retryAfterMs);
          }
          break; // 降级到下一路线
        }
      }
    }
    throw new ProviderExecutionError('所有已配置 AI 服务暂时不可用，请稍后重试', 'transient_provider');
  }

  private recordSuccess(route: ProviderRoute): void {
    this.deps.health.upsert({
      providerId: route.providerId,
      routeId: route.routeId,
      state: 'closed',
      consecutiveFailures: 0,
      cooldownUntil: undefined,
      lastFailureKind: undefined,
      updatedAt: this.deps.now(),
    });
  }

  private recordFailure(route: ProviderRoute, kind: FailureKind, retryAfterMs?: number): void {
    const existing = this.deps.health.get(route.providerId, route.routeId);
    const failures = (existing?.consecutiveFailures ?? 0) + 1;
    const now = this.deps.now();
    let cooldownUntil: number | undefined;
    if (kind === 'authentication' || kind === 'model_unavailable') {
      cooldownUntil = undefined; // 开到 revision 变更（由 ProviderStore.clearHealth 清除）
    } else if (kind === 'rate_limit') {
      cooldownUntil = now + rateLimitCooldownMs(failures, retryAfterMs);
    } else {
      cooldownUntil = now + transientCooldownMs(failures);
    }
    this.deps.health.upsert({
      providerId: route.providerId,
      routeId: route.routeId,
      state: 'open',
      consecutiveFailures: failures,
      cooldownUntil,
      lastFailureKind: kind,
      updatedAt: now,
    });
  }
}
