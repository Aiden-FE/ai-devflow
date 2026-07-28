# Progressive Knowledge Base Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the production integration, Git ownership, retrieval evidence, deposition, audit, and iteration archive gaps found while reviewing the approved progressive knowledge base design.

**Architecture:** Keep Markdown as the only knowledge body source and make `KnowledgeCoordinator` the host-side owner of worktrees, commits, validation, locks, recovery records, and state gates. Pi agents may edit only their scoped files and report structured results; they never perform Git operations. Production composition must inject the same coordinator used by integration tests.

**Tech Stack:** TypeScript 5.7, Node.js 22+, pnpm 11.15.1, Electron 43, React 18, Vitest 2, SQLite, Git worktrees, Pi JSONL runtime.

## Global Constraints

- The approved design at `docs/superpowers/specs/2026-07-27-progressive-knowledge-base-design.md` remains the source of requirements.
- `docs/knowledge/**` and `docs/iterations/**` are the only paths a project lead may change.
- Host code, not an agent, performs Git add/commit/merge/cleanup and validates the complete diff.
- A passing test review cannot enter `in_review` without a valid assessment and, for `valuable`, a validated deposition.
- Missing knowledge does not block ordinary execution, but `valuable` pauses for explicit initialization.
- Iteration archive operates on the sprint branch, aggregates before validating, and archives the database only after a successful merge.
- SQLite stores metadata and evidence references, never Markdown bodies.
- Every behavior change follows a red-green test cycle.

---

### Task 1: Production Composition and Task Knowledge Lifecycle

**Files:**
- Modify: `apps/desktop/electron/services.ts`
- Modify: `packages/scheduler/src/orchestrator.ts`
- Modify: `packages/scheduler/src/knowledge-coordinator.ts`
- Test: `apps/desktop/electron/__tests__/services-init.test.ts`
- Test: `packages/scheduler/src/__tests__/orchestrator-knowledge.test.ts`

**Interfaces:**
- Produces one shared `KnowledgeCoordinator` injected into `OrchestratorOptions.knowledgeCoordinator`.
- Produces task-start initialization of `docs/iterations/<version>/tasks/<task-id>/index.md` in the task worktree.

- [x] Add a production composition test that starts a task through services and observes a persisted retrieval plus enforced missing-assessment gate.
- [x] Run the focused Desktop test and confirm it fails because the orchestrator has no coordinator.
- [x] Construct the coordinator before the orchestrator and inject it into `OrchestratorOptions`.
- [x] Add a scheduler integration test that observes the task index in the task branch.
- [x] Run it and confirm it fails because `initializeTask()` has no production caller.
- [x] Initialize the task layout before the first development manifest and commit it through the task branch lifecycle.
- [x] Run focused Desktop and scheduler tests until green.

### Task 2: Host-Owned Knowledge Draft Git Contract

**Files:**
- Modify: `packages/scheduler/src/knowledge-coordinator.ts`
- Modify: `packages/scheduler/src/worktree.ts`
- Test: `packages/scheduler/src/__tests__/knowledge-coordinator.test.ts`

**Interfaces:**
- Produces a host helper that stages scoped Markdown, inspects staged paths, commits the draft, and returns changed paths.
- Produces cleanup of every knowledge worktree on confirm, cancel, success, and failure.

- [x] Change the fake project lead to edit files without committing and add assertions that initialization still previews and merges the edits.
- [x] Run the focused test and confirm the draft path is empty or merge loses the edit.
- [x] Add a host-owned stage/validate/commit helper using explicit Git arguments and scoped paths.
- [x] Use it for initialization, repair, and deposition before commit-range diff or merge.
- [x] Persist the worktree path needed by pending runs or derive it deterministically from run IDs, then remove it before deleting branches.
- [x] Add an out-of-scope uncommitted edit test and confirm the host rejects it before staging.
- [x] Run coordinator and worktree tests until green.

### Task 3: Retrieval Completion and Coverage

**Files:**
- Modify: `packages/scheduler/src/orchestrator.ts`
- Modify: `packages/scheduler/src/knowledge-coordinator.ts`
- Modify: `apps/desktop/electron/ipc.ts`
- Test: `packages/scheduler/src/__tests__/orchestrator-knowledge.test.ts`
- Test: `apps/desktop/electron/__tests__/knowledge-ipc.test.ts`

**Interfaces:**
- Produces `KnowledgeCoordinator.completeRetrieval(manifest, reads, state)` with candidate membership and file/character budget validation.
- Produces persisted project-scope manifests for product, UX, development lead, development, and test executions.

- [x] Add a scheduler test whose agent reports a real `knowledgeReads` entry and assert the stored retrieval becomes `completed` with that evidence.
- [x] Run it and confirm the row remains `planned` with empty evidence.
- [x] Complete or fail each retrieval after agent termination and reject reads outside the manifest or over budget.
- [x] Rebuild task evidence from persisted candidate and read JSON rather than empty arrays.
- [x] Add a project chat/proposal boundary test that observes a persisted manifest before the Pi request.
- [x] Wire project-scope preparation into the existing Pi AI entry points without injecting knowledge bodies.
- [x] Run scheduler, agent, and Desktop knowledge tests until green.

### Task 4: Full Audit and Validated Deposition

