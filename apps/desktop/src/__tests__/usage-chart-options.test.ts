import { describe, expect, it } from 'vitest';
import type { UsageAnalytics, UsageMetric, UsageTimeBucket } from '@ai-devflow/core';

// Pure-builder test. The builder modules co-exist with React wrappers that import
// EChart (echarts runtime) and i18n (reads window.api at load). Provide a window.api
// stub so those modules load in Node; the builders themselves are pure and never
// touch these.
Object.assign(globalThis, {
  window: { api: {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) },
});

const { buildUsageTrendOption } = await import('../components/usage/UsageTrendChart.js');
const { buildTokenCompositionOption } = await import('../components/usage/TokenCompositionChart.js');

const colors = {
  calls: '#111',
  tokens: '#2cbac1',
  success: '#3fb950',
  grid: '#eee',
  text: '#888',
  input: '#2cbac1',
  output: '#111',
  cacheRead: '#3fb950',
  cacheWrite: '#d29922',
};

const zhLabels = {
  calls: '调用次数',
  tokens: 'Token 总量',
  succeeded: '成功',
  failed: '失败',
  totalTokens: 'Token 总量',
  coverage: 'Token 覆盖率',
  successRate: '成功率',
  date: '日期',
  input: '输入',
  output: '输出',
  cacheRead: '缓存读取',
  cacheWrite: '缓存写入',
  unknown: '未知',
};

function bucket(day: string, over: Partial<UsageMetric>): UsageTimeBucket {
  const base: UsageMetric = {
    providerCalls: 0,
    logicalRequests: 0,
    succeeded: 0,
    failed: 0,
    canceled: 0,
    interrupted: 0,
    averageDurationMs: null,
    tokens: { input: null, output: null, cacheRead: null, cacheWrite: null, total: null },
    tokenKnownCalls: 0,
    tokenCoverage: 0,
  };
  return { day, ...base, ...over, tokens: { ...base.tokens, ...over.tokens } };
}

const trendFixture: UsageAnalytics = {
  filters: { startAt: 1_700_000_000_000, endAt: 1_700_086_400_000 },
  summary: bucket('2026-07-29', { providerCalls: 6 }) as UsageMetric,
  timeBuckets: [
    bucket('2026-07-29', {
      providerCalls: 4, logicalRequests: 3, succeeded: 3, failed: 1,
      tokens: { input: 100, output: 40, cacheRead: 20, cacheWrite: 5, total: 165 },
      tokenKnownCalls: 4, tokenCoverage: 1,
    }),
    bucket('2026-07-30', {
      providerCalls: 2, logicalRequests: 2, succeeded: 1, failed: 1,
      tokens: { input: 50, output: null, cacheRead: 10, cacheWrite: null, total: null },
      tokenKnownCalls: 1, tokenCoverage: 0.5,
    }),
    bucket('2026-07-31', {
      providerCalls: 1, logicalRequests: 1, succeeded: 0, failed: 1,
      tokens: { input: null, output: null, cacheRead: null, cacheWrite: null, total: null },
      tokenKnownCalls: 0, tokenCoverage: 0,
    }),
  ],
  providers: [], models: [], projects: [], workloads: [], sources: [], failures: [], latestFailures: [],
};

function trendInput(mode: 'calls' | 'tokens' | 'successRate', over: Record<string, unknown> = {}) {
  return {
    data: trendFixture,
    mode,
    colors: { calls: colors.calls, tokens: colors.tokens, success: colors.success, grid: colors.grid, text: colors.text },
    labels: zhLabels,
    reducedMotion: false,
    ...over,
  };
}

