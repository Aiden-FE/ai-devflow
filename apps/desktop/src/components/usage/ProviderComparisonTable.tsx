// 供应商对比表：横向滚动限定在表格包装层（min-w-[790px]），页面永不横向溢出。
import React from 'react';
import type { UsageBreakdown } from '@ai-devflow/core';
import { useT } from '../../i18n/index.js';
import { Button } from '../ui/button.js';

function number(value: number | null, unknownLabel: string): string {
  return value === null ? unknownLabel : new Intl.NumberFormat().format(value);
}

function percent(value: number, unknownLabel: string): string {
  if (!Number.isFinite(value)) return unknownLabel;
  return `${Math.round(value * 100)}%`;
}

function duration(value: number | null, unknownLabel: string): string {
  if (value === null) return unknownLabel;
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`;
}

function successRate(row: UsageBreakdown, unknownLabel: string): string {
  return row.providerCalls > 0 ? percent(row.succeeded / row.providerCalls, unknownLabel) : unknownLabel;
}

export interface ProviderComparisonTableProps {
  providers: UsageBreakdown[];
  onSelect: (providerId: string) => void;
}

/**
 * 供应商对比表。列顺序：供应商 / 调用次数 / 逻辑请求 / 成功率 / 平均耗时 / Token 总量 / 覆盖率 / 详情。
 * 横向滚动放在带 `data-testid="provider-table-scroll"` 与 `min-w-[790px]` 的包装层。
 */
export function ProviderComparisonTable({ providers, onSelect }: ProviderComparisonTableProps): React.ReactElement {
  const t = useT();
  const unknown = t('usage.unknown');
  const headers = [
    t('usage.provider'),
    t('usage.calls'),
    t('usage.requests'),
    t('usage.successRate'),
    t('usage.avgDuration'),
    t('usage.totalTokens'),
    t('usage.coverage'),
    '',
  ];

  return (
    <section className="flex flex-col gap-2">
      <h3 className="m-0 text-sm font-semibold">{t('usage.providers')}</h3>
      <div className="overflow-x-auto border-y border-border" data-testid="provider-table-scroll">
        <table className="w-full min-w-[790px] border-collapse text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              {headers.map((label, index) => (
                <th key={`${label}-${index}`} className="px-3 py-2 font-medium">{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {providers.map((provider) => (
              <tr key={provider.key} className="border-t border-border">
                <td className="px-3 py-2 font-medium">{provider.label}</td>
                <td className="px-3 py-2 tabular-nums">{number(provider.providerCalls, unknown)}</td>
                <td className="px-3 py-2 tabular-nums">{number(provider.logicalRequests, unknown)}</td>
                <td className="px-3 py-2 tabular-nums">{successRate(provider, unknown)}</td>
                <td className="px-3 py-2 tabular-nums">{duration(provider.averageDurationMs, unknown)}</td>
                <td className="px-3 py-2 tabular-nums">{number(provider.tokens.total, unknown)}</td>
                <td className="px-3 py-2 tabular-nums">{percent(provider.tokenCoverage, unknown)}</td>
                <td className="px-3 py-2 text-right">
                  <Button size="sm" variant="ghost" onClick={() => onSelect(provider.key)}>{t('usage.detail')}</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
