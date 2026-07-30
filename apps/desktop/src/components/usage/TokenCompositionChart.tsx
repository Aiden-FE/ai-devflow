// Token 构成：纯 option 构造器 + 受控的 ECharts 包装与覆盖率 DOM 文本。
// 构造器是纯函数（不读 DOM、不读 i18n、不读主题），所有本地化文案与解析后的
// CSS 颜色都由调用方通过 input 传入；组件层负责解析主题色与覆盖率的非 Canvas 文本。
import React from 'react';
import type { EChartsCoreOption } from 'echarts/core';
import type { UsageMetric } from '@ai-devflow/core';
import { EChart } from './EChart.js';
import { useT } from '../../i18n/index.js';

export interface TokenCompositionColors {
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
  grid: string;
  text: string;
}

export interface TokenCompositionLabels {
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
  unknown: string;
}

export interface TokenCompositionInput {
  metric: UsageMetric;
  colors: TokenCompositionColors;
  labels: TokenCompositionLabels;
  reducedMotion: boolean;
}

interface CompositionDataItem {
  value: number;
  missing: boolean;
  itemStyle: { color: string; opacity: number };
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

/**
 * 构造 Token 构成的 ECharts option。
 *
 * 渲染四条横向条目：输入 / 输出 / 缓存读取 / 缓存写入。
 * 已知零为 `{ value: 0, missing: false }`；未知字段为不可见的
 * `{ value: 0, missing: true, itemStyle: { opacity: 0 } }`，避免把缺失值画成可见的零柱。
 * 标签与 tooltip 在格式化前先检查 `missing`，未知返回本地化的 `未知`/`Unknown`。
 */
export function buildTokenCompositionOption(input: TokenCompositionInput): EChartsCoreOption {
  const { metric, colors, labels, reducedMotion } = input;
  const fields: Array<{ label: string; value: number | null; color: string }> = [
    { label: labels.input, value: metric.tokens.input, color: colors.input },
    { label: labels.output, value: metric.tokens.output, color: colors.output },
    { label: labels.cacheRead, value: metric.tokens.cacheRead, color: colors.cacheRead },
    { label: labels.cacheWrite, value: metric.tokens.cacheWrite, color: colors.cacheWrite },
  ];

  const data: CompositionDataItem[] = fields.map((field) => {
    const missing = field.value === null;
    const value: number = field.value === null ? 0 : field.value;
    return {
      value,
      missing,
      itemStyle: { color: field.color, opacity: missing ? 0 : 1 },
    };
  });

  return {
    animationDuration: reducedMotion ? 0 : undefined,
    grid: { left: 96, right: 24, top: 16, bottom: 24 },
    tooltip: {
      trigger: 'item',
      formatter: (params: { data: CompositionDataItem; name: string }): string => {
        if (params.data.missing) return `${params.name}: ${labels.unknown}`;
        return `${params.name}: ${formatNumber(params.data.value)}`;
      },
    },
    xAxis: {
      type: 'value',
      axisLabel: { color: colors.text },
      splitLine: { lineStyle: { color: colors.grid, type: 'dashed' } },
    },
    yAxis: {
      type: 'category',
      data: fields.map((field) => field.label),
      inverse: true,
      axisLabel: { color: colors.text },
      axisLine: { lineStyle: { color: colors.grid } },
    },
    series: [
      {
        type: 'bar',
        data,
        barMaxWidth: 22,
        label: {
          show: true,
          position: 'right',
          formatter: (params: { data: CompositionDataItem }): string =>
            params.data.missing ? labels.unknown : formatNumber(params.data.value),
        },
      },
    ],
  };
}

function resolveColor(name: string): string {
  if (typeof window === 'undefined') return '';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export interface TokenCompositionChartProps {
  metric: UsageMetric;
  reducedMotion?: boolean;
}

export function TokenCompositionChart({ metric, reducedMotion = false }: TokenCompositionChartProps): React.ReactElement {
  const t = useT();

  const colors: TokenCompositionColors = {
    input: resolveColor('--color-lane-in_review'),
    output: resolveColor('--color-foreground'),
    cacheRead: resolveColor('--color-ok'),
    cacheWrite: resolveColor('--color-warn'),
    grid: resolveColor('--color-border'),
    text: resolveColor('--color-muted-foreground'),
  };

  const labels: TokenCompositionLabels = {
    input: t('usage.token.input'),
    output: t('usage.token.output'),
    cacheRead: t('usage.token.cacheRead'),
    cacheWrite: t('usage.token.cacheWrite'),
    unknown: '未知',
  };

  const option = buildTokenCompositionOption({ metric, colors, labels, reducedMotion });
  const ariaLabel = `${t('usage.tokens')} · ${metric.tokenKnownCalls}/${metric.providerCalls}`;

  return (
    <section className="flex flex-col gap-2">
      <EChart option={option as unknown as Record<string, unknown>} ariaLabel={ariaLabel} className="h-[200px] min-h-[180px]" />
      <p className="text-xs tabular-nums text-muted-foreground">
        {t('usage.coverage')}: {metric.tokenKnownCalls}/{metric.providerCalls}
      </p>
    </section>
  );
}
