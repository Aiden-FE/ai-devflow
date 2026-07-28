# Git Default Branch Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make imported and previously persisted Git projects use a real local default branch before iteration initialization mutates SQLite or Git.

**Architecture:** Add a scheduler-owned resolver beside the existing worktree Git helpers. Desktop IPC uses that single resolver when importing an existing project and immediately before creating an iteration, persisting a recovered branch so every later workflow sees consistent project metadata.

**Tech Stack:** TypeScript 5.7, Node.js `child_process`, Git CLI, Electron IPC, Vitest 2, SQLite repositories.

## Global Constraints

- Prefer the configured branch when it resolves to a commit.
- Recover only to the current named local branch when it resolves to a commit.
- Do not guess in detached HEAD, non-Git, or no-commit repositories.
- Resolve before iteration claims, worktrees, documents, or sprint branch mutation.
- Do not change new-project `git init` behavior.
- Preserve all pre-existing uncommitted changes in the target files; do not commit implementation automatically because those files already contain user changes.

---

### Task 1: Resolve a Project Default Branch

**Files:**
- Modify: `packages/scheduler/src/worktree.ts`
- Modify: `packages/scheduler/src/index.ts`
- Test: `packages/scheduler/src/__tests__/worktree.test.ts`

**Interfaces:**
- Consumes: existing `isGitRepo(repoPath)`, `isValidCommit(repoPath, ref)`, and Git command wrapper behavior.
- Produces: `resolveProjectDefaultBranch(repoPath: string, configuredBranch?: string): Promise<{ branch: string; recovered: boolean }>` exported from `@ai-devflow/scheduler`.

- [ ] **Step 1: Write failing resolver tests using real repositories**

Add focused tests whose expected values are literal:

```typescript
it('keeps a configured branch that resolves to a commit', async () => {
  await expect(resolveProjectDefaultBranch(repo, 'main')).resolves.toEqual({
    branch: 'main',
    recovered: false,
  });
});

it('recovers an invalid configured branch to the current named branch', async () => {
  sh('git', ['branch', '-m', 'master'], repo);
  await expect(resolveProjectDefaultBranch(repo, 'main')).resolves.toEqual({
    branch: 'master',
    recovered: true,
  });
});

it('rejects detached HEAD instead of guessing a branch', async () => {
  sh('git', ['checkout', '--detach'], repo);
  await expect(resolveProjectDefaultBranch(repo, 'missing')).rejects.toMatchObject({
    message: expect.stringMatching(/默认分支|detached|游离/),
  });
});

it('rejects a repository without commits', async () => {
  const emptyRepo = mkdtempSync(join(tmpdir(), 'aidf-default-empty-'));
  sh('git', ['init', '-q', '-b', 'main'], emptyRepo);
  try {
    await expect(resolveProjectDefaultBranch(emptyRepo, 'main')).rejects.toMatchObject({
      hint: expect.stringMatching(/初始提交/),
    });
  } finally {
    rmSync(emptyRepo, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
pnpm --filter @ai-devflow/scheduler exec vitest run src/__tests__/worktree.test.ts
```

Expected: compilation/test failure because `resolveProjectDefaultBranch` does not exist.

- [ ] **Step 3: Implement the minimal resolver**

Add the exported helper in `worktree.ts`:

```typescript
export async function resolveProjectDefaultBranch(
  repoPath: string,
  configuredBranch?: string,
): Promise<{ branch: string; recovered: boolean }> {
  if (!(await isGitRepo(repoPath))) {
    throw new WorktreeError(`不是 Git 仓库：${repoPath}`, '请确认项目路径指向一个 Git 工作区');
  }
  if (configuredBranch && await isValidCommit(repoPath, configuredBranch)) {
    return { branch: configuredBranch, recovered: false };
  }
  const { stdout } = await exec('git', ['branch', '--show-current'], { cwd: repoPath });
  const branch = stdout.trim();
  if (branch && await isValidCommit(repoPath, branch)) {
    return { branch, recovered: branch !== configuredBranch };
  }
  throw new WorktreeError(
    '仓库没有可恢复的当前默认分支',
    '请切换到一个有提交的本地分支后重试',
  );
}
```

Export it from `packages/scheduler/src/index.ts`.

- [ ] **Step 4: Run the resolver tests and verify GREEN**

Run the Task 1 command again. Expected: all `worktree.test.ts` tests pass with no warnings.

---

### Task 2: Repair Project Metadata at Desktop Boundaries

**Files:**
- Modify: `apps/desktop/electron/ipc.ts`
- Test: `apps/desktop/electron/__tests__/ipc.test.ts`

