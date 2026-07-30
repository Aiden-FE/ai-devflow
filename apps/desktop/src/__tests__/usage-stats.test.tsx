// @vitest-environment happy-dom
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { UsageAnalytics, UsageMetric } from '@ai-devflow/core';

// --- Mock EChart as an accessible <div> so tests stay Canvas-independent ---
// The mock calls onError on mount when `setChartErrorTrigger` returns true for
// the chart's ariaLabel, so a test can force exactly one chart to error.
const chartErrorState = vi.hoisted(() => ({
  trigger: null as null | ((ariaLabel: string) => boolean),
}));
vi.mock('../components/usage/EChart.js', async () => {
  const { useEffect, createElement } = await import('react');
  return {
    setChartErrorTrigger: (fn: ((ariaLabel: string) => boolean) | null) => {
      chartErrorState.trigger = fn;
    },
    EChart: ({ option, ariaLabel, className, onError }: {
      option: Record<string, unknown>;
      ariaLabel: string;
      className?: string;
      onError?: (e: unknown) => void;
    }) => {
      useEffect(() => {
        if (onError && chartErrorState.trigger?.(ariaLabel)) {
          onError(new Error('forced chart error'));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return createElement(
        'div',
        {
          role: 'img',
          'aria-label': ariaLabel,
          'data-testid': 'echart',
          className,
        },
        JSON.stringify(option?.series ?? []),
      );
    },
  };
});

// --- Synchronous i18n: LocaleProvider renders children; useT returns zh translate ---
// Avoids the async settings.getLocale() effect that bleeds work across tests.
const { zh } = await import('../i18n/zh.js');
function translate(key: string, vars?: Record<string, string | number>): string {
  let s = zh[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return s;
}
vi.mock('../i18n/index.js', () => ({
  LocaleProvider: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  useT: () => translate,
  useLocale: () => ({ locale: 'zh', setLocale: async () => {}, t: translate }),
}));

// --- window.api stub: analytics.query + settings.getLocale/getTheme ---
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
  models: [{ key: 'gpt-5', label: 'gpt-5', ...metric }],
  projects: [{ key: 'proj-a', label: 'Proj A', ...metric }],
  workloads: [{ key: 'task', label: 'task', ...metric }],
  sources: [{ key: 'task_agent', label: 'task_agent', ...metric }],
  failures: [{ key: 'timeout', label: 'timeout', ...metric }],
  latestFailures: [],
};

// Extend the happy-dom window with the api/matchMedia stubs (do NOT replace it -
// react-dom's synthetic event system needs window.addEventListener etc.).
Object.assign(window, {
  api: {
    analytics: { query: async () => fixture },
    settings: { getLocale: async () => 'zh', getTheme: async () => 'system' },
  },
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
});
Object.defineProperty(globalThis, 'ResizeObserver', {
  value: class { observe() {} unobserve() {} disconnect() {} },
  configurable: true,
  writable: true,
});
// happy-dom omits window.HTMLIFrameElement; react-dom@18 getActiveElementDeep uses
// `element instanceof win.HTMLIFrameElement` during prepareForCommit when focusable
// elements (buttons) are committed. Define a minimal constructor so instanceof works.
if (!(window as unknown as Record<string, unknown>).HTMLIFrameElement) {
  Object.defineProperty(window, 'HTMLIFrameElement', {
    value: class HTMLIFrameElement {},
    configurable: true,
    writable: true,
  });
}
const { LocaleProvider } = await import('../i18n/index.js');
const { UsageStatsView, UsageStatsPage } = await import('../pages/UsageStats.js');
const { setChartErrorTrigger } = (await import('../components/usage/EChart.js')) as unknown as {
  setChartErrorTrigger: (fn: ((ariaLabel: string) => boolean) | null) => void;
};

const trackedRoots: ReturnType<typeof createRoot>[] = [];

function render(props: React.ComponentProps<typeof UsageStatsView>): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  trackedRoots.push(root);
  act(() => {
    root.render(<LocaleProvider><UsageStatsView {...props} /></LocaleProvider>);
  });
  return container;
}

function text(el: HTMLElement | null): string {
  return el?.textContent ?? '';
}

function click(node: HTMLElement | null): void {
  act(() => {
    node?.click();
  });
}

afterEach(() => {
  while (trackedRoots.length) {
    const root = trackedRoots.pop()!;
    act(() => { root.unmount(); });
  }
  document.body.innerHTML = '';
  setChartErrorTrigger(null);
});

describe('UsageStats dashboard', () => {
  it('renders six KPIs in order with values, unknown total, coverage, and failed calls', () => {
    const c = render({ data: fixture, loading: false, onProviderSelect: () => undefined });
    const shell = c.querySelector('[data-testid="usage-shell"]');
    expect(shell).not.toBeNull();

    // Six KPI labels present
    expect(text(c.querySelector('[data-testid="usage-shell"]'))).toContain('供应商使用统计');
    expect(c.textContent).toContain('调用次数');
    expect(c.textContent).toContain('逻辑请求');
    expect(c.textContent).toContain('成功率');
    expect(c.textContent).toContain('平均耗时');
    expect(c.textContent).toContain('Token 总量');
    expect(c.textContent).toContain('Token 覆盖率');
    expect(c.textContent).toContain('失败调用');

    // Values
    expect(c.textContent).toContain('4'); // providerCalls
    expect(c.textContent).toContain('75%'); // coverage
    expect(c.textContent).toContain('1'); // failedCalls

    // Unknown total rendered as 未知, not -- or 0
    expect(c.textContent).toContain('未知');
    expect(c.textContent).not.toMatch(/>--</);

    // Calls support text includes logical requests
    expect(c.textContent).toContain('3 次逻辑请求');

    // Coverage support text includes unknown calls (4 - 3 = 1)
    expect(c.textContent).toContain('1 次未知');

    // Provider table present
    expect(c.textContent).toContain('Provider One');
    expect(c.textContent).toContain('查看详情');
  });

  it('renders provider table with min-width wrapper and scroll testid', () => {
    const c = render({ data: fixture, loading: false, onProviderSelect: () => undefined });
    const scroll = c.querySelector('[data-testid="provider-table-scroll"]');
    expect(scroll).not.toBeNull();
    const table = scroll?.querySelector('table');
    expect(table?.getAttribute('class') ?? '').toContain('min-w-[790px]');
  });

  it('renders two EChart canvases (trend + composition) in global view', () => {
    const c = render({ data: fixture, loading: false, onProviderSelect: () => undefined });
    const charts = c.querySelectorAll('[data-testid="echart"]');
    expect(charts.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps usage-shell in loading, empty, and error states', () => {
    expect(render({ loading: true, onProviderSelect: () => undefined }).querySelector('[data-testid="usage-shell"]')).not.toBeNull();
    const empty = render({ loading: false, data: { ...fixture, summary: { ...metric, providerCalls: 0 }, providers: [], timeBuckets: [] }, onProviderSelect: () => undefined });
    expect(empty.querySelector('[data-testid="usage-shell"]')).not.toBeNull();
    expect(empty.textContent).toContain('暂无使用数据');
    const err = render({ loading: false, error: 'boom', onProviderSelect: () => undefined });
    expect(err.querySelector('[data-testid="usage-shell"]')).not.toBeNull();
    expect(err.textContent).toContain('boom');
  });

  it('empty state offers 365-day action only when days < 365', () => {
    const onDaysChange = vi.fn();
    const short = render({ loading: false, days: 30, data: { ...fixture, summary: { ...metric, providerCalls: 0 }, providers: [], timeBuckets: [] }, onDaysChange, onProviderSelect: () => undefined });
    expect(short.textContent).toContain('查看 365 天');
    const long = render({ loading: false, days: 365, data: { ...fixture, summary: { ...metric, providerCalls: 0 }, providers: [], timeBuckets: [] }, onDaysChange, onProviderSelect: () => undefined });
    expect(long.textContent).not.toContain('查看 365 天');
  });

  it('query error shows a retry button', () => {
    const onRefresh = vi.fn();
    const c = render({ loading: false, error: 'boom', onRefresh, onProviderSelect: () => undefined });
    const retry = Array.from(c.querySelectorAll('button')).find((b) => b.textContent?.includes('重试'));
    expect(retry).toBeTruthy();
    click(retry!);
    expect(onRefresh).toHaveBeenCalled();
  });

  it('opens drill-down on detail click, keeps header+KPIs, back returns to global', () => {
    const onProviderSelect = vi.fn();
    const onDaysChange = vi.fn();
    const c = render({ data: fixture, loading: false, days: 30, onProviderSelect, onDaysChange });
    const detail = Array.from(c.querySelectorAll('button')).find((b) => b.textContent?.includes('查看详情'));
    expect(detail).toBeTruthy();
    click(detail!);
    expect(onProviderSelect).toHaveBeenCalledWith('p1');

    // Re-render as drill-down selected
    const d = render({ data: fixture, loading: false, days: 30, selectedProviderId: 'p1', onProviderSelect, onDaysChange });
    // KPIs still present
    expect(d.textContent).toContain('调用次数');
    // Drill-down shows decorated provider label
    expect(d.textContent).toContain('Provider One');
    // Drill-down shows breakdown groups
    expect(d.textContent).toContain('模型');
    expect(d.textContent).toContain('失败类型');
    // Global trend chart not shown in drill-down (only drill-down content)
    // Back button calls onProviderSelect(undefined), not onDaysChange.
    const backBtn = d.querySelector<HTMLElement>('[title="返回总体统计"]');
    click(backBtn);
    expect(onProviderSelect).toHaveBeenCalledWith(undefined);
    expect(onDaysChange).not.toHaveBeenCalled();
  });

  it('selectedProviderId without data shows generic scope label, never the full ID', () => {
    const c = render({ loading: false, selectedProviderId: 'uuid-776f5082-9779', onProviderSelect: () => undefined });
    expect(c.textContent).toContain('所选供应商');
    expect(c.textContent).not.toContain('uuid-776f5082-9779');
  });

  it('deleted-provider scope uses decorated historical label when data present', () => {
    const hist: UsageAnalytics = {
      ...fixture,
      providers: [{ key: '776f5082-9779-4a15-8f3d-ac0b7068da9b', label: '历史供应商 · 776f…da9b', ...metric }],
    };
    const c = render({ data: hist, loading: false, selectedProviderId: '776f5082-9779-4a15-8f3d-ac0b7068da9b', onProviderSelect: () => undefined });
    expect(c.textContent).toContain('历史供应商 · 776f…da9b');
  });

  it('chart error leaves KPIs and provider table visible, with per-chart retry', () => {
    // Force only the trend chart (ariaLabel starts with the zh trend title) to error
    // on mount. The composition chart must stay mounted and unaffected.
    setChartErrorTrigger((label: string) => label.startsWith('每日调用趋势'));
    const c = render({ data: fixture, loading: false, onProviderSelect: () => undefined });

    // Trend chart errored -> its error block is visible.
    expect(c.textContent).toContain('图表加载失败');
    // KPIs and provider table remain visible alongside the trend error.
    expect(c.textContent).toContain('调用次数');
    expect(c.textContent).toContain('Provider One');
    // The other chart (composition) is unaffected: exactly one echart still rendered.
    expect(c.querySelectorAll('[data-testid="echart"]').length).toBe(1);
    // No composition error text.
    expect(c.querySelectorAll('[role="alert"]').length).toBe(1);

    // Clear the trigger so the remounted chart does not re-error.
    setChartErrorTrigger(null);
    const retry = Array.from(c.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('重试图表'),
    );
    expect(retry).toBeTruthy();
    click(retry!);

    // Trend chart remounted; both charts now rendered and no error alerts remain.
    expect(c.querySelectorAll('[data-testid="echart"]').length).toBe(2);
    expect(c.querySelectorAll('[role="alert"]').length).toBe(0);
    expect(c.textContent).not.toContain('图表加载失败');
    // KPIs/table still present after retry.
    expect(c.textContent).toContain('调用次数');
    expect(c.textContent).toContain('Provider One');
  });

  it('renders partial token values without crashing', () => {
    const partial: UsageAnalytics = {
      ...fixture,
      summary: { ...metric, tokens: { input: 100, output: null, cacheRead: null, cacheWrite: null, total: 100 } },
    };
    const c = render({ data: partial, loading: false, onProviderSelect: () => undefined });
    expect(c.querySelector('[data-testid="usage-shell"]')).not.toBeNull();
    expect(c.textContent).toContain('100');
    expect(c.textContent).toContain('未知');
  });

  it('UsageStatsPage wires query and navigation', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    trackedRoots.push(root);
    await act(async () => {
      root.render(<LocaleProvider><UsageStatsPage /></LocaleProvider>);
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(container.querySelector('[data-testid="usage-shell"]')).not.toBeNull();
  });
});
