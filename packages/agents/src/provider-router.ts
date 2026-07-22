// ProviderRouter：有序提供商路由 + 熔断/降级（设计 §9）。
//
// - 模型来源：用户配置的 ProviderConfig.defaultModel / workloadModels（按 ModelRoleKey 覆盖）。
//   每个 workload 在每个提供商下至多解析出一个模型 -> 一条候选路线（无同提供商 fallback 层）；
//   解析不到模型的提供商对该 workload 跳过。
// - 候选顺序：提供商 N 的路线 -> 提供商 N+1 的路线 …（按 priority 升序）。
//   禁用/无凭证/无该 workload 模型/仍处熔断冷却的路线不进入本轮候选；
//   若全部路线都在冷却，仅选最早到期的一条做 half-open 探测（禁止忙循环）。
// - 故障分类驱动熔断：authentication/model_unavailable 开到 revision 变更；rate_limit 用 Retry-After
//   或指数冷却并立即降级；transient/runtime/protocol 当前路线重试一次再冷却降级。
// - 总尝试上限 8 次 operation 调用。Pi 自身 retry 关闭，重试只由本路由控制（§7.5/§9.4）。
//
// ProviderHealthStore 结构化依赖（不 import persistence）；Task 9 由 Electron 注入持久化仓储。
// modelRouteFor 为集成测试缝：存在时覆盖用户配置解析（含 thinking 等级），供 real-pi 等测试注入。
import { createHash } from 'node:crypto';
import type { FailureKind, ModelRoleKey, ProviderConfig, ProviderHealth, ProviderKind, Workload } from '@ai-devflow/core';

export interface ModelChoice {
  model: string;
  thinking: 'low' | 'medium' | 'high' | 'xhigh';
}

/**
 * 候选路线（设计 §9.1）。
 *
 * 与设计 §9.1 契约的等价取舍（显式注明，非偏差）：`priority` 未列入本接口。
 * `routesFor()` 已按 `ProviderConfig.priority` 升序生成候选，priority 信息已编码在
 * 生成顺序中（调用方按数组顺序消费即为按 priority 优先级），故不再在每条路线上冗余携带。
 */
export interface ProviderRoute {
  providerId: string;
  providerRevision: number;
  providerKind: ProviderKind;
  /** 传给 Pi 的 provider 名（标准提供商为 catalog 名；兼容网关为生成的 ai-devflow-<hash>）。 */
  providerName: string;
  routeId: string;
  model: string;
  /** 当前 workload 在该提供商下解析出的模型集合（单元素：用户配置解析出的唯一模型）。 */
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

// ---- 模型解析（设计 §7.2：模型由用户配置，不再内置 MODEL_TABLE） ----

type BaseKind = 'anthropic' | 'openai' | 'google' | 'deepseek' | 'openrouter';

export interface ModelRoute {
  primary: ModelChoice;
  fallback?: ModelChoice;
}

/** 兼容网关 -> 标准基底（仅用于 providerNameFor 生成 ai-devflow-<hash> 名）。 */
const COMPATIBLE_BASE: Partial<Record<ProviderKind, BaseKind>> = {
  openai_compatible: 'openai',
  anthropic_compatible: 'anthropic',
};

/**
 * workload -> 模型角色键（设计 §7.2）。`chat` 覆盖 task_chat/requirement_chat，
 * `proposal` 覆盖 task_proposal/requirement_proposal；四角色一一对应。
 */
export function workloadRoleKey(workload: Workload): ModelRoleKey {
  switch (workload) {
    case 'planner': return 'planner';
    case 'coder': return 'coder';
    case 'reviewer': return 'reviewer';
    case 'tester': return 'tester';
    case 'task_chat':
    case 'requirement_chat': return 'chat';
    case 'task_proposal':
    case 'requirement_proposal': return 'proposal';
  }
}

/**
 * 解析某提供商在指定 workload 下应使用的模型：workloadModels 按角色覆盖，否则取 defaultModel；
 * 两者皆无返回 undefined（调用方跳过该提供商对此 workload 的候选）。
 */
export function resolveModelFor(provider: ProviderConfig, workload: Workload): string | undefined {
  const role = workloadRoleKey(workload);
  return provider.workloadModels?.[role] ?? provider.defaultModel;
}

/** 用户配置模型不携带 thinking 等级；解析路径统一回落到 medium（modelRouteFor 缝可显式覆盖）。 */
const DEFAULT_THINKING: ModelChoice['thinking'] = 'medium';

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
const PROVIDER_AUTH_ROUTE_ID = 'provider:authentication';

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
  /** 集成测试缝：存在时覆盖用户配置解析（含 thinking 等级），供 real-pi 等测试注入非生产模型。 */
  modelRouteFor?: (provider: ProviderConfig, workload: Workload) => ModelRoute | undefined;
}

export class ProviderRouter {
  constructor(private deps: ProviderRouterDeps) {}

