# Provider Usage Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture every new provider route attempt with Token usage, expose global and provider-specific analytics, and bound database growth with tiered retention.

**Architecture:** Add canonical analytics types in core and a v15 SQLite usage schema with raw and daily rollup repositories. Inject one best-effort usage sink into both PiRunner and text-AI execution, aggregate in Main, render a global statistics page, and run a bounded retention service from Electron startup.

**Tech Stack:** TypeScript 5.7, Node SQLite, Electron IPC/preload, React 18, Tailwind CSS, Lucide React, Vitest 2, Playwright, pnpm.

## Global Constraints

- Store input, output, cache-read, cache-write, and total Token values; do not store or calculate cost.
- Missing historical or runtime Token values remain `NULL`, never zero.
- Never store prompts, response text, API keys, credential references, or other secrets in analytics tables.
- Historical task attempts are backfilled; historical chat calls and unknown models are not fabricated.
- Default retention is 90 days for terminal execution details, 180 days for archived-task conversations, and 365 days for raw provider calls.
- No chart dependency is added; use stable CSS grid/bar primitives consistent with the existing application.
- Existing dirty changes in Electron AI cancellation and provider routing must be preserved and integrated.

## File Structure

- `packages/core/src/analytics.ts` owns canonical records, filters, aggregates, Token usage, and retention policy.
- `packages/persistence/src/migrations/provider-usage-migration-v15.ts` owns schema creation and historical backfill.
- `packages/persistence/src/provider-usage.ts` owns raw writes, recovery, rollups, pruning, and aggregate queries.
- `packages/agents/src/token-usage.ts` owns Pi event usage normalization and deduplication.
- `packages/agents/src/pi-runner.ts` records scheduler route attempts.
- `apps/desktop/electron/pi-ai.ts` records text-AI route attempts.
- `apps/desktop/electron/retention.ts` owns scheduling and retention settings.
- `apps/desktop/src/pages/UsageStats.tsx` owns the statistics UI.

---

### Task 1: Canonical Analytics Types and SQLite Migration

**Files:**
- Create: `packages/core/src/analytics.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/persistence/src/migrations/provider-usage-migration-v15.ts`
- Modify: `packages/persistence/src/migrations.ts`
- Create: `packages/persistence/src/__tests__/provider-usage-migration-v15.test.ts`

**Interfaces:**
- Produces: `TokenUsage`, `ProviderCallRecord`, `ProviderCallStart`, `ProviderCallFinish`, `UsageFilters`, `UsageAnalytics`, `RetentionPolicy`.
- Produces schema version 15 tables `provider_usage`, `provider_usage_daily`, `logical_request_daily`.

- [ ] **Step 1: Write the failing migration test**

Open an in-memory database at v14, seed a project, task, execution, and two `execution_attempts`, then migrate to v15. Assert:

```ts
expect(getCurrentVersion(db)).toBe(15);
expect(rows).toMatchObject([
  {
    id: 'legacy:a1', logical_request_id: 'e1', provider_id: 'p1',
    model: null, input_tokens: null, output_tokens: null,
    project_id: 'p', task_id: 't', source: 'task_agent',
  },
]);
```

Run: `pnpm --filter @ai-devflow/persistence test -- src/__tests__/provider-usage-migration-v15.test.ts`

Expected: FAIL because v15 does not exist.

- [ ] **Step 2: Define exact core types**

```ts
export interface TokenUsage {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  total: number | null;
}

export type ProviderCallStatus = 'running' | 'succeeded' | 'failed' | 'canceled' | 'interrupted';
export type ProviderCallSource =
  | 'task_agent' | 'review_agent' | 'knowledge_agent'
  | 'requirement_chat' | 'task_chat' | 'requirement_proposal'
  | 'task_proposal' | 'ux_consultation' | 'connection_test';

export interface RetentionPolicy {
  executionDetailDays: number;
  archivedConversationDays: number;
  providerRawDays: number;
}
```

Include concrete filter and response types for the fields in the approved design. Export from core index.

- [ ] **Step 3: Create the v15 schema**

