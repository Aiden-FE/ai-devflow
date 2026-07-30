# Usage Statistics Correctness and ECharts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist canonical Pi 0.80.10 Token usage, show stable user-facing provider names, and replace the usage page with the approved ECharts balanced-analysis dashboard.

**Architecture:** Keep the existing analytics types, SQLite schema, rollups, retention, and IPC shape. Repair no-ID assistant-message normalization in `packages/agents`, aggregate provider metrics by stable ID in `packages/persistence`, decorate labels in Electron Main, and keep chart state and rendering in focused Renderer components.

**Tech Stack:** TypeScript 5.7, Pi 0.80.10 JSON events, Node SQLite, Electron IPC/preload, React 18, ECharts 6 modular imports, Tailwind CSS, Lucide React, Vitest 2, happy-dom, Playwright, pnpm.

## Global Constraints

- Use ECharts for the time trend and Token composition visualizations.
- Consume Pi's canonical `input`, `output`, `cacheRead`, `cacheWrite`, and `totalTokens` fields from completed assistant messages.
- Never add `reasoning` or `cacheWrite1h` to their parent fields.
- Missing Token values remain `null`; do not estimate from content or rewrite historical rows.
- Preserve `TokenUsage`, `UsageAnalytics`, `UsageFilters`, typed IPC, existing database tables, daily rollups, and retention behavior.
- Provider IDs remain stable aggregation keys and filter values but never become unshortened user-facing fallback labels.
- Configured display name wins over snapshots; deleted or historical internal providers use `历史供应商 · 776f…da9b` / `Historical provider · 776f…da9b`.
- Do not add a database migration or mutate existing analytics history.
- Preserve the sidebar route, `data-testid="usage-shell"`, light/dark themes, Electron isolation, and local-only analytics.
- Use modular `echarts/core` imports; do not add a chart wrapper or CDN dependency.
- Preserve the approved 4 px spacing rhythm, 6 px control radius, maximum 8 px metric-surface radius, system font, and tabular numeric figures; do not scale fonts with viewport width.
- Keep normal UI feedback within 120-180 ms and chart updates near 240 ms; disable chart animation when `prefers-reduced-motion` is active.
- Preserve unrelated worktree changes. Several agent tests and fixtures are already modified; inspect each diff and use `git add -p` for overlapping files.

## File Structure

- `packages/agents/src/token-usage.ts` owns canonical usage normalization and per-attempt non-content fingerprint deduplication.
- `packages/persistence/src/provider-usage.ts` owns stable-ID aggregation and preferred stored snapshots.
- `apps/desktop/electron/usage-analytics.ts` owns provider label resolution and analytics decoration.
- `apps/desktop/electron/ipc.ts` validates filters, reads locale, and calls the decoration service.
- `apps/desktop/src/components/usage/EChart.tsx` owns ECharts initialization, option updates, resize, theme reaction, errors, and disposal.
- `apps/desktop/src/components/usage/UsageTrendChart.tsx` and `TokenCompositionChart.tsx` own pure option builders and chart-specific controls.
- `apps/desktop/src/components/usage/UsageSummary.tsx`, `ProviderComparisonTable.tsx`, and `ProviderDrilldown.tsx` own non-canvas data views.
- `apps/desktop/src/pages/UsageStats.tsx` remains the query and navigation controller.

---

### Task 1: Canonical No-ID Pi Token Capture

**Files:**
- Modify: `packages/agents/src/token-usage.ts`
- Modify: `packages/agents/src/__tests__/token-usage.test.ts`
- Modify: `packages/agents/src/__tests__/fixtures/fake-pi.mjs`
- Modify: `packages/agents/src/__tests__/pi-runner.test.ts`
- Modify: `apps/desktop/electron/__tests__/pi-ai-streaming.test.ts`

**Interfaces:**
- Preserves: `PiTokenUsageAccumulator.add(event: unknown): void`.
- Preserves: `PiTokenUsageAccumulator.snapshot(): TokenUsage`.
- Consumes: `message_end.message` first and `agent_end.messages` as fallback.
- Produces: one summed `TokenUsage` per provider attempt without storing or hashing message content.

