import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, access, lstat, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isCanonicalGitBranchSegment, sanitizeGitBranchSegment } from '@ai-devflow/core';

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
 * Resolve the branch persisted for a project before workflows create refs from it.
 * A stale configured branch may recover only to the repository's current named branch.
 */
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
  if (await isValidCommit(repoPath, 'HEAD')) {
    throw new WorktreeError(
      '仓库处于游离 HEAD，无法恢复项目默认分支',
      '请先切换到一个本地分支后重试',
    );
  }
  throw new WorktreeError(
    '仓库没有可用提交，无法解析项目默认分支',
    '请先创建至少一个初始提交后再重试',
  );
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
  // 共享主仓库的 node_modules：worktree 是独立工作目录，默认不含 node_modules，
  // 而 Agent 执行 npm/pnpm 脚本（test/typecheck/lint）需要依赖。安全策略禁止在 worktree 内安装，
  // 主仓库手动安装的 node_modules 也不会进入 worktree。这里把主仓库的 node_modules 链接进 worktree，
  // 让 Agent 直接复用主仓库已安装的依赖；非 Node 项目（无 node_modules）则跳过。
  await linkNodeModules(opts.repoPath, wtPath);
  return { path: wtPath, branch };
}

/**
 * 把主仓库的 node_modules 链接到 worktree，使 Agent 复用主仓库已安装的依赖。
 * - 主仓库无 node_modules 时跳过（非 Node 项目或尚未安装）。
 * - worktree 内已存在 node_modules（可能是目录或链接）时不覆盖。
 * - 链接主仓库的绝对路径：pnpm 的内部软链是相对 node_modules 的，整体复用即可解析。
 * - 失败不抛错：依赖缺失只影响 Agent 跑脚本，不应阻断 worktree 创建（用户可后续手动安装）。
 */
async function linkNodeModules(repoPath: string, wtPath: string): Promise<void> {
  const src = join(repoPath, 'node_modules');
  if (!existsSync(src)) return;
  const dest = join(wtPath, 'node_modules');
  try {
    // worktree 刚由 git 创建，node_modules 一般不存在；保险起见检查并跳过。
    await access(dest).then(
      () => { /* 已存在，不覆盖 */ },
      () => symlink(src, dest, process.platform === 'win32' ? 'junction' : 'dir'),
    );
  } catch {
    // 符号链接失败（权限/平台限制）：忽略，Agent 仍可执行非依赖类工作。
  }
}

/**
 * 移除 worktree 中的 node_modules 链接（若为符号链接），避免 removeWorktree 误删主仓库依赖。
 * 普通目录 node_modules 不处理（非本函数创建）。
 */