`provider_usage` stores all immutable dimensions and nullable Token columns. Add indexes on `(started_at)`, `(provider_id, started_at)`, `(project_id, started_at)`, and `(logical_request_id)`.

`provider_usage_daily` stores provider-attempt aggregates keyed by day plus provider/model/project/workload/source/status/failure kind.

`logical_request_daily` stores compact membership rows keyed by day,
`logical_request_id`, filter dimensions, and a `grain` column (`global` or
`provider`). Global rows omit provider identity; provider rows retain it. This
lets queries use `COUNT(DISTINCT logical_request_id)` across rolled and raw data
without double counting a request that is split across cleanup batches.

Backfill `execution_attempts` using deterministic `legacy:` IDs, `execution_id` as logical request ID, task/project joins, provider/workload parsed from `route_id`, and `NULL` Token/model fields. Use `INSERT OR IGNORE` for migration idempotence.

- [ ] **Step 4: Verify migration and commit**

Run: `pnpm --filter @ai-devflow/core typecheck`

Run: `pnpm --filter @ai-devflow/persistence test -- src/__tests__/provider-usage-migration-v15.test.ts`

Expected: PASS.

```bash
git add packages/core/src/analytics.ts packages/core/src/index.ts packages/persistence/src/migrations/provider-usage-migration-v15.ts packages/persistence/src/migrations.ts packages/persistence/src/__tests__/provider-usage-migration-v15.test.ts
git commit -m "feat(persistence): add provider usage schema"
```

### Task 2: Usage Repository, Aggregation, and Recovery

**Files:**
- Create: `packages/persistence/src/provider-usage.ts`
- Create: `packages/persistence/src/__tests__/provider-usage.test.ts`
- Modify: `packages/persistence/src/repositories.ts`
- Modify: `packages/persistence/src/index.ts`

**Interfaces:**
- Produces `ProviderUsageRepo`:

```ts
interface ProviderUsageRepo {
  start(input: ProviderCallStart): ProviderCallRecord;
  finish(id: string, input: ProviderCallFinish): void;
  recoverInterrupted(at: number): number;
  query(filters: UsageFilters): UsageAnalytics;
  rollupAndPrune(before: number, batchSize: number): { rolledUp: number; deleted: number };
}
```

- Adds `providerUsage: ProviderUsageRepo` to `Repositories`.

- [ ] **Step 1: Write failing CRUD and recovery tests**

Start a record, finish it with success and Token usage, and assert exact persisted values. Start a second record and call `recoverInterrupted(500)`; assert status `interrupted`, `endedAt=500`, and duration derived from start.

Verify finishing an unknown ID throws and a duplicate finish cannot overwrite a terminal record.

Run: `pnpm --filter @ai-devflow/persistence test -- src/__tests__/provider-usage.test.ts`

Expected: FAIL because the repository does not exist.

- [ ] **Step 2: Implement raw writes and recovery**

Use prepared statements and validate all Token values as non-negative finite integers or `null`. `finish` updates only `WHERE id=? AND status='running'` and requires exactly one changed row.

- [ ] **Step 3: Write failing aggregate-query tests**

Seed calls spanning two providers, models, projects, sources, statuses, and dates. Assert:

```ts
expect(result.summary).toMatchObject({
  providerCalls: 4,
  logicalRequests: 3,
  succeeded: 3,
  totalTokens: 360,
  tokenKnownCalls: 3,
  tokenCoverage: 0.75,
});
```

Verify provider, project, model, workload, source, status, and explicit date filters independently and in combination.

- [ ] **Step 4: Implement aggregate queries**

Build SQL from a fixed whitelist of filter clauses and bound values. Return summary, time buckets, provider/model/project/workload/source/failure breakdowns, and at most 20 sanitized latest failures. Distinct logical requests use `COUNT(DISTINCT logical_request_id)` while raw rows exist.

- [ ] **Step 5: Write failing rollup tests**

Seed retry and failover records sharing a logical request. Roll up the old day and assert:

