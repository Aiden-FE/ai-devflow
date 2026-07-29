# Conversation Stream Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep both thinking and task-conversation scroll positions under user control and persist streamed assistant text as complete semantic messages.

**Architecture:** Reuse the existing pure stick-to-bottom state transition for both scroll regions. Add an update path to `TaskMessagesRepo`, assemble consecutive text deltas inside `Orchestrator`, and upsert streamed messages in `TaskDetail`; coalesce only legacy adjacent fragments on read.

**Tech Stack:** React 18, TypeScript 5.7, Vitest 2, Electron IPC, Node SQLite, pnpm.

## Global Constraints

- Preserve the existing uncommitted changes in `ChatThread.tsx`, `useStickToBottom.ts`, and their tests; extend them instead of replacing them.
- An upward user scroll pauses immediately even inside the bottom-distance threshold.
- Tool, status, interaction, error, user, and execution boundaries must never be merged.
- No production code is written before its focused test has failed for the expected reason.
- Do not persist any additional hidden chain-of-thought data.

## File Structure

- `apps/desktop/src/hooks/useStickToBottom.ts` owns reusable pinned-scroll behavior.
- `apps/desktop/src/components/ChatThread.tsx` owns outer pagination and the inner thinking scroll container.
- `packages/persistence/src/repositories.ts` owns task-message insert, update, and legacy-read coalescing.
- `packages/scheduler/src/orchestrator.ts` owns semantic streamed-text assembly.
- `apps/desktop/src/task-messages.ts` owns Renderer message-list upsert behavior.
- `apps/desktop/src/pages/TaskDetail.tsx` consumes message upserts.

---

### Task 1: Independent Thinking Scroll

**Files:**
- Modify: `apps/desktop/src/hooks/useStickToBottom.ts:41`
- Modify: `apps/desktop/src/components/ChatThread.tsx:252`
- Test: `apps/desktop/src/hooks/__tests__/useStickToBottom.test.ts`
- Test: `apps/desktop/src/components/__tests__/ChatThread.test.tsx`

**Interfaces:**
- Consumes: `nextStickToBottomState(state, event)` already present in the dirty worktree.
- Produces: `useStickToBottom(deps, threshold)` with direction-aware pause; an internal `ThinkingBody({ text, className })` that attaches its own ref.

- [ ] **Step 1: Extend the failing scroll-state tests**

```ts
it('does not request scrolling after an upward move that is still near bottom', () => {
  const paused = nextStickToBottomState(
    { pinned: true, paused: false },
    { type: 'user-scroll', atBottom: true, direction: 'up' },
  );
  expect(nextStickToBottomState(paused, { type: 'content' }).scroll).toBe(false);
});
```

Add a ChatThread assertion that an expanded thinking region has `data-testid="thinking-body"` and an explicit scroll container. Run the focused tests and confirm the hook test fails because `useStickToBottom` still ignores scroll direction.

Run: `pnpm --filter @ai-devflow/desktop test -- src/hooks/__tests__/useStickToBottom.test.ts src/components/__tests__/ChatThread.test.tsx`

Expected: FAIL on the direction-aware hook behavior.

- [ ] **Step 2: Make the reusable hook direction-aware**

Track `lastScrollTopRef` and use the pure transition in the listener:

```ts
const direction = el.scrollTop < lastScrollTopRef.current ? 'up' : 'down';
lastScrollTopRef.current = el.scrollTop;
const next = nextStickToBottomState(
  { pinned: !paused, paused },
  { type: 'user-scroll', atBottom, direction },
);
setPaused(next.paused);
if (!next.paused) setUnreadCount(0);
```

Update `lastScrollTopRef` after every programmatic scroll.

- [ ] **Step 3: Attach the hook to the thinking body**

Extract this internal component and render it only while thinking is expanded:

```tsx
function ThinkingBody({ text, className }: { text: string; className: string }) {
  const { containerRef } = useStickToBottom([text], 16);
  return <div ref={containerRef} data-testid="thinking-body" className={className}>{text}</div>;
}
```

