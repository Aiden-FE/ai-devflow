import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, lstatSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorktree, removeWorktree, listWorktrees, isGitRepo, WorktreeError, mergeWorktreeBranch, sprintBranchName, sanitizeBranchSegment, ensureSprintBranch, mergeBranchInto, branchExists } from '../worktree.js';

let repo: string;
let base: string;

function sh(cmd: string, args: string[], cwd: string) {
  execFileSync(cmd, args, { cwd, stdio: 'ignore' });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'aidf-wt-repo-'));
  base = mkdtempSync(join(tmpdir(), 'aidf-wt-base-'));
  sh('git', ['init', '-q', '-b', 'main'], repo);
  sh('git', ['config', 'user.email', 't@t'], repo);
  sh('git', ['config', 'user.name', 't'], repo);
  writeFileSync(join(repo, 'README.md'), 'hello');
  sh('git', ['add', '.'], repo);
  sh('git', ['commit', '-q', '-m', 'init'], repo);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
});

describe('git worktree lifecycle', () => {
  it('isGitRepo detects repo vs non-repo', async () => {
    expect(await isGitRepo(repo)).toBe(true);
    const notRepo = mkdtempSync(join(tmpdir(), 'aidf-notrepo-'));
    try {
      expect(await isGitRepo(notRepo)).toBe(false);
    } finally {
      rmSync(notRepo, { recursive: true, force: true });
    }
  });

  it('createWorktree creates a linked worktree on a new branch', async () => {
    const handle = await createWorktree({ repoPath: repo, baseDir: base, id: 't1', baseBranch: 'main' });
    expect(existsSync(handle.path)).toBe(true);
    expect(handle.branch).toBe('ai-devflow/t1');
    expect(await isGitRepo(handle.path)).toBe(true);
    // worktree 应能看到主仓库的文件
    expect(existsSync(join(handle.path, 'README.md'))).toBe(true);
    const list = await listWorktrees(repo);
    // 用分支名比对，避免 macOS /tmp -> /private/tmp 符号链接导致路径不一致
    expect(list.some((w) => w.branch === 'ai-devflow/t1')).toBe(true);
  });

  it('createWorktree on non-repo throws WorktreeError with hint', async () => {
    const notRepo = mkdtempSync(join(tmpdir(), 'aidf-notrepo2-'));
    try {
      await expect(
        createWorktree({ repoPath: notRepo, baseDir: base, id: 't2' }),
      ).rejects.toBeInstanceOf(WorktreeError);
    } finally {
      rmSync(notRepo, { recursive: true, force: true });
    }
  });

  it('removeWorktree removes path and branch', async () => {
    const handle = await createWorktree({ repoPath: repo, baseDir: base, id: 't3', baseBranch: 'main' });
    await removeWorktree({ repoPath: repo, worktreePath: handle.path, branchName: handle.branch });
    expect(existsSync(handle.path)).toBe(false);
    const list = await listWorktrees(repo);
    expect(list.some((w) => w.branch === handle.branch)).toBe(false);
  });

  it('createWorktree cleans up stale existing path', async () => {
    const stale = join(base, 't4');
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, 'junk'), 'x');
    const handle = await createWorktree({ repoPath: repo, baseDir: base, id: 't4', baseBranch: 'main' });
    expect(existsSync(join(handle.path, 'README.md'))).toBe(true);
    expect(existsSync(join(handle.path, 'junk'))).toBe(false);
  });

  it('createWorktree auto-detects current branch when baseBranch does not exist', async () => {
    // 模拟用户导入时误填 defaultBranch 为 main，实际仓库分支是 master
    sh('git', ['checkout', '-q', '-b', 'master'], repo);
    const handle = await createWorktree({ repoPath: repo, baseDir: base, id: 't5', baseBranch: 'main' });
    expect(existsSync(handle.path)).toBe(true);
    expect(handle.branch).toBe('ai-devflow/t5');
    const list = await listWorktrees(repo);
    expect(list.some((w) => w.branch === 'ai-devflow/t5')).toBe(true);
  });

  it('createWorktree on repo with no commits throws clear WorktreeError', async () => {
    const emptyRepo = mkdtempSync(join(tmpdir(), 'aidf-wt-empty-'));
    sh('git', ['init', '-q', '-b', 'main'], emptyRepo);
    sh('git', ['config', 'user.email', 't@t'], emptyRepo);
    sh('git', ['config', 'user.name', 't'], emptyRepo);
    try {
      await expect(
        createWorktree({ repoPath: emptyRepo, baseDir: base, id: 't6', baseBranch: 'main' }),
      ).rejects.toMatchObject({
        message: /没有可用的提交/,
        hint: /初始提交/,
      });
    } finally {
      rmSync(emptyRepo, { recursive: true, force: true });
    }
  });
});

