# Structured Result Contract Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the full desktop task startup flow by making the report-result transport schema represent the host's valid result-kind contract.

**Architecture:** Keep the Pi tool schema permissive only about payload presence and keep all result-kind discrimination in `validateExpertCompletion`. Update tester guidance and the E2E provider so review runs exercise the required `task_review` payload, then finish the separately approved project-default-branch metadata recovery.

**Tech Stack:** TypeScript 5.7, TypeBox tool schemas, bundled Pi runtime, Electron, Vitest 2, Playwright Electron E2E, Git CLI.

## Global Constraints

- `task_execution` must omit `payload`.
- Every non-task result kind must include a payload with the matching discriminator.
- Transport optionality must not weaken host validation.
- The full Electron E2E remains the behavioral acceptance test.
- Preserve all pre-existing uncommitted changes; do not commit implementation automatically.

---

### Task 1: Repair Report-Result Transport Optionality

**Files:**
- Modify: `packages/agents/assets/profiles/shared/extensions/event-bridge.ts`
- Verify: `packages/agents/src/__tests__/pi-runner.test.ts`
- Verify: `apps/desktop/scripts/run-e2e.mjs`

**Interfaces:**
- Consumes: `AI_DEVFLOW_RESULT_KIND` enforced by host-side `validateExpertCompletion`.
- Produces: `ai_devflow_report_result` transport arguments where `payload` may be absent.

- [ ] **Step 1: Preserve the observed RED evidence**

Run:

```bash
pnpm --filter @ai-devflow/desktop e2e
```

Expected: the task returns to `ready` after three development attempts because the payload-less task-execution report cannot satisfy the tool schema.

- [ ] **Step 2: Make only the transport field optional**

Change the report-result parameters from:

```typescript
payload: Type.Unknown(),
```

to:

```typescript
payload: Type.Optional(Type.Unknown()),
```

Do not change `validateResultPayload`; its existing tests already prove task execution rejects payload and task review requires payload.

- [ ] **Step 3: Run focused host contract tests**

```bash
pnpm --filter @ai-devflow/agents exec vitest run src/__tests__/pi-runner.test.ts src/__tests__/json-events.test.ts
```

Expected: all tests pass, including task-execution rejection of an unexpected payload and task-review rejection of a missing payload.

- [ ] **Step 4: Re-run E2E to expose the next real boundary**

```bash
pnpm --filter @ai-devflow/desktop e2e
```

Expected: development completes; if the deterministic provider still omits the review payload, the flow fails later at review with the specific task-review contract error.

---

### Task 2: Supply the Review Contract End to End

**Files:**
- Modify: `packages/agents/assets/profiles/tester/SYSTEM.md`
- Modify: `apps/desktop/scripts/run-e2e.mjs`
- Verify: `packages/agents/src/__tests__/real-pi.test.ts`

**Interfaces:**
- Consumes: required `task_review` host payload contract.
- Produces: tester guidance and deterministic E2E review responses with `{ kind: 'task_review', review, knowledgeAssessment }`.

- [ ] **Step 1: Make tester guidance exact**

Extend the tester completion protocol with this contract:

```text
当 resultKind=task_review 时，payload 必须为：
{ kind: 'task_review', review: { pass, summary, feedback?, checks? }, knowledgeAssessment }
summary 与 review.summary 的 REVIEW_VERDICT 必须一致；knowledgeAssessment 必须是合法 none 或 valuable 结构。
task_execution 不得携带 payload。
```

- [ ] **Step 2: Make the fake provider phase-aware**

In `startFakeProvider`, derive a review request from message text containing the existing review prompt marker `你是一名严格的代码审查 Agent`. Build common result fields once and add this payload only for review:

```javascript
const isTaskReview = Array.isArray(body.messages) && body.messages.some((message) =>
  typeof message?.content === 'string' && message.content.includes('你是一名严格的代码审查 Agent'),
);
const args = JSON.stringify({
  summary: 'packaged isolation complete\nREVIEW_VERDICT: PASS',
  verification: ['bundled Pi isolation'],
  changedFiles: [],
  unresolved: [],
  ...(isTaskReview ? {
    payload: {
      kind: 'task_review',
      review: { pass: true, summary: 'REVIEW_VERDICT: PASS' },
      knowledgeAssessment: {
        verdict: 'none',
        reason: 'deterministic E2E review found no reusable knowledge',
        evidence: ['README.md'],
      },
    },
  } : {}),
});
```

- [ ] **Step 3: Run agent tests and the complete Electron E2E**

```bash
pnpm --filter @ai-devflow/agents exec vitest run src/__tests__/pi-runner.test.ts src/__tests__/json-events.test.ts src/__tests__/profiles.test.ts
pnpm --filter @ai-devflow/desktop e2e
```

Expected: agent tests pass and the E2E started task reaches `in_review`, then all remaining UI checks complete.

---

### Task 3: Complete Project Default-Branch Metadata Recovery

**Files:**
- Modify: `apps/desktop/electron/ipc.ts`
- Test: `apps/desktop/electron/__tests__/ipc.test.ts`
- Already modified in the current TDD cycle: `packages/scheduler/src/worktree.ts`, `packages/scheduler/src/index.ts`, `packages/scheduler/src/__tests__/worktree.test.ts`.

**Interfaces:**
- Consumes: `resolveProjectDefaultBranch(repoPath, configuredBranch)` already implemented and covered by four passing real-Git tests.
- Produces: corrected metadata on import and before iteration creation.

- [ ] **Step 1: Keep the existing IPC RED tests**

The two current tests must continue failing only because imported and existing projects retain `main` instead of the repository's current `master` branch.

- [ ] **Step 2: Resolve on project import**

Make the `projects:create` handler async, call:

```typescript
const resolved = await resolveProjectDefaultBranch(input.path, input.defaultBranch || 'main');
```

and persist `defaultBranch: resolved.branch`.

- [ ] **Step 3: Resolve and persist before iteration mutation**

In `iterations:create`, after loading the project and before `initializeIteration`, resolve the branch. When `recovered` is true, persist:

```typescript
repos.projects.update({
  ...project,
  defaultBranch: resolved.branch,
  updatedAt: now(),
});
```

- [ ] **Step 4: Update unrelated IPC fixtures to use valid Git repositories or direct repository inserts**

Tests that only need an existing project must insert it directly. Tests specifically covering project import must initialize and commit a real temporary Git repository. Do not weaken the new import contract to preserve non-Git fixtures.

- [ ] **Step 5: Run focused regression tests**

```bash
pnpm --filter @ai-devflow/scheduler exec vitest run src/__tests__/worktree.test.ts
pnpm --filter @ai-devflow/desktop exec vitest run electron/__tests__/ipc.test.ts electron/__tests__/iteration-knowledge-lifecycle.test.ts
```

Expected: all tests pass.

---

### Task 4: Final Verification

**Files:**
- Verify only.

- [ ] **Step 1: Run typechecks and diff validation**

```bash
pnpm --filter @ai-devflow/agents typecheck
pnpm --filter @ai-devflow/scheduler typecheck
pnpm --filter @ai-devflow/desktop typecheck
git diff --check
```

- [ ] **Step 2: Run the complete Electron E2E once more**

```bash
pnpm --filter @ai-devflow/desktop e2e
```

Expected: `ALL PASSED`.

- [ ] **Step 3: Verify the real repository mismatch read-only**

Confirm `/Users/aiden/dev/aiden/omni-ai-translator` resolves from configured `main` to current `master` without editing the real user database during verification.

