// 用量统计 Main 进程装饰层：将稳定 provider_id 上的存储快照名解析为用户可见的展示名。
// 不触碰密钥/credentialRef；仅在 Main 进程内读取 ProviderStore.list() 的脱敏 displayName。
import type { Locale, UsageAnalytics, UsageFilters } from '@ai-devflow/core';
import type { ProviderUsageRepo } from '@ai-devflow/persistence';
import type { ProviderStore } from './provider-store.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUNTIME_NAME_RE = /^ai-devflow-[0-9a-f]+$/i;

export interface ProviderDisplayNameInput {
  providerId: string;
  storedName: string;
  configuredName?: string;
  locale: Locale;
}

/** 内部快照：空、等于 providerId、UUID 或运行时哈希。这类值不作为可见标签。 */
function isInternalValue(providerId: string, value: string): boolean {
  const name = value.trim();
  return !name || name === providerId || UUID_RE.test(name) || RUNTIME_NAME_RE.test(name);
}

/** 用 providerId 收尾：前 4 + … + 后 4；过短则原样返回。 */
function shorten(providerId: string): string {
  return providerId.length <= 8 ? providerId : `${providerId.slice(0, 4)}…${providerId.slice(-4)}`;
}

function fallbackLabel(providerId: string, locale: Locale): string {
  const head = locale === 'en' ? 'Historical provider' : '历史供应商';
  return `${head} · ${shorten(providerId)}`;
}

/**
 * 解析单个供应商的展示名。优先级：
 * 1. 配置的 displayName（已 trim，非内部）；
 * 2. 存储快照 storedName（已 trim，非内部；覆盖标准 kind 与已删除供应商的有效快照）；
 * 3. 本地化的「历史供应商 · <short>」回退（基于 providerId，永不原样暴露完整 ID）。
 */
export function resolveProviderDisplayName(input: ProviderDisplayNameInput): string {
  const { providerId, storedName, locale } = input;
  const configured = input.configuredName?.trim();
  if (configured && !isInternalValue(providerId, configured)) return configured;
  const stored = storedName?.trim();
  if (stored && !isInternalValue(providerId, stored)) return stored;
  return fallbackLabel(providerId, locale);
}

export function createUsageAnalyticsService(options: {
  usage: Pick<ProviderUsageRepo, 'query'>;
  providerStore?: Pick<ProviderStore, 'list'>;
  locale: () => Locale;
}): { query(filters: UsageFilters): UsageAnalytics } {
  const { usage, locale } = options;

  const configuredNameFor = (providerId: string): string | undefined => {
    const store = options.providerStore;
    if (!store) return undefined;
    try {
      const match = store.list().find((p) => p.id === providerId);
      return match?.displayName;
    } catch {
      return undefined;
    }
  };

  return {
    query(filters: UsageFilters): UsageAnalytics {
      const raw = usage.query(filters);
      const localeValue = locale();

      const providers = raw.providers.map((row) => ({
        ...row,
        label: resolveProviderDisplayName({
          providerId: row.key,
          storedName: row.label,
          configuredName: configuredNameFor(row.key),
          locale: localeValue,
        }),
      }));

      const latestFailures = raw.latestFailures.map((failure) => ({
        ...failure,
        providerName: resolveProviderDisplayName({
          providerId: failure.providerId,
          storedName: failure.providerName,
          configuredName: configuredNameFor(failure.providerId),
          locale: localeValue,
        }),
      }));

      return { ...raw, providers, latestFailures };
    },
  };
}