**Interfaces:**
- Consumes: `resolveProjectDefaultBranch(repoPath, configuredBranch)` from Task 1 and `repos.projects.update(project)`.
- Produces: imported projects whose `defaultBranch` is valid, plus lazy recovery for existing stale project records before iteration initialization.

- [ ] **Step 1: Write a failing import test**

Use a real temporary repository whose only branch is `master`:

```typescript
it('projects.create persists the current branch when the requested default is invalid', async () => {
  execFileSync('git', ['init', '-q', '-b', 'master', workdir]);
  execFileSync('git', ['-C', workdir, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', workdir, 'config', 'user.name', 't']);
  writeFileSync(join(workdir, 'README.md'), 'x');
  execFileSync('git', ['-C', workdir, 'add', '.']);
  execFileSync('git', ['-C', workdir, 'commit', '-qm', 'init']);

  const project = await call('projects', 'create', {
    name: 'Master Repo', path: workdir, defaultBranch: 'main',
  }) as { id: string; defaultBranch: string };

  expect(project.defaultBranch).toBe('master');
  expect(repos.projects.get(project.id)?.defaultBranch).toBe('master');
});
```

- [ ] **Step 2: Write a failing lazy-recovery iteration test**

Persist the known production mismatch and assert both metadata and workflow effects:

```typescript
it('iterations.create repairs a stale project default branch before creating the sprint branch', async () => {
  // Initialize and commit a real master-only repository, then persist stale `main` metadata.
  repos.projects.insert({
    id: 'p', name: 'P', path: workdir, defaultBranch: 'main',
    createdAt: 1, updatedAt: 1, settings: {},
  });
  services.knowledge = new KnowledgeCoordinator({
    repos,
    runner: {
      async verifyRuntime() { return { version: 'fake', entry: 'fake' }; },
      async run() { throw new Error('unused'); },
    },
    knowledge: new ProjectKnowledgeService(),
    worktreesBaseDir: join(workdir, 'knowledge-worktrees'),
  });

  const iteration = await call('iterations', 'create', 'p', 'I1', 'v1') as { id: string };

  expect(repos.projects.get('p')?.defaultBranch).toBe('master');
  expect(repos.iterations.get(iteration.id)).toBeDefined();
  expect(execFileSync('git', [
    'show', 'ai-devflow-sprint/v1:docs/iterations/v1/index.md',
  ], { cwd: workdir, encoding: 'utf8' })).toContain(iteration.id);
});
```

- [ ] **Step 3: Run both Desktop tests and verify RED**

Run:

```bash
pnpm --filter @ai-devflow/desktop exec vitest run electron/__tests__/ipc.test.ts
```

Expected: import assertion receives `main`; stale iteration creation rejects with `invalid reference: main`.

- [ ] **Step 4: Resolve and persist branches in IPC**

Make `projects:create` async, resolve before constructing the project, and store `resolved.branch`.

Before calling `services.knowledge.initializeIteration`, resolve `project.defaultBranch`. When `recovered` is true, update a copy with the resolved branch and a fresh `updatedAt`, persist it through `repos.projects.update`, and pass the now-consistent repository state into the coordinator path.

Do not apply this logic to `projects:createAtPath`; that handler creates the requested branch and initial commit itself.

- [ ] **Step 5: Run focused Desktop and scheduler tests and verify GREEN**

Run:

```bash
pnpm --filter @ai-devflow/scheduler exec vitest run src/__tests__/worktree.test.ts
pnpm --filter @ai-devflow/desktop exec vitest run electron/__tests__/ipc.test.ts electron/__tests__/iteration-knowledge-lifecycle.test.ts
```

Expected: both commands pass with no warnings.

---

### Task 3: Verify the Real Startup Boundary

**Files:**
- Verify only; no planned production edits.

**Interfaces:**
- Consumes: Tasks 1-2 behavior.
- Produces: evidence that the production mismatch `configured=main`, repository=`master` is recovered without modifying the real user database during the test.

- [ ] **Step 1: Run static verification**

```bash
pnpm --filter @ai-devflow/scheduler typecheck
pnpm --filter @ai-devflow/desktop typecheck
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 2: Run a temporary-user-data startup flow**

Run the existing Desktop E2E flow or a focused Electron harness with a temporary user-data directory and a `master`-only imported repository. The flow must import the project, create iteration `v1`, and observe `ai-devflow-sprint/v1` plus the persisted iteration.

- [ ] **Step 3: Confirm the production evidence is addressed read-only**

Re-run read-only Git inspection on `/Users/aiden/dev/aiden/omni-ai-translator` and confirm the resolver returns `{ branch: 'master', recovered: true }` when configured with `main`. Do not edit the real database; the running application will persist the correction on the next iteration attempt.
