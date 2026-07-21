import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorktree, removeWorktree, listWorktrees, isGitRepo, WorktreeError, mergeWorktreeBranch } from '../worktree.js';

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