**Files:**
- Modify: `packages/core/src/knowledge.ts`
- Modify: `packages/scheduler/src/knowledge-coordinator.ts`
- Modify: `packages/scheduler/src/orchestrator.ts`
- Modify: `packages/knowledge/src/audit.ts`
- Test: `packages/scheduler/src/__tests__/knowledge-coordinator.test.ts`
- Test: `packages/scheduler/src/__tests__/orchestrator-knowledge.test.ts`
- Test: `packages/knowledge/src/__tests__/audit.test.ts`

**Interfaces:**
- Full audit invokes `project_lead` with `resultKind: knowledge_audit`, validates that exact payload, and persists semantic findings alongside structural findings.
- Valuable deposition returns an explicit `awaitingInitialization` outcome when the catalog is missing.
- Successful deposition requires scoped commit, blocking-free audit, Git tracking, non-empty related knowledge IDs, and coverage of every valuable candidate.

- [x] Add a full-audit test asserting the project lead request and semantic finding persistence; confirm it fails because full equals light.
- [x] Implement full-audit agent execution in a disposable worktree and preserve light audit as host-only.
- [x] Add an ignored-Markdown audit test expecting a blocking finding; confirm current warning behavior fails it.
- [x] Make ignored Markdown blocking for write-gated operations.
- [x] Add a valuable/uninitialized scheduler test expecting `awaiting_input` and an `awaiting_initialization` deposition record.
- [x] Implement the pause outcome and a resumable system message/checkpoint path.
- [x] Add deposition tests for malformed metadata, missing candidate coverage, and valid indexed/tracked output.
- [x] Pass assessment, task diff, retrieval references, and iteration context to project lead; validate its payload and the resulting catalog before merge.
- [x] Base deposition on the sprint branch when the task belongs to an active iteration and merge the deposition into that branch under the iteration lock.
- [x] Run core, knowledge, and scheduler tests until green.

### Task 5: Iteration CHANGELOG Aggregation and Strict Archive

**Files:**
- Modify: `packages/scheduler/src/knowledge-coordinator.ts`
- Modify: `packages/knowledge/src/changelog.ts`
- Test: `apps/desktop/electron/__tests__/iteration-knowledge-lifecycle.test.ts`
- Test: `packages/knowledge/src/__tests__/changelog.test.ts`

**Interfaces:**
- Archive creates a temporary worktree from `ai-devflow-sprint/<version>`, runs `project_lead` with `resultKind: iteration_changelog`, host-commits scoped output, verifies that same worktree, then merges the sprint branch.
- Verification checks task coverage, task CHANGELOG existence, version path, Git tracking at the candidate commit, and referenced knowledge IDs.

- [x] Rewrite the archive integration fixture so task changelogs exist only on the sprint branch and the fake project lead does not commit.
- [x] Run it and confirm current default-worktree validation fails.
- [x] Add aggregation before validation and commit it through the host helper.
- [x] Validate in the sprint worktree and persist the structured aggregation payload and findings.
- [x] Add failure tests for missing task coverage, invalid knowledge reference, aggregation failure, and merge failure; assert the iteration remains active.
- [x] Merge sprint into default only after validation and archive the database only after merge success.
- [x] Run changelog and Desktop lifecycle tests until green.

### Task 6: Recovery and End-to-End Verification

**Files:**
- Modify: `packages/scheduler/src/knowledge-coordinator.ts`
- Modify: `packages/scheduler/src/orchestrator.ts`
- Modify: `packages/agents/src/__tests__/real-pi.test.ts`
- Test: `packages/scheduler/src/__tests__/orchestrator-knowledge.test.ts`
- Test: `apps/desktop/electron/__tests__/iteration-knowledge-lifecycle.test.ts`

**Interfaces:**
- Startup recovery marks interrupted knowledge runs/depositions failed or resumes only from current Git state.
- Real Pi coverage supplies an actual bounded manifest and asserts reported reads stay within it.

- [x] Add restart tests for running deposition and pending initialization confirmation, including preserved diagnostics and no duplicate document creation.
- [x] Implement recovery using persisted run/deposition state and current branch/worktree inspection.
- [x] Update the real Pi knowledge fixture to pass a real manifest and assert returned reads and payload.
- [x] Run focused knowledge tests, then `pnpm typecheck`.
- [x] Run `pnpm test` outside the network-listen sandbox.
- [x] Re-read all ten acceptance criteria and record any remaining gap before completion.

### Task 7: Final Review Remediation

- [x] Diagnose legacy duplicate and normalized iteration-version collisions before applying the v13 unique index.
- [x] Claim iteration versions in SQLite before Git mutation and use expected-old CAS for shared branch updates and rollback.
- [x] Persist deposition validation/integration commit progress and reconcile Git before reuse or restart recovery.
- [x] Retry cleanup for every deposition attempt and report residual worktrees or branches.
- [x] Run all automated tests, real Pi tests from the repository-root `.env`, typecheck, diff validation, and secret scanning.

### Task 8: Final Consistency Review

- [x] Share one complete canonical Git branch-segment predicate between runtime validation and legacy migration preflight.
- [x] Persist hidden iteration initialization claims and recover claim-only, branch-only, and already-merged crash points before activation.
- [x] Require the knowledge draft commit itself to remain in the deposition target before persisting success.
- [x] Remove unsafe iteration creation without a knowledge coordinator.
- [x] Return exact CAS write/previous OIDs from branch merges and use only the written OID for rollback ownership.
- [x] Resolve the sprint base to a fixed commit and create the branch with a zero-OID CAS before recording rollback ownership.