- provider attempts remain two calls;
- global logical requests remain one;
- each participating provider reports one provider-filtered logical request;
- Token totals and known-count coverage are preserved;
- querying raw plus rollup does not double count the boundary;
- placing attempts for one logical request in separate prune batches still
  produces one global request and one request per participating provider.

- [ ] **Step 6: Implement transactional rollup and bounded deletion**

Select at most `batchSize` eligible raw rows, add their provider-attempt sums to
`provider_usage_daily`, and insert global/provider logical-request membership
rows with `INSERT OR IGNORE`; then delete exactly that selected raw batch inside
the same transaction. Re-running must be idempotent. Queries union raw logical
request IDs with the matching membership grain before applying
`COUNT(DISTINCT logical_request_id)`, so partially pruned days remain correct.

- [ ] **Step 7: Verify and commit**

Run: `pnpm --filter @ai-devflow/persistence test -- src/__tests__/provider-usage.test.ts`

Expected: PASS.

```bash
git add packages/persistence/src/provider-usage.ts packages/persistence/src/__tests__/provider-usage.test.ts packages/persistence/src/repositories.ts packages/persistence/src/index.ts
git commit -m "feat(persistence): aggregate provider usage"
```

### Task 3: Pi Token Normalization and Scheduler Usage Capture

**Files:**
- Create: `packages/agents/src/token-usage.ts`
- Create: `packages/agents/src/__tests__/token-usage.test.ts`
- Modify: `packages/agents/src/index.ts`
- Modify: `packages/agents/src/json-events.ts`
- Modify: `packages/agents/src/pi-runner.ts`
- Modify: `packages/agents/src/__tests__/pi-runner.test.ts`
- Modify: `apps/desktop/electron/pi-runtime.ts`

**Interfaces:**
- Produces: `PiTokenUsageAccumulator.add(event: unknown): void` and `.snapshot(): TokenUsage`.
- Produces: `ProviderUsageSink` with best-effort `start` and `finish` methods.
- Extends `PiEventTranslator` with `usage(): TokenUsage`.

- [ ] **Step 1: Write failing Token normalization tests**

Feed canonical Pi events:

```ts
acc.add({
  type: 'message_end',
  message: { id: 'm1', usage: { input: 100, output: 40, cacheRead: 20, cacheWrite: 5, totalTokens: 165 } },
});
acc.add({
  type: 'agent_end',
  messages: [{ id: 'm1', usage: { input: 100, output: 40, cacheRead: 20, cacheWrite: 5, totalTokens: 165 } }],
});
expect(acc.snapshot()).toEqual({ input: 100, output: 40, cacheRead: 20, cacheWrite: 5, total: 165 });
```

Assert duplicate message IDs are not double-counted, alias fields normalize, invalid negatives become `null`, and absent usage yields all-null fields.

Run: `pnpm --filter @ai-devflow/agents test -- src/__tests__/token-usage.test.ts`

Expected: FAIL because the accumulator does not exist.

- [ ] **Step 2: Implement and attach the accumulator**

Consume usage only from completed assistant messages and deduplicate by stable message ID. If total is absent but at least one component is known, calculate it from known components; otherwise keep it `null`. Feed every parsed JSON event in `json-events.ts` to the accumulator and expose `usage()`.

- [ ] **Step 3: Write failing PiRunner sink tests**

Use a fake sink and a two-route harness. Assert one start/finish pair per actual route attempt, the same logical request ID (`executionId`) across retry/failover, correct expert/source, success/failure classification, model, ordinal, and Token snapshot. Make the sink throw and assert the Agent result still succeeds.

- [ ] **Step 4: Add best-effort scheduler capture**

Define:

```ts
export interface ProviderUsageSink {
  start(input: ProviderCallStart): string | undefined;
  finish(id: string, input: ProviderCallFinish): void;
}
```

Wrap both methods in local `try/catch`. In `runAttempt`, start immediately before spawning and finish in every success, provider failure, cancellation, protocol failure, and interaction path. Derive source from `resultKind`: task review, task execution, or knowledge agent.

In `pi-runtime.ts`, adapt `repos.providerUsage` to the sink and resolve task/project/provider display-name snapshots before writing.

- [ ] **Step 5: Verify and commit**

