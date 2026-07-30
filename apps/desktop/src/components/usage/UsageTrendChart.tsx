// 每日调用趋势：纯 option 构造器 + 受控的 ECharts 包装与焦点切换。
// 构造器是纯函数（不读 DOM、不读 i18n、不读主题），所有本地化文案与解析后的
// CSS 颜色都由调用方通过 input 传入；组件层负责解析主题色与 aria-label。
import React, { useState } from 'react';
import type { EChartsCoreOption } from 'echarts/core';
import type { UsageAnalytics, UsageTimeBucket } from '@ai-devflow/core';
import { EChart } from './EChart.js';
import { useT } from '../../i18n/index.js';
import { cn } from '@/lib/utils';

export type UsageTrendMode = 'calls' | 'tokens' | 'successRate';

export interface UsageTrendColors {
  calls: string;
  tokens: string;
  success: string;
  grid: string;
  text: string;
}

export interface UsageTrendLabels {
  calls: string;
  tokens: string;
  succeeded: string;
  failed: string;
  totalTokens: string;
  coverage: string;
  successRate: string;
  date: string;
  unknown: string;
}

export interface UsageTrendInput {
  data: UsageAnalytics;
  mode: UsageTrendMode;
  colors: UsageTrendColors;
  labels: UsageTrendLabels;
  reducedMotion: boolean;
}

const TOKENS_OPACITY_DIMMED = 0.35;
const CALLS_OPACITY_DIMMED = 0.35;

function safeNumber(value: number | null): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function tokenTotalLabel(bucket: UsageTimeBucket, labels: UsageTrendLabels): string {
  return bucket.tokens.total === null ? labels.unknown : new Intl.NumberFormat().format(bucket.tokens.total);
}

/**
 * 构造每日调用趋势的 ECharts option。
 *
 * - calls 焦点：calls 折线全不透明、Token 柱状半透明。
 * - tokens 焦点：两者不透明度互换。
 * - successRate 焦点：以 0–100 百分比轴替换 Token 轴，仅渲染一条成功率折线。
 * - 共享 tooltip 始终汇报 日期 / 调用次数 / 成功 / 失败 / Token 总量 / 覆盖率。
 * - 所有日期分类直接来自 data.timeBuckets，不在渲染层再次采样或聚合。
 */
