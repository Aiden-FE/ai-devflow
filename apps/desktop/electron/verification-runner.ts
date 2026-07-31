// 宿主端验证运行器：在原始项目仓库（非 worktree）用真实 PATH 运行受限白名单命令，
// 让 reviewer/test 专家能在沙箱无项目工具链时亲自重跑测试/类型检查/lint。
//
// 背景：Pi 子进程 PATH 经 buildControlledPath 白名单构造，不含 $HOME 级工具链
// （nvm/volta/fnm/pnpm under Homebrew）；reviewer 运行在 git worktree（无 node_modules）；
// execution-policy 又拦截直接解释器（node/vitest/eslint）与任意包管理器 wrapper。
// 故 reviewer 无法亲自重跑测试，只能依赖 coder 声明。本运行器在宿主侧用真实环境执行，
// 输出经 redactText 脱敏并限长，不写文件、不暴露凭证。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { redactText } from '@ai-devflow/core';
import type { VerificationCommand, VerificationResult, VerificationRunner } from '@ai-devflow/agents';
import type { AgentRunScope } from '@ai-devflow/agents';
import type { Repositories } from '@ai-devflow/persistence';

const execFileP = promisify(execFile);

const MAX_OUTPUT_CHARS = 16_000;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** 可注入的执行函数（测试桩用）；生产使用 promisify(execFile)。 */
export type ExecFileFn = (
  file: string,
  args: string[],
  opts: { cwd: string; maxBuffer: number; timeout: number; env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

/** 可注入的 git 执行函数（测试桩用）。 */
export type GitExecFn = (
  args: string[],
  opts: { cwd: string },
) => Promise<{ stdout: string; stderr: string }>;

/** 命令 -> pnpm 动作（仓库根 workspace 级）。scope 存在时用 --filter 限定单包。 */
export function buildVerificationArgs(command: VerificationCommand, scope?: string): string[] {
  const action = command === 'test' ? 'test'
    : command === 'typecheck' ? 'exec tsc --noEmit'
      : 'exec eslint . --max-warnings=0';
  const tokens = action.split(' ');
  if (scope) return ['--filter', scope, ...tokens];
  // 仓库根：-w 保证 workspace 脚本/二进制可用（vitest/tsc/eslint 经 node_modules/.bin 解析）。
  return ['-w', ...tokens];
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const head = text.slice(0, Math.floor(MAX_OUTPUT_CHARS / 2));
  const tail = text.slice(-Math.floor(MAX_OUTPUT_CHARS / 2));
  return `${head}\n…[output truncated ${text.length - MAX_OUTPUT_CHARS} chars]…\n${tail}`;
}

/**
 * 生产验证运行器：repos 用于把运行作用域解析回原始项目路径（worktree 之外）。
 * - 不写文件、不安装依赖；仅执行只读验证命令。
 * - 输出经 redactText 脱敏（密钥/凭证）并限长。
 * - 超时返回失败结果（不抛错），避免 reviewer 长时间阻塞。
 */
export class HostVerificationRunner implements VerificationRunner {
  private execFileFn: ExecFileFn;
  private gitExecFn: GitExecFn;
  private worktreesBaseDir?: string;
  private worktreeLocks = new Map<string, Promise<string | undefined>>();

  constructor(
    private repos: Repositories,
    opts?: { execFileFn?: ExecFileFn; gitExecFn?: GitExecFn; worktreesBaseDir?: string },
  ) {
    this.execFileFn = opts?.execFileFn ?? (execFileP as unknown as ExecFileFn);
    this.gitExecFn = opts?.gitExecFn ?? (async (args, gitOpts) => execFileP('git', args, { ...gitOpts, encoding: 'utf8' }));
    this.worktreesBaseDir = opts?.worktreesBaseDir;
  }

  resolveProjectPath(scope: AgentRunScope): string | undefined {
    if (scope.kind === 'task') {
      const task = this.repos.tasks.get(scope.taskId);
      if (!task) return undefined;
      return this.repos.projects.get(task.projectId)?.path;
    }
    if (scope.kind === 'project' || scope.kind === 'iteration') {
      return this.repos.projects.get(scope.projectId)?.path;
    }
    return undefined;
  }

  /**
   * 验证必须跑在包含任务分支代码的工作目录上：默认仓库可能停在默认分支或用户当前工作区，
   * 不含任务分支改动，reviewer 会看到“桥运行在未含任务分支的原始仓库状态上”。
   * 任务作用域优先使用任务 worktree；缺失时按任务分支创建一个验证 worktree 并链接主仓库 node_modules。
   */
  private async resolveVerificationCwd(input: { cwd: string; agentScope?: AgentRunScope }): Promise<string> {
    const scope = input.agentScope;
    if (scope?.kind !== 'task') return input.cwd;
    const task = this.repos.tasks.get(scope.taskId);
    const project = task ? this.repos.projects.get(task.projectId) : undefined;
    if (!task || !project) return input.cwd;
    if (task.worktreePath && existsSync(task.worktreePath)) {
      await this.ensureNodeModulesLink(task.worktreePath, project.path).catch(() => undefined);
      return task.worktreePath;
    }
    if (!this.worktreesBaseDir) return input.cwd;
    const key = `${project.id}:${task.id}`;
    const pending = this.worktreeLocks.get(key);
    if (pending) return (await pending) ?? input.cwd;
    const prepare = (async () => {
      const wtPath = join(this.worktreesBaseDir!, task.id);
      const branch = `ai-devflow/${task.id}`;
      if (!existsSync(wtPath)) {
        const listed = await this.gitExecFn(['worktree', 'list', '--porcelain'], { cwd: project.path }).catch(() => ({ stdout: '' }));
        if (!listed.stdout.includes(wtPath)) {
          await this.gitExecFn(['worktree', 'add', wtPath, branch], { cwd: project.path });
        }
      }
      await this.ensureNodeModulesLink(wtPath, project.path);
      return wtPath;
    })().catch(() => undefined);
    this.worktreeLocks.set(key, prepare);
    try {
      return (await prepare) ?? input.cwd;
    } finally {
      this.worktreeLocks.delete(key);
    }
  }

  /** worktree 默认不含 node_modules；链接主仓库依赖，复用 createWorktree 的策略，不在验证侧安装依赖。 */
  private async ensureNodeModulesLink(worktreePath: string, projectPath: string): Promise<void> {
    const source = join(projectPath, 'node_modules');
    const dest = join(worktreePath, 'node_modules');
    if (!existsSync(source)) return;
    try {
      await access(dest);
      return;
    } catch {
      // dest 不存在：创建链接
    }
    await symlink(source, dest, 'dir');
  }

  async run(input: {
    command: VerificationCommand;
    scope?: string;
    cwd: string;
    timeoutMs?: number;
    agentScope?: AgentRunScope;
  }): Promise<VerificationResult> {
    const { command } = input;
    const cwd = await this.resolveVerificationCwd({ cwd: input.cwd, agentScope: input.agentScope });
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const args = buildVerificationArgs(command, input.scope);
    const startedAt = Date.now();
    try {
      const { stdout, stderr } = await this.execFileFn('pnpm', args, {
        cwd,
        maxBuffer: 4 * 1024 * 1024,
        timeout: timeoutMs,
        // 用真实 PATH（含用户级工具链），而非受控白名单 PATH：宿主侧执行不受沙箱限制。
        env: process.env,
      });
      const combined = truncate(redactText(`${stdout}\n${stderr}`.trim()));
      return {
        ok: true,
        command,
        exitCode: 0,
        summary: `${command} 通过（exit 0）`,
        output: combined,
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string; signal?: string; killed?: boolean };
      // 非零退出码：测试/类型/lint 失败仍是有效结果（reviewer 据此判定），ok=false 但携带输出。
      const exitCode = typeof e.code === 'number' ? e.code : null;
      const combined = truncate(redactText(`${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim()));
      const summary = e.killed && e.signal === 'SIGTERM'
        ? `${command} 超时（>${Math.round(timeoutMs / 1000)}s）`
        : `${command} 失败（exit ${exitCode ?? e.signal ?? '?'}）`;
      return {
        ok: false,
        command,
        exitCode,
        summary,
        output: combined,
        durationMs: Date.now() - startedAt,
      };
    }
  }
}
