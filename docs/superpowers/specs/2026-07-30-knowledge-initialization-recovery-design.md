# Knowledge Initialization Recovery Design

**Date:** 2026-07-30
**Status:** Approved

## Problem

A project can have a persisted knowledge run in `awaiting_confirmation` while its main working tree still reports `not_initialized`. The Knowledge page currently treats these facts independently: it can show the draft while leaving initialization available, and a repeated initialization request then fails because the scheduler correctly detects the active run. Page re-entry also depends on recovering enough persisted run data to make Confirm and Cancel usable.

The result is a stuck-looking workflow in which Initialize reports an active-run error and the user cannot reliably finish or discard the existing draft.

## Desired Behavior

- A pending initialization draft is preserved across page navigation and application restart.
- The page loads the complete active run, including its draft diff when available.
- Confirm applies the recovered draft and refreshes the health snapshot.
- Cancel discards the recovered draft and makes initialization available again.
- Repeating Initialize for a project with a pending initialization is idempotent: it returns the existing draft instead of creating or queueing another run.
- A project has at most one mutating knowledge operation at a time.
- Missing or invalid draft resources produce an actionable error without preventing Cancel from terminating the run.

## Design

### Scheduler Authority

The scheduler remains the source of truth for active knowledge runs. It will separate persisted active-run lookup from view construction:

- Internal synchronous lookup returns the latest `running` or `awaiting_confirmation` record for guards and lock-protected decisions.
- Public `getActiveRun` asynchronously builds the same complete view as `getRun`, including findings and the draft diff.

`startInitialization` will check for an active run while holding the project knowledge lock. If the active run is an initialization awaiting confirmation, it returns that existing full view. Other active run kinds or genuinely running initialization work continue to reject conflicting operations with a clear status message.

### Serialization

Initialization, audit, repair, confirmation, and cancellation will use one project-scoped knowledge-operation lock. Confirmation and cancellation resolve the run to its project, enter that project lock, then re-read and validate the record before changing it. This prevents cross-operation races that separate `init:*`, `audit:*`, and `run:*` lock keys cannot prevent.

Terminal transitions are monotonic: once a run is `succeeded`, `failed`, or `canceled`, another action cannot overwrite it.

### Renderer State

The Knowledge page loads the health snapshot and active run together. A recovered `awaiting_confirmation` run renders the existing draft controls; a `running` run renders progress. While any active run exists, new initialization, audit, and repair commands are disabled. Confirm and Cancel remain enabled only for an awaiting-confirmation run and are disabled while their request is in flight.

Run events update the same authoritative `activeRun` state. Terminal events clear it and trigger a fresh snapshot/active-run read so the available actions reflect persisted state.

### Recovery Errors

If the draft branch or worktree required for confirmation is missing, Confirm returns a specific recovery error and does not silently create a replacement run. Cancel remains best-effort for filesystem cleanup and always records the pending run as canceled when its persisted state still permits cancellation. The user can then initialize again.

## Testing

Scheduler tests will verify:

- `getActiveRun` returns the complete pending view.
- repeated initialization returns the same pending run ID and does not add a run;
- cancellation followed by initialization creates a new run;
- confirmation and cancellation revalidate state under the project lock;
- a terminal run cannot be overwritten by a competing action;
- missing draft resources fail confirmation but remain cancelable.

Renderer tests will verify:

- page entry recovers a pending run and invokes Confirm with its persisted ID;
- page entry recovers a pending run and invokes Cancel with its persisted ID;
- mutating operation buttons are disabled while a run is active;
- terminal completion clears the draft/progress state and refreshes the project.

Existing scheduler, Electron IPC, renderer, typecheck, and lint suites remain required verification.

## Scope

This change does not alter knowledge document formats, initialization content generation, audit rules, or merge policy. It does not automatically discard a pending draft, and it does not add a second recovery UI.
