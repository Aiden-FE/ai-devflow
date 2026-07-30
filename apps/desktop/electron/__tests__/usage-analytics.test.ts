import { describe, it, expect } from 'vitest';
import type { UsageAnalytics, UsageFilters, Locale } from '@ai-devflow/core';
import {
  resolveProviderDisplayName,
  createUsageAnalyticsService,
} from '../usage-analytics.js';

const UUID = '776f5082-9779-4a15-8f3d-ac0b7068da9b';
const RUNTIME = 'ai-devflow-1a2b3c4d5e6f7a8b';

describe('resolveProviderDisplayName', () => {
  it('uses a configured display name when available and not internal', () => {
    expect(resolveProviderDisplayName({
      providerId: UUID,
      storedName: UUID,
      configuredName: 'Friendly Gateway',
      locale: 'zh',
    })).toBe('Friendly Gateway');
  });

  it('trims configured names before use', () => {
    expect(resolveProviderDisplayName({
      providerId: 'p-1',
      storedName: 'p-1',
      configuredName: '  Spaced Provider  ',
      locale: 'en',
    })).toBe('Spaced Provider');
  });

  it('treats a UUID-shaped configured name as internal and falls back', () => {
    expect(resolveProviderDisplayName({
      providerId: UUID,
      storedName: UUID,
      configuredName: '11111111-2222-3333-8444-555555555555',
      locale: 'zh',
    })).toBe(`历史供应商 · 776f…da9b`);
  });

  it('treats a runtime-hash configured name as internal and falls back', () => {
    expect(resolveProviderDisplayName({
      providerId: RUNTIME,
      storedName: RUNTIME,
      configuredName: RUNTIME,
      locale: 'zh',
    })).toBe(`历史供应商 · ai-d…7a8b`);
  });

  it('uses a valid stored snapshot when configured name is absent (deleted provider)', () => {
    expect(resolveProviderDisplayName({
      providerId: UUID,
      storedName: 'Friendly Gateway',
      locale: 'en',
    })).toBe('Friendly Gateway');
  });

  it('treats standard kinds as valid labels', () => {
    for (const kind of ['openai', 'anthropic', 'google', 'deepseek', 'openrouter']) {
      expect(resolveProviderDisplayName({
        providerId: `id-${kind}`,
        storedName: kind,
        locale: 'zh',
      })).toBe(kind);
    }
  });

  it('falls back when stored name equals the provider id', () => {
    expect(resolveProviderDisplayName({
      providerId: UUID,
      storedName: UUID,
      locale: 'zh',
    })).toBe(`历史供应商 · 776f…da9b`);
  });

  it('falls back when stored name is a UUID', () => {
    expect(resolveProviderDisplayName({
      providerId: 'provider-x',
      storedName: '11111111-2222-3333-8444-555555555555',
      locale: 'zh',
    })).toBe(`历史供应商 · prov…er-x`);
  });

  it('falls back when stored name is a runtime hash', () => {
    expect(resolveProviderDisplayName({
      providerId: RUNTIME,
      storedName: RUNTIME,
      locale: 'zh',
    })).toBe(`历史供应商 · ai-d…7a8b`);
  });

  it('falls back when stored name is empty', () => {
    expect(resolveProviderDisplayName({
      providerId: UUID,
      storedName: '',
      locale: 'zh',
    })).toBe(`历史供应商 · 776f…da9b`);
  });

  it('localizes the fallback in English', () => {
    expect(resolveProviderDisplayName({
      providerId: UUID,
      storedName: UUID,
      locale: 'en',
    })).toBe(`Historical provider · 776f…da9b`);
  });

  it('shortens using the provider id (first four + last four joined by …)', () => {
    expect(resolveProviderDisplayName({
      providerId: UUID,
      storedName: UUID,
      locale: 'zh',
    })).toBe(`历史供应商 · 776f…da9b`);
  });

  it('uses the full id as fallback when it is too short to shorten', () => {
    expect(resolveProviderDisplayName({
      providerId: 'abcd',
      storedName: 'abcd',
      locale: 'zh',
    })).toBe(`历史供应商 · abcd`);
  });
});

