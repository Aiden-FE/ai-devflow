import React, { useMemo, useState } from 'react';
import type { UsageAnalytics } from '@ai-devflow/core';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { api, useAsync } from '../lib.js';
import { useT } from '../i18n/index.js';
import { Button } from '../components/ui/button.js';
import { EChart } from '../components/usage/EChart.js';
import { UsageSummary } from '../components/usage/UsageSummary.js';
import { ProviderComparisonTable } from '../components/usage/ProviderComparisonTable.js';
import { ProviderDrilldown } from '../components/usage/ProviderDrilldown.js';
import { buildUsageTrendOption, type UsageTrendMode } from '../components/usage/UsageTrendChart.js';
import { buildTokenCompositionOption } from '../components/usage/TokenCompositionChart.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function resolveColor(name: string): string {
  if (typeof window === 'undefined' || !window.getComputedStyle) return '';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
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
  const [trendMode, setTrendMode] = useState<UsageTrendMode>('calls');
  const [trendError, setTrendError] = useState(false);
  const [compositionError, setCompositionError] = useState(false);

  const selectedProvider = selectedProviderId
    ? data?.providers.find((provider) => provider.key === selectedProviderId)
    : undefined;

  const scopeLabel = selectedProviderId
    ? (selectedProvider?.label ?? t('usage.scope.selected'))
    : t('usage.scope.all');

  const reducedMotion = prefersReducedMotion();

  const trendOption = useMemo(() => {
    if (!data) return null;
    return buildUsageTrendOption({
      data,
      mode: trendMode,
      colors: {
        calls: resolveColor('--color-foreground'),
        tokens: resolveColor('--color-lane-in_review'),
        success: resolveColor('--color-ok'),
        grid: resolveColor('--color-border'),
        text: resolveColor('--color-muted-foreground'),
      },
      labels: {
        calls: t('usage.calls'),
        tokens: t('usage.totalTokens'),
        succeeded: t('usage.succeeded'),
        failed: t('usage.failedCalls'),
        totalTokens: t('usage.totalTokens'),
        coverage: t('usage.coverage'),
        successRate: t('usage.successRate'),
        date: t('usage.date'),
        unknown: t('usage.unknown'),
      },
      reducedMotion,
    });
  }, [data, trendMode, reducedMotion, t]);

  const compositionOption = useMemo(() => {
    if (!data) return null;
    return buildTokenCompositionOption({
      metric: data.summary,
      colors: {
        input: resolveColor('--color-lane-in_review'),
        output: resolveColor('--color-foreground'),
        cacheRead: resolveColor('--color-ok'),
        cacheWrite: resolveColor('--color-warn'),
        grid: resolveColor('--color-border'),
        text: resolveColor('--color-muted-foreground'),
      },
      labels: {
        input: t('usage.token.input'),
        output: t('usage.token.output'),
        cacheRead: t('usage.token.cacheRead'),
        cacheWrite: t('usage.token.cacheWrite'),
        unknown: t('usage.unknown'),
      },
      reducedMotion,
    });
  }, [data, reducedMotion, t]);

  const trendAriaLabel = `${t('usage.trend')} · ${t('usage.days', { n: days })}`;
  const compositionAriaLabel = `${t('usage.tokens')} · ${data ? `${data.summary.tokenKnownCalls}/${data.summary.providerCalls}` : ''}`;

  const focusOptions: Array<{ mode: UsageTrendMode; key: string }> = [
    { mode: 'calls', key: 'usage.calls' },
    { mode: 'tokens', key: 'usage.totalTokens' },
    { mode: 'successRate', key: 'usage.successRate' },
  ];

  return (
    <div data-testid="usage-shell" className="mx-auto flex w-full max-w-[1500px] flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {selectedProviderId && (
              <Button
                size="icon-sm"
                variant="ghost"
                title={t('usage.back')}
                aria-label={t('usage.back')}
                onClick={() => onProviderSelect(undefined)}
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
            )}
            <h2 className="m-0 text-xl font-semibold">{t('usage.title')}</h2>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{scopeLabel}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1 rounded-md border border-border p-1">
          {[7, 30, 90, 365].map((value) => (
            <Button
              key={value}
              size="sm"
              variant={days === value ? 'secondary' : 'ghost'}
              aria-pressed={days === value}
              onClick={() => onDaysChange?.(value)}
            >
              {t('usage.days', { n: value })}
            </Button>
          ))}
          <Button size="icon-sm" variant="ghost" title={t('usage.refresh')} aria-label={t('usage.refresh')} onClick={onRefresh}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </header>

      {error ? (
        <div role="alert" className="flex min-h-36 flex-col items-start gap-2 border-l-2 border-destructive px-4 py-6 text-sm text-destructive">
          <span>{error}</span>
          <Button size="sm" variant="outline" onClick={onRefresh}>{t('usage.retry')}</Button>
        </div>
      ) : loading && !data ? (
        <div
          data-testid="usage-skeleton"
          className="grid min-h-36 grid-cols-2 border-y border-border md:grid-cols-3 xl:grid-cols-6"
          aria-label={t('usage.loading')}
        >
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className={`min-w-0 px-4 py-3 ${index > 0 ? 'border-l border-border' : ''}`}>
              <div className="h-3 w-16 rounded bg-secondary" />
              <div className="mt-2 h-5 w-20 rounded bg-secondary/60" />
            </div>
          ))}
        </div>
      ) : !data || data.summary.providerCalls === 0 ? (
        <div className="flex min-h-36 flex-col items-center justify-center gap-2 border-y border-border text-sm text-muted-foreground">
          <span>{t('usage.empty')}</span>
          {days < 365 && onDaysChange ? (
            <Button size="sm" variant="outline" onClick={() => onDaysChange(365)}>
              {t('usage.empty.action')}
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          <UsageSummary metric={data.summary} />

          {selectedProviderId ? (
            <ProviderDrilldown data={data} providerLabel={scopeLabel} />
          ) : (
            <>
              <div className="grid gap-5 xl:grid-cols-12">
                <section className="flex flex-col gap-3 xl:col-span-8">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="m-0 text-sm font-semibold">{t('usage.trend')}</h3>
                    <div className="flex flex-wrap items-center gap-1 rounded-md border border-border p-1">
                      {focusOptions.map((option) => (
                        <button
                          key={option.mode}
                          type="button"
                          aria-pressed={trendMode === option.mode}
                          className={`rounded px-3 py-1 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${
                            trendMode === option.mode
                              ? 'bg-secondary text-foreground'
                              : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
                          }`}
                          onClick={() => setTrendMode(option.mode)}
                        >
                          {t(option.key)}
                        </button>
                      ))}
                    </div>
                  </div>
                  {trendError ? (
                    <div role="alert" className="flex min-h-36 flex-col items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-6 text-sm text-destructive">
                      <span>{t('usage.chart.error')}</span>
                      <Button size="sm" variant="outline" onClick={() => setTrendError(false)}>
                        {t('usage.chart.retry')}
                      </Button>
                    </div>
                  ) : trendOption ? (
                    <EChart
                      key={`trend-${trendMode}`}
                      option={trendOption as unknown as Record<string, unknown>}
                      ariaLabel={trendAriaLabel}
                      onError={() => setTrendError(true)}
                    />
                  ) : null}
                </section>

                <section className="flex flex-col gap-2 xl:col-span-4">
                  <h3 className="m-0 text-sm font-semibold">{t('usage.tokens')}</h3>
                  {compositionError ? (
                    <div role="alert" className="flex min-h-36 flex-col items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-6 text-sm text-destructive">
                      <span>{t('usage.chart.error')}</span>
                      <Button size="sm" variant="outline" onClick={() => setCompositionError(false)}>
                        {t('usage.chart.retry')}
                      </Button>
                    </div>
                  ) : compositionOption ? (
                    <>
                      <EChart
                        option={compositionOption as unknown as Record<string, unknown>}
                        ariaLabel={compositionAriaLabel}
                        onError={() => setCompositionError(true)}
                      />
                      <p className="text-xs tabular-nums text-muted-foreground">
                        {t('usage.coverage')}: {data.summary.tokenKnownCalls}/{data.summary.providerCalls}
                      </p>
                    </>
                  ) : null}
                </section>
              </div>

              <ProviderComparisonTable providers={data.providers} onSelect={onProviderSelect} />
            </>
          )}
        </>
      )}
    </div>
  );
}