- [ ] **Step 1: Replace ID-based fixtures with canonical Pi messages and write failing unit cases**

Use messages without `id`, with the stable non-content fields emitted by Pi:

```ts
const first = {
  role: 'assistant',
  timestamp: 1_753_824_000_000,
  provider: 'openai',
  model: 'gpt-5',
  responseId: 'resp-1',
  stopReason: 'toolUse',
  usage: {
    input: 100,
    output: 40,
    cacheRead: 20,
    cacheWrite: 5,
    totalTokens: 165,
    reasoning: 12,
    cacheWrite1h: 3,
  },
};
acc.add({ type: 'message_end', message: first });
acc.add({ type: 'agent_end', messages: [first] });
expect(acc.snapshot()).toEqual({
  input: 100,
  output: 40,
  cacheRead: 20,
  cacheWrite: 5,
  total: 165,
});
```

Add separate cases for two assistant tool-use turns with distinct timestamps, `agent_end` without a preceding `message_end`, user/tool-result exclusion, missing total derivation, and negative/fractional/unsafe/non-number rejection. Parameterize one canonical case over `provider: 'openai'` and `provider: 'anthropic'` to prove both protocols use the same normalized path.

Run: `pnpm --filter @ai-devflow/agents test -- src/__tests__/token-usage.test.ts`

Expected: FAIL because no-ID messages are currently rejected.

- [ ] **Step 2: Replace `messageIds` with a content-free message fingerprint**

Implement normalization and fingerprinting with stable field order:

```ts
function messageFingerprint(message: Record<string, unknown>, usage: TokenUsage): string {
  const text = (key: string): string | null =>
    typeof message[key] === 'string' ? message[key] as string : null;
  const timestamp = typeof message.timestamp === 'number' && Number.isSafeInteger(message.timestamp)
    ? message.timestamp
    : null;
  return JSON.stringify([
    timestamp,
    text('provider'),
    text('model'),
    text('responseId'),
    text('stopReason'),
    usage.input,
    usage.output,
    usage.cacheRead,
    usage.cacheWrite,
    usage.total,
  ]);
}
```

In `add`, ignore explicit non-assistant roles, normalize usage before fingerprinting, skip a previously accepted fingerprint, then add only non-null fields to `sums`. Keep canonical fields first in each alias list and ignore `reasoning` and `cacheWrite1h` completely.

- [ ] **Step 3: Verify unit normalization**

Run: `pnpm --filter @ai-devflow/agents test -- src/__tests__/token-usage.test.ts`

Expected: PASS for canonical no-ID messages, deduplication, fallback, invalid values, and unknown preservation.

- [ ] **Step 4: Make both runtime integration fixtures prove no-ID persistence**

Remove synthetic assistant `id` fields from the successful fake Pi events and `SUCCESS_EVENTS`. Add the same `timestamp`, `provider`, `model`, `responseId`, and `stopReason` to `message_end` and its repeated `agent_end` message. Keep the existing exact sink assertions:

```ts
expect(finish.value.usage).toEqual({
  input: 100,
  output: 40,
  cacheRead: 20,
  cacheWrite: 5,
  total: 165,
});
```

Add a text-executor case where the sink's `finish` throws after a valid completion and assert the returned assistant text is unchanged. Add a failure-before-terminal-message case and assert the finished usage is all-null.

- [ ] **Step 5: Verify both execution paths and commit only the relevant hunks**

Run: `pnpm --filter @ai-devflow/agents test -- src/__tests__/token-usage.test.ts src/__tests__/pi-runner.test.ts`

Run: `pnpm --filter @ai-devflow/desktop test -- electron/__tests__/pi-ai-streaming.test.ts`

Expected: PASS; retry/failover remains one usage row per attempt and analytics failures never change execution behavior.

```bash
git add -p packages/agents/src/token-usage.ts packages/agents/src/__tests__/token-usage.test.ts packages/agents/src/__tests__/fixtures/fake-pi.mjs packages/agents/src/__tests__/pi-runner.test.ts apps/desktop/electron/__tests__/pi-ai-streaming.test.ts
git commit -m "fix(analytics): capture canonical Pi token usage"
```

### Task 2: Stable Provider-ID Aggregation