async function unlinkNodeModules(wtPath: string): Promise<void> {
  const dest = join(wtPath, 'node_modules');
  try {
    const st = await lstat(dest);
    if (st.isSymbolicLink()) await rm(dest, { force: true });
  } catch {
    // 不存在或无法判定：忽略。
  }
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

/** 在任务 worktree 内同步最新目标分支；脏工作区或冲突时保持原分支并返回诊断。 */
export async function syncWorktreeWithBranch(opts: {
  worktreePath: string;
  sourceBranch: string;
}): Promise<{ merged: boolean; reason?: string }> {
  try {
    const excludedRuntimePaths = await untrackedRuntimePathExclusions(opts.worktreePath);
    const { stdout } = await git(opts.worktreePath, [
      'status', '--porcelain', '--untracked-files=all', '--', '.', ...excludedRuntimePaths,
    ]);
    if (stdout.trim()) {
      return { merged: false, reason: '任务 worktree 存在未提交改动，无法同步迭代分支' };
    }
    await git(opts.worktreePath, ['merge', '--no-edit', opts.sourceBranch]);
    return { merged: true };
  } catch (err) {
    await git(opts.worktreePath, ['merge', '--abort']).catch(() => undefined);
    const e = err as WorktreeError;
    return { merged: false, reason: e.hint ? `${e.message}（${e.hint}）` : e.message };
  }
}

const HOST_COMMIT_FORBIDDEN_SEGMENTS = new Set([
  'credentials',
  'runtime-manifest.json',
  'settings.json',
  'system.md',
  'models.json',
  'node_modules',
]);

/** Worktree-local dependency/tool caches that are execution scaffolding, not reviewed task output. */
const WORKTREE_RUNTIME_PATHS = [
  { tracked: 'node_modules', excluded: ':(top,exclude)node_modules' },
  { tracked: '.extramods', excluded: ':(top,exclude).extramods' },
  { tracked: '.pw-browsers', excluded: ':(top,exclude).pw-browsers' },
  { tracked: '.toolchain', excluded: ':(top,exclude).toolchain' },
  { tracked: '.toolchainbin', excluded: ':(top,exclude).toolchainbin' },
  { tracked: ':(top,glob).tmp-*', excluded: ':(top,glob,exclude).tmp-*' },
] as const;

async function untrackedRuntimePathExclusions(worktreePath: string): Promise<string[]> {
  const exclusions: string[] = [];
  for (const pathspec of WORKTREE_RUNTIME_PATHS) {
    const { stdout } = await git(worktreePath, ['ls-files', '-z', '--', pathspec.tracked]);
    // Repository-owned paths remain visible; only wholly untracked execution scaffolding is excluded.
    if (!stdout) exclusions.push(pathspec.excluded);
  }
  return exclusions;
}

function hostCommitForbidden(path: string): boolean {
  return path.split('/').some((segment) => {
    const lower = segment.toLowerCase();
    return lower.startsWith('.env') || HOST_COMMIT_FORBIDDEN_SEGMENTS.has(lower);
  });
}

/** 提交 reviewer 已审查的任务改动；Agent 本身无 Git 变更权限。 */
export async function commitWorktreeChanges(opts: {
  worktreePath: string;
  message: string;
}): Promise<{ committed: boolean; changedPaths: string[]; reason?: string }> {
  try {
    const excludedRuntimePaths = await untrackedRuntimePathExclusions(opts.worktreePath);
    await git(opts.worktreePath, ['add', '-A', '--', '.', ...excludedRuntimePaths]);
    const { stdout } = await git(opts.worktreePath, ['diff', '--cached', '--name-only', '-z']);
    const changedPaths = stdout.split('\0').filter(Boolean).sort();
    const forbidden = changedPaths.filter(hostCommitForbidden);
    if (forbidden.length > 0) {
      await git(opts.worktreePath, ['reset', '--mixed', 'HEAD']).catch(() => undefined);
      return { committed: false, changedPaths, reason: `任务改动包含禁止提交的敏感路径：${forbidden.join(', ')}` };
    }
    if (changedPaths.length === 0) return { committed: false, changedPaths: [] };
    await git(opts.worktreePath, [
      '-c', 'user.name=ai-devflow',
      '-c', 'user.email=ai-devflow@local',
      'commit', '--no-verify', '-q', '-m', opts.message,
    ]);
    return { committed: true, changedPaths };
  } catch (err) {
    await git(opts.worktreePath, ['reset', '--mixed', 'HEAD']).catch(() => undefined);
    return { committed: false, changedPaths: [], reason: (err as Error).message };
  }
}

/** 移除 worktree 并清理分支。 */
export async function removeWorktree(opts: {
  repoPath: string;
  worktreePath: string;
  branchName?: string;
  keepBranch?: boolean;
}): Promise<void> {
  // 先移除 node_modules 符号链接：git worktree remove 可能因符号链接指向主仓库而拒绝或误删。
  await unlinkNodeModules(opts.worktreePath);
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
  if (existsSync(opts.worktreePath)) {
    throw new WorktreeError(`worktree 清理后仍存在：${opts.worktreePath}`, '请检查文件占用与目录权限');
  }
  if (opts.branchName && !opts.keepBranch && await branchExists(opts.repoPath, opts.branchName)) {
    throw new WorktreeError(`分支 ${opts.branchName} 清理后仍存在`, '请检查该分支是否仍被其他 worktree 使用');
  }
}

/** 清洗版本号为合法 git 分支名片段：保留字母数字 . _ -，其余替换为 -，去首尾分隔符。 */
export function sanitizeBranchSegment(version: string): string {
  return sanitizeGitBranchSegment(version);
}

/** 新迭代版本必须已是规范 Git 分支片段，禁止不同输入归一到同一 sprint 分支。 */
export function requireCanonicalBranchSegment(version: string): string {
  if (!isCanonicalGitBranchSegment(version)) {
    throw new Error(`版本号不是规范 Git 分支片段：${version}`);
  }
  return version;
}

/** 迭代专用分支名：ai-devflow-sprint/<version>。 */
export function sprintBranchName(version: string): string {
  return `ai-devflow-sprint/${sanitizeBranchSegment(version)}`;
}

/** 检查本地分支是否存在。 */
export async function branchExists(repoPath: string, name: string): Promise<boolean> {
  try {
    await git(repoPath, ['rev-parse', '--verify', `refs/heads/${name}`]);
    return true;
  } catch {
    return false;
  }
}

/** 使用 expected-old OID 原子推进或删除分支；目标已变化时绝不覆盖。 */
export async function compareAndSwapBranchRef(opts: {
  repoPath: string;
  branch: string;
  newCommit?: string;
  expectedCommit: string;
}): Promise<{ updated: boolean; reason?: string }> {
  const ref = `refs/heads/${opts.branch}`;
  const args = opts.newCommit
    ? ['update-ref', ref, opts.newCommit, opts.expectedCommit]
    : ['update-ref', '-d', ref, opts.expectedCommit];
  try {
    await git(opts.repoPath, args);
    return { updated: true };
  } catch {
    return { updated: false, reason: `分支 ${opts.branch} 已变化，不再按期望提交 ${opts.expectedCommit} 更新` };
  }
}

/**
 * 确保迭代分支存在：已存在则复用（不动其指向），不存在则从 baseBranch 创建。
 * 用于迭代创建与任务启动两处，幂等。
 */
export async function ensureSprintBranch(opts: {
  repoPath: string;
  version: string;
  baseBranch: string;
}): Promise<{ branch: string; created: boolean; commit: string }> {
  const branch = sprintBranchName(opts.version);
  if (await branchExists(opts.repoPath, branch)) {
    const { stdout } = await exec('git', ['rev-parse', branch], { cwd: opts.repoPath });
    return { branch, created: false, commit: stdout.trim() };
  }
  const base = await resolveBase(opts.repoPath, opts.baseBranch);
  const { stdout } = await exec('git', ['rev-parse', `${base}^{commit}`], { cwd: opts.repoPath });
  const baseCommit = stdout.trim();
  const created = await compareAndSwapBranchRef({
    repoPath: opts.repoPath,
    branch,
    newCommit: baseCommit,
    expectedCommit: '0'.repeat(baseCommit.length),
  });
  if (!created.updated) {
    if (await branchExists(opts.repoPath, branch)) {
      const current = (await exec('git', ['rev-parse', branch], { cwd: opts.repoPath })).stdout.trim();
      return { branch, created: false, commit: current };
    }
    throw new WorktreeError(`无法创建迭代分支 ${branch}`, created.reason);
  }
  return { branch, created: true, commit: baseCommit };
}

/**
 * 把 source 分支合并到 into 分支（在项目主仓库执行，主工作区无需切到 into）。
 * - 快进（into 是 source 的祖先）：`git branch -f <into> <source>` 原子更新引用，无需 checkout。
 * - 非快进：临时 worktree 检出 into，`merge --no-ff` source，再移除临时 worktree。
 * - 冲突：中止合并、清理临时 worktree，返回未合并原因。
 * 用于任务分支 -> 迭代分支的合并（主工作区停在 defaultBranch，不能直接 checkout 迭代分支）。
 */
export async function mergeBranchInto(opts: {
  repoPath: string;
  into: string;
  source: string;
}): Promise<{ merged: boolean; reason?: string; commit?: string; previousCommit?: string }> {
  if (!(await branchExists(opts.repoPath, opts.into))) {
    return { merged: false, reason: `目标分支不存在：${opts.into}` };
  }
  if (!(await branchExists(opts.repoPath, opts.source))) {
    return { merged: false, reason: `源分支不存在：${opts.source}` };
  }
  const intoCommit = (await exec('git', ['rev-parse', opts.into], { cwd: opts.repoPath })).stdout.trim();
  const sourceCommit = (await exec('git', ['rev-parse', opts.source], { cwd: opts.repoPath })).stdout.trim();
  // 快进判定：into 是 source 的祖先 -> 直接 branch -f 移动 into 指向 source。
  let isAncestor = false;
  try {
    await exec('git', ['merge-base', '--is-ancestor', intoCommit, sourceCommit], { cwd: opts.repoPath });
    isAncestor = true;
  } catch {
    isAncestor = false;
  }
  if (isAncestor) {
    const updated = await compareAndSwapBranchRef({
      repoPath: opts.repoPath,
      branch: opts.into,
      newCommit: sourceCommit,
      expectedCommit: intoCommit,
    });
    return updated.updated
      ? { merged: true, commit: sourceCommit, previousCommit: intoCommit }
      : { merged: false, reason: updated.reason };
  }
  // 非快进：临时 worktree 检出 into 再合并 source。
  const tmpPath = join(opts.repoPath, '..', `.ai-devflow-merge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    await git(opts.repoPath, ['worktree', 'add', '--detach', tmpPath, intoCommit]);
    try {
      await git(tmpPath, ['merge', '--no-ff', '-m', `merge: ${opts.source} into ${opts.into}`, sourceCommit]);
      // 合并成功后 into 的工作区 HEAD 即合并结果，用 branch -f 把 into 指向该提交。
      const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: tmpPath });
      const mergedCommit = stdout.trim();
      const updated = await compareAndSwapBranchRef({
        repoPath: opts.repoPath,
        branch: opts.into,
        newCommit: mergedCommit,
        expectedCommit: intoCommit,
      });
      return updated.updated
        ? { merged: true, commit: mergedCommit, previousCommit: intoCommit }
        : { merged: false, reason: updated.reason };
    } catch (err) {
      await git(tmpPath, ['merge', '--abort']).catch(() => {});
      const e = err as WorktreeError;
      return { merged: false, reason: e.hint ? `${e.message}（${e.hint}）` : e.message };
    }
  } catch (err) {
    const e = err as WorktreeError;
    return { merged: false, reason: `无法检出 ${opts.into} 进行合并：${e.hint ? e.message + '（' + e.hint + '）' : e.message}` };
  } finally {
    await git(opts.repoPath, ['worktree', 'remove', '--force', tmpPath]).catch(() => {});
    await rm(tmpPath, { recursive: true, force: true }).catch(() => {});
    await git(opts.repoPath, ['worktree', 'prune']).catch(() => {});
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

/** 删除分支（不存在视为成功；force=true 用 -D）。供知识初始化/修复取消时清理草稿分支。 */
export async function deleteBranch(repoPath: string, branchName: string, opts: { force?: boolean } = {}): Promise<void> {
  if (!(await branchExists(repoPath, branchName))) return;
  await git(repoPath, ['branch', opts.force ? '-D' : '-d', branchName]).catch(() => {
    // -d 可能因未合并失败；草稿分支取消时强制删除。
  });
  if (await branchExists(repoPath, branchName)) {
    await git(repoPath, ['branch', '-D', branchName]).catch(() => undefined);
  }
}

/** 列出 baseRef..branchRef 之间的变更路径（相对路径，去重排序）。供知识草稿校验越界改动。 */
export async function listChangedPaths(repoPath: string, baseRef: string, branchRef: string): Promise<string[]> {
  try {
    const { stdout } = await git(repoPath, ['diff', '--name-only', `${baseRef}...${branchRef}`]);
    return stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0).sort();
  } catch {
    return [];
  }
}
