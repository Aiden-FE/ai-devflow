// Provider 领域契约与输入归一化（设计 §8）。纯 TS，零 Node 依赖，Renderer 与 Main 共享。
// 这是「内置 Pi 单一运行时」重构的新增契约；旧 Agent 契约在删除阶段（Task 12）前保持不变。

/** 提供商类型：标准提供商 + 两类兼容网关。 */
export type ProviderKind =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'deepseek'
  | 'openrouter'
  | 'openai_compatible'
  | 'anthropic_compatible';

/** 鉴权类型。首版仅实现 api_key；oauth 仅保留形状（ProviderAuthenticator 扩展点），无实现/IPC/UI。 */
export type AuthType = 'api_key' | 'oauth';

/** ProviderRouter 的 workload 维度：四角色 + 对话/结构化提案。 */
export type Workload =
  | 'planner'
  | 'coder'
  | 'reviewer'
  | 'tester'
  | 'task_chat'
  | 'requirement_chat'
  | 'task_proposal'
  | 'requirement_proposal';

/** 故障分类（设计 §9.4）。 */
export type FailureKind =
  | 'authentication'
  | 'rate_limit'
  | 'transient_provider'
  | 'model_unavailable'
  | 'runtime'
  | 'protocol'
  | 'task_result'
  | 'interaction';

/**
 * 用户可见的提供商配置（持久化形态）。模型/备用模型/thinking/tools/extensions/skills/
 * 系统提示词/Pi 路径均不在此契约内（不进入 Renderer）。
 */
export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  displayName: string;
  enabled: boolean;
  /** 用户排序（越小越优先）。 */
  priority: number;
  authType: AuthType;
  /** 指向安全存储中密钥的引用（非明文）。 */
  credentialRef: string;
  /** 仅两类 compatible provider 使用。 */
  baseURL?: string;
  /** 配置修订号：每次保存递增，用于清除相关路线的旧健康状态。 */
  revision: number;
}

/** Provider 保存输入（携带可选明文 apiKey；归一化后明文只在 secret 字段返回，不进入 config）。 */
export interface ProviderInput extends Omit<ProviderConfig, 'credentialRef'> {
  apiKey?: string;
  /** 显式允许本地 HTTP（127.0.0.1 / [::1] / localhost）。 */
  allowInsecureLocal?: boolean;
}

/** 脱敏后的提供商摘要（IPC 返回；不含 credentialRef/密文/明文）。 */
export interface ProviderSummary extends Omit<ProviderConfig, 'credentialRef'> {
  hasCredential: boolean;
  health: 'available' | 'untested' | 'cooldown' | 'configuration_error';
}

/** 路线健康状态（持久化，设计 §9.3）。 */
export interface ProviderHealth {
  providerId: string;
  routeId: string;
  state: 'closed' | 'open' | 'half_open';
  consecutiveFailures: number;
  cooldownUntil?: number;
  lastFailureKind?: FailureKind;
  updatedAt: number;
}

/** 高层健康摘要（IPC providers.health）。 */
export interface ProviderHealthSummary {
  providerId: string;
  status: 'available' | 'untested' | 'cooldown' | 'configuration_error';
  cooldownUntil?: number;
  lastFailureKind?: FailureKind;
}

/** 「测试连接」结果（经 ProviderRouter 与真实隐藏模型最小调用）。 */
export interface ProviderTestResult {
  ok: boolean;
  providerId: string;
  status: number;
  error?: string;
}

/**
 * 鉴权扩展点（设计 §8.1 OAuth 预留）。首版只实现 API Key 鉴权；
 * OAuth 保留接口形状，但无实现、IPC 或 UI 入口。
 */
export interface ProviderAuthenticator {
  readonly authType: AuthType;
  normalize(input: ProviderInput): { credentialRef: string; secret?: string };
}

/** 需要用户提供 Base URL 的兼容网关类型。 */
const COMPATIBLE_KINDS: ReadonlySet<ProviderKind> = new Set(['openai_compatible', 'anthropic_compatible']);

/** 显式「本地兼容服务」允许的 http 主机。 */
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/**
 * 归一化 Provider 保存输入并校验（§8.1/§8.3）。
 * - 首版仅接受 `authType: 'api_key'`。
 * - compatible 类型必须提供 Base URL；标准提供商不得覆盖 Base URL。
 * - Base URL 默认仅 https；http 仅限显式 allowInsecureLocal 的 loopback 主机。
 * - 拒绝 URL 用户名/密码、query、fragment。
 * 返回的 `config` 不含明文密钥（credentialRef 指向安全存储）；明文只在 `secret` 字段返回。
 */
export function normalizeProviderInput(input: ProviderInput): { config: ProviderConfig; secret?: string } {
  if (!input.id.trim() || !input.displayName.trim()) throw new Error('提供商名称不能为空');
  if (input.authType !== 'api_key') throw new Error('当前版本仅支持 API Key');
  const compatible = COMPATIBLE_KINDS.has(input.kind);
  if (compatible && !input.baseURL) throw new Error('兼容服务必须配置 Base URL');
  if (!compatible && input.baseURL) throw new Error('标准提供商不能覆盖 Base URL');
  let baseURL: string | undefined;
  if (input.baseURL) {
    const url = new URL(input.baseURL);
    const local = LOCAL_HOSTS.includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && input.allowInsecureLocal === true)) {
      throw new Error(local ? '本地 HTTP 必须显式允许' : 'Base URL 必须使用 HTTPS');
    }
    if (url.username || url.password) throw new Error('Base URL 禁止包含用户名或密码');
    if (url.hash || url.search) throw new Error('Base URL 禁止包含 query 或 fragment');
    baseURL = url.toString().replace(/\/$/, '');
  }
  return {
    config: {
      id: input.id.trim(),
      kind: input.kind,
      displayName: input.displayName.trim(),
      enabled: input.enabled,
      priority: input.priority,
      authType: input.authType,
      credentialRef: `provider:${input.id.trim()}`,
      baseURL,
      revision: input.revision,
    },
    secret: input.apiKey?.trim() || undefined,
  };
}
