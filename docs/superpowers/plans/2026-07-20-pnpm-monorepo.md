# Minimal pnpm Monorepo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a dependency-free monorepo skeleton whose packages are managed through pnpm workspace configuration.

**Architecture:** The repository root is a private coordination package that owns the shared lockfile and recursive lifecycle commands. Publishable or runnable packages will live one level below `packages/` and opt into the workspace by providing their own `package.json` files.

**Tech Stack:** Node.js v26.5.0, pnpm v11.11.0, YAML, JSON, Markdown, Git

## Global Constraints

- Keep the root package private and record `pnpm@11.11.0` in `packageManager`.
- Match only `packages/*` as workspace members.
- Do not add example packages, application frameworks, TypeScript, linting tools, formatters, release tools, task runners, CI, or third-party dependencies.
- Root `build`, `test`, and `lint` commands must recursively run matching child scripts and succeed when no child defines them.
- Track the otherwise-empty `packages/` directory with `.gitkeep`.
- Generate one shared root `pnpm-lock.yaml` with pnpm.
- Keep the project-local `.worktrees/` isolation directory ignored by Git.

---

### Task 1: Create and validate the workspace skeleton

**Files:**

- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Modify: `.gitignore`
- Create: `README.md`
- Create: `packages/.gitkeep`
- Generate: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: pnpm v11.11.0 and Node.js v26.5.0 from the local environment.
- Produces: a workspace root accepting packages at `packages/<package-name>/package.json`; child packages may expose `build`, `test`, and `lint` scripts consumed by the root commands.

- [ ] **Step 1: Run the acceptance check before scaffolding**

Run:

```bash
test -f package.json \
  && test -f pnpm-workspace.yaml \
  && test -f .gitignore \
  && test -f README.md \
  && test -f packages/.gitkeep \
  && test -f pnpm-lock.yaml
```

Expected: exit status 1 because the workspace files do not exist yet.

- [ ] **Step 2: Create the root package manifest**

Create `package.json` with exactly:

```json
{
  "name": "ai-devflow",
  "version": "0.0.0",
  "private": true,
  "packageManager": "pnpm@11.11.0",
  "scripts": {
    "build": "pnpm --recursive --if-present run build",
    "test": "pnpm --recursive --if-present run test",
    "lint": "pnpm --recursive --if-present run lint"
  }
}
```

- [ ] **Step 3: Declare workspace membership**

Create `pnpm-workspace.yaml` with exactly:

```yaml
packages:
  - "packages/*"
```

- [ ] **Step 4: Add repository hygiene files and package placeholder**

Replace `.gitignore` with exactly:

```gitignore
.worktrees/

node_modules/
.pnpm-store/

dist/
build/
coverage/

.env
.env.*
!.env.example

*.log
.DS_Store
```

Create an empty `packages/.gitkeep` file.

- [ ] **Step 5: Document workspace usage**

Create `README.md` with exactly:

````markdown
# ai-devflow

使用 pnpm workspace 管理的最小 monorepo。

## 环境要求

- Node.js
- pnpm 11.11.0

## 安装

```bash
pnpm install
```

## 目录

- `packages/*`：工作区包

每个包需要自己的 `package.json`。工作区内部依赖使用 `workspace:*` 协议声明。

## 命令

```bash
pnpm build
pnpm test
pnpm lint
```

根命令会递归执行各包中已定义的同名脚本。
````

- [ ] **Step 6: Install and generate the shared lockfile**

Run:

```bash
pnpm install
```

Expected: exit status 0, no third-party package download, and a new root `pnpm-lock.yaml` whose `lockfileVersion` is compatible with pnpm 11.

- [ ] **Step 7: Verify the workspace and root lifecycle commands**

Run:

```bash
pnpm list --recursive --depth -1
pnpm build
pnpm test
pnpm lint
```

Expected: all four commands exit 0. The list includes the private `ai-devflow@0.0.0` root; lifecycle commands find no child scripts and perform no work.

- [ ] **Step 8: Verify the resulting repository diff**

Run:

```bash
git diff --check
git status --short
```

Expected: `git diff --check` has no output. Git status shows only `.gitignore`, `README.md`, `package.json`, `packages/.gitkeep`, `pnpm-lock.yaml`, and `pnpm-workspace.yaml` as new or modified files.

- [ ] **Step 9: Commit the validated skeleton**

Run:

```bash
git add .gitignore README.md package.json packages/.gitkeep pnpm-lock.yaml pnpm-workspace.yaml
git commit -m "chore: initialize pnpm monorepo"
```

Expected: commit succeeds and `git status --short` is empty.