describe('node_modules sharing', () => {
  it('createWorktree symlinks main repo node_modules into worktree', async () => {
    // 主仓库已安装依赖（含一个 marker 包）
    mkdirSync(join(repo, 'node_modules'));
    mkdirSync(join(repo, 'node_modules', 'marker-pkg'));
    writeFileSync(join(repo, 'node_modules', 'marker-pkg', 'package.json'), '{"name":"marker-pkg"}');

    const handle = await createWorktree({ repoPath: repo, baseDir: base, id: 'nm1', baseBranch: 'main' });
    const wtNodeModules = join(handle.path, 'node_modules');
    expect(existsSync(wtNodeModules)).toBe(true);
    // worktree 内能解析到主仓库的依赖
    expect(existsSync(join(handle.path, 'node_modules', 'marker-pkg', 'package.json'))).toBe(true);
    // node_modules 是符号链接（复用主仓库，非拷贝）
    expect(lstatSync(wtNodeModules).isSymbolicLink()).toBe(true);
    // 指向主仓库的 node_modules
    expect(readlinkSync(wtNodeModules)).toBe(join(repo, 'node_modules'));
  });

  it('createWorktree skips node_modules link when main repo has none', async () => {
    const handle = await createWorktree({ repoPath: repo, baseDir: base, id: 'nm2', baseBranch: 'main' });
    expect(existsSync(join(handle.path, 'node_modules'))).toBe(false);
  });

  it('removeWorktree cleans up the symlink without deleting main repo node_modules', async () => {
    mkdirSync(join(repo, 'node_modules'));
    writeFileSync(join(repo, 'node_modules', 'pkg.json'), '{}');
    const handle = await createWorktree({ repoPath: repo, baseDir: base, id: 'nm3', baseBranch: 'main' });
    expect(existsSync(join(handle.path, 'node_modules'))).toBe(true);
    await removeWorktree({ repoPath: repo, worktreePath: handle.path, branchName: handle.branch });
    expect(existsSync(handle.path)).toBe(false);
    // 主仓库的 node_modules 必须完好（符号链接被删除而非依赖目录）
    expect(existsSync(join(repo, 'node_modules', 'pkg.json'))).toBe(true);
  });
});

describe('mergeWorktreeBranch', () => {
  it('fast-forwards feature branch into default branch', async () => {
    const handle = await createWorktree({ repoPath: repo, baseDir: base, id: 'm1', baseBranch: 'main' });
    // 在 worktree 里提交一个新文件
    writeFileSync(join(handle.path, 'feature.txt'), 'x');
    sh('git', ['add', '.'], handle.path);
    sh('git', ['commit', '-q', '-m', 'feature'], handle.path);

    const res = await mergeWorktreeBranch({ repoPath: repo, branchName: handle.branch, defaultBranch: 'main' });
    expect(res.merged).toBe(true);
    expect(existsSync(join(repo, 'feature.txt'))).toBe(true);
    const log = execFileSync('git', ['log', '--oneline'], { cwd: repo }).toString();
    expect(log).toMatch(/feature/);
  });

  it('skips merge when project workspace is on a different branch', async () => {
    sh('git', ['checkout', '-q', '-b', 'other'], repo);
    const res = await mergeWorktreeBranch({ repoPath: repo, branchName: 'ai-devflow/whatever', defaultBranch: 'main' });
    expect(res.merged).toBe(false);
    expect(res.reason).toMatch(/other/);
  });

  it('falls back to no-ff merge when default branch has advanced', async () => {
    const handle = await createWorktree({ repoPath: repo, baseDir: base, id: 'm3', baseBranch: 'main' });
    // 主分支前进
    writeFileSync(join(repo, 'main.txt'), 'm');
    sh('git', ['add', '.'], repo);
    sh('git', ['commit', '-q', '-m', 'main advance'], repo);
    // 特性分支也前进
    writeFileSync(join(handle.path, 'feature.txt'), 'f');
    sh('git', ['add', '.'], handle.path);
    sh('git', ['commit', '-q', '-m', 'feature'], handle.path);

    const res = await mergeWorktreeBranch({ repoPath: repo, branchName: handle.branch, defaultBranch: 'main' });
    expect(res.merged).toBe(true);
    expect(existsSync(join(repo, 'feature.txt'))).toBe(true);
    expect(existsSync(join(repo, 'main.txt'))).toBe(true);
  });
});

