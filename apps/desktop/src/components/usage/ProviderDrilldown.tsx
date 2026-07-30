// 供应商下钻：选中某供应商时替换全局趋势/构成/对比表，保留页头与 KPI。
// 展示装饰后的供应商名称 + 模型 / 项目 / 工作负载 / 来源 / 失败类型分项。
import React from 'react';
import type { UsageAnalytics, UsageBreakdown } from '@ai-devflow/core';
import { useT } from '../../i18n/index.js';

function number(value: number | null, unknownLabel: string): string {
  return value === null ? unknownLabel : new Intl.NumberFormat().format(value);
}

export interface ProviderDrilldownProps {
  data: UsageAnalytics;
  providerLabel: string;
}

/**
 * 供应商下钻视图。Back 按钮由父级页头承载（onProviderSelect(undefined)）；
 * 此组件只渲染分项明细，不触发导航。
 */
export function ProviderDrilldown({ data, providerLabel }: ProviderDrilldownProps): React.ReactElement {
  const t = useT();
  const unknown = t('usage.unknown');

  const groups: Array<[string, UsageBreakdown[]]> = [
    [t('usage.models'), data.models],
    [t('usage.projects'), data.projects],
    [t('usage.workloads'), data.workloads],
    [t('usage.sources'), data.sources],
    [t('usage.failures'), data.failures.filter((row) => row.key)],
  ];

  return (
    <section className="flex flex-col gap-4">
      <p className="m-0 text-sm font-medium">{providerLabel}</p>
      <div className="grid gap-x-8 gap-y-5 md:grid-cols-2 xl:grid-cols-3">
        {groups
          .filter(([, rows]) => rows.length > 0)
          .map(([title, rows]) => (
            <div key={title} className="min-w-0">
              <h3 className="mb-1 text-sm font-semibold">{title}</h3>
              {rows.slice(0, 8).map((row) => (
                <div
                  key={row.key}
                  className="flex items-center justify-between gap-3 border-b border-border py-1.5 text-xs"
                >
                  <span className="truncate text-muted-foreground">{row.label}</span>
                  <span className="shrink-0 tabular-nums">
                    {number(row.providerCalls, unknown)} / {number(row.tokens.total, unknown)}
                  </span>
                </div>
              ))}
            </div>
          ))}
      </div>
    </section>
  );
}