Run: `pnpm --filter @ai-devflow/agents test -- src/__tests__/token-usage.test.ts src/__tests__/pi-runner.test.ts`

Run: `pnpm --filter @ai-devflow/desktop test -- electron/__tests__/services-init.test.ts`

Expected: PASS.

```bash
git add packages/agents/src/token-usage.ts packages/agents/src/__tests__/token-usage.test.ts packages/agents/src/index.ts packages/agents/src/json-events.ts packages/agents/src/pi-runner.ts packages/agents/src/__tests__/pi-runner.test.ts apps/desktop/electron/pi-runtime.ts
git commit -m "feat(agents): capture provider token usage"
```

### Task 4: Text-AI Usage Capture and Project Attribution

**Files:**
- Modify: `apps/desktop/electron/pi-ai.ts`
- Modify: `apps/desktop/electron/api.ts`
- Modify: `apps/desktop/electron/ipc.ts`
- Modify: `apps/desktop/electron/preload.ts`
- Modify: `apps/desktop/electron/services.ts`
- Modify: `apps/desktop/src/pages/Workspace.tsx`
- Test: `apps/desktop/electron/__tests__/pi-ai-streaming.test.ts`
- Test: `apps/desktop/electron/__tests__/ipc.test.ts`

**Interfaces:**
- Extends AI chat options with `projectId?: string` and internal `logicalRequestId`, `source`, and usage sink values.
- Consumes `PiTokenUsageAccumulator` and `repos.providerUsage` from Tasks 2-3.

- [ ] **Step 1: Write failing text-executor usage tests**

Use streamed supervisor fixtures with one success and one failover. Assert the fake sink receives separate provider attempts, a shared session ID, exact chat/proposal source, project ID, model, duration, result status, and Token totals. Assert abort produces `canceled` and sink failure does not alter the existing AbortError behavior.

Run: `pnpm --filter @ai-devflow/desktop test -- electron/__tests__/pi-ai-streaming.test.ts`

Expected: FAIL because text calls do not record usage.

- [ ] **Step 2: Capture each routed text attempt**

Add usage context to `PiTextExecutor` options. In `executeTextOnRoute`, feed parsed events to `PiTokenUsageAccumulator`; start before spawn and finish in `finally`. Preserve the current dirty-worktree AbortSignal and timeout behavior exactly.

Map workloads to sources: `requirement_chat`, `task_chat`, `requirement_proposal`, `task_proposal`, `ux_consultation`, and `connection_test`.

- [ ] **Step 3: Carry project attribution across IPC**

Add `projectId?: string` to Renderer API, preload payload, and Main handler. Pass the active project ID from requirement/task AI components in `Workspace.tsx`. Use the existing session ID as `logicalRequestId`; never derive project identity from a filesystem path.

- [ ] **Step 4: Wire the shared sink in services**

Pass the same repository-backed sink used by PiRunner into `createProductionTextExecutor`. Resolve provider display-name snapshots from `ProviderStore` at start time.

- [ ] **Step 5: Verify and commit**

Run: `pnpm --filter @ai-devflow/desktop test -- electron/__tests__/pi-ai-streaming.test.ts electron/__tests__/ipc.test.ts`

Expected: PASS.

```bash
git add apps/desktop/electron/pi-ai.ts apps/desktop/electron/api.ts apps/desktop/electron/ipc.ts apps/desktop/electron/preload.ts apps/desktop/electron/services.ts apps/desktop/src/pages/Workspace.tsx apps/desktop/electron/__tests__/pi-ai-streaming.test.ts apps/desktop/electron/__tests__/ipc.test.ts
git commit -m "feat(desktop): record all AI provider calls"
```

### Task 5: Analytics IPC and Global Statistics Page

