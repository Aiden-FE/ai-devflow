# Task Workflow Guardrails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restrict board drag-and-drop to four explicit actions and make `task_review` payload production and validation deterministic.

**Architecture:** Put the drop-action matrix in `@ai-devflow/core` and use dedicated start, accept, and reject IPC operations. Make the report-result tool schema depend on `AI_DEVFLOW_RESULT_KIND`, then carry field-level payload validation diagnostics through JSON translation and PiRunner.

**Tech Stack:** TypeScript 5.7, React 18, Electron IPC, TypeBox, Pi coding-agent extensions, Vitest 2, pnpm.

## Global Constraints

- Only `ready -> in_progress`, `in_review -> archived`, and `in_review -> ready|in_progress` are board actions.
- Rejection always requires a non-empty reason; rejecting to `in_progress` starts repair immediately.
- `in_progress`, `testing`, `awaiting_input`, and `archived` cards are never draggable.
- The host remains fail-closed for malformed review results and never fabricates a knowledge assessment.
- Preserve unrelated dirty-worktree changes, especially current `Workspace.tsx`, IPC, and provider-router edits.

## File Structure

- `packages/core/src/board-actions.ts` owns the pure drop-action matrix.
- `apps/desktop/src/pages/Workspace.tsx` owns drag state, lane affordances, and rejection-dialog handoff.
- `apps/desktop/src/components/RejectTaskDialog.tsx` owns the shared rejection form and preserves input across failed submissions.
- `apps/desktop/electron/ipc.ts` owns Main-process enforcement of dedicated actions.
- `packages/core/src/knowledge.ts` owns detailed domain-payload validation.
- `packages/agents/assets/profiles/shared/extensions/event-bridge.ts` owns result-kind-specific TypeBox tool schemas.
- `packages/agents/src/json-events.ts` and `pi-runner.ts` preserve and surface contract diagnostics.

---

### Task 1: Pure Board Action Matrix

**Files:**
- Create: `packages/core/src/board-actions.ts`
- Create: `packages/core/src/__tests__/board-actions.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `BoardDropAction`.
- Produces: `boardDropAction(source: TaskStatus, target: TaskStatus): BoardDropAction | undefined`.
- Produces: `isBoardDraggable(status: TaskStatus): boolean`.

- [ ] **Step 1: Write the complete failing matrix test**

```ts
const allowed = new Map([
  ['ready:in_progress', { kind: 'start' }],
  ['in_review:archived', { kind: 'accept' }],
  ['in_review:ready', { kind: 'reject', target: 'ready' }],
  ['in_review:in_progress', { kind: 'reject', target: 'in_progress' }],
]);
for (const source of ALL_STATUSES) {
  for (const target of ALL_STATUSES) {
    expect(boardDropAction(source, target)).toEqual(allowed.get(`${source}:${target}`));
  }
}
expect(ALL_STATUSES.filter(isBoardDraggable)).toEqual(['ready', 'in_review']);
```

Run: `pnpm --filter @ai-devflow/core test -- src/__tests__/board-actions.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 2: Implement the minimal policy**

```ts
export type BoardDropAction =
  | { kind: 'start' }
  | { kind: 'accept' }
  | { kind: 'reject'; target: 'ready' | 'in_progress' };

export function boardDropAction(source: TaskStatus, target: TaskStatus): BoardDropAction | undefined {
  if (source === 'ready' && target === 'in_progress') return { kind: 'start' };
  if (source === 'in_review' && target === 'archived') return { kind: 'accept' };
  if (source === 'in_review' && (target === 'ready' || target === 'in_progress')) {
    return { kind: 'reject', target };
  }
  return undefined;
}

export const isBoardDraggable = (status: TaskStatus): boolean =>
  status === 'ready' || status === 'in_review';
```

Export the module from `packages/core/src/index.ts`.

- [ ] **Step 3: Verify and commit**

