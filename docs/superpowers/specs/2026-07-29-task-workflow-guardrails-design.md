# Task Workflow Guardrails Design

## Goal

Make every board drag represent one explicit business action and make the development-to-testing review contract reliable enough that a valid review cannot be reduced to the generic `task_review` missing-payload error.

## Board Action Policy

The board uses a pure action policy shared by rendering and IPC validation. It returns an action, not merely a target status.

| Source | Target | Action | User interaction |
| --- | --- | --- | --- |
| `ready` | `in_progress` | Start task | Start immediately through `tasks.start` |
| `in_review` | `archived` | Accept task | Run `tasks.accept` |
| `in_review` | `ready` | Reject to backlog | Require a non-empty rejection reason, then run `tasks.reject` with `target=ready` |
| `in_review` | `in_progress` | Reject and repair | Require a non-empty rejection reason, then run `tasks.reject` with `target=in_progress`; repair starts immediately |

Every other source-target pair has no board action.

Consequences:

- Only `ready` and `in_review` cards are draggable.
- `in_progress`, `testing`, `awaiting_input`, and `archived` cards remain selectable but cannot begin a drag.
- A lane only activates its drop affordance when the dragged task and target lane produce an allowed action.
- Invalid targets do not highlight and do not call IPC.
- The rejection dialog opens after either allowed rejection drop. Closing it performs no transition.
- Whitespace-only rejection reasons are rejected in both Renderer and Main.

The generic `tasks.updateStatus` endpoint is not a board shortcut. Dedicated start, accept, and reject operations remain the authoritative entry points because they perform execution, artifact, acceptance, and audit side effects. Main-process validation repeats the action policy so synthetic Renderer calls cannot bypass it.

## Review Result Contract

The current report tool accepts `payload` as `Type.Unknown()`. A model can therefore complete the tool with a structurally invalid `task_review` payload. `json-events.ts` then silently normalizes that payload to `undefined`, and `validateExpertCompletion()` reports only `task_review result missing domain payload`.

The report-result extension will select its TypeBox parameter schema from `AI_DEVFLOW_RESULT_KIND` when the Pi process starts:

- `task_execution` does not accept a payload.
- `task_review` requires `payload.kind = task_review`, a review verdict, and a knowledge assessment.
- Other existing knowledge result kinds retain their exact discriminated payload schemas.

The `task_review` schema requires:

- `review.pass`: boolean;
- `review.summary`: non-empty string;
- optional `review.feedback`: string;
- optional `review.checks`: string array;
- `knowledgeAssessment.verdict = none` with non-empty `reason` and at least one evidence item; or
- `knowledgeAssessment.verdict = valuable` with at least one fully populated candidate.

The host remains the final validator. Invalid payloads are not silently discarded: normalization returns a field-level diagnostic, such as an empty `knowledgeAssessment.evidence`, and the runner surfaces that diagnostic. The scheduler never fabricates an assessment or advances to `in_review` after a malformed result.

`summary`, `review.summary`, and `review.pass` must agree on `REVIEW_VERDICT: PASS|FAIL`. A passing result enters finalization only after the existing artifact, knowledge, commit, and merge gates pass. A failing result follows the bounded repair loop already owned by the scheduler.

## Error Handling

- Failure to start a ready task leaves it in `ready` and displays the existing board error.
- Failure to accept leaves the task in `in_review`.
- Failure to reject leaves the task in `in_review` and keeps the entered reason available for retry.
- A tool-schema validation failure stays within the agent turn so the model can correct its tool arguments.
- A host validation failure terminates the review attempt with the exact contract diagnostic and never reports a false review conclusion.

## Testing

- Table-driven policy tests cover every source-target pair, including `awaiting_input` and the same-lane case.
- Workspace tests assert only `ready` and `in_review` cards render as draggable and only allowed lanes accept drag-over.
- Interaction tests cover start, accept, both rejection targets, dialog cancellation, and blank reasons.
- IPC tests attempt to bypass each dedicated action and assert that no status is persisted.
- Extension tests validate accepted and rejected payload shapes for every result kind.
- JSON-event tests assert malformed payload diagnostics retain the failing field rather than becoming `undefined` without explanation.
- PiRunner and scheduler integration tests carry a valid `task_review` payload from tool execution through the done event and into `in_review`.

## Non-Goals

- Changing scheduler-owned automatic transitions between development, testing, repair, and review.
- Making running or paused tasks manually movable on the board.
- Allowing direct archive or rejection through `tasks.updateStatus`.