**Files:**
- Modify: `packages/persistence/src/provider-usage.ts`
- Modify: `packages/persistence/src/__tests__/provider-usage.test.ts`

**Interfaces:**
- Preserves: `ProviderUsageRepo.query(filters: UsageFilters): UsageAnalytics`.
- Produces: exactly one `UsageBreakdown` per `provider_id`.
- Preserves: `UsageBreakdown.key` as the full stable provider ID.
- Produces: a preferred stored snapshot in `UsageBreakdown.label` for Main-process decoration.

- [ ] **Step 1: Write a failing rename and rollup aggregation test**

Seed one provider ID with three calls: a UUID snapshot, a later `Friendly Gateway` snapshot, and the same logical request retried across both names. Roll one old row into `provider_usage_daily` and leave the newer rows raw. Assert:

```ts
expect(result.providers).toHaveLength(1);
expect(result.providers[0]).toMatchObject({
  key: providerId,
  label: 'Friendly Gateway',
  providerCalls: 3,
  logicalRequests: 2,
});
```

Also assert totals and `tokenKnownCalls` include all three attempts exactly once.

Run: `pnpm --filter @ai-devflow/persistence test -- src/__tests__/provider-usage.test.ts`

Expected: FAIL because the current SQL groups by both ID and mutable name.

- [ ] **Step 2: Group metrics by ID and select a preferred snapshot separately**

Change the aggregate helper so provider rows group only by `provider_id`. Query the distinct `(provider_id, provider_name)` snapshots from the same `attempts` CTE, then rank names in TypeScript:

```ts
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUNTIME_NAME = /^ai-devflow-[0-9a-f]+$/i;

function isInternalSnapshot(providerId: string, value: string): boolean {
  const name = value.trim();
  return !name || name === providerId || UUID.test(name) || RUNTIME_NAME.test(name);
}

function preferredSnapshot(providerId: string, values: readonly string[]): string {
  return values.map((value) => value.trim()).find((value) => !isInternalSnapshot(providerId, value))
    ?? values.map((value) => value.trim()).find(Boolean)
    ?? providerId;
}
```

Keep logical-request counts sourced from `logicalCounts(..., 'provider_id')`, so each stable provider gets one distinct count even when names changed.

- [ ] **Step 3: Verify raw, rolled-up, and mixed aggregation**

Run: `pnpm --filter @ai-devflow/persistence test -- src/__tests__/provider-usage.test.ts`

Expected: PASS with one provider row before and after rollup; no schema or migration changes.

- [ ] **Step 4: Commit the stable aggregation boundary**

```bash
git add packages/persistence/src/provider-usage.ts packages/persistence/src/__tests__/provider-usage.test.ts
git commit -m "fix(persistence): aggregate usage by provider id"
```

### Task 3: Electron Provider Label Decoration

**Files:**
- Create: `apps/desktop/electron/usage-analytics.ts`
- Create: `apps/desktop/electron/__tests__/usage-analytics.test.ts`
- Modify: `apps/desktop/electron/ipc.ts`
- Modify: `apps/desktop/electron/__tests__/ipc.test.ts`

**Interfaces:**
- Produces: `resolveProviderDisplayName(input): string`.
- Produces: `createUsageAnalyticsService(options).query(filters): UsageAnalytics`.
- Consumes: `ProviderUsageRepo`, optional `Pick<ProviderStore, 'list'>`, and `() => Locale`.
- Preserves: Renderer `DesktopApi.analytics.query(filters)` and all `UsageAnalytics` types.

- [ ] **Step 1: Write failing resolver and decorator tests**

Cover configured-name priority, UUID-shaped configured names, valid deleted-provider snapshots, standard kinds, provider-ID snapshots, UUID snapshots, and runtime hashes. Include both locales:

```ts
expect(resolveProviderDisplayName({
  providerId: '776f5082-9779-4a15-8f3d-ac0b7068da9b',
  storedName: '776f5082-9779-4a15-8f3d-ac0b7068da9b',
  locale: 'zh',
})).toBe('历史供应商 · 776f…da9b');
```

Build a `UsageAnalytics` fixture and assert both `providers[].label` and `latestFailures[].providerName` use the same resolver while their full IDs remain unchanged.