export function buildUsageTrendOption(input: UsageTrendInput): EChartsCoreOption {
  const { data, mode, colors, labels, reducedMotion } = input;
  const buckets = data.timeBuckets;
  const days = buckets.map((bucket) => bucket.day);
  const callsValues = buckets.map((bucket) => bucket.providerCalls);
  const tokenValues = buckets.map((bucket) => safeNumber(bucket.tokens.total));
  const successValues = buckets.map((bucket) =>
    bucket.providerCalls > 0 ? Math.round((bucket.succeeded / bucket.providerCalls) * 100) : 0,
  );

  const baseGrid = {
    left: 48,
    right: 24,
    top: 24,
    bottom: 32,
  };
  const axisLabelColor = { color: colors.text };
  const splitLineStyle = { lineStyle: { color: colors.grid, type: 'dashed' as const } };

  if (mode === 'successRate') {
    return {
      animationDuration: reducedMotion ? 0 : undefined,
      grid: baseGrid,
      tooltip: {
        trigger: 'axis',
        formatter: (params: Array<{ dataIndex: number; axisValue: string }>): string => {
          const bucket = buckets[params[0]?.dataIndex ?? 0];
          if (!bucket) return '';
          const rate = bucket.providerCalls > 0 ? Math.round((bucket.succeeded / bucket.providerCalls) * 100) : 0;
          return [
            `${labels.date}: ${params[0].axisValue}`,
            `${labels.calls}: ${bucket.providerCalls}`,
            `${labels.succeeded}: ${bucket.succeeded}`,
            `${labels.failed}: ${bucket.failed}`,
            `${labels.totalTokens}: ${tokenTotalLabel(bucket, labels)}`,
            `${labels.coverage}: ${Math.round(bucket.tokenCoverage * 100)}%`,
            `${labels.successRate}: ${rate}%`,
          ].join('\n');
        },
      },
      xAxis: {
        type: 'category',
        data: days,
        axisLabel: axisLabelColor,
        axisLine: { lineStyle: { color: colors.grid } },
      },
      yAxis: {
        type: 'value',
        min: 0,
        max: 100,
        axisLabel: { ...axisLabelColor, formatter: '{value}%' },
        splitLine: splitLineStyle,
      },
      series: [
        {
          name: labels.successRate,
          type: 'line',
          data: successValues,
          smooth: false,
          symbol: 'circle',
          symbolSize: 6,
          itemStyle: { color: colors.success },
          lineStyle: { color: colors.success, width: 2 },
        },
      ],
    };
  }

  const callsFocus = mode === 'calls';
  const callsLineOpacity = callsFocus ? 1 : CALLS_OPACITY_DIMMED;
  const tokensBarOpacity = callsFocus ? TOKENS_OPACITY_DIMMED : 1;

  return {
    animationDuration: reducedMotion ? 0 : undefined,
    grid: baseGrid,
    tooltip: {
      trigger: 'axis',
      formatter: (params: Array<{ dataIndex: number; axisValue: string }>): string => {
        const bucket = buckets[params[0]?.dataIndex ?? 0];
        if (!bucket) return '';
        return [
          `${labels.date}: ${params[0].axisValue}`,
          `${labels.calls}: ${bucket.providerCalls}`,
          `${labels.succeeded}: ${bucket.succeeded}`,
          `${labels.failed}: ${bucket.failed}`,
          `${labels.totalTokens}: ${tokenTotalLabel(bucket, labels)}`,
          `${labels.coverage}: ${Math.round(bucket.tokenCoverage * 100)}%`,
        ].join('\n');
      },
    },
    xAxis: {
      type: 'category',
      data: days,
      axisLabel: axisLabelColor,
      axisLine: { lineStyle: { color: colors.grid } },
    },
    yAxis: [
      {
        type: 'value',
        name: labels.calls,
        nameTextStyle: { color: colors.text },
        axisLabel: axisLabelColor,
        splitLine: splitLineStyle,
      },
      {
        type: 'value',
        name: labels.tokens,
        nameTextStyle: { color: colors.text },
        axisLabel: axisLabelColor,
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: labels.calls,
        type: 'line',
        data: callsValues,
        smooth: false,
        symbol: 'circle',
        symbolSize: 5,
        itemStyle: { color: colors.calls },
        lineStyle: { color: colors.calls, width: 2, opacity: callsLineOpacity },
        yAxisIndex: 0,
      },
      {
        name: labels.tokens,
        type: 'bar',
        data: tokenValues,
        barMaxWidth: 18,
        itemStyle: { color: colors.tokens, opacity: tokensBarOpacity },
        yAxisIndex: 1,
      },
    ],
  };
}

function resolveColor(name: string): string {
  if (typeof window === 'undefined') return '';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const FOCUS_OPTIONS: Array<{ mode: UsageTrendMode; key: string }> = [
  { mode: 'calls', key: 'usage.calls' },
  { mode: 'tokens', key: 'usage.totalTokens' },
  { mode: 'successRate', key: 'usage.successRate' },
];

export interface UsageTrendChartProps {
  data: UsageAnalytics;
  reducedMotion?: boolean;
}

export function UsageTrendChart({ data, reducedMotion = false }: UsageTrendChartProps): React.ReactElement {
  const t = useT();
  const [mode, setMode] = useState<UsageTrendMode>('calls');

  const colors: UsageTrendColors = {
    calls: resolveColor('--color-foreground'),
    tokens: resolveColor('--color-lane-in_review'),
    success: resolveColor('--color-ok'),
    grid: resolveColor('--color-border'),
    text: resolveColor('--color-muted-foreground'),
  };

  const labels: UsageTrendLabels = {
    calls: t('usage.calls'),
    tokens: t('usage.totalTokens'),
    succeeded: t('usage.calls'),
    failed: t('usage.calls'),
    totalTokens: t('usage.totalTokens'),
    coverage: t('usage.coverage'),
    successRate: t('usage.successRate'),
    date: t('usage.days', { n: 0 }),
    unknown: '未知',
  };

  const option = buildUsageTrendOption({ data, mode, colors, labels, reducedMotion });
  const ariaLabel = `${t('usage.trend')} · ${mode} · ${new Date(data.filters.startAt).toLocaleDateString()}–${new Date(data.filters.endAt).toLocaleDateString()}`;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1 rounded-md border border-border p-1">
        {FOCUS_OPTIONS.map((option) => (
          <button
            key={option.mode}
            type="button"
            aria-pressed={mode === option.mode}
            className={cn(
              'rounded px-3 py-1 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
              mode === option.mode ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
            )}
            onClick={() => setMode(option.mode)}
          >
            {t(option.key)}
          </button>
        ))}
      </div>
      <EChart option={option as unknown as Record<string, unknown>} ariaLabel={ariaLabel} />
    </section>
  );
}
