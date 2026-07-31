# Knowledge Initialization Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make pending knowledge initialization drafts recoverable so Confirm, Cancel, and repeated Initialize cannot leave a project stuck.

**Architecture:** Keep the scheduler as the authority for persisted run state. Serialize all project-level knowledge mutations on one project key, return an existing pending initialization idempotently, and let the renderer derive controls from the recovered full run view.

**Tech Stack:** TypeScript, Electron IPC, React 18, Vitest, SQLite-backed repositories, Git worktrees

## Global Constraints

- Preserve an existing `awaiting_confirmation` initialization draft; never auto-cancel it.
- Keep terminal run transitions monotonic.
- Do not change knowledge document formats, generation prompts, audit rules, or merge policy.
- Do not overwrite or stage unrelated pre-existing worktree changes.
- Use TDD: add each regression first and observe the expected failure before production edits.

---

## File Map

- `packages/scheduler/src/knowledge-coordinator.ts`: authoritative active-run lookup, project-scoped serialization, idempotent initialization, recovery errors.
- `packages/scheduler/src/__tests__/knowledge-coordinator.test.ts`: scheduler behavior and race regression coverage.
- `apps/desktop/src/pages/Knowledge.tsx`: renderer control availability derived from the active run.
- `apps/desktop/src/__tests__/knowledge-page.test.tsx`: recovered Confirm/Cancel and disabled-operation behavior.
- `apps/desktop/electron/api.ts`: already contains the `getActiveRun` public contract; update its return type only if required by scheduler async behavior.
- `apps/desktop/electron/ipc.ts`: forwards `getActiveRun`; no behavior change expected beyond accepting the async scheduler result.
- `apps/desktop/electron/preload.ts`: forwards `getActiveRun`; no behavior change expected.

### Task 1: Scheduler Recovery and Idempotent Initialization

**Files:**
- Modify: `packages/scheduler/src/__tests__/knowledge-coordinator.test.ts`
- Modify: `packages/scheduler/src/knowledge-coordinator.ts`

**Interfaces:**
- Produces: `getActiveRun(projectId: string): Promise<KnowledgeRunView | undefined>`
- Produces: an internal synchronous active-record lookup used while holding a project lock
- Preserves: `startInitialization(projectId: string): Promise<KnowledgeRunView>`

- [ ] **Step 1: Add a failing complete-view recovery test**

Extend the existing active-run test so the created draft has a diff and verify public recovery returns it:

```ts
it('getActiveRun recovers the complete pending draft view', async () => {
  const run = await coordinator.startInitialization('p1');

  const active = await coordinator.getActiveRun('p1');

  expect(active).toEqual(expect.objectContaining({
    id: run.id,
    state: 'awaiting_confirmation',
    confirmationState: 'pending',
  }));
  expect(active?.diff).toContain('docs/knowledge');
});
```

- [ ] **Step 2: Add a failing idempotent initialization test**

Replace the current expectation that a second initialization rejects when the pending run is an initialization:

```ts
it('returns the existing pending initialization instead of starting another run', async () => {
  const first = await coordinator.startInitialization('p1');
  const second = await coordinator.startInitialization('p1');

  expect(second.id).toBe(first.id);
  expect(second.diff).toContain('docs/knowledge');
  expect(repos.knowledgeRuns.listByProject('p1')).toHaveLength(1);
  expect(runner.requests).toHaveLength(1);
});
```

Keep a separate assertion that audit and repair reject while this draft is pending.

- [ ] **Step 3: Run the scheduler regression tests and verify RED**

Run:

```bash
pnpm --filter @ai-devflow/scheduler exec vitest run src/__tests__/knowledge-coordinator.test.ts
```

Expected failures:

- recovered view has no `diff`;
- second initialization rejects with the active-run error.

- [ ] **Step 4: Split active record lookup from full view construction**

Implement a private record lookup and make the public method async:

```ts
private getActiveRunRecord(projectId: string): KnowledgeRunRecord | undefined {
  return this.opts.repos.knowledgeRuns
    .listByProject(projectId)
    .find((record) => record.state === 'running' || record.state === 'awaiting_confirmation');
}

async getActiveRun(projectId: string): Promise<KnowledgeRunView | undefined> {
  const active = this.getActiveRunRecord(projectId);
  return active ? this.getRun(active.id) : undefined;
}
```

Update `requireNoActiveRun` to use `getActiveRunRecord` so it remains synchronous.