Run: `pnpm --filter @ai-devflow/desktop test -- electron/__tests__/usage-analytics.test.ts`

Expected: FAIL because the service does not exist.

- [ ] **Step 2: Implement the pure resolver and query service**

Use this contract:

```ts
export interface ProviderDisplayNameInput {
  providerId: string;
  storedName: string;
  configuredName?: string;
  locale: Locale;
}

export function createUsageAnalyticsService(options: {
  usage: Pick<ProviderUsageRepo, 'query'>;
  providerStore?: Pick<ProviderStore, 'list'>;
  locale: () => Locale;
}): { query(filters: UsageFilters): UsageAnalytics };
```

Trim configured names first. Treat `openai`, `anthropic`, `google`, `deepseek`, and `openrouter` as standard labels. Treat equality with `providerId`, UUIDs, and `ai-devflow-<hex>` as internal. Shorten fallbacks with the first four and last four characters joined by `…`. Catch provider-store reads and continue with stored snapshots; never access `listConfigs`, secrets, encrypted payloads, or credential references.

- [ ] **Step 3: Route analytics IPC through the service and share locale parsing**

Extract the existing locale rule into a local helper:

```ts
const readLocale = (): Locale => repos.credentials.get('locale') === 'en' ? 'en' : 'zh';
const usageAnalytics = createUsageAnalyticsService({
  usage: repos.providerUsage,
  providerStore: services.providerStore,
  locale: readLocale,
});
```

Keep `validateUsageFilters(filters)` before the repository query. Reuse `readLocale` for `settings.getLocale` so both paths have the same default.

- [ ] **Step 4: Extend IPC coverage for current and historical providers**

In `ipc.test.ts`, configure a provider with `ProviderStore.save`, seed a row whose stored name is internal, and expect its configured display name. Seed an unconfigured UUID provider and a failed call, set locale to English, and assert the provider row and latest failure both contain `Historical provider · 776f…da9b` and never contain the full UUID as a label.

- [ ] **Step 5: Verify and commit**

Run: `pnpm --filter @ai-devflow/desktop test -- electron/__tests__/usage-analytics.test.ts electron/__tests__/ipc.test.ts`

Expected: PASS with filter validation unchanged.

```bash
git add apps/desktop/electron/usage-analytics.ts apps/desktop/electron/__tests__/usage-analytics.test.ts apps/desktop/electron/ipc.ts apps/desktop/electron/__tests__/ipc.test.ts
git commit -m "fix(desktop): resolve provider usage labels"
```

### Task 4: Modular ECharts Lifecycle Component

**Files:**
- Modify: `apps/desktop/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/desktop/src/components/usage/EChart.tsx`
- Create: `apps/desktop/src/__tests__/echart.test.tsx`

**Interfaces:**
- Produces: `EChartProps { option, ariaLabel, className?, onError? }`.
- Consumes: `useTheme().resolved` and modular ECharts features.
- Produces: a stable `role="img"` chart container and reports initialization/update failures without throwing through React.

- [ ] **Step 1: Add exact local dependencies**

Run: `pnpm --filter @ai-devflow/desktop add echarts@^6.0.0`

Run: `pnpm --filter @ai-devflow/desktop add -D happy-dom@^15.11.7`

Expected: `apps/desktop/package.json` and `pnpm-lock.yaml` change; no runtime CDN or wrapper is added.

- [ ] **Step 2: Write the failing lifecycle test**

Use `// @vitest-environment happy-dom`, mock `echarts/core.init`, and install a controllable `ResizeObserver`. Render with `createRoot` and assert:

```ts
expect(init).toHaveBeenCalledTimes(1);
expect(chart.setOption).toHaveBeenCalledWith(option, {
  notMerge: false,
  replaceMerge: ['series', 'xAxis', 'yAxis'],
});
resizeCallback();
expect(chart.resize).toHaveBeenCalledTimes(1);
root.unmount();
expect(chart.dispose).toHaveBeenCalledTimes(1);
expect(observer.disconnect).toHaveBeenCalledTimes(1);
```

