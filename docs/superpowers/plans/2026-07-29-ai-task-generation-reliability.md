# AI Task Generation Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep long AI task-generation runs observable, pinned, cancelable, and alive for the configured 15-minute `dev_lead` window so they can produce task drafts reliably.

**Architecture:** Carry one `AbortSignal` from the session-aware Electron IPC handler through `PiAiService` and the production text executor to `SpawnedPi.cancel()`, while deriving the process timeout from the selected step-agent profile. Keep rendering policy in `ChatThread`: content updates scroll only while pinned, collapsed thinking is absent from layout, and `AiCreateTask` normalizes leading stream whitespace and cancels its current session during cleanup.

**Tech Stack:** TypeScript, React 18, Electron IPC/context bridge, Pi process supervisor, Vitest, pnpm workspaces.

## Global Constraints

- `task_proposal` uses the existing 15-minute task-proposer/dev-lead configuration; do not introduce a second duplicated 15-minute constant.
- Unprofiled `task_chat` retains the current 120-second fallback.
- Cancellation is expected control flow: it must not emit a provider error or modify provider health.
- A canceled session emits no later text, thinking, proposal, done, or error event.
- User upward scrolling pauses automatic pinning until the user returns to the bottom or uses the resume control.
- Do not impose a fixed maximum height on normal assistant answer bubbles.
- Preserve existing task proposal schemas, provider failover policy, and draft editing behavior.

---

### Task 1: Use Profile Timeouts And Cancel Spawned Pi Runs

**Files:**
- Modify: `apps/desktop/electron/pi-ai.ts:56-71,295-481,503-522,566-577`
- Test: `apps/desktop/electron/__tests__/pi-ai-streaming.test.ts`

**Interfaces:**
- Consumes: `stepAgentForWorkload(workload)?.timeoutMs`, `PiTextExecutor` option `{ signal?: AbortSignal }`, and `SpawnedPi.cancel()`.
- Produces: `executeTextOnRoute(..., signal?: AbortSignal)` and a production executor that stops provider routing after cancellation.

- [ ] **Step 1: Write failing timeout and cancellation tests**

Extend the streaming harness to capture `spawn` options and its `cancel` calls, then add:

```typescript
it('task_proposal uses the configured task proposer timeout', async () => {
  const h = harnessWithControls(successEvents);
  await h.executor('task_proposal', [{ role: 'user', content: 'split it' }]);
  expect(h.spawnOptions[0]?.timeoutMs).toBe(15 * 60_000);
});

it('task_chat keeps the 120 second fallback timeout', async () => {
  const h = harnessWithControls(successEvents);
  await h.executor('task_chat', [{ role: 'user', content: 'hello' }]);
  expect(h.spawnOptions[0]?.timeoutMs).toBe(120_000);
});

it('aborting cancels the spawned process and does not retry the provider route', async () => {
  const controller = new AbortController();
  const h = blockingHarness();
  const result = h.executor('task_proposal', [{ role: 'user', content: 'split it' }], undefined, { signal: controller.signal });
  controller.abort();
  await expect(result).rejects.toMatchObject({ kind: 'interaction' });
  expect(h.cancel).toHaveBeenCalledTimes(1);
  expect(h.routeCalls).toBe(1);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `pnpm --filter @ai-devflow/desktop exec vitest run electron/__tests__/pi-ai-streaming.test.ts`

Expected: the timeout assertions receive `120000` for both workloads and the executor option does not accept or act on `signal`.

- [ ] **Step 3: Implement workload timeout selection and abort propagation**

Add `signal?: AbortSignal` to the existing executor options and AI service options. In `executeTextOnRoute`, use:

```typescript
const timeoutMs = step?.timeoutMs ?? 120_000;
const spawned = deps.supervisor.spawn(plan, {
  cwd: cwdOverride ?? sessionDir,
  timeoutMs,
  secrets: [route.secret],
});
const cancel = () => { void spawned.cancel(); };
signal?.addEventListener('abort', cancel, { once: true });
```

Remove the listener during cleanup. Before interpreting process exit/provider/protocol state, check `signal?.aborted` and throw `new ProviderExecutionError('AI 生成已取消', 'interaction')`. Check the signal before each routed attempt so the router propagates the existing non-retryable `interaction` kind without recording route failure.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `pnpm --filter @ai-devflow/desktop exec vitest run electron/__tests__/pi-ai-streaming.test.ts`

Expected: PASS, including existing text/thinking separation and error-stream tests.

### Task 2: Add Session Cancellation Across API, Preload, And IPC

**Files:**
- Modify: `apps/desktop/electron/api.ts:129-136,302-325`
- Modify: `apps/desktop/electron/preload.ts:129-164`
- Modify: `apps/desktop/electron/ipc.ts:26-27,628-758`
- Test: `apps/desktop/electron/__tests__/ipc.test.ts`
- Test: `apps/desktop/electron/__tests__/preload-ai.test.ts`

**Interfaces:**
- Consumes: `PiAiService.chat(..., { signal })` from Task 1.
- Produces: `DesktopApi.ai.chat` option `onSession?: (sessionId: string) => void`, `DesktopApi.ai.cancel(sessionId: string): Promise<void>`, and main-process `ai-devflow:ai:cancel` handling.

- [ ] **Step 1: Write failing preload session-lifecycle tests**

Mock Electron's `ipcRenderer` and verify observable API behavior:

```typescript
it('reports the generated session id before sending chat', async () => {
  const sessions: string[] = [];
  windowApi.ai.chat([{ role: 'user', content: 'x' }], () => {}, { onSession: (id) => sessions.push(id) });
  expect(sessions).toEqual([expect.any(String)]);
  expect(send).toHaveBeenCalledWith('ai-devflow:ai:chat', expect.objectContaining({ sessionId: sessions[0] }));
});