The outer `ChatThread` retains its pagination-specific scroll logic. The inner body receives `max-h-48 overflow-auto` and never receives the outer ref.

- [ ] **Step 4: Verify focused behavior**

Run: `pnpm --filter @ai-devflow/desktop test -- src/hooks/__tests__/useStickToBottom.test.ts src/components/__tests__/ChatThread.test.tsx`

Expected: PASS with no warnings.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/hooks/useStickToBottom.ts apps/desktop/src/hooks/__tests__/useStickToBottom.test.ts apps/desktop/src/components/ChatThread.tsx apps/desktop/src/components/__tests__/ChatThread.test.tsx
git commit -m "fix(desktop): stabilize nested conversation scrolling"
```

### Task 2: Task-Message Update and Legacy Coalescing

**Files:**
- Modify: `packages/persistence/src/repositories.ts:753`
- Test: `packages/persistence/src/__tests__/persistence.test.ts`

**Interfaces:**
- Produces: `TaskMessagesRepo.updateText(id: string, text: string): void`.
- Produces: exported `coalesceLegacyTaskMessages(messages: TaskMessage[]): TaskMessage[]` for focused testing.

- [ ] **Step 1: Write failing repository tests**

Insert three assistant text rows for one execution, a status row, and a fourth assistant text row. Assert:

```ts
expect(repos.taskMessages.listByTask('t').map((m) => m.text)).toEqual([
  'files that need to be changed',
  'tool finished',
  'final answer',
]);
```

Also insert user text and two different execution IDs and assert they remain separate. Add an update test:

```ts
repos.taskMessages.updateText('m1', 'complete sentence');
expect(repos.taskMessages.listByTask('t')[0]?.text).toBe('complete sentence');
```

Run: `pnpm --filter @ai-devflow/persistence test -- src/__tests__/persistence.test.ts`

Expected: FAIL because `updateText` and coalescing do not exist.

- [ ] **Step 2: Implement exact coalescing rules**

Merge only adjacent rows satisfying all of:

```ts
previous.executionId === current.executionId &&
previous.role === 'assistant' && current.role === 'assistant' &&
previous.kind === 'text' && current.kind === 'text'
```

Preserve the first ID and timestamp and concatenate with no inserted characters. Return copied objects so repository callers cannot mutate database mappings.

- [ ] **Step 3: Implement update and read integration**

Add:

```ts
updateText(id, text) {
  const result = db.prepare('UPDATE task_messages SET text=? WHERE id=?').run(text, id);
  if (result.changes !== 1) throw new Error(`任务消息不存在：${id}`);
}
```

Apply `coalesceLegacyTaskMessages` after the existing ordered query in `listByTask`.

- [ ] **Step 4: Verify persistence**

Run: `pnpm --filter @ai-devflow/persistence test -- src/__tests__/persistence.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/persistence/src/repositories.ts packages/persistence/src/__tests__/persistence.test.ts
git commit -m "fix(persistence): coalesce streamed task messages"
```

### Task 3: Scheduler Text Assembly and Renderer Upsert

**Files:**
- Modify: `packages/scheduler/src/orchestrator.ts:755`
- Test: `packages/scheduler/src/__tests__/orchestrator.test.ts`
- Create: `apps/desktop/src/task-messages.ts`
- Create: `apps/desktop/src/__tests__/task-messages.test.ts`
- Modify: `apps/desktop/src/pages/TaskDetail.tsx:60`

**Interfaces:**
- Produces: `upsertTaskMessage(messages: TaskMessage[], incoming: TaskMessage): TaskMessage[]`.
- Orchestrator stores one active assistant text message per execution ID and emits the complete updated value under the same message ID.

- [ ] **Step 1: Write the failing scheduler test**

Run a fake development execution with text deltas `files that `, `need to `, `be changed`, then a status event, then `final answer`. Assert the persisted conversation contains exactly two assistant text messages with complete text and that repeated stream events reuse the first message ID.

Run: `pnpm --filter @ai-devflow/scheduler test -- src/__tests__/orchestrator.test.ts`

Expected: FAIL because each delta is inserted separately.

- [ ] **Step 2: Implement scheduler assembly**

Add `private activeTextMessages = new Map<string, TaskMessage>()`. For informational `log` events:

```ts
const active = this.activeTextMessages.get(execution.id);
if (active) {
  const updated = { ...active, text: `${active.text ?? ''}${ev.text}` };
  this.repos.taskMessages.updateText(updated.id, updated.text ?? '');
  this.activeTextMessages.set(execution.id, updated);
  this.emit('task-message', { taskId: task.id, message: updated });
} else {
  const created = this.recordMessage(task, execution, {
    role: 'assistant', kind: 'text', text: ev.text, t,
  });
  this.activeTextMessages.set(execution.id, created);
}
```

Delete the map entry before every non-informational event and when `consumeRun` exits, including cancellation and errors. Error-level logs remain standalone error messages.

- [ ] **Step 3: Write the failing Renderer upsert test**

```ts
const first = { id: 'm1', taskId: 't', role: 'assistant', kind: 'text', text: 'files', t: 1 } as TaskMessage;
expect(upsertTaskMessage([first], { ...first, text: 'files changed' })).toEqual([{ ...first, text: 'files changed' }]);
```

Also assert a new ID appends and preserves order.

Run: `pnpm --filter @ai-devflow/desktop test -- src/__tests__/task-messages.test.ts`

Expected: FAIL because the helper does not exist.

- [ ] **Step 4: Implement and connect Renderer upsert**

```ts
export function upsertTaskMessage(list: TaskMessage[], incoming: TaskMessage): TaskMessage[] {
  const index = list.findIndex((message) => message.id === incoming.id);
  if (index < 0) return [...list, incoming];
  const next = [...list];
  next[index] = incoming;
  return next;
}
```

Use it in `TaskDetail` for `task-message` stream events. Keep initial API loads unchanged because persistence already coalesces legacy rows.

- [ ] **Step 5: Verify scheduler and desktop tests**

Run: `pnpm --filter @ai-devflow/scheduler test -- src/__tests__/orchestrator.test.ts`

Run: `pnpm --filter @ai-devflow/desktop test -- src/__tests__/task-messages.test.ts src/components/__tests__/ChatThread.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/scheduler/src/orchestrator.ts packages/scheduler/src/__tests__/orchestrator.test.ts apps/desktop/src/task-messages.ts apps/desktop/src/__tests__/task-messages.test.ts apps/desktop/src/pages/TaskDetail.tsx
git commit -m "fix: assemble streamed task conversation messages"
```

### Task 4: Conversation Regression Verification

**Files:**
- Modify only if a failing regression requires a scoped correction to files from Tasks 1-3.

**Interfaces:**
- Consumes all interfaces from Tasks 1-3.
- Produces no new API.

- [ ] **Step 1: Run package verification**

Run: `pnpm --filter @ai-devflow/persistence typecheck && pnpm --filter @ai-devflow/persistence test`

Run: `pnpm --filter @ai-devflow/scheduler typecheck && pnpm --filter @ai-devflow/scheduler test`

Run: `pnpm --filter @ai-devflow/desktop typecheck && pnpm --filter @ai-devflow/desktop test`

Expected: all commands exit 0.

- [ ] **Step 2: Run the desktop and inspect both scroll regions**

Run: `pnpm --filter @ai-devflow/desktop dev`

Verify with a streamed AI creation conversation and a task conversation:

1. Expanded thinking follows its newest line.
2. Scrolling upward inside thinking pauses only that region.
3. Scrolling upward in task conversation prevents both new bubbles and bubble updates from moving the outer position.
4. A completed sentence appears as one bubble.

- [ ] **Step 3: Route any correction back through its owning task**

If verification exposes a regression, return to Task 1, 2, or 3 according to
the owning file, add a focused failing test, and repeat that task's red-green
cycle and concrete commit step. If verification is clean, create no extra
commit for this task.