Add cases for option/theme updates without a second `init`, and for `init`/`setOption` errors calling `onError` while leaving a stable container.

Run: `pnpm --filter @ai-devflow/desktop test -- src/__tests__/echart.test.tsx`

Expected: FAIL because `EChart` does not exist.

- [ ] **Step 3: Implement one shared modular ECharts component**

Register only `LineChart`, `BarChart`, `GridComponent`, `TooltipComponent`, `LegendComponent`, `AriaComponent`, and `CanvasRenderer`. Initialize once after mount, call `setOption` on option or resolved-theme changes, observe the container, disconnect and dispose on unmount, and catch both initialization and update errors.

Render a fixed responsive surface such as:

```tsx
<div
  ref={containerRef}
  role="img"
  aria-label={ariaLabel}
  className={cn('h-[240px] min-h-[200px] w-full', className)}
/>
```

- [ ] **Step 4: Verify lifecycle and commit**

Run: `pnpm --filter @ai-devflow/desktop test -- src/__tests__/echart.test.tsx`

Run: `pnpm --filter @ai-devflow/desktop typecheck`

Expected: PASS.

```bash
git add apps/desktop/package.json pnpm-lock.yaml apps/desktop/src/components/usage/EChart.tsx apps/desktop/src/__tests__/echart.test.tsx
git commit -m "feat(desktop): add modular ECharts lifecycle"
```

### Task 5: Pure Trend and Token Composition Charts

**Files:**
- Create: `apps/desktop/src/components/usage/UsageTrendChart.tsx`
- Create: `apps/desktop/src/components/usage/TokenCompositionChart.tsx`
- Create: `apps/desktop/src/__tests__/usage-chart-options.test.ts`

**Interfaces:**
- Produces: `UsageTrendMode = 'calls' | 'tokens' | 'successRate'`.
- Produces: `buildUsageTrendOption(input): EChartsCoreOption`.
- Produces: `buildTokenCompositionOption(input): EChartsCoreOption`.
- Consumes: `UsageAnalytics`, locale, resolved CSS colors, and reduced-motion preference.

- [ ] **Step 1: Write failing pure option-builder tests**

Use time buckets with known, partial, and unknown totals. Assert date categories, dual axes, calls line, Token bars, success percentages, theme colors, tooltip content, and `animationDuration: 0` under reduced motion. Assert all 365 supplied daily buckets remain present; do not sample or aggregate them again in Renderer.

For composition, assert an unknown field produces an invisible data item with an `未知`/`Unknown` label instead of a visible zero bar:

```ts
expect(series.data[2]).toMatchObject({ value: 0, missing: true });
expect(series.label.formatter({ data: series.data[2] })).toBe('未知');
```

Run: `pnpm --filter @ai-devflow/desktop test -- src/__tests__/usage-chart-options.test.ts`

Expected: FAIL because the builders do not exist.

- [ ] **Step 2: Implement the trend option builder and focus controls**

Always use daily dates and sparse horizontal grid lines. In `calls` focus, render the calls line at full opacity and Token columns at reduced opacity; in `tokens` focus, reverse those opacities. In `successRate`, replace the Token axis with a 0-100 percent axis and render one success-rate line. The shared tooltip always reports date, calls, succeeded, failed, total Tokens, and coverage from the original bucket.

Use foreground for calls, `--color-lane-in_review` for Tokens, `--color-ok` for success, and theme-derived grid/text colors. The segmented controls are real buttons with `aria-pressed` and visible focus. Build the chart `aria-label` from the active focus plus `data.filters.startAt/endAt`, so assistive technology receives the metric and date range.

- [ ] **Step 3: Implement Token composition without false zeroes**

Build four horizontal data items for input, output, cache read, and cache write. Known zero uses `{ value: 0, missing: false }`; unknown uses `{ value: 0, missing: true, itemStyle: { opacity: 0 } }`. Labels and tooltips consult `missing` before formatting. Use Token teal, foreground, success, and warning colors respectively. Render `tokenKnownCalls / providerCalls` as adjacent DOM text below the chart so coverage is available without Canvas.

- [ ] **Step 4: Verify pure behavior and commit**

Run: `pnpm --filter @ai-devflow/desktop test -- src/__tests__/usage-chart-options.test.ts`

