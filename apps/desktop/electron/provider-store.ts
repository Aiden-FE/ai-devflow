// 有序、加密的 Provider 存储 + 旧单提供商配置幂等迁移（设计 §8.2/§12.4）。
//
// 设计取舍：提供商列表元数据以加密 JSON 存入 credentials('providers:v1')，每个 API Key 存入
// credentials('provider-secret:<id>')。元数据与密钥均经注入的 crypto（生产为 safeStorage 包装）
// 加密；list()/listConfigs() 绝不返回明文密钥或 credentialRef。crypto 与 credentials 均构造注入，
// 使本模块可在 Vitest 中脱离 Electron 测试。
import { randomUUID } from 'node:crypto';
import type { ProviderConfig, ProviderInput, ProviderSummary } from '@ai-devflow/core';
import { normalizeProviderInput } from '@ai-devflow/core';

const PROVIDERS_KEY = 'providers:v1';
const MIGRATION_MARKER = 'provider-migration:v1';
const LEGACY_KEY = 'ai_provider';

/** 凭证存储端口（生产为 Repositories.credentials 的事务化包装；测试为内存 Map）。 */
export interface ProviderCredentialSink {
  get(key: string): string | undefined;
  upsert(key: string, value: string): void;
  delete(key: string): void;
  transaction<T>(fn: () => T): T;
}

/** 加解密端口（生产为 credentials.ts 的 encryptProviderSecret/decryptProviderSecret）。 */
export interface ProviderCrypto {
  encrypt(value: string): string;
  decrypt(value: string): string;
}

function secretKey(id: string): string {
  return `provider-secret:${id}`;
}

interface LegacyAiProvider {
  provider: 'anthropic' | 'openai';
  apiKey: string;
  baseURL?: string;
  model?: string;
}

const LEGACY_DEFAULT_BASE_URLS: Record<LegacyAiProvider['provider'], Set<string>> = {
  openai: new Set(['https://api.openai.com', 'https://api.openai.com/v1']),
  anthropic: new Set(['https://api.anthropic.com', 'https://api.anthropic.com/v1', 'https://api.anthropic.com/v1/messages']),
};

function normalizedLegacyBaseURL(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  return value.trim().replace(/\/+$/, '');
}