- [ ] **Step 5: Use one project lock and return the pending initialization**

Change initialization, audit, and repair lock keys to `knowledge:${projectId}`. At the beginning of `startInitialization` while inside that lock:

```ts
const active = this.getActiveRunRecord(projectId);
if (active?.kind === 'initialization' && active.state === 'awaiting_confirmation') {
  return this.getRun(active.id);
}
this.requireNoActiveRun(projectId);
```

Do not return a `running` initialization; it remains a conflicting operation.

- [ ] **Step 6: Run the scheduler regression tests and verify GREEN**

Run the Task 1 command again. Expected: all `knowledge-coordinator` tests pass.

### Task 2: Serialize Confirm and Cancel and Preserve Recovery

**Files:**
- Modify: `packages/scheduler/src/__tests__/knowledge-coordinator.test.ts`
- Modify: `packages/scheduler/src/knowledge-coordinator.ts`

**Interfaces:**
- Preserves: `confirmRun(runId: string): Promise<KnowledgeHealthSnapshot>`
- Preserves: `cancelRun(runId: string): Promise<void>`
- Consumes: the project lock key `knowledge:${projectId}` from Task 1

- [ ] **Step 1: Add a failing missing-draft recovery test**

```ts
it('keeps a missing pending draft cancelable after confirm reports recovery guidance', async () => {
  const run = await coordinator.startInitialization('p1');
  rmSync(join(wtBase, `knowledge-${run.id}`), { recursive: true, force: true });

  await expect(coordinator.confirmRun(run.id)).rejects.toThrow(/草稿.*缺失|取消.*重新初始化/);
  expect((await coordinator.getRun(run.id)).state).toBe('awaiting_confirmation');

  await expect(coordinator.cancelRun(run.id)).resolves.toBeUndefined();
  expect((await coordinator.getRun(run.id)).state).toBe('canceled');
});
```

- [ ] **Step 2: Add a failing terminal-state race test**

Use a deferred injected `mergeWorktreeBranch` to start Confirm, then call Cancel before releasing the merge. Assert that only one operation can enter the project mutation section and that the loser rejects without overwriting the winner's terminal state.

```ts
const confirmPromise = racingCoordinator.confirmRun(run.id);
await mergeEntered.promise;
const cancelPromise = racingCoordinator.cancelRun(run.id);
mergeRelease.resolve();

await expect(confirmPromise).resolves.toEqual(expect.objectContaining({ projectId: 'p1' }));
await expect(cancelPromise).rejects.toThrow(/不能取消/);
expect((await racingCoordinator.getRun(run.id)).state).toBe('succeeded');
```

- [ ] **Step 3: Run the two new scheduler tests and verify RED**

Run:

```bash
pnpm --filter @ai-devflow/scheduler exec vitest run src/__tests__/knowledge-coordinator.test.ts -t "missing pending draft|terminal-state race"
```

Expected: missing draft error is generic and/or concurrent Cancel can enter before Confirm finishes.

- [ ] **Step 4: Put Confirm and Cancel under the project lock**

Resolve the initial record only to obtain `projectId`, enter `this.locks.run(`knowledge:${projectId}`, ...)`, then re-read the record and validate its current state inside the lock. Keep all preflight, merge, cleanup, confirmation, and finish operations inside the critical section.

For Confirm, validate `draftBranch`, branch existence, and the derived worktree path before audit. Use a stable message:

```ts
throw new Error('知识草稿资源缺失，请取消本次草稿后重新初始化');
```

Do not mark this resource-loss case failed; leaving it awaiting confirmation is what keeps Cancel available.

For Cancel, keep cleanup best-effort and persist `confirmationState='canceled'` plus `state='canceled'` after revalidation.

- [ ] **Step 5: Run all scheduler tests and verify GREEN**

Run:

```bash
pnpm --filter @ai-devflow/scheduler test
```

Expected: all scheduler tests pass.

### Task 3: Renderer Recovery Controls

**Files:**
- Modify: `apps/desktop/src/__tests__/knowledge-page.test.tsx`
- Modify: `apps/desktop/src/pages/Knowledge.tsx`

**Interfaces:**
- Consumes: `api.knowledge.getActiveRun(projectId): Promise<KnowledgeRunView | undefined>`
- Preserves: `api.knowledge.confirmRun(runId)` and `api.knowledge.cancelRun(runId)`