describe('buildUsageTrendOption', () => {
  it('uses every daily bucket as an x-axis category without re-aggregation', () => {
    const option = buildUsageTrendOption(trendInput('calls'));
    const xAxis = (option as any).xAxis;
    const x = Array.isArray(xAxis) ? xAxis[0] : xAxis;
    expect(x.type).toBe('category');
    expect(x.data).toEqual(['2026-07-29', '2026-07-30', '2026-07-31']);
  });

  it('keeps all 365 supplied daily buckets present', () => {
    const buckets: UsageTimeBucket[] = Array.from({ length: 365 }, (_, i) =>
      bucket(`2026-${String(Math.floor(i / 30) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`, {
        providerCalls: i % 5,
      }),
    );
    const option = buildUsageTrendOption(trendInput('calls', { data: { ...trendFixture, timeBuckets: buckets } }));
    const xAxis = (option as any).xAxis;
    const x = Array.isArray(xAxis) ? xAxis[0] : xAxis;
    expect(x.data).toHaveLength(365);
  });

  it('renders a calls line and a tokens bar with theme colors in calls focus', () => {
    const option = buildUsageTrendOption(trendInput('calls'));
    const series = (option as any).series;
    const line = series.find((s: any) => s.type === 'line');
    const bar = series.find((s: any) => s.type === 'bar');
    expect(line).toBeTruthy();
    expect(bar).toBeTruthy();
    expect(line.data).toEqual([4, 2, 1]);
    expect(line.itemStyle.color).toBe(colors.calls);
    expect(bar.itemStyle.color).toBe(colors.tokens);
    // calls focus: calls full opacity, tokens reduced.
    expect(line.lineStyle.opacity).toBe(1);
    expect(bar.itemStyle.opacity).toBeLessThan(1);
  });

  it('reverses opacities in tokens focus', () => {
    const option = buildUsageTrendOption(trendInput('tokens'));
    const series = (option as any).series;
    const line = series.find((s: any) => s.type === 'line');
    const bar = series.find((s: any) => s.type === 'bar');
    expect(line.lineStyle.opacity).toBeLessThan(1);
    expect(bar.itemStyle.opacity).toBe(1);
  });

  it('replaces the token axis with a 0-100 percent axis and one success line in successRate focus', () => {
    const option = buildUsageTrendOption(trendInput('successRate'));
    const yAxis = (option as any).yAxis;
    const y = Array.isArray(yAxis) ? yAxis[0] : yAxis;
    expect(y.min).toBe(0);
    expect(y.max).toBe(100);
    const series = (option as any).series;
    expect(series).toHaveLength(1);
    expect(series[0].type).toBe('line');
    expect(series[0].itemStyle.color).toBe(colors.success);
    // 4 calls, 3 succeeded -> 75%; 2 calls, 1 succeeded -> 50%; 1 call, 0 -> 0.
    expect(series[0].data).toEqual([75, 50, 0]);
  });

  it('reports date, calls, succeeded, failed, total tokens, and coverage in the shared tooltip', () => {
    const option = buildUsageTrendOption(trendInput('calls'));
    const formatter = (option as any).tooltip.formatter;
    const params = [{ dataIndex: 1, axisValue: '2026-07-30' }];
    const text: string = formatter(params);
    expect(text).toContain('2026-07-30');
    expect(text).toContain('2'); // calls
    expect(text).toContain('1'); // succeeded
    expect(text).toContain('1'); // failed
    expect(text).toContain('50%'); // coverage
    // total tokens is unknown for this bucket -> rendered as unknown label.
    expect(text).toContain('未知');
  });

  it('reports total tokens in the successRate focus tooltip, including the unknown label for a null-total bucket', () => {
    const option = buildUsageTrendOption(trendInput('successRate'));
    const formatter = (option as any).tooltip.formatter;
    // Known-total bucket (2026-07-29, total 165): total tokens line present.
    const known: string = formatter([{ dataIndex: 0, axisValue: '2026-07-29' }]);
    expect(known).toContain('165');
    // Null-total bucket (2026-07-30): rendered as the localized unknown label.
    const unknown: string = formatter([{ dataIndex: 1, axisValue: '2026-07-30' }]);
    expect(unknown).toContain('未知');
    // All six mandated fields present in the successRate tooltip.
    expect(unknown).toContain('日期');
    expect(unknown).toContain('调用次数');
    expect(unknown).toContain('成功');
    expect(unknown).toContain('失败');
    expect(unknown).toContain('Token 总量');
    expect(unknown).toContain('Token 覆盖率');
  });

  it('disables animation under reduced motion', () => {
    const option = buildUsageTrendOption(trendInput('calls', { reducedMotion: true }));
    expect((option as any).animationDuration).toBe(0);
  });
});

describe('buildTokenCompositionOption', () => {
  const metric: UsageMetric = {
    providerCalls: 4,
    logicalRequests: 3,
    succeeded: 3,
    failed: 1,
    canceled: 0,
    interrupted: 0,
    averageDurationMs: 1000,
    tokens: { input: 100, output: 50, cacheRead: null, cacheWrite: 20, total: null },
    tokenKnownCalls: 3,
    tokenCoverage: 0.75,
  };

  function compInput(over: Record<string, unknown> = {}) {
    return {
      metric,
      colors: { input: colors.input, output: colors.output, cacheRead: colors.cacheRead, cacheWrite: colors.cacheWrite, grid: colors.grid, text: colors.text },
      labels: zhLabels,
      reducedMotion: false,
      ...over,
    };
  }

  it('renders four horizontal items in input/output/cacheRead/cacheWrite order', () => {
    const option = buildTokenCompositionOption(compInput());
    const series = (option as any).series[0];
    expect(series.data).toHaveLength(4);
    expect(series.data[0]).toMatchObject({ value: 100, missing: false });
    expect(series.data[1]).toMatchObject({ value: 50, missing: false });
    expect(series.data[2]).toMatchObject({ value: 0, missing: true });
    expect(series.data[3]).toMatchObject({ value: 20, missing: false });
  });

  it('makes an unknown field invisible instead of a visible zero bar', () => {
    const option = buildTokenCompositionOption(compInput());
    const series = (option as any).series[0];
    expect(series.data[2]).toMatchObject({ value: 0, missing: true });
    expect(series.data[2].itemStyle.opacity).toBe(0);
    expect(series.data[0].itemStyle.opacity).toBe(1);
  });

  it('labels an unknown field as 未知 via the label formatter', () => {
    const option = buildTokenCompositionOption(compInput());
    const series = (option as any).series[0];
    expect(series.label.formatter({ data: series.data[2] })).toBe('未知');
    expect(series.label.formatter({ data: series.data[0] })).toContain('100');
  });

  it('labels an unknown field as Unknown in the English locale', () => {
    const option = buildTokenCompositionOption(compInput({ labels: { ...zhLabels, unknown: 'Unknown' } }));
    const series = (option as any).series[0];
    expect(series.label.formatter({ data: series.data[2] })).toBe('Unknown');
  });

  it('uses token teal, foreground, success, and warning colors per field', () => {
    const option = buildTokenCompositionOption(compInput());
    const series = (option as any).series[0];
    expect(series.data[0].itemStyle.color).toBe(colors.input);
    expect(series.data[1].itemStyle.color).toBe(colors.output);
    expect(series.data[2].itemStyle.color).toBe(colors.cacheRead);
    expect(series.data[3].itemStyle.color).toBe(colors.cacheWrite);
  });

  it('disables animation under reduced motion', () => {
    const option = buildTokenCompositionOption(compInput({ reducedMotion: true }));
    expect((option as any).animationDuration).toBe(0);
  });
});
