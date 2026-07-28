# Git Default Branch Recovery Design

## Problem

Imported Git projects currently trust the renderer-supplied `defaultBranch`, whose default is `main`. A repository whose actual branch is `master` can therefore be persisted with an invalid default branch. Progressive knowledge initialization now creates the iteration sprint branch atomically from the persisted default branch, so the first iteration fails with `fatal: invalid reference: main`.

The production database demonstrates this exact state: the imported project records `main`, while its repository contains only `master`.

## Desired Behavior

- Importing an existing Git repository persists its current valid local branch instead of an invalid form default.
- Existing projects with a stale or invalid configured default branch recover when an operation first needs the branch.
- Recovery is allowed only when Git exposes one unambiguous current named branch that resolves to a commit.
- Detached HEAD, repositories without commits, and paths that are not Git repositories fail with an actionable error instead of guessing.
- Once recovered, the corrected default branch is persisted so iteration, task, archive, and knowledge flows use the same branch thereafter.

## Design

Add one scheduler-level Git helper that resolves a project default branch:

1. Verify that the configured branch resolves to a commit. If it does, return it unchanged.
2. Otherwise read the repository's current named branch and verify that it resolves to a commit.
3. Return the verified current branch as a recovery result, including whether it differs from the configured value.
4. Reject detached HEAD, empty repositories, and non-Git paths with a `WorktreeError` and a clear hint.

Use the helper at two host boundaries:

- Project import: resolve before inserting the project record, so new imports are correct from the start.
- Iteration creation: resolve before knowledge initialization. If recovery changes the branch, update the project record before creating the sprint branch. This repairs existing persisted records without direct database editing.

New-project creation with `git init` remains unchanged because it explicitly creates the requested branch and an initial commit.

## Error Handling

Branch resolution runs before any iteration claim, worktree, document, or sprint branch mutation. A resolution failure therefore leaves both SQLite and Git unchanged. IPC surfaces the diagnostic to the existing form error display.

Persisting a recovered branch happens before iteration mutation. If later iteration initialization fails, the branch correction remains valid project metadata and is not rolled back.

## Tests

- Scheduler unit tests cover valid configured branches, recovery from `main` to `master`, detached HEAD, and repositories without commits.
- Desktop IPC tests import a real `master` repository while the request supplies `main`, then assert that `master` is persisted.
- Desktop IPC tests start with an existing project persisted as `main` over a `master` repository, create an iteration, and assert both project repair and sprint branch creation.
- Existing focused Desktop, scheduler, typecheck, and startup-flow tests must remain green.