Expected: PASS in the Node test environment without requiring Canvas.

```bash
git add apps/desktop/src/components/usage/UsageTrendChart.tsx apps/desktop/src/components/usage/TokenCompositionChart.tsx apps/desktop/src/__tests__/usage-chart-options.test.ts
git commit -m "feat(desktop): add usage analytics charts"
```

### Task 6: Balanced-Analysis Usage Dashboard

**Files:**
- Create: `apps/desktop/src/components/usage/UsageSummary.tsx`
- Create: `apps/desktop/src/components/usage/ProviderComparisonTable.tsx`
- Create: `apps/desktop/src/components/usage/ProviderDrilldown.tsx`
- Modify: `apps/desktop/src/pages/UsageStats.tsx`
- Modify: `apps/desktop/src/__tests__/usage-stats.test.tsx`
- Modify: `apps/desktop/src/i18n/zh.ts`
- Modify: `apps/desktop/src/i18n/en.ts`

**Interfaces:**
- Preserves: `UsageStatsPage()` and `UsageStatsViewProps` query/navigation contract.
- Preserves: provider IDs as `onProviderSelect` values.
- Produces: six KPIs, two analysis charts, provider comparison, and in-place drill-down.

- [ ] **Step 1: Expand failing page-state and interaction tests**

Mock `EChart` as an accessible `<div>` so SSR tests remain independent of Canvas. Assert the six KPI labels and values, including failed calls and a truly unknown total rendered as `未知`, not `--` or `0`.

Render the selected scope as the decorated provider label when available and as localized generic `所选供应商` / `Selected provider` while data is unavailable. Add a case with `selectedProviderId` set and no data, and assert the full ID never appears in visible text.

Add happy-dom interaction cases for:

```ts
await click(detailButton);
expect(onProviderSelect).toHaveBeenCalledWith('p1');
await click(backButton);
expect(onProviderSelect).toHaveBeenCalledWith(undefined);
expect(onDaysChange).not.toHaveBeenCalled();
```

Cover stable loading skeleton dimensions, empty-state 365-day action, retryable query error, partial Token values, deleted-provider scope label, and a chart error that leaves KPIs/table visible.

Run: `pnpm --filter @ai-devflow/desktop test -- src/__tests__/usage-stats.test.tsx`

Expected: FAIL against the current CSS-bar page.

- [ ] **Step 2: Build the approved six-column KPI band**

Render provider calls, success rate, average duration, total Tokens, Token coverage, and failed calls in that order. Calls include logical requests as supporting text; coverage includes `providerCalls - tokenKnownCalls` unknown calls. Use `grid-cols-2`, `md:grid-cols-3`, and `xl:grid-cols-6`, tabular figures, borders, no shadows, and no nested cards.

- [ ] **Step 3: Build provider comparison and drill-down**

The table columns are provider, calls, logical requests, success rate, average duration, total Tokens, coverage, and detail. Put horizontal overflow on the table wrapper with `min-w-[790px]`; never put it on the page.

When `selectedProviderId` is set, replace the global trend, composition, and comparison table with `ProviderDrilldown`. Keep the header and KPIs. Show the decorated provider label plus model, project, workload, source, and failure breakdown groups. Back calls only `onProviderSelect(undefined)`.

- [ ] **Step 4: Assemble query, chart, empty, error, and chart-failure states**

Keep the header order and 7/30/90/365 segmented control. Use an icon-only Lucide refresh button with a tooltip/title. Global analysis uses a 12-column grid with trend `xl:col-span-8` and composition `xl:col-span-4`; stack below `xl`.

Query error takes precedence over stale data and shows one retry button. Empty state offers `onDaysChange(365)` only when `days < 365`. Track chart failures independently and remount only the failed chart on retry; do not hide summary or provider comparison.

- [ ] **Step 5: Add exact bilingual copy**

Add keys for KPI support text, trend focus controls, chart aria labels, unknown values, empty-range action, retry actions, chart failure, provider table columns, and drill-down breakdown headings. Use `未知` and `Unknown` consistently; keep existing navigation and title keys.

- [ ] **Step 6: Verify page behavior and responsive classes**

