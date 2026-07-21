import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, access } from 'node:fs/promises';
import { join } from 'node:path';

const exec = promisify(execFile);

export interface WorktreeHandle {
  path: string;
  branch: string;
}

export class WorktreeError extends Error {
  constructor(message: string, public readonly hint?: string) {
    super(message);
  }
}

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await exec('git', args, { cwd, env: process.env });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new WorktreeError(
      `git ${args.join(' ')} 失败：${e.stderr?.trim() || e.message}`,
      diagnoseGitError(args, e.stderr || e.message || ''),
    );
  }
}

function diagnoseGitError(args: string[], stderr: string): string | undefined {
  if (/not a git repository/i.test(stderr)) return '目标路径不是 Git 仓库';
  if (/already exists/i.test(stderr) && args.includes('worktree')) return 'worktree 路径已存在，清理后重试';
  if (/no commits yet/i.test(stderr)) return '仓库尚无提交，无法创建 worktree';
  return undefined;
}

/** 判断路径是否为 Git 仓库。 */
export async function isGitRepo(path: string): Promise<boolean> {
  try {
    await git(path, ['rev-parse', '--is-inside-work-tree']);
    return true;
  } catch {
    return false;
  }
}

/** 获取仓库当前分支。 */
export async function currentBranch(path: string): Promise<string> {
  const { stdout } = await git(path, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return stdout.trim();
}

/** 检查 ref 是否能解析到一个提交。 */
async function isValidCommit(repoPath: string, ref: string): Promise<boolean> {
  try {
    await exec('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: repoPath });
    return true;
  } catch {
    return false;
  }
}

/**
 * 解析可用的 worktree 基础 ref。
 * 优先使用调用方指定的 baseBranch；不存在时自动检测当前分支/任意本地分支/HEAD；
 * 若仓库完全没有提交，则抛出带清晰提示的 WorktreeError。
 */
async function resolveBase(repoPath: string, preferred?: string): Promise<string> {
  if (preferred && (await isValidCommit(repoPath, preferred))) {
    return preferred;
  }

  // 当前分支（可能为空，如 detached HEAD 或无提交）
  try {
    const { stdout } = await exec('git', ['branch', '--show-current'], { cwd: repoPath });
    const branch = stdout.trim();
    if (branch && (await isValidCommit(repoPath, branch))) {
      return branch;
    }
  } catch {
    // ignore
  }

  // 任意本地分支
  try {
    const { stdout } = await exec('git', ['branch', '--format=%(refname:short)'], { cwd: repoPath });
    const branches = stdout
      .trim()
      .split('\n')
      .map((b) => b.trim())
      .filter(Boolean);
    for (const b of branches) {
      if (await isValidCommit(repoPath, b)) {
        return b;
      }
    }
  } catch {
    // ignore
  }

  // detached HEAD 等场景
  if (await isValidCommit(repoPath, 'HEAD')) {
    return 'HEAD';
  }

  throw new WorktreeError(
    '仓库没有可用的提交，无法创建 worktree',
    '请先创建至少一个初始提交（git commit）后再启动任务',
  );
}

/**
 * 在 <baseDir>/<id> 创建项目仓库的 worktree，基于 baseBranch 新建分支 branchName。
 * 返回 worktree 绝对路径与分支名。
 */
export async function createWorktree(opts: {
  repoPath: string;
  baseDir: string;
  id: string;
  branchName?: string;
  baseBranch?: string;
}): Promise<WorktreeHandle> {
  if (!(await isGitRepo(opts.repoPath))) {
    throw new WorktreeError(`不是 Git 仓库：${opts.repoPath}`, '请确认项目路径指向一个 Git 工作区');
  }
  const branch = opts.branchName ?? `ai-devflow/${opts.id}`;
  const base = await resolveBase(opts.repoPath, opts.baseBranch);
  const wtPath = join(opts.baseDir, opts.id);
  await mkdir(opts.baseDir, { recursive: true });
  // 若 worktree 路径已存在则先清理（异常残留）。
  try {
    await access(wtPath);
    await rm(wtPath, { recursive: true, force: true });
  } catch {
    // 不存在，正常
  }
  await git(opts.repoPath, ['worktree', 'add', '-b', branch, wtPath, base]);
  return { path: wtPath, branch };
}

/**
 * 把任务特性分支合并到项目默认分支（在项目主工作区执行）。
 * 仅当主工作区当前停在 defaultBranch 时才合并，避免干扰用户的其他分支。
 * 优先 ff-only；主分支已前进则回退 no-ff 产生合并提交；冲突则中止保持工作区干净。
 */
export async function mergeWorktreeBranch(opts: {
  repoPath: string;
  branchName: string;
  defaultBranch: string;
}): Promise<{ merged: boolean; reason?: string }> {
  const cur = await currentBranch(opts.repoPath).catch(() => '');
  if (cur && cur !== opts.defaultBranch) {
    return { merged: false, reason: `项目工作区当前在 ${cur} 分支，未自动合并到 ${opts.defaultBranch}` };
  }
  try {
    try {
      await git(opts.repoPath, ['merge', '--ff-only', opts.branchName]);
    } catch {
      await git(opts.repoPath, ['merge', '--no-ff', '-m', `merge: ${opts.branchName}`, opts.branchName]);
    }
    return { merged: true };
  } catch (err) {
    await git(opts.repoPath, ['merge', '--abort']).catch(() => {});
    const e = err as WorktreeError;
    return { merged: false, reason: e.hint ? `${e.message}（${e.hint}）` : e.message };
  }
}

/** 移除 worktree 并清理分支。 */
export async function removeWorktree(opts: {
  repoPath: string;
  worktreePath: string;
  branchName?: string;
  keepBranch?: boolean;
}): Promise<void> {
  try {
    await git(opts.repoPath, ['worktree', 'remove', '--force', opts.worktreePath]);
  } catch {
    // 即使移除失败也尝试物理删除
    await rm(opts.worktreePath, { recursive: true, force: true });
  }
  await git(opts.repoPath, ['worktree', 'prune']).catch(() => {});
  if (opts.branchName && !opts.keepBranch) {
    await git(opts.repoPath, ['branch', '-D', opts.branchName]).catch(() => {});
  }
}

/** 列出仓库的所有 worktree（用于审计/诊断）。 */
export async function listWorktrees(repoPath: string): Promise<Array<{ path: string; branch: string; head: string }>> {
  const { stdout } = await git(repoPath, ['worktree', 'list', '--porcelain']);
  const blocks = stdout.split('\n\n');
  const out: Array<{ path: string; branch: string; head: string }> = [];
  for (const b of blocks) {
    const path = /^worktree (.+)$/m.exec(b)?.[1];
    const head = /^HEAD ([0-9a-f]+)/m.exec(b)?.[1] ?? '';
    const branch = /^branch refs\/heads\/(.+)$/m.exec(b)?.[1] ?? '';
    if (path) out.push({ path, branch, head });
  }
  return out;
}
