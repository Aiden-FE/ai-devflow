import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { UsageAnalytics, UsageMetric } from '@ai-devflow/core';

Object.assign(globalThis, { window: { api: { analytics: { query: async () => fixture } } } });
const { LocaleProvider } = await import('../i18n/index.js');
const { UsageStatsView } = await import('../pages/UsageStats.js');

const metric: UsageMetric = {
  providerCalls: 4,
  logicalRequests: 3,
  succeeded: 3,
  failed: 1,
  canceled: 0,
  interrupted: 0,
  averageDurationMs: 1250,
  tokens: { input: 200, output: 100, cacheRead: 40, cacheWrite: 20, total: null },
  tokenKnownCalls: 3,
  tokenCoverage: 0.75,
};

const fixture: UsageAnalytics = {
  filters: { startAt: 0, endAt: 1000 },
  summary: metric,
  timeBuckets: [{ day: '2026-07-29', ...metric }],
  providers: [{ key: 'p1', label: 'Provider One', ...metric }],
  models: [],
  projects: [],
  workloads: [],
  sources: [],
  failures: [],
  latestFailures: [],
};

function render(props: React.ComponentProps<typeof UsageStatsView>): string {
  return renderToStaticMarkup(<LocaleProvider><UsageStatsView {...props} /></LocaleProvider>);
}

describe('UsageStats', () => {
  it('renders global metrics, unknown Token values, coverage, and provider drill-down', () => {
    const html = render({ data: fixture, loading: false, onProviderSelect: () => undefined });
    expect(html).toContain('供应商使用统计');
    expect(html).toContain('调用次数');
    expect(html).toContain('逻辑请求');
    expect(html).toContain('Token 总量');
    expect(html).toContain('>--<');
    expect(html).toContain('75%');
    expect(html).toContain('Provider One');
    expect(html).toContain('查看详情');
  });

  it('keeps a stable page shell for loading, empty, and error states', () => {
    expect(render({ loading: true, onProviderSelect: () => undefined })).toContain('data-testid="usage-shell"');
    expect(render({ loading: false, data: { ...fixture, summary: { ...metric, providerCalls: 0 }, providers: [], timeBuckets: [] }, onProviderSelect: () => undefined })).toContain('暂无使用数据');
    expect(render({ loading: false, error: 'boom', onProviderSelect: () => undefined })).toContain('boom');
  });
});
