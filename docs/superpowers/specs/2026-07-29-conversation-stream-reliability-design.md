# Conversation Stream Reliability Design

## Goal

Make streamed AI conversations readable and stable: the inner thinking region follows its latest content, the outer task conversation respects user-controlled scrolling, and token-sized deltas no longer become separate visible messages.

## Current Failure Modes

- `MessageBubble` renders the thinking body as an independently scrollable element but does not manage that element's scroll position.
- `ChatThread` receives content updates through changing `items` references. The existing uncommitted work correctly starts separating user and programmatic scrolling, but the behavior still needs integration coverage for content growth while paused.
- `json-events.ts` maps every Pi `message_update` delta to a `log` event. `Orchestrator.handleEvent()` inserts every such event as a new `task_messages` row, so one sentence can appear as many incomplete bubbles.
- `TaskDetail` appends every streamed `task-message` event without replacing a previously updated message.

## Scroll Model

The outer conversation and inner thinking body are separate scroll regions with separate state. Each region tracks:

- `pinned`: content growth should move the region to its bottom.
- `paused`: an explicit upward user scroll has suspended automatic movement.
- `programmatic`: the current scroll event came from application code and must not be interpreted as user intent.
- `lastScrollTop`: determines whether a user scroll moved upward or downward.

### Outer Conversation

- First display of a conversation starts at the latest message.
- New items and updates to an existing item's text move to the bottom only while `pinned` is true.
- Any upward user movement pauses automatic scrolling immediately, including movement that remains within the bottom-distance threshold.
- While paused, neither new items nor updates to an existing streamed item change `scrollTop`.
- Returning to the bottom or activating the existing new-message control resumes automatic scrolling and clears the unread count.
- Loading older messages at the top preserves the visible anchor by applying the change in `scrollHeight` to `scrollTop`.

### Thinking Region

- An expanded thinking body starts at its latest content.
- Thinking deltas move only the thinking body's own scroll position; they do not directly manipulate the outer conversation container.
- Upward user movement inside the thinking body pauses that inner region. Returning to its bottom resumes it.
- Completion still collapses the thinking body by default. A manual expand or collapse remains authoritative for that message.

## Message Assembly

The scheduler owns persisted conversation semantics. It will assemble consecutive informational Agent text deltas into one task message per contiguous assistant-text segment.

The active segment key consists of the execution ID, role, and message kind. The first delta inserts a `TaskMessage`; later consecutive deltas append to that row and emit an updated message with the same ID. The following events close the active segment before they are recorded:

- tool calls or tool results;
- status changes;
- errors;
- clarification, approval, or confirmation requests;
- completion;
- execution stop, cancellation, or replacement.

The repository adds an explicit text-update operation. The stream continues using the `task-message` event kind, but Renderer state applies it as an upsert by message ID rather than always appending.

Existing data remains readable. The task-message read path coalesces adjacent legacy assistant text rows only when execution ID, role, and kind match and no semantic boundary lies between them. It preserves the first row's ID and timestamp and concatenates text exactly as received. Tool, status, user, interaction, and error messages are never merged across boundaries.

`log_entries` may retain lower-level execution diagnostics, but the task conversation is no longer a token log. Its row count reflects semantic conversation items.

## Error Handling

- A failed message update must not create a second fragment row. The scheduler reports the persistence error through the existing task-error path.
- Duplicate delivery of the same upsert event is idempotent in Renderer state.
- Switching tasks discards scroll and message-assembly state belonging to the previous task.

## Testing

- Pure scroll-state tests cover content growth while pinned, immediate pause on upward movement, no movement while paused, and resume at bottom.
- DOM tests use real scroll containers to distinguish the thinking body's `scrollTop` from the outer conversation's `scrollTop`.
- Scheduler tests feed multiple text deltas and assert one persisted task message with complete text.
- Boundary tests assert that text before and after a tool, status, error, or interaction remains in separate messages.
- TaskDetail tests assert that a repeated message ID replaces content without increasing visible message count.
- Legacy-read tests assert safe coalescing without crossing roles, executions, or semantic message kinds.

## Non-Goals

- Replacing task messages and execution logs with a new event-sourcing system.
- Persisting hidden chain-of-thought content that the runtime does not already expose.
- Deleting historical data; retention is specified in the provider analytics design.
