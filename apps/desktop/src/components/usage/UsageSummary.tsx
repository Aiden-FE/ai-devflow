// 使用统计 KPI 带：六个指标横向排列，tabular-nums，边框分隔，无阴影/嵌套卡片。
import React from 'react';
import type { UsageMetric } from '@ai-devflow/core';
import { useT } from '../../i18n/index.js';

function number(value: number | null | undefined, unknownLabel: string): string {
  if (value === null || value === undefined) return unknownLabel;
  return new Intl.NumberFormat().format(value);
}

function percent(value: number, unknownLabel: string): string {
  if (!Number.isFinite(value)) return unknownLabel;
  return `${Math.round(value * 100)}%`;
}

function duration(value: number | null | undefined, unknownLabel: string): string {
  if (value === null || value === undefined) return unknownLabel;
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`;
}

function successRate(metric: UsageMetric, unknownLabel: string): string {
  return metric.providerCalls > 0 ? percent(metric.succeeded / metric.providerCalls, unknownLabel) : unknownLabel;
}

export interface UsageSummaryProps {
  metric: UsageMetric;
}

/**
 * 六列 KPI：调用次数 / 成功率 / 平均耗时 / Token 总量 / Token 覆盖率 / 失败调用。
 * 调用次数附带逻辑请求数；覆盖率附带未知调用数（providerCalls - tokenKnownCalls）。
 */
export function UsageSummary({ metric }: UsageSummaryProps): React.ReactElement {
  const t = useT();
  const unknown = t('usage.unknown');
  const unknownCalls = Math.max(0, metric.providerCalls - metric.tokenKnownCalls);

  const kpis: Array<{ label: string; value: string; support?: string }> = [
    {
      label: t('usage.calls'),
      value: number(metric.providerCalls, unknown),
      support: t('usage.kpi.calls.support', { n: metric.logicalRequests }),
    },
    {
      label: t('usage.successRate'),
      value: successRate(metric, unknown),
    },
    {
      label: t('usage.avgDuration'),
      value: duration(metric.averageDurationMs, unknown),
    },
    {
      label: t('usage.totalTokens'),
      value: number(metric.tokens.total, unknown),
    },
    {
      label: t('usage.coverage'),
      value: percent(metric.tokenCoverage, unknown),
      support: t('usage.kpi.coverage.support', { n: unknownCalls }),
    },
    {
      label: t('usage.failedCalls'),
      value: number(metric.failed, unknown),
    },
  ];

  return (
    <section className="grid grid-cols-2 border-y border-border md:grid-cols-3 xl:grid-cols-6">
      {kpis.map((kpi, index) => (
        <div
          key={kpi.label}
          className={`min-w-0 px-4 py-3 ${index > 0 ? 'border-l border-border' : ''}`}
        >
          <div className="truncate text-xs text-muted-foreground">{kpi.label}</div>
          <div className="mt-1 text-xl font-semibold tabular-nums">{kpi.value}</div>
          {kpi.support ? (
            <div className="mt-0.5 truncate text-xs tabular-nums text-muted-foreground">{kpi.support}</div>
          ) : null}
        </div>
      ))}
    </section>
  );
}
