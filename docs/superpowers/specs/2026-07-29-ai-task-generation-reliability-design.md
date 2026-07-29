# AI Task Generation Reliability Design

## Goal

Make AI task generation remain observable and controllable during long repository analysis, then reliably produce task drafts instead of being interrupted by a generic two-minute timeout.

## Scope

- Keep the chat view pinned to the newest streamed thinking or answer content until the user deliberately scrolls upward.
- Pause automatic scrolling after a user scrolls upward and resume it when the user returns to the bottom or activates the existing new-message control.
- Change the quick-generation prompt to ask for task decomposition and tool-backed draft generation without asserting that clarification is unnecessary.
- Use the configured `dev_lead` timeout of 15 minutes for `task_proposal` work instead of the executor-wide 120-second timeout.
- Cancel the active main-process AI session when the task-creation UI is closed or unmounted.
- Prevent meaningless leading whitespace in streamed assistant text from producing a tall blank message area.

## Streaming UI Behavior

`ChatThread` owns scrolling policy. The policy reacts to rendered content growth, including updates to an existing message, rather than only changes to the message count. While the view is pinned, each streamed update moves the viewport to the current bottom after React commits the new content. A user-originated upward scroll disables pinning; subsequent stream updates must not change `scrollTop`. Returning to the bottom or using the existing resume control re-enables pinning.

Thinking details remain bounded by the existing internal maximum height while expanded. Once answer text begins or streaming ends, the automatic state collapses the thinking body so continued hidden thinking updates do not occupy layout height. Manual expand/collapse remains authoritative for that message.

`AiCreateTask` retains the complete accumulated assistant text for conversation history but removes leading whitespace before rendering streamed text. Interior whitespace and all later answer formatting remain unchanged. This addresses blank vertical space without imposing a fixed height on normal assistant answers.

## Prompt Behavior

The Chinese quick-generation prompt becomes:

`请基于当前需求拆解任务，并调用工具生成任务草稿。`

The English prompt carries the same meaning and does not tell the agent that clarification is forbidden. Existing button and hint labels remain unchanged.

## Execution Lifetime

The Pi text executor derives its timeout from the workload's configured expert profile. `task_proposal` maps to `dev_lead`, therefore it receives the existing 15-minute timeout. Workloads without an execution-expert profile retain the current 120-second fallback.

AI chat sessions become explicitly cancelable across the renderer/preload/main boundary. Cancellation targets one session ID, removes its stream resources, and terminates its spawned Pi process. Closing or unmounting `AiCreateTask` cancels only its active request. A naturally completed or failed request clears the active session so later cleanup is a no-op.

## Failure Handling

- Cancellation is an expected terminal state and must not be reported as provider exhaustion.
- Provider and protocol failures continue through the existing error path.
- A canceled session must not emit later proposal, text, thinking, done, or error events to the renderer.
- Starting a later task-generation request uses a new session ID and is unaffected by prior cancellation.

## Tests

- DOM test: updating thinking/text in the same message keeps a pinned container at the bottom.
- DOM test: a user upward scroll pauses pinning during later stream updates; returning to the bottom resumes it.
- Rendering test: collapsed thinking content is absent from layout while the answer remains visible.
- Task-creation test: the quick action sends the corrected Chinese prompt and streamed leading whitespace does not create blank rendered content.
- Executor test: `task_proposal` uses 15 minutes while an unprofiled chat workload retains 120 seconds.
- IPC/preload tests: cancel targets the active session, terminates the corresponding process, and suppresses later events.
- Component cleanup test: unmounting task generation cancels an in-flight request and does nothing after normal completion.

## Non-Goals

- No redesign of task proposal cards or dependency DAG handling.
- No global fixed height for assistant messages.
- No change to provider failover policy.
- No change to the `dev_lead` profile's existing 15-minute value.
