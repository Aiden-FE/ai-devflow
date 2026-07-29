import React, { useMemo, useState } from 'react';
import type { UsageAnalytics, UsageBreakdown, UsageMetric } from '@ai-devflow/core';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { api, useAsync } from '../lib.js';
import { useT } from '../i18n/index.js';
import { Button } from '../components/ui/button.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function number(value: number | null): string {
  return value === null ? '--' : new Intl.NumberFormat().format(value);
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function duration(value: number | null): string {
  if (value === null) return '--';
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`;
}

function successRate(metric: UsageMetric): string {
  return metric.providerCalls > 0 ? percent(metric.succeeded / metric.providerCalls) : '--';
}

export function UsageStatsPage(): React.ReactElement {
  const [days, setDays] = useState(30);
  const [providerId, setProviderId] = useState<string | undefined>();
  const range = useMemo(() => {
    const endAt = Date.now();
    return { startAt: endAt - days * DAY_MS, endAt };
  }, [days]);
  const query = useAsync(
    () => api.analytics.query({ ...range, providerId }),
    [range.startAt, range.endAt, providerId],
  );

  return (
    <UsageStatsView
      data={query.data}
      loading={query.loading}
      error={query.error}
      days={days}
      selectedProviderId={providerId}
      onDaysChange={setDays}
      onProviderSelect={setProviderId}
      onRefresh={query.reload}
    />
  );
}

export interface UsageStatsViewProps {
  data?: UsageAnalytics;
  loading: boolean;
  error?: string;
  days?: number;
  selectedProviderId?: string;
  onDaysChange?: (days: number) => void;
  onProviderSelect: (providerId: string | undefined) => void;
  onRefresh?: () => void;
}

export function UsageStatsView({
  data,
  loading,
  error,
  days = 30,
  selectedProviderId,
  onDaysChange,
  onProviderSelect,
  onRefresh,
}: UsageStatsViewProps): React.ReactElement {
  const t = useT();
  const selectedProvider = selectedProviderId
    ? data?.providers.find((provider) => provider.key === selectedProviderId)
    : undefined;

  return (
    <div data-testid="usage-shell" className="mx-auto flex w-full max-w-[1500px] flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {selectedProviderId && (
              <Button size="icon-sm" variant="ghost" title={t('usage.back')} onClick={() => onProviderSelect(undefined)}>
                <ArrowLeft className="h-4 w-4" />
              </Button>
            )}
            <h2 className="m-0 text-xl font-semibold">{t('usage.title')}</h2>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {selectedProvider?.label ?? (selectedProviderId ? selectedProviderId : t('usage.scope.all'))}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1 rounded-md border border-border p-1">
          {[7, 30, 90, 365].map((value) => (
            <Button key={value} size="sm" variant={days === value ? 'secondary' : 'ghost'} onClick={() => onDaysChange?.(value)}>
              {t('usage.days', { n: value })}
            </Button>
          ))}
          <Button size="icon-sm" variant="ghost" title={t('usage.refresh')} onClick={onRefresh}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </header>

      {error ? (
        <div className="min-h-36 border-l-2 border-destructive px-4 py-6 text-sm text-destructive">{error}</div>
      ) : loading && !data ? (
        <div className="flex min-h-36 items-center justify-center text-sm text-muted-foreground">{t('usage.loading')}</div>
      ) : !data || data.summary.providerCalls === 0 ? (
        <div className="flex min-h-36 items-center justify-center border-y border-border text-sm text-muted-foreground">{t('usage.empty')}</div>
      ) : (
        <>
          <Summary metric={data.summary} />
          <TokenStrip metric={data.summary} />
          <Trend data={data} />
          <ProviderTable providers={data.providers} onSelect={onProviderSelect} />
          <Breakdowns data={data} />
        </>
      )}
    </div>
  );
}

function Summary({ metric }: { metric: UsageMetric }): React.ReactElement {
  const t = useT();
  const values = [
    [t('usage.calls'), number(metric.providerCalls)],
    [t('usage.requests'), number(metric.logicalRequests)],
    [t('usage.successRate'), successRate(metric)],
    [t('usage.avgDuration'), duration(metric.averageDurationMs)],
    [t('usage.totalTokens'), number(metric.tokens.total)],
    [t('usage.coverage'), percent(metric.tokenCoverage)],
  ];
  return (
    <section className="grid grid-cols-2 border-y border-border sm:grid-cols-3 xl:grid-cols-6">
      {values.map(([label, value], index) => (
        <div key={label} className={`min-w-0 px-4 py-3 ${index > 0 ? 'border-l border-border' : ''}`}>
          <div className="truncate text-xs text-muted-foreground">{label}</div>
          <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
        </div>
      ))}
    </section>
  );
}

function TokenStrip({ metric }: { metric: UsageMetric }): React.ReactElement {
  const t = useT();
  const tokens = [
    [t('usage.token.input'), metric.tokens.input],
    [t('usage.token.output'), metric.tokens.output],
    [t('usage.token.cacheRead'), metric.tokens.cacheRead],
    [t('usage.token.cacheWrite'), metric.tokens.cacheWrite],
  ] as const;
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold">{t('usage.tokens')}</h3>
      <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
        {tokens.map(([label, value]) => (
          <div key={label} className="flex min-w-0 items-baseline justify-between gap-3 border-b border-border pb-2">
            <span className="truncate text-xs text-muted-foreground">{label}</span>
            <span className="font-medium tabular-nums">{number(value)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function Trend({ data }: { data: UsageAnalytics }): React.ReactElement {
  const t = useT();
  const max = Math.max(1, ...data.timeBuckets.map((bucket) => bucket.providerCalls));
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold">{t('usage.trend')}</h3>
      <div className="grid h-36 grid-flow-col auto-cols-[minmax(22px,1fr)] items-end gap-1 overflow-x-auto border-b border-border px-1 pt-3">
        {data.timeBuckets.map((bucket) => (
          <div key={bucket.day} className="group flex h-full min-w-0 flex-col justify-end gap-1" title={`${bucket.day}: ${bucket.providerCalls}`}>
            <div className="mx-auto text-[10px] tabular-nums text-muted-foreground opacity-0 group-hover:opacity-100">{bucket.providerCalls}</div>
            <div className="min-h-1 w-full bg-primary/75" style={{ height: `${Math.max(4, bucket.providerCalls / max * 92)}px` }} />
            <div className="truncate text-center text-[10px] text-muted-foreground">{bucket.day.slice(5)}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ProviderTable({ providers, onSelect }: { providers: UsageBreakdown[]; onSelect: (id: string) => void }): React.ReactElement {
  const t = useT();
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold">{t('usage.providers')}</h3>
      <div className="overflow-x-auto border-y border-border">
        <table className="w-full min-w-[680px] border-collapse text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr>{[t('usage.provider'), t('usage.calls'), t('usage.requests'), t('usage.successRate'), t('usage.totalTokens'), t('usage.coverage'), ''].map((label, index) => <th key={`${label}-${index}`} className="px-3 py-2 font-medium">{label}</th>)}</tr>
          </thead>
          <tbody>
            {providers.map((provider) => (
              <tr key={provider.key} className="border-t border-border">
                <td className="px-3 py-2 font-medium">{provider.label}</td>
                <td className="px-3 py-2 tabular-nums">{number(provider.providerCalls)}</td>
                <td className="px-3 py-2 tabular-nums">{number(provider.logicalRequests)}</td>
                <td className="px-3 py-2 tabular-nums">{successRate(provider)}</td>
                <td className="px-3 py-2 tabular-nums">{number(provider.tokens.total)}</td>
                <td className="px-3 py-2 tabular-nums">{percent(provider.tokenCoverage)}</td>
                <td className="px-3 py-2 text-right"><Button size="sm" variant="ghost" onClick={() => onSelect(provider.key)}>{t('usage.detail')}</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Breakdowns({ data }: { data: UsageAnalytics }): React.ReactElement {
  const t = useT();
  const groups: Array<[string, UsageBreakdown[]]> = [
    [t('usage.models'), data.models],
    [t('usage.projects'), data.projects],
    [t('usage.workloads'), data.workloads],
    [t('usage.sources'), data.sources],
    [t('usage.failures'), data.failures.filter((row) => row.key)],
  ];
  return (
    <section className="grid gap-x-8 gap-y-5 md:grid-cols-2 xl:grid-cols-3">
      {groups.filter(([, rows]) => rows.length > 0).map(([title, rows]) => (
        <div key={title} className="min-w-0">
          <h3 className="mb-1 text-sm font-semibold">{title}</h3>
          {rows.slice(0, 8).map((row) => (
            <div key={row.key} className="flex items-center justify-between gap-3 border-b border-border py-1.5 text-xs">
              <span className="truncate text-muted-foreground">{row.label}</span>
              <span className="shrink-0 tabular-nums">{row.providerCalls} / {number(row.tokens.total)}</span>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}