it('sends cancellation for exactly one session', async () => {
  await windowApi.ai.cancel('session-1');
  expect(send).toHaveBeenCalledWith('ai-devflow:ai:cancel', { sessionId: 'session-1' });
});
```

- [ ] **Step 2: Write failing IPC cancellation tests**

Use a deferred `PiTextExecutor` that records its `options.signal`, trigger `ai:chat`, then `ai:cancel`, and assert:

```typescript
expect(capturedSignal?.aborted).toBe(true);
expect(sentAi.filter((event) => event.sessionId === 's1')).toEqual([]);
```

Also resolve a normal request, cancel afterward, and assert the completed session is no longer affected and produced exactly one `done` event.

- [ ] **Step 3: Run the focused tests and verify RED**

Run: `pnpm --filter @ai-devflow/desktop exec vitest run electron/__tests__/preload-ai.test.ts electron/__tests__/ipc.test.ts`

Expected: preload tests fail because `onSession`/`cancel` do not exist; IPC test fails because no active controller is registered.

- [ ] **Step 4: Implement the API and preload contract**

Extend `DesktopApi.ai.chat` options with `onSession`, call it immediately after UUID generation and before the IPC send, and add:

```typescript
cancel(sessionId: string): Promise<void> {
  ipcRenderer.send('ai-devflow:ai:cancel', { sessionId });
  return Promise.resolve();
}
```

Keep listener removal on `done` and `error` unchanged.

- [ ] **Step 5: Implement main-process session ownership**

Inside `registerIpc`, maintain `Map<string, AbortController>`. Reject duplicate live session IDs. Register the controller before knowledge preparation, pass its signal to `piAi.chat`, and guard every `sendAi` callback with `!signal.aborted`. In `finally`, delete only when the map still contains that controller. The cancel handler aborts and removes the pending ask entry:

```typescript
ipcMain.on('ai-devflow:ai:cancel', (_e, { sessionId }: { sessionId: string }) => {
  activeAiChats.get(sessionId)?.abort();
  pendingAsks.delete(sessionId);
});
```

When the catch path observes `signal.aborted`, skip the stream error and mark any prepared knowledge retrieval failed without presenting cancellation as provider exhaustion.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `pnpm --filter @ai-devflow/desktop exec vitest run electron/__tests__/preload-ai.test.ts electron/__tests__/ipc.test.ts electron/__tests__/pi-ai-streaming.test.ts`

Expected: PASS.

### Task 3: Keep Streaming Content Pinned Unless The User Scrolls Up

**Files:**
- Modify: `apps/desktop/src/components/ChatThread.tsx:58-171`
- Modify: `apps/desktop/src/hooks/useStickToBottom.ts`
- Test: `apps/desktop/src/hooks/__tests__/useStickToBottom.test.ts`
- Test: `apps/desktop/src/components/__tests__/ChatThread.test.tsx`

**Interfaces:**
- Consumes: `items` where the last item's text or thinking can grow without changing `items.length`.
- Produces: pure `nextStickToBottomState(...)` decisions used by `ChatThread` for user scrolls and content commits.

- [ ] **Step 1: Write failing scroll-policy tests**

Add literal, hand-derived cases around a small pure state transition:

```typescript
expect(nextStickToBottomState({ pinned: true, paused: false }, { type: 'content' }))
  .toEqual({ pinned: true, paused: false, scroll: true });
expect(nextStickToBottomState({ pinned: false, paused: true }, { type: 'content' }))
  .toEqual({ pinned: false, paused: true, scroll: false });
expect(nextStickToBottomState({ pinned: true, paused: false }, { type: 'user-scroll', atBottom: false }))
  .toEqual({ pinned: false, paused: true, scroll: false });
expect(nextStickToBottomState({ pinned: false, paused: true }, { type: 'user-scroll', atBottom: true }))
  .toEqual({ pinned: true, paused: false, scroll: false });
```

Add a `ChatThread` rendering regression asserting a streamed message with answer text has `aria-expanded="false"` and no `thinking-body`, even when thinking content is present.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm --filter @ai-devflow/desktop exec vitest run src/hooks/__tests__/useStickToBottom.test.ts src/components/__tests__/ChatThread.test.tsx`

Expected: the transition helper is missing.