**Files:**
- Modify: `apps/desktop/electron/api.ts`
- Modify: `apps/desktop/electron/ipc.ts`
- Modify: `apps/desktop/electron/preload.ts`
- Modify: `apps/desktop/electron/__tests__/ipc.test.ts`
- Create: `apps/desktop/src/pages/UsageStats.tsx`
- Create: `apps/desktop/src/__tests__/usage-stats.test.tsx`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/i18n/zh.ts`
- Modify: `apps/desktop/src/i18n/en.ts`

**Interfaces:**
- Produces: `DesktopApi.analytics.query(filters: UsageFilters): Promise<UsageAnalytics>`.
- Produces: global `Route` value `usage`.

- [ ] **Step 1: Write failing IPC validation tests**

Assert valid filters return seeded aggregates. Reject end-before-start, ranges longer than five years, unknown statuses, and non-integer timestamps before repository query.

Run: `pnpm --filter @ai-devflow/desktop test -- electron/__tests__/ipc.test.ts`

Expected: FAIL because the analytics namespace does not exist.

- [ ] **Step 2: Add typed analytics IPC**

Add the API/preload namespace and validate a copied whitelist object in Main. Do not pass arbitrary sort columns or SQL fragments from Renderer.

- [ ] **Step 3: Write failing page-state tests**

Render fixtures and assert:

- global summary labels and values;
- missing Token displays `--`, not `0`;
- coverage displays a percentage based on known calls;
- provider rows expose a filter/drill-down command;
- loading, empty, and error states retain a stable page shell.

Run: `pnpm --filter @ai-devflow/desktop test -- src/__tests__/usage-stats.test.tsx`

Expected: FAIL because the page does not exist.

- [ ] **Step 4: Build the compact statistics page**

Use existing Select, Button, and Lucide components. Implement a full-width filter band, six stable metric cells, CSS-grid trend bars, provider comparison table, and same-page provider detail. Keep chart dimensions fixed with `minmax` grid tracks and `tabular-nums`; do not nest cards or add a chart dependency.

- [ ] **Step 5: Add global navigation and translations**

Add `usage` to App route state and a `BarChart3` navigation item that works without a selected project. Add complete Chinese and English labels for filters, metrics, breakdowns, loading, errors, no data, and Token coverage.

- [ ] **Step 6: Verify and commit**

Run: `pnpm --filter @ai-devflow/desktop test -- electron/__tests__/ipc.test.ts src/__tests__/usage-stats.test.tsx`

Run: `pnpm --filter @ai-devflow/desktop typecheck`

Expected: PASS.

```bash
git add apps/desktop/electron/api.ts apps/desktop/electron/ipc.ts apps/desktop/electron/preload.ts apps/desktop/electron/__tests__/ipc.test.ts apps/desktop/src/pages/UsageStats.tsx apps/desktop/src/__tests__/usage-stats.test.tsx apps/desktop/src/App.tsx apps/desktop/src/i18n/zh.ts apps/desktop/src/i18n/en.ts
git commit -m "feat(desktop): add provider usage statistics"
```

### Task 6: Retention Service and Settings Controls

**Files:**
- Create: `apps/desktop/electron/retention.ts`
- Create: `apps/desktop/electron/__tests__/retention.test.ts`
- Modify: `apps/desktop/electron/services.ts`
- Modify: `apps/desktop/electron/main.ts`
- Modify: `apps/desktop/electron/api.ts`
- Modify: `apps/desktop/electron/ipc.ts`
- Modify: `apps/desktop/electron/preload.ts`
- Modify: `apps/desktop/src/pages/Settings.tsx`
- Create: `apps/desktop/src/__tests__/settings-retention.test.tsx`
- Modify: `apps/desktop/src/i18n/zh.ts`
- Modify: `apps/desktop/src/i18n/en.ts`

**Interfaces:**
- Produces: `DEFAULT_RETENTION_POLICY = { executionDetailDays: 90, archivedConversationDays: 180, providerRawDays: 365 }`.
- Produces: `RetentionService.runIfDue(force?: boolean)`, `.start()`, `.stop()`, and `.compact()`.
- Adds settings methods `getRetention`, `setRetention`, `runRetention`, and `compactDatabase`.

- [ ] **Step 1: Write failing fixed-clock cleanup tests**

Seed terminal/running/paused executions, archived/active tasks, task messages, logs, journals, and provider calls around exact boundaries. Assert:

- terminal details older than 90 days are removed;
- running and paused details remain;
- only archived-task conversations older than 180 days are removed;
- provider raw calls older than 365 days are rolled up before deletion;
- a second non-forced run within 24 hours is a no-op;
- batches never delete more than the configured limit.

Run: `pnpm --filter @ai-devflow/desktop test -- electron/__tests__/retention.test.ts`

Expected: FAIL because the service does not exist.

- [ ] **Step 2: Implement validated settings and cleanup**

Store policy JSON under credentials key `data-retention:v1`. Accept integer values with minimums 7, 30, and 30 days respectively. Persist `data-retention:last-run` after successful cleanup only.

Delete terminal log/journal details and archived messages with explicit joined
predicates and the same bounded-batch rule. Call
`providerUsage.rollupAndPrune` one batch at a time, yield to the event loop with
`setImmediate` between batches, and continue until no eligible rows remain.
Persist `data-retention:last-run` only after the complete pass succeeds, then
finish with `PRAGMA wal_checkpoint(TRUNCATE)`.

- [ ] **Step 3: Implement lifecycle and manual compaction**

`initializeServices` calls interrupted-usage recovery and one non-blocking `runIfDue`. `RetentionService.start()` schedules a 24-hour interval and `before-quit` calls `.stop()` before orchestrator shutdown. `compact()` runs `VACUUM` only through a separately confirmed IPC command and never from the automatic timer.

- [ ] **Step 4: Write failing settings-page tests**

Assert the page renders the three defaults, rejects below-minimum input, saves valid values, invokes immediate cleanup, and requires confirmation before compaction.

Run: `pnpm --filter @ai-devflow/desktop test -- src/__tests__/settings-retention.test.tsx`

Expected: FAIL because the section is missing.

- [ ] **Step 5: Add retention settings UI**

Add one un-nested settings section with numeric inputs, Save, Clean Now, and Compact Database commands. Use a destructive confirmation dialog only for compaction. Display the last cleanup result and localized errors without blocking other settings.

- [ ] **Step 6: Verify and commit**

Run: `pnpm --filter @ai-devflow/desktop test -- electron/__tests__/retention.test.ts src/__tests__/settings-retention.test.tsx electron/__tests__/services-init.test.ts`

Expected: PASS.

```bash
git add apps/desktop/electron/retention.ts apps/desktop/electron/__tests__/retention.test.ts apps/desktop/electron/services.ts apps/desktop/electron/main.ts apps/desktop/electron/api.ts apps/desktop/electron/ipc.ts apps/desktop/electron/preload.ts apps/desktop/src/pages/Settings.tsx apps/desktop/src/__tests__/settings-retention.test.tsx apps/desktop/src/i18n/zh.ts apps/desktop/src/i18n/en.ts
git commit -m "feat(desktop): add bounded data retention"
```

### Task 7: End-to-End Analytics Verification

**Files:**
- Create: `apps/desktop/e2e/usage-stats.spec.ts`

**Interfaces:**
- Consumes Tasks 1-6.
- Produces no new runtime API.

- [ ] **Step 1: Seed deterministic usage data in the E2E user database**

Create two providers, two projects, success/failure calls, known/unknown Tokens, and one deleted-provider display-name snapshot through the existing E2E database setup path.

- [ ] **Step 2: Verify global and provider views**

The Playwright test opens Usage Statistics, checks all six metrics, applies project/provider filters, drills into a provider, and asserts unknown Token cells show `--` while coverage is below 100%.

- [ ] **Step 3: Verify desktop and narrow screenshots**

Capture 1440x900 and 900x700 screenshots. Assert no overlapping filter controls, clipped metric text, blank trends, or horizontal page overflow.

- [ ] **Step 4: Run full verification**

Run: `pnpm -r typecheck`

Run: `pnpm -r test`

Run: `pnpm test:scripts`

Run: `pnpm --filter @ai-devflow/desktop e2e -- usage-stats.spec.ts`

Expected: all commands exit 0 and screenshots contain non-empty analytics content.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/e2e/usage-stats.spec.ts
git commit -m "test(desktop): verify provider usage analytics"
```