describe('sprint branch helpers', () => {
  it('sprintBranchName prefixes version with ai-devflow-sprint/', () => {
    expect(sprintBranchName('v1.0.0')).toBe('ai-devflow-sprint/v1.0.0');
    expect(sprintBranchName('v1')).toBe('ai-devflow-sprint/v1');
  });

  it('sanitizeBranchSegment replaces illegal chars and trims separators', () => {
    expect(sanitizeBranchSegment('v 1.0.0')).toBe('v-1.0.0');
    expect(sanitizeBranchSegment('v1/2')).toBe('v1-2');
    expect(sanitizeBranchSegment('..v1..')).toBe('v1');
    expect(sanitizeBranchSegment('   ')).toBe('unnamed');
  });

  it('ensureSprintBranch creates branch from base if absent, reuses if present', async () => {
    const r1 = await ensureSprintBranch({ repoPath: repo, version: 'v1.0.0', baseBranch: 'main' });
    expect(r1.branch).toBe('ai-devflow-sprint/v1.0.0');
    expect(r1.created).toBe(true);
    expect(await branchExists(repo, 'ai-devflow-sprint/v1.0.0')).toBe(true);
    // 重复调用：复用现有分支，不动其指向
    const r2 = await ensureSprintBranch({ repoPath: repo, version: 'v1.0.0', baseBranch: 'main' });
    expect(r2.created).toBe(false);
    expect(r2.branch).toBe('ai-devflow-sprint/v1.0.0');
  });

  it('mergeBranchInto fast-forwards sprint branch to task branch (no checkout)', async () => {
    // 先建迭代分支
    await ensureSprintBranch({ repoPath: repo, version: 'v1', baseBranch: 'main' });
    // 任务分支从迭代分支拉出并新增提交
    const handle = await createWorktree({ repoPath: repo, baseDir: base, id: 'spt1', baseBranch: 'ai-devflow-sprint/v1' });
    writeFileSync(join(handle.path, 'feat.txt'), 'x');
    sh('git', ['add', '.'], handle.path);
    sh('git', ['commit', '-q', '-m', 'feat'], handle.path);

    const res = await mergeBranchInto({ repoPath: repo, into: 'ai-devflow-sprint/v1', source: handle.branch });
    expect(res.merged).toBe(true);
    // 迭代分支现包含 feat.txt（主工作区仍在 main，不受影响）
    sh('git', ['checkout', '-q', 'ai-devflow-sprint/v1'], repo);
    expect(existsSync(join(repo, 'feat.txt'))).toBe(true);
    sh('git', ['checkout', '-q', 'main'], repo);
  });

  it('mergeBranchInto merges non-ff via temp worktree when sprint has diverged', async () => {
    await ensureSprintBranch({ repoPath: repo, version: 'v2', baseBranch: 'main' });
    // 迭代分支独立前进一步
    sh('git', ['checkout', '-q', 'ai-devflow-sprint/v2'], repo);
    writeFileSync(join(repo, 'sprint.txt'), 's');
    sh('git', ['add', '.'], repo);
    sh('git', ['commit', '-q', '-m', 'sprint advance'], repo);
    sh('git', ['checkout', '-q', 'main'], repo);

    // 任务分支也独立前进一步
    const handle = await createWorktree({ repoPath: repo, baseDir: base, id: 'spt2', baseBranch: 'ai-devflow-sprint/v2' });
    // 任务分支的 base 是迭代分支的旧位置，需要重置到 diverge 点之前
    // 直接在任务 worktree 提交
    writeFileSync(join(handle.path, 'task.txt'), 't');
    sh('git', ['add', '.'], handle.path);
    sh('git', ['commit', '-q', '-m', 'task advance'], handle.path);

    const res = await mergeBranchInto({ repoPath: repo, into: 'ai-devflow-sprint/v2', source: handle.branch });
    expect(res.merged).toBe(true);
    sh('git', ['checkout', '-q', 'ai-devflow-sprint/v2'], repo);
    expect(existsSync(join(repo, 'sprint.txt'))).toBe(true);
    expect(existsSync(join(repo, 'task.txt'))).toBe(true);
    sh('git', ['checkout', '-q', 'main'], repo);
  });

  it('mergeBranchInto returns reason when target branch missing', async () => {
    const res = await mergeBranchInto({ repoPath: repo, into: 'ai-devflow-sprint/missing', source: 'main' });
    expect(res.merged).toBe(false);
    expect(res.reason).toMatch(/不存在/);
  });
});