- [ ] **Step 1: Add failing recovered Confirm and Cancel tests**

Add separate tests whose initial `getActiveRun` resolves to `pendingRun('p1')`, then click each recovered action:

```ts
it('confirms the pending run recovered on page entry', async () => {
  knowledgeApi.getProjectSnapshot.mockResolvedValue(snapshot('p1', { state: 'not_initialized' }));
  knowledgeApi.getActiveRun.mockResolvedValueOnce(pendingRun('p1'));
  knowledgeApi.confirmRun.mockResolvedValue(snapshot('p1'));
  render({ project: p1, projects, onSwitchProject: () => {} });
  await flush();

  click(findButton('common.confirm'));
  await flush();

  expect(knowledgeApi.confirmRun).toHaveBeenCalledWith('run-p1');
});
```

The Cancel test uses the same recovered setup and asserts `cancelRun('run-p1')`.

- [ ] **Step 2: Add a failing active-run operation guard test**

```ts
it('disables all new knowledge operations while a draft awaits confirmation', async () => {
  knowledgeApi.getProjectSnapshot.mockResolvedValue(snapshot('p1', { state: 'not_initialized' }));
  knowledgeApi.getActiveRun.mockResolvedValueOnce(pendingRun('p1'));
  render({ project: p1, projects, onSwitchProject: () => {} });
  await flush();

  expect(findButton('knowledge.initialize')?.disabled).toBe(true);
  expect(findButton('knowledge.fullAudit')?.disabled).toBe(true);
  expect(findButton('knowledge.repair')?.disabled).toBe(true);
  expect(findButton('common.confirm')?.disabled).toBe(false);
  expect(findButton('common.cancel')?.disabled).toBe(false);
});
```

- [ ] **Step 3: Run renderer tests and verify RED**

Run:

```bash
pnpm --filter @ai-devflow/desktop exec vitest run src/__tests__/knowledge-page.test.tsx
```

Expected: the initialization and audit buttons remain enabled for an awaiting-confirmation run.

- [ ] **Step 4: Derive operation availability from any active run**

In `Knowledge.tsx`, change the guard to:

```ts
const operationDisabled = busy || !!activeRun;
const switchDisabled = operationDisabled;
```

Keep Confirm and Cancel disabled only by `busy`. Keep `pendingRun` and `runningRun` derived from `activeRun`, and retain event-driven terminal refresh.

- [ ] **Step 5: Run renderer tests and verify GREEN**

Run the Task 3 test command again. Expected: all Knowledge page tests pass.

### Task 4: IPC Contract and Full Verification

**Files:**
- Verify: `apps/desktop/electron/api.ts`
- Verify: `apps/desktop/electron/ipc.ts`
- Verify: `apps/desktop/electron/preload.ts`
- Verify: all files changed in Tasks 1-3

**Interfaces:**
- Confirms Electron exposes and forwards the async `getActiveRun` result without changing channel names.

- [ ] **Step 1: Add or extend the IPC integration assertion**

In `apps/desktop/electron/__tests__/knowledge-ipc.test.ts`, initialize a run and call `getActiveRun` through the registered handler. Assert the recovered ID and `diff`, then cancel through IPC and assert `getActiveRun` is `undefined`.

- [ ] **Step 2: Run the IPC test and verify behavior**

Run:

```bash
pnpm --filter @ai-devflow/desktop exec vitest run electron/__tests__/knowledge-ipc.test.ts
```

Expected: PASS if forwarding already handles promises; otherwise make the smallest contract-preserving IPC change and rerun.

- [ ] **Step 3: Run focused typechecks and tests**

```bash
pnpm --filter @ai-devflow/scheduler typecheck
pnpm --filter @ai-devflow/desktop typecheck
pnpm --filter @ai-devflow/scheduler test
pnpm --filter @ai-devflow/desktop test
```

Expected: all commands exit 0. Existing unrelated warnings must be reported but do not justify unrelated edits.

- [ ] **Step 4: Inspect the final scoped diff**

Run:

```bash
git diff --check
git diff -- packages/scheduler/src/knowledge-coordinator.ts packages/scheduler/src/__tests__/knowledge-coordinator.test.ts apps/desktop/src/pages/Knowledge.tsx apps/desktop/src/__tests__/knowledge-page.test.tsx apps/desktop/electron/__tests__/knowledge-ipc.test.ts
```

Confirm every hunk maps to the approved design and no unrelated existing changes were reverted.
