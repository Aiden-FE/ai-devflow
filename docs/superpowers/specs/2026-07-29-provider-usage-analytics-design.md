# Provider Usage Analytics and Retention Design

## Goal

Add a global statistics page that compares AI provider usage and drills into one provider, including reliable Token usage for new calls and bounded storage growth.

## Measurement Semantics

A provider call is one actual route attempt. Retries and provider failover therefore create separate provider-call records. A `logicalRequestId` groups attempts that belong to one task execution or AI conversation request.

Each record stores:

- immutable provider ID and provider display-name snapshot;
- route ID, model, workload or expert, and source;
- logical request ID plus optional execution, task, and project IDs;
- attempt ordinal;
- `running`, `succeeded`, `failed`, `canceled`, or `interrupted` status;
- optional normalized failure kind;
- start, end, and duration;
- nullable input, output, cache-read, cache-write, and total Token counts.

No prompt, response body, API key, credential reference, or monetary cost is stored.

Token values use `NULL` when the runtime does not report them. `NULL` is never converted to zero. Aggregates return both known Token totals and Token coverage so historical gaps remain visible.

## Capture Points

Both production execution paths record usage:

- `PiRunner` records scheduler task, review, and knowledge attempts.
- The production text executor records requirement chat, task chat, requirement proposal, task proposal, and UX consultation attempts.

A shared usage sink writes a running record immediately before a route attempt and finishes it in a `finally` path. Pi JSON message and terminal events are normalized into the common Token fields. The capture path accepts the provider runtime's supported usage aliases but emits only the canonical database shape.

Usage persistence is best-effort and must not change the result of an AI call. A persistence error is logged locally and leaves the provider call behavior unchanged. Records left as `running` by an application crash are marked `interrupted` during startup recovery.

## Historical Data

The schema migration copies existing `execution_attempts` into usage records with deterministic legacy IDs. It derives provider and workload from the route ID and joins execution, task, and project relationships where available.

Historical fields that cannot be proven, including model and Token counts, remain `NULL`. Historical AI chats were not persisted with route-attempt identity and are not fabricated. Their statistics begin after this migration.

## Query API

SQLite performs aggregation before data crosses IPC. Filters support:

- preset or explicit time range;
- project;
- provider;
- model;
- workload or expert;
- source;
- result status.

The API returns:

- actual provider-call count and distinct logical-request count;
- success rate and average duration;
- Token totals and Token coverage;
- time buckets for call, result, duration, and Token trends;
- provider, model, project, workload, source, and failure-kind breakdowns;
- latest failures with bounded, sanitized diagnostic labels.

## Statistics Page

The sidebar adds a global `Usage Statistics` destination that does not require an active project.

The page uses a compact operational layout consistent with the current desktop application:

- a top filter bar for time, project, provider, model, workload or source, and status;
- summary metrics for provider calls, logical requests, success rate, average duration, total Tokens, and Token coverage;
- a stable-dimension time trend for calls, success or failure, and Tokens;
- a provider comparison table with share, success rate, average duration, Token total, coverage, and latest failure;
- a same-page provider drill-down showing model, project, workload, source, failure-type, and Token-component breakdowns.

Selecting a provider updates the filter state instead of navigating to a disconnected page. Disabled or deleted providers remain identifiable by the stored display-name snapshot. Empty, loading, error, and partial-Token states are explicit and do not collapse the layout.

## Retention Policy

Retention values are configurable in Settings with these defaults:

- terminal execution detail logs and attempt journals: 90 days;
- complete task conversation for archived tasks: 180 days;
- raw provider-call records: 365 days.

Running or paused execution detail is never automatically deleted. Active and non-archived task conversations are never automatically deleted. The compact `execution_records` summary remains available after its detailed logs and journals expire.

Before provider-call records exceed 365 days, they are rolled up by date, provider, model, project, workload, source, status, and failure kind. The provider-attempt rollup preserves call counts, duration totals, known Token totals, and Token coverage counts. A separate logical-request rollup is computed before deletion so one request that retried or failed over across providers is counted once in global totals. Provider-filtered logical-request rollups retain one count per provider that participated in the request, while repeated attempts on that same provider remain deduplicated. Queries select the matching rollup grain instead of summing provider groups into a global distinct count. Raw records are deleted only after every required aggregate transaction commits.

Cleanup runs after startup recovery when the app is idle and no more than once every 24 hours. It deletes in bounded batches so the Renderer and scheduler remain responsive. Completion checkpoints the WAL. SQLite reuses freed pages; automatic cleanup does not run a blocking full `VACUUM`.

Settings also provides:

- configurable retention durations with validation and documented minimums;
- an immediate cleanup command using the same policy;
- a separately confirmed manual database compaction command for users who need the file to shrink on disk.

## Failure and Consistency Handling

- Rollup and raw-row deletion occur in one transaction.
- Cleanup failure records a diagnostic and retries on the next eligible run; it never blocks application startup.
- Statistics queries include raw and rolled-up buckets without double counting at the retention boundary.
- A removed project or provider does not erase historical usage dimensions.
- Invalid time ranges or retention values are rejected at IPC before SQL execution.

## Testing

- Migration tests cover legacy backfill, nullable model and Token fields, and idempotence.
- Token-normalization tests cover supported runtime shapes and absent usage.
- Route integration tests cover success, failure, cancellation, retry, failover, and startup interruption recovery for both execution paths.
- Repository tests verify filters, time buckets, provider comparisons, logical-request grouping, Token coverage, and raw-plus-rollup queries.
- Retention tests use a fixed clock to verify 90, 180, and 365-day boundaries, protection of active tasks, transactional rollup, bounded deletion, and once-per-day scheduling.
- IPC tests verify validation and sanitized response shapes.
- Renderer tests cover global and provider-filtered states, missing Token display, filter combinations, and deleted-provider snapshots.
- Desktop E2E verifies sidebar navigation, stable layout at desktop and narrow widths, and a provider drill-down using seeded usage data.

## Non-Goals

- Cost or pricing calculation.
- Retrospective Token estimation from text length.
- Storing raw model prompts or responses for analytics.
- Real-time external telemetry export.
- Replacing SQLite with a separate analytics database.