Run: `pnpm --filter @ai-devflow/core test -- src/__tests__/board-actions.test.ts`

Expected: PASS.

```bash
git add packages/core/src/board-actions.ts packages/core/src/__tests__/board-actions.test.ts packages/core/src/index.ts
git commit -m "feat(core): define explicit board drop actions"
```

### Task 2: Workspace Drag Actions and Rejection Dialog

**Files:**
- Modify: `apps/desktop/src/pages/Workspace.tsx:146`
- Create: `apps/desktop/src/components/RejectTaskDialog.tsx`
- Modify: `apps/desktop/src/pages/TaskDetail.tsx:253`
- Create: `apps/desktop/src/__tests__/workspace-drag-policy.test.tsx`
- Modify: `apps/desktop/src/i18n/zh.ts`
- Modify: `apps/desktop/src/i18n/en.ts`

**Interfaces:**
- Consumes: `boardDropAction`, `isBoardDraggable` from Task 1.
- Produces: Workspace state `{ taskId: string; target: 'ready' | 'in_progress' } | undefined` for a pending rejection drop.
- Produces: `RejectTaskDialog` with `initialTarget`, optional `lockedTarget`, `busy`, `error`, `onClose`, and `onSubmit(reason, target)` props.

- [ ] **Step 1: Write the failing render tests**

Render exported `TaskCard` fixtures and assert:

```ts
expect(renderCard('ready')).toContain('draggable="true"');
expect(renderCard('in_review')).toContain('draggable="true"');
for (const status of ['in_progress', 'testing', 'awaiting_input', 'archived']) {
  expect(renderCard(status as TaskStatus)).not.toContain('draggable="true"');
}
```

Test an exported `dropActionFor(tasks, taskId, target)` helper to prove only the four actions from Task 1 are returned.

Run: `pnpm --filter @ai-devflow/desktop test -- src/__tests__/workspace-drag-policy.test.tsx`

Expected: FAIL because every card is currently draggable and the helper does not exist.

- [ ] **Step 2: Implement drag state and lane gating**

Track `draggedTaskId` in `WorkspaceBody`. Pass the source task to each lane and compute `canDrop` from `boardDropAction`. Only call `preventDefault()` in `onDragOver` when `canDrop` is true. Set:

```tsx
draggable={isBoardDraggable(task.status)}
onDragStart={(event) => {
  if (!isBoardDraggable(task.status)) return;
  event.dataTransfer.setData('text/plain', task.id);
  onDragState(task.id);
}}
onDragEnd={() => onDragState(undefined)}
```

Invalid lanes retain normal border/background styling.

- [ ] **Step 3: Dispatch the dedicated action**

Replace `onDrop` status mutation with:

```ts
const action = boardDropAction(task.status, target);
if (action?.kind === 'start') await api.tasks.start(task.id);
if (action?.kind === 'accept') await api.tasks.accept(task.id);
if (action?.kind === 'reject') setPendingDropReject({ taskId: task.id, target: action.target });
```

Extract TaskDetail's private `RejectDialog` into `RejectTaskDialog`. TaskDetail
uses the shared component with an editable target. A drag rejection passes the
drop target as both `initialTarget` and `lockedTarget`, so the dialog requests
only the reason and cannot redirect the task to another lane. Its submit calls
`api.tasks.reject({ taskId, target, reason })`. Keep the same component mounted
and preserve its local reason text if IPC rejects; expose the returned error in
the dialog. Add a render test for the locked target and concise Chinese and
English labels only where existing translations do not cover them.

- [ ] **Step 4: Verify and commit**

Run: `pnpm --filter @ai-devflow/desktop test -- src/__tests__/workspace-drag-policy.test.tsx src/__tests__/workspace-reqitem.test.tsx`

Expected: PASS.