Run: `pnpm --filter @ai-devflow/desktop test -- src/__tests__/usage-stats.test.tsx src/__tests__/usage-chart-options.test.ts src/__tests__/echart.test.tsx`

Run: `pnpm --filter @ai-devflow/desktop typecheck`

Expected: PASS with `data-testid="usage-shell"` present in every state.

- [ ] **Step 7: Commit the dashboard**

```bash
git add apps/desktop/src/components/usage/UsageSummary.tsx apps/desktop/src/components/usage/ProviderComparisonTable.tsx apps/desktop/src/components/usage/ProviderDrilldown.tsx apps/desktop/src/pages/UsageStats.tsx apps/desktop/src/__tests__/usage-stats.test.tsx apps/desktop/src/i18n/zh.ts apps/desktop/src/i18n/en.ts
git commit -m "feat(desktop): redesign provider usage dashboard"
```

### Task 7: Desktop Usage E2E and Final Verification

**Files:**
- Modify: `apps/desktop/scripts/run-e2e.mjs`

**Interfaces:**
- Consumes: existing Electron E2E application, temporary `userData`, and `window.api.analytics.query`.
- Produces: deterministic assertions for charts, UUID sanitization, drill-down, themes, and responsive overflow.

- [ ] **Step 1: Seed deterministic raw usage in the temporary database**

After the existing task and language flows complete, obtain `app.getPath('userData')` through Electron evaluation and use Node's `DatabaseSync` to clear `provider_usage`, `provider_usage_daily`, and `logical_request_daily` in this temporary E2E database only. Insert four current-time terminal `provider_usage` rows: three for the configured provider, one unconfigured UUID provider, three known totals, and one unknown total. Use two logical requests for the configured provider so attempts and requests visibly differ.

Close the seeding connection before querying through Renderer IPC. Do not add a production analytics-write API.

- [ ] **Step 2: Assert the real usage workflow and Canvas output**

Navigate by the `使用统计` button and assert KPI values, 75% Token coverage, two provider rows, and no body text matching a full UUID or `ai-devflow-[0-9a-f]+`. Assert at least two chart canvases have positive width/height and nontrivial `toDataURL()` output.

Open configured-provider detail, assert model/project/workload/source/failure groups, return, and confirm the 30-day button remains selected.

- [ ] **Step 3: Assert light, dark, wide, and minimum-window layouts**

At 1280x840 and 960x640, capture screenshots under the temporary `userData` directory and assert:

```js
const overflow = await win.evaluate(() => ({
  document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  table: document.querySelector('[data-testid="provider-table-scroll"]')?.scrollWidth ?? 0,
  tableClient: document.querySelector('[data-testid="provider-table-scroll"]')?.clientWidth ?? 0,
}));
check('使用统计无页面级横向溢出', overflow.document <= 2);
check('窄窗口供应商表局部滚动', overflow.table > overflow.tableClient);
```

Switch to dark theme through Settings, return to usage, and repeat the nonblank-chart assertion.

- [ ] **Step 4: Run the complete verification matrix**

Run: `pnpm --filter @ai-devflow/agents test -- src/__tests__/token-usage.test.ts src/__tests__/pi-runner.test.ts`

Run: `pnpm --filter @ai-devflow/persistence test -- src/__tests__/provider-usage.test.ts`

Run: `pnpm --filter @ai-devflow/desktop test -- electron/__tests__/usage-analytics.test.ts electron/__tests__/ipc.test.ts electron/__tests__/pi-ai-streaming.test.ts src/__tests__/echart.test.tsx src/__tests__/usage-chart-options.test.ts src/__tests__/usage-stats.test.tsx`

Run: `pnpm --filter @ai-devflow/desktop typecheck`

Run: `pnpm --filter @ai-devflow/desktop build`

Run: `pnpm --filter @ai-devflow/desktop e2e`

Expected: all commands PASS; screenshots show no overlap, clipping, blank chart, or page-level horizontal overflow.

- [ ] **Step 5: Commit the E2E coverage**

```bash
git add apps/desktop/scripts/run-e2e.mjs
git commit -m "test(desktop): cover usage analytics dashboard"
```