describe('createUsageAnalyticsService', () => {
  function buildAnalytics(storedName: string, providerId: string): UsageAnalytics {
    const filters: UsageFilters = { startAt: 0, endAt: 1000 };
    const metric = {
      providerCalls: 1,
      logicalRequests: 1,
      succeeded: 1,
      failed: 0,
      canceled: 0,
      interrupted: 0,
      averageDurationMs: 10,
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
      tokenKnownCalls: 1,
      tokenCoverage: 1,
    };
    return {
      filters,
      summary: metric,
      timeBuckets: [],
      providers: [{ key: providerId, label: storedName, ...metric }],
      models: [],
      projects: [],
      workloads: [],
      sources: [],
      failures: [],
      latestFailures: [
        {
          id: 'f1',
          providerId,
          providerName: storedName,
          model: 'm',
          failureKind: 'unknown',
          startedAt: 5,
        },
      ],
    };
  }

  function service(opts: {
    configured?: Array<{ id: string; displayName: string }>;
    locale: Locale;
    raw: UsageAnalytics;
  }) {
    return createUsageAnalyticsService({
      usage: { query: (_filters: UsageFilters) => opts.raw },
      providerStore: opts.configured
        ? { list: () => opts.configured!.map((c) => ({ id: c.id, displayName: c.displayName }) as never) }
        : undefined,
      locale: () => opts.locale,
    });
  }

  it('decorates providers[].label and latestFailures[].providerName with the configured name', () => {
    const raw = buildAnalytics(UUID, UUID);
    const out = service({ configured: [{ id: UUID, displayName: 'Friendly Gateway' }], locale: 'zh', raw }).query({
      startAt: 0,
      endAt: 1000,
    });
    expect(out.providers[0]!.label).toBe('Friendly Gateway');
    expect(out.latestFailures[0]!.providerName).toBe('Friendly Gateway');
    // Full stable IDs remain unchanged.
    expect(out.providers[0]!.key).toBe(UUID);
    expect(out.latestFailures[0]!.providerId).toBe(UUID);
  });

  it('uses the localized fallback when the provider is unconfigured and the stored name is internal', () => {
    const raw = buildAnalytics(UUID, UUID);
    const out = service({ locale: 'en', raw }).query({ startAt: 0, endAt: 1000 });
    expect(out.providers[0]!.label).toBe(`Historical provider · 776f…da9b`);
    expect(out.latestFailures[0]!.providerName).toBe(`Historical provider · 776f…da9b`);
    expect(out.providers[0]!.key).toBe(UUID);
    expect(out.latestFailures[0]!.providerId).toBe(UUID);
  });

  it('keeps a valid stored snapshot label when no configured name exists', () => {
    const raw = buildAnalytics('Friendly Gateway', UUID);
    const out = service({ locale: 'zh', raw }).query({ startAt: 0, endAt: 1000 });
    expect(out.providers[0]!.label).toBe('Friendly Gateway');
    expect(out.latestFailures[0]!.providerName).toBe('Friendly Gateway');
  });

  it('continues with stored snapshots when the provider store throws', () => {
    const raw = buildAnalytics(UUID, UUID);
    const out = createUsageAnalyticsService({
      usage: { query: (_filters: UsageFilters) => raw },
      providerStore: { list: () => { throw new Error('boom'); } },
      locale: () => 'zh',
    }).query({ startAt: 0, endAt: 1000 });
    expect(out.providers[0]!.label).toBe(`历史供应商 · 776f…da9b`);
    expect(out.latestFailures[0]!.providerName).toBe(`历史供应商 · 776f…da9b`);
  });

  it('does not mutate filters or other breakdown labels', () => {
    const raw = buildAnalytics(UUID, UUID);
    const providerRow = raw.providers[0]!;
    raw.models = [{
      key: 'gpt-5',
      label: 'gpt-5',
      providerCalls: providerRow.providerCalls,
      logicalRequests: providerRow.logicalRequests,
      succeeded: providerRow.succeeded,
      failed: providerRow.failed,
      canceled: providerRow.canceled,
      interrupted: providerRow.interrupted,
      averageDurationMs: providerRow.averageDurationMs,
      tokens: providerRow.tokens,
      tokenKnownCalls: providerRow.tokenKnownCalls,
      tokenCoverage: providerRow.tokenCoverage,
    }];
    const out = service({ configured: [{ id: UUID, displayName: 'Friendly Gateway' }], locale: 'zh', raw }).query({
      startAt: 0,
      endAt: 1000,
    });
    expect(out.models[0]!.label).toBe('gpt-5');
    expect(out.filters).toEqual({ startAt: 0, endAt: 1000 });
  });
});