```bash
git add apps/desktop/src/pages/Workspace.tsx apps/desktop/src/pages/TaskDetail.tsx apps/desktop/src/components/RejectTaskDialog.tsx apps/desktop/src/__tests__/workspace-drag-policy.test.tsx apps/desktop/src/i18n/zh.ts apps/desktop/src/i18n/en.ts
git commit -m "fix(desktop): restrict task board drag actions"
```

### Task 3: Main-Process Action Enforcement

**Files:**
- Modify: `apps/desktop/electron/ipc.ts:422`
- Test: `apps/desktop/electron/__tests__/ipc.test.ts`

**Interfaces:**
- Consumes: dedicated `tasks.start`, `tasks.accept`, and `tasks.reject` operations.
- Keeps `tasks.updateStatus` for compatibility but makes it reject Renderer-driven workflow changes with a stable error.

- [ ] **Step 1: Write failing bypass tests**

For `ready`, `in_review`, `testing`, and `archived` fixtures, call `tasks.updateStatus` with every visible target and assert rejection with `任务状态只能通过启动、验收或驳回操作变更`. Assert the stored status is unchanged. Retain existing positive tests for `start`, `accept`, and both `reject` targets.

Run: `pnpm --filter @ai-devflow/desktop test -- electron/__tests__/ipc.test.ts`

Expected: FAIL because the generic handler currently allows gated transitions.

- [ ] **Step 2: Close the generic IPC path**

Replace the handler body with a stable rejection:

```ts
ipcMain.handle(channel('tasks', 'updateStatus'), () => {
  throw new Error('任务状态只能通过启动、验收或驳回操作变更');
});
```

Do not remove `TasksRepo.updateStatus`; scheduler transitions still use the repository internally.

- [ ] **Step 3: Verify and commit**

Run: `pnpm --filter @ai-devflow/desktop test -- electron/__tests__/ipc.test.ts`

Expected: PASS.

```bash
git add apps/desktop/electron/ipc.ts apps/desktop/electron/__tests__/ipc.test.ts
git commit -m "fix(electron): enforce dedicated task transitions"
```

### Task 4: Field-Level Domain Payload Diagnostics

**Files:**
- Modify: `packages/core/src/knowledge.ts:302`
- Test: `packages/core/src/__tests__/knowledge.test.ts`
- Modify: `packages/agents/src/json-events.ts:20`
- Test: `packages/agents/src/__tests__/json-events.test.ts`
- Modify: `packages/agents/src/pi-runner.ts:329`
- Test: `packages/agents/src/__tests__/pi-runner.test.ts`

**Interfaces:**
- Produces: `validateKnowledgeAgentPayload(value: unknown): { ok: true; value: KnowledgeAgentPayload } | { ok: false; error: string }`.
- Extends `StructuredResult` with `payloadError?: string`.

- [ ] **Step 1: Write failing detailed-validation tests**

```ts
expect(validateKnowledgeAgentPayload({
  kind: 'task_review',
  review: { pass: true, summary: 'REVIEW_VERDICT: PASS' },
  knowledgeAssessment: { verdict: 'none', reason: 'x', evidence: [] },
})).toEqual({ ok: false, error: 'payload.knowledgeAssessment.evidence 必须至少包含一项' });
```

Add JSON translator and PiRunner assertions that the same diagnostic is returned instead of `task_review 结果缺少领域载荷`.

Add table-driven completion cases for the three review verdict sources:

```ts
const cases = [
  { summary: 'REVIEW_VERDICT: PASS', reviewSummary: 'REVIEW_VERDICT: PASS', pass: false },
  { summary: 'REVIEW_VERDICT: PASS', reviewSummary: 'REVIEW_VERDICT: FAIL', pass: true },
  { summary: 'REVIEW_VERDICT: FAIL', reviewSummary: 'reviewed', pass: false },
];
```

Each case must return a stable inconsistency diagnostic. Add positive PASS and
FAIL cases where `summary`, `review.summary`, and `review.pass` all agree.

Run: `pnpm --filter @ai-devflow/core test -- src/__tests__/knowledge.test.ts`