- [ ] **Step 3: Implement the policy and bind it to all content updates**

Export the pure transition helper from `useStickToBottom.ts`. In `ChatThread`, keep pagination height compensation first, then apply a content transition whenever `items` changes, not only when `items.length` grows. If pinned, set `scrollTop = scrollHeight`; if paused, preserve `scrollTop`. Keep unread count message-based: increment only when a new item is appended, not for every token delta.

The existing `MessageBubble` condition remains `manual ?? (streaming && !text)` so collapsed thinking stays out of the DOM; retain `max-h-48 overflow-auto` for manually/automatically expanded thinking only.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `pnpm --filter @ai-devflow/desktop exec vitest run src/hooks/__tests__/useStickToBottom.test.ts src/components/__tests__/ChatThread.test.tsx src/components/__tests__/ChatPanel.test.tsx`

Expected: PASS.

### Task 4: Correct The Prompt, Normalize Stream Display, And Cancel On Cleanup

**Files:**
- Modify: `apps/desktop/src/i18n/zh.ts:194`
- Modify: `apps/desktop/src/i18n/en.ts:194`
- Modify: `apps/desktop/src/pages/Workspace.tsx:817-910`
- Test: `apps/desktop/src/__tests__/workspace-create-task-modal.test.tsx`

**Interfaces:**
- Consumes: `DesktopApi.ai.chat(..., { onSession })` and `DesktopApi.ai.cancel(sessionId)` from Task 2.
- Produces: `normalizeAssistantStreamText(text: string): string`, corrected quick-generation copy, and cleanup of the current session.

- [ ] **Step 1: Write failing normalization and prompt tests**

Export the normalization helper for direct behavior testing:

```typescript
expect(WS.normalizeAssistantStreamText('\n\n   Now I understand.\nNext')).toBe('Now I understand.\nNext');
expect(WS.normalizeAssistantStreamText('Answer\n  indented')).toBe('Answer\n  indented');
```

Render the Chinese quick action and assert its click path sends exactly:

```text
请基于当前需求拆解任务，并调用工具生成任务草稿。
```

Use the API mock's `onSession` callback plus the exported session cleanup helper to assert an active session is canceled once and a cleared session is a no-op.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter @ai-devflow/desktop exec vitest run src/__tests__/workspace-create-task-modal.test.tsx`

Expected: the old prompt contains the clarification prohibition and the normalization/cleanup helpers are missing.

- [ ] **Step 3: Implement the prompt and stream normalization**

Set the Chinese prompt to `请基于当前需求拆解任务，并调用工具生成任务草稿。` and the English prompt to `Break down the current requirement into tasks and use the tool to generate task drafts.`

Render accumulated assistant text through:

```typescript
export const normalizeAssistantStreamText = (text: string): string => text.trimStart();
```

Keep `segRef.current.text` unchanged so complete conversation history is retained; only pass its normalized form to `syncAssistant`.

- [ ] **Step 4: Implement session cleanup in `AiCreateTask`**

Store the ID from `onSession` in `activeSessionRef`. Clear it after normal resolve/reject only if it still matches that request. Add an unmount cleanup effect that calls `api.ai.cancel(activeSessionRef.current)` and clears the ref before awaiting. Ignore cancellation-shaped errors so closing the modal does not append the interrupted marker or set a provider error.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run: `pnpm --filter @ai-devflow/desktop exec vitest run src/__tests__/workspace-create-task-modal.test.tsx src/components/__tests__/ChatThread.test.tsx`

Expected: PASS.

### Task 5: Cross-Layer Verification

**Files:**
- Verify all files changed in Tasks 1-4.

**Interfaces:**
- Consumes: complete renderer-to-process cancellation and streaming chain.
- Produces: verified desktop build and regression suite.

- [ ] **Step 1: Run all affected desktop tests**

Run:

```bash
pnpm --filter @ai-devflow/desktop exec vitest run \
  electron/__tests__/pi-ai-streaming.test.ts \
  electron/__tests__/preload-ai.test.ts \
  electron/__tests__/ipc.test.ts \
  src/hooks/__tests__/useStickToBottom.test.ts \
  src/components/__tests__/ChatThread.test.tsx \
  src/components/__tests__/ChatPanel.test.tsx \
  src/__tests__/workspace-create-task-modal.test.tsx
```

Expected: PASS with zero failed tests.

- [ ] **Step 2: Run desktop typecheck and build**

Run:

```bash
pnpm --filter @ai-devflow/desktop typecheck
pnpm --filter @ai-devflow/desktop build:renderer
pnpm --filter @ai-devflow/desktop build:electron
```

Expected: all commands exit 0.

- [ ] **Step 3: Run the full desktop test suite**

Run: `pnpm --filter @ai-devflow/desktop test`

Expected: PASS with zero failed tests.

- [ ] **Step 4: Inspect the final diff and requirements**

Run: `git diff --check && git status --short && git diff --stat HEAD`

Confirm every design requirement has an implementation and a regression test, no provider policy or proposal schema changed, and no unrelated files are included.