function legacyAllowsLocalHTTP(baseURL: string | undefined): boolean {
  if (!baseURL) return false;
  try {
    const url = new URL(baseURL);
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

export class ProviderStore {
  constructor(
    private credentials: ProviderCredentialSink,
    private crypto: ProviderCrypto,
    private clearHealth: (providerId: string) => void,
  ) {}

  /** 读取全部提供商配置（解密；失败视为空列表，绝不抛出明文）。 */
  listConfigs(): ProviderConfig[] {
    const raw = this.credentials.get(PROVIDERS_KEY);
    if (!raw) return [];
    let json: string;
    try {
      json = this.crypto.decrypt(raw);
    } catch {
      return [];
    }
    try {
      const parsed = JSON.parse(json) as ProviderConfig[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private writeConfigs(configs: ProviderConfig[]): void {
    this.credentials.upsert(PROVIDERS_KEY, this.crypto.encrypt(JSON.stringify(configs)));
  }

  /** 脱敏摘要：hasCredential 布尔，无密文/明文/credentialRef。health 缺省 untested（路由层合并真实健康）。 */
  list(): ProviderSummary[] {
    return this.listConfigs().map((c) => ({
      id: c.id,
      kind: c.kind,
      displayName: c.displayName,
      enabled: c.enabled,
      priority: c.priority,
      authType: c.authType,
      baseURL: c.baseURL,
      revision: c.revision,
      hasCredential: this.credentials.get(secretKey(c.id)) !== undefined,
      health: 'untested',
    }));
  }

  /**
   * 保存（新增或更新）一个提供商。revision 在 kind/Base URL/启用状态变化或提供新密钥时递增；
   * 更新已存在提供商时于提交后 clearHealth(id)。密钥只在提供时写入，空密钥不覆盖既有密钥。
   */
  save(input: ProviderInput): ProviderSummary {
    const { config, secret } = normalizeProviderInput(input);
    const configs = this.listConfigs();
    const existing = configs.find((c) => c.id === config.id);
    let revision: number;
    let changed = false;
    if (existing) {
      changed =
        existing.kind !== config.kind ||
        (existing.baseURL ?? '') !== (config.baseURL ?? '') ||
        existing.enabled !== config.enabled ||
        secret !== undefined;
      revision = changed ? existing.revision + 1 : existing.revision;
    } else {
      revision = config.revision > 0 ? config.revision : 1;
    }
    const priority = existing
      ? existing.priority
      : configs.length > 0
        ? Math.max(...configs.map((c) => c.priority)) + 1
        : 0;
    const next: ProviderConfig = { ...config, revision, priority };
    this.credentials.transaction(() => {
      const others = configs.filter((c) => c.id !== config.id);
      this.writeConfigs([...others, next].sort((a, b) => a.priority - b.priority));
      if (secret !== undefined) {
        this.credentials.upsert(secretKey(config.id), this.crypto.encrypt(secret));
      }
    });
    if (existing && changed) this.clearHealth(config.id);
    const saved = this.list().find((s) => s.id === config.id);
    if (!saved) throw new Error('保存提供商失败');
    return saved;
  }

  /** 删除提供商及其密钥，并清除其路线健康。 */
  remove(id: string): void {
    this.credentials.transaction(() => {
      const remaining = this.listConfigs()
        .filter((c) => c.id !== id)
        .sort((a, b) => a.priority - b.priority)
        .map((c, i) => ({ ...c, priority: i }));
      this.writeConfigs(remaining);
      this.credentials.delete(secretKey(id));
    });
    this.clearHealth(id);
  }

  /** 重排序：ids 必须是当前全部提供商 ID 的一个排列（拒绝缺失/重复/未知），写连续 priority 0..n-1。 */
  reorder(ids: string[]): void {
    const configs = this.listConfigs();
    const known = new Set(configs.map((c) => c.id));
    if (ids.length !== configs.length) throw new Error('排序列表必须包含全部提供商');
    const seen = new Set<string>();
    for (const id of ids) {
      if (!known.has(id)) throw new Error(`未知提供商：${id}`);
      if (seen.has(id)) throw new Error(`重复提供商：${id}`);
      seen.add(id);
    }
    this.credentials.transaction(() => {
      const byId = new Map(configs.map((c) => [c.id, c] as const));
      const reordered = ids.map((id, i) => ({ ...byId.get(id)!, priority: i }));
      this.writeConfigs(reordered);
    });
  }

  /** 解析某提供商的明文 API Key（仅供 Main 进程构造子进程环境/探测；绝不进 IPC/Renderer）。 */
  resolveSecret(id: string): string | undefined {
    const enc = this.credentials.get(secretKey(id));
    if (!enc) return undefined;
    try {
      return this.crypto.decrypt(enc);
    } catch {
      return undefined;
    }
  }

  /** Replace an unreadable legacy record with an explicitly re-entered provider in one transaction. */
  completeLegacyReentry(input: ProviderInput): ProviderSummary {
    const { config, secret } = normalizeProviderInput(input);
    if (!secret) throw new Error('重新录入需要新的 API Key');
    const existing = this.listConfigs()
      .filter((provider) => provider.id !== config.id)
      .sort((a, b) => a.priority - b.priority);
    const reordered = [{ ...config, priority: 0, revision: Math.max(config.revision, 1) }, ...existing]
      .map((provider, priority) => ({ ...provider, priority }));
    this.credentials.transaction(() => {
      this.writeConfigs(reordered);
      this.credentials.upsert(secretKey(config.id), this.crypto.encrypt(secret));
      this.credentials.upsert(MIGRATION_MARKER, this.crypto.encrypt(`reentered:${config.id}`));
      this.credentials.delete(LEGACY_KEY);
    });
    const saved = this.list().find((provider) => provider.id === config.id);
    if (!saved) throw new Error('重新录入提供商失败');
    return saved;
  }

  /**
   * 幂等迁移旧单提供商配置（credentials('ai_provider')）为新列表第一项；丢弃旧 model（由内置
   * workload map 接管）。仅在新记录落盘后写 marker 并于同一事务删除旧 key。无法解密时保留旧密文、
   * 不建记录/marker（调用方提示用户重新输入密钥）。
   */
  migrateLegacy(): 'not_needed' | 'migrated' | 'needs_reentry' {
    if (this.credentials.get(MIGRATION_MARKER)) return 'not_needed';
    const legacyEnc = this.credentials.get(LEGACY_KEY);
    if (!legacyEnc) return 'not_needed';
    let legacy: LegacyAiProvider;
    try {
      legacy = JSON.parse(this.crypto.decrypt(legacyEnc)) as LegacyAiProvider;
    } catch {
      // 无法解密：不伪造迁移成功，保留旧密文，等待用户重新输入密钥。
      return 'needs_reentry';
    }
    const id = randomUUID();
    const baseKind = legacy.provider === 'openai' ? 'openai' : 'anthropic';
    const legacyBaseURL = normalizedLegacyBaseURL(legacy.baseURL);
    const customURL = legacyBaseURL !== undefined && !LEGACY_DEFAULT_BASE_URLS[legacy.provider].has(legacyBaseURL);
    const kind = customURL ? `${baseKind}_compatible` as const : baseKind;
    const { config } = normalizeProviderInput({
      id,
      kind,
      displayName: baseKind === 'openai' ? 'OpenAI' : 'Anthropic',
      enabled: true,
      priority: 0,
      authType: 'api_key',
      baseURL: customURL ? legacyBaseURL : undefined,
      allowInsecureLocal: legacyAllowsLocalHTTP(legacyBaseURL),
      revision: 1,
    });
    this.credentials.transaction(() => {
      const configs = this.listConfigs().sort((a, b) => a.priority - b.priority);
      this.writeConfigs([config, ...configs].map((provider, priority) => ({ ...provider, priority })));
      if (legacy.apiKey) this.credentials.upsert(secretKey(id), this.crypto.encrypt(legacy.apiKey));
      this.credentials.upsert(MIGRATION_MARKER, this.crypto.encrypt(`migrated:${id}`));
      this.credentials.delete(LEGACY_KEY);
    });
    return 'migrated';
  }
}