Run: `pnpm --filter @ai-devflow/agents test -- src/__tests__/json-events.test.ts src/__tests__/pi-runner.test.ts`

Expected: FAIL because validation is boolean and malformed payloads are silently dropped.

- [ ] **Step 2: Implement detailed validation without weakening existing guards**

Validate discriminant, review fields, and both knowledge-assessment variants in deterministic field order. Keep:

```ts
export function isKnowledgeAgentPayload(value: unknown): value is KnowledgeAgentPayload {
  return validateKnowledgeAgentPayload(value).ok;
}
```

This preserves existing callers while exposing the diagnostic API.

- [ ] **Step 3: Preserve diagnostics through translation and completion**

`normalize()` stores either `payload` or `payloadError`.
`validateExpertCompletion()` returns `result.payloadError` before checking for
a missing payload. For `task_review`, parse an explicit PASS or FAIL marker from
both `result.summary` and `payload.review.summary`; reject a missing marker,
reject differing markers, and reject a marker that disagrees with
`payload.review.pass`. Valid, agreeing PASS and FAIL payload behavior remains
unchanged.

- [ ] **Step 4: Verify and commit**

Run: `pnpm --filter @ai-devflow/core test -- src/__tests__/knowledge.test.ts`

Run: `pnpm --filter @ai-devflow/agents test -- src/__tests__/json-events.test.ts src/__tests__/pi-runner.test.ts`

Expected: PASS.

```bash
git add packages/core/src/knowledge.ts packages/core/src/__tests__/knowledge.test.ts packages/agents/src/json-events.ts packages/agents/src/__tests__/json-events.test.ts packages/agents/src/pi-runner.ts packages/agents/src/__tests__/pi-runner.test.ts
git commit -m "fix(agents): preserve review payload diagnostics"
```

### Task 5: Result-Kind-Specific Report Tool Schema

**Files:**
- Modify: `packages/agents/assets/profiles/shared/extensions/event-bridge.ts`
- Modify: `packages/agents/assets/profiles/tester/SYSTEM.md`
- Test: `packages/agents/src/__tests__/real-pi.test.ts`
- Test: `scripts/inspect-roles.test.mjs`

**Interfaces:**
- Consumes: `AI_DEVFLOW_RESULT_KIND` from `buildPiRunPlan`.
- Produces: a required TypeBox payload schema for each non-task result kind and no payload property for `task_execution`.

- [ ] **Step 1: Add a failing real-Pi contract case**

Add a task-review request whose first attempted report has `knowledgeAssessment.evidence: []`. The real tool must reject that invocation inside the turn; the prompt then instructs the agent to correct it with one evidence path. Assert the final done event contains a valid `task_review` payload and no missing-payload error.

Run: `pnpm --filter @ai-devflow/agents test -- src/__tests__/real-pi.test.ts`

Expected: FAIL because `payload: Type.Unknown()` accepts the invalid first invocation.

- [ ] **Step 2: Define exact TypeBox schemas**

Build schemas for `task_review`, `knowledge_initialization`, `knowledge_audit`, `knowledge_repair`, `knowledge_deposition`, and `iteration_changelog`. The review schema uses:

```ts
const nonEmpty = Type.String({ minLength: 1 });
const nonEmptyStrings = Type.Array(nonEmpty, { minItems: 1 });
const assessment = Type.Union([
  Type.Object({ verdict: Type.Literal('none'), reason: nonEmpty, evidence: nonEmptyStrings }),
  Type.Object({ verdict: Type.Literal('valuable'), candidates: Type.Array(candidate, { minItems: 1 }) }),
]);
```

Construct report parameters from `process.env.AI_DEVFLOW_RESULT_KIND`. Require the mapped payload for non-task kinds and omit it for `task_execution`. Keep host validation as defense in depth.

Use these exact shared shapes for the remaining payload fields:

```ts
const strings = Type.Array(Type.String());
const knowledgeType = Type.Union([
  Type.Literal('context'), Type.Literal('adr'), Type.Literal('feature'),
  Type.Literal('runbook'), Type.Literal('product'), Type.Literal('ux'),
]);
const candidate = Type.Object({
  type: knowledgeType,
  summary: nonEmpty,
  evidence: nonEmptyStrings,
  suggestedTarget: Type.Optional(Type.String()),
  reuseScenario: nonEmpty,
});
const finding = Type.Object({
  id: nonEmpty,
  severity: Type.Union([Type.Literal('info'), Type.Literal('warn'), Type.Literal('error')]),
  code: Type.String(),
  path: Type.Optional(Type.String()),
  knowledgeId: Type.Optional(Type.String()),
  message: Type.String(),
  evidence: strings,
});
const payloadByKind = {
  task_review: Type.Object({
    kind: Type.Literal('task_review'),
    review: Type.Object({
      pass: Type.Boolean(), summary: nonEmpty,
      feedback: Type.Optional(Type.String()),
      checks: Type.Optional(strings),
    }),
    knowledgeAssessment: assessment,
  }),
  knowledge_initialization: Type.Object({
    kind: Type.Literal('knowledge_initialization'), changedPaths: strings, knowledgeIds: strings,
  }),
  knowledge_audit: Type.Object({ kind: Type.Literal('knowledge_audit'), findings: Type.Array(finding) }),
  knowledge_repair: Type.Object({
    kind: Type.Literal('knowledge_repair'), changedPaths: strings,
    knowledgeIds: strings, resolvedFindingIds: strings,
  }),
  knowledge_deposition: Type.Object({
    kind: Type.Literal('knowledge_deposition'), changedPaths: strings, knowledgeIds: strings,
    candidateKnowledge: Type.Array(Type.Object({
      candidateIndex: Type.Integer({ minimum: 0 }), knowledgeId: nonEmpty,
    })),
    assessment,
  }),
  iteration_changelog: Type.Object({
    kind: Type.Literal('iteration_changelog'), changedPaths: strings, coveredTaskIds: strings,
  }),
} as const;
```

- [ ] **Step 3: Make tester guidance concrete**

Replace pseudo-object notation with valid JSON examples for both `none` and `valuable` assessments, including non-empty evidence. Do not change unrelated role policy.

- [ ] **Step 4: Verify packaged profile and real Pi**

Run: `pnpm inspect:roles`

Run: `pnpm test:scripts`

Run: `pnpm --filter @ai-devflow/agents test -- src/__tests__/real-pi.test.ts src/__tests__/pi-runner.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/assets/profiles/shared/extensions/event-bridge.ts packages/agents/assets/profiles/tester/SYSTEM.md packages/agents/src/__tests__/real-pi.test.ts scripts/inspect-roles.test.mjs
git commit -m "fix(agents): enforce typed task review results"
```

### Task 6: Workflow Verification

**Files:**
- No planned file changes.

**Interfaces:**
- Consumes Tasks 1-5.
- Produces no new API.

- [ ] **Step 1: Run full affected-package verification**

Run: `pnpm --filter @ai-devflow/core typecheck && pnpm --filter @ai-devflow/core test`

Run: `pnpm --filter @ai-devflow/agents typecheck && pnpm --filter @ai-devflow/agents test`

Run: `pnpm --filter @ai-devflow/scheduler typecheck && pnpm --filter @ai-devflow/scheduler test`

Run: `pnpm --filter @ai-devflow/desktop typecheck && pnpm --filter @ai-devflow/desktop test`

Expected: all commands exit 0.

- [ ] **Step 2: Manually exercise the four board actions**

Run: `pnpm --filter @ai-devflow/desktop dev`

Verify ready-to-development starts execution, review-to-archive accepts, both rejection targets require a reason, and every running/testing/archived card refuses dragging.