  /** 生成某 workload 的候选路线（每提供商至多一条：用户配置解析出的模型），跳过冷却路线；全冷却时仅 half-open 探测最早到期者。 */
  routesFor(workload: Workload, now = this.deps.now()): ProviderRoute[] {
    const providers = this.deps
      .listProviders()
      .filter((p) => p.enabled)
      .sort((a, b) => a.priority - b.priority);

    interface Candidate {
      route: ProviderRoute;
      cooling: boolean;
      cooldownUntil?: number;
      probeEligible: boolean;
    }
    const candidates: Candidate[] = [];
    for (const provider of providers) {
      const authHealth = this.deps.health.get(provider.id, PROVIDER_AUTH_ROUTE_ID);
      if (authHealth?.state === 'open' || authHealth?.state === 'half_open') continue;
      const secret = this.deps.resolveSecret(provider.id);
      if (!secret) continue;
      // modelRouteFor 缝存在时覆盖用户配置解析（含 thinking）；否则按 defaultModel/workloadModels 解析。
      const seam = this.deps.modelRouteFor?.(provider, workload);
      let model: string | undefined;
      let thinking: ModelChoice['thinking'];
      if (seam) {
        model = seam.primary.model;
        thinking = seam.primary.thinking;
      } else {
        model = resolveModelFor(provider, workload);
        thinking = DEFAULT_THINKING;
      }
      if (model === undefined) continue;
      const providerName = providerNameFor(provider);
      const routeId = `${provider.id}:${workload}`;
      const h = this.deps.health.get(provider.id, routeId);
      const isOpen = h?.state === 'open';
      const isHalfOpen = h?.state === 'half_open';
      // open 且无到期（auth/model 直到 revision 变更）或到期未到 -> 冷却中。
      const cooling = !!isHalfOpen || (!!isOpen && (h!.cooldownUntil === undefined || h!.cooldownUntil > now));
      candidates.push({
        route: {
          providerId: provider.id,
          providerRevision: provider.revision,
          providerKind: provider.kind,
          providerName,
          routeId,
          model,
          models: [model],
          thinking,
          baseURL: provider.baseURL,
          secret,
        },
        cooling,
        cooldownUntil: h?.cooldownUntil,
        probeEligible: !!isOpen && h?.cooldownUntil !== undefined,
      });
    }

    const active = candidates.filter((c) => !c.cooling).map((c) => c.route);
    if (active.length > 0) return active;
    // 全部冷却：仅选最早到期的一条 half-open 探测（无到期者如 auth 不可探测）。
    const probes = candidates
      .filter((c) => c.probeEligible)
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
    const authenticationFailures = new Set<string>();
    for (const route of routes) {
      if (authenticationFailures.has(route.providerId) || !this.claimRoute(route)) continue;
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
          if (kind === 'authentication') {
            authenticationFailures.add(route.providerId);
            this.recordAuthenticationFailure(route.providerId);
            break;
          }
          this.recordFailure(route, kind, retryAfterMs);
          const retryableSame = kind === 'transient_provider' || kind === 'runtime' || kind === 'protocol';
          if (retryableSame && !retriedSame.has(route.routeId)) {
            retriedSame.add(route.routeId);
            continue; // 当前路线重试一次
          }
          break; // 降级到下一路线
        }
      }
    }
    throw new ProviderExecutionError('所有已配置 AI 服务暂时不可用，请稍后重试', 'transient_provider');
  }

  /** Synchronously claim an open route so concurrent executions cannot duplicate its half-open probe. */
  private claimRoute(route: ProviderRoute): boolean {
    const existing = this.deps.health.get(route.providerId, route.routeId);
    if (!existing || existing.state === 'closed') return true;
    if (existing.state === 'half_open') return false;
    this.deps.health.upsert({
      ...existing,
      state: 'half_open',
      updatedAt: this.deps.now(),
    });
    return true;
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

  private recordAuthenticationFailure(providerId: string): void {
    const existing = this.deps.health.get(providerId, PROVIDER_AUTH_ROUTE_ID);
    this.deps.health.upsert({
      providerId,
      routeId: PROVIDER_AUTH_ROUTE_ID,
      state: 'open',
      consecutiveFailures: (existing?.consecutiveFailures ?? 0) + 1,
      cooldownUntil: undefined,
      lastFailureKind: 'authentication',
      updatedAt: this.deps.now(),
    });
  }

  private recordFailure(route: ProviderRoute, kind: FailureKind, retryAfterMs?: number): void {
    const existing = this.deps.health.get(route.providerId, route.routeId);
    const failures = (existing?.consecutiveFailures ?? 0) + 1;
    const now = this.deps.now();
    let cooldownUntil: number | undefined;
    if (kind === 'model_unavailable') {
      cooldownUntil = undefined; // 当前模型路线开到 revision 变更（由 ProviderStore.clearHealth 清除）
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
