// execution-policy：拦截工具调用，实施路径/命令/角色权限和 reviewer 完整性规则。
// 所有拒绝原因使用稳定的 policy:* 前缀；不得包含命令输出、文件内容或凭证。
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';

type PolicyRole = 'planner' | 'coder' | 'reviewer' | 'tester' | string;

export interface ExecutionPolicyContext {
  role: PolicyRole;
  worktree: string;
}

interface ToolCallLike {
  type?: string;
  toolCallId: string;
  toolName: string;
  input?: Record<string, unknown>;
}

interface ToolResultLike extends ToolCallLike {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  details?: unknown;
}

interface BlockResult {
  block: true;
  reason: string;
}

interface ToolResultOverride {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
}

const SENSITIVE = new Set([
  '.env', 'credentials', 'runtime-manifest.json', 'settings.json', 'system.md', 'models.json',
]);
const INSTALL_ACTIONS = new Set(['add', 'install', 'i', 'publish', 'link', 'unlink', 'update', 'upgrade']);
const DESTRUCTIVE_GIT = new Set([
  'clean', 'reset', 'checkout', 'restore', 'rebase', 'merge', 'cherry-pick', 'revert', 'commit',
  'push', 'fetch', 'pull', 'worktree', 'gc', 'prune', 'reflog', 'update-ref', 'symbolic-ref',
]);
const INTERPRETERS = new Set(['node', 'python', 'python3', 'perl', 'ruby', 'php']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'cmd', 'cmd.exe', 'powershell', 'pwsh']);
const COMMAND_WRAPPERS = new Set(['env', 'command', 'exec', 'nice', 'nohup', 'sudo', 'time', 'timeout', 'xargs']);
const DIRECT_PACKAGE_WRAPPERS = new Set(['npx', 'pnpx', 'bunx']);
const PACKAGE_EXECUTION_ACTIONS: Partial<Record<string, Set<string>>> = {
  pnpm: new Set(['exec', 'dlx']),
  npm: new Set(['exec', 'x']),
  yarn: new Set(['exec', 'dlx']),
  bun: new Set(['x']),
};
const PACKAGE_VERIFICATION_ACTIONS: Record<string, Set<string>> = {
  pnpm: new Set(['test', 'typecheck', 'lint', 'verify', 'vitest', 'tsc']),
  npm: new Set(['test']),
  yarn: new Set(['test', 'typecheck', 'lint', 'verify', 'vitest', 'tsc']),
  bun: new Set(['test', 'typecheck', 'lint', 'verify', 'vitest', 'tsc']),
};
const PACKAGE_VERIFICATION_SCRIPTS = new Set(['test', 'typecheck', 'lint', 'verify', 'vitest', 'tsc']);

type PackageCommandDisposition = 'verification' | 'install' | 'deny';

function block(code: string, detail: string): BlockResult {
  return { block: true, reason: `policy:${code}: ${detail}` };
}

function canonicalPath(worktree: string, raw: string): string {
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(worktree, raw);
  let existing = absolute;
  const suffix: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    suffix.unshift(basename(existing));
    existing = parent;
  }
  const realBase = existsSync(existing) ? realpathSync(existing) : existing;
  return resolve(realBase, ...suffix);
}

function isWithin(worktree: string, target: string): boolean {
  if (!worktree || !existsSync(worktree)) return false;
  const root = realpathSync(worktree);
  return target === root || target.startsWith(root + sep);
}

function isSensitivePath(target: string): boolean {
  return target
    .toLowerCase()
    .split(/[\\/]/)
    .some((part) => part.startsWith('.env') || SENSITIVE.has(part));
}

function shellTokens(command: string): string[] | undefined {
  const tokens: string[] = [];
  let token = '';
  let quote = '';
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;
    if (quote) {
      if (char === quote) quote = '';
      else if (char === '\\') {
        i += 1;
        if (i >= command.length) return undefined;
        token += command[i]!;
      } else token += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (token) {
        tokens.push(token);
        token = '';
      }
    } else if (char === '\\') {
      i += 1;
      if (i >= command.length) return undefined;
      token += command[i]!;
    } else {
      token += char;
    }
  }
  if (quote) return undefined;
  if (token) tokens.push(token);
  return tokens;
}

function commandName(token: string | undefined): string {
  return basename((token ?? '').toLowerCase());
}

function pathFromArg(arg: string): string | undefined {
  const value = arg.startsWith('-') && arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg;
  if (!value || value.startsWith('-') || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return undefined;
  return isAbsolute(value) || value.startsWith('.') || value.includes('/') || value.includes('\\')
    ? value
    : undefined;
}

function firstOutsidePath(worktree: string, argv: string[]): string | undefined {
  for (let i = 1; i < argv.length; i += 1) {
    const path = pathFromArg(argv[i]!);
    if (!path) continue;
    try {
      if (!isWithin(worktree, canonicalPath(worktree, path))) return path;
    } catch {
      return path;
    }
  }
  return undefined;
}

function packageManager(token: string | undefined): string | undefined {
  const name = commandName(token);
  if (name === 'yarnpkg') return 'yarn';
  return PACKAGE_EXECUTION_ACTIONS[name] ? name : undefined;
}

function packageCommandDisposition(argv: string[]): PackageCommandDisposition | undefined {
  const executable = commandName(argv[0]);
  if (executable === 'corepack' || DIRECT_PACKAGE_WRAPPERS.has(executable)) return 'deny';

  const manager = packageManager(argv[0]);
  if (!manager) return undefined;
  let args = argv.slice(1);

  // The only required manager-global prefix is the repository's filtered pnpm form.
  if (manager === 'pnpm' && args[0] === '--filter') {
    const selector = args[1];
    if (!selector || selector.startsWith('-')) return 'deny';
    args = args.slice(2);
  } else if (args[0]?.startsWith('-')) {
    return 'deny';
  }

  const actionToken = args[0];
  if (!actionToken || actionToken !== actionToken.toLowerCase() || commandName(actionToken) !== actionToken) {
    return 'deny';
  }
  if (PACKAGE_EXECUTION_ACTIONS[manager]?.has(actionToken)) return 'deny';
  if (INSTALL_ACTIONS.has(actionToken)) return 'install';
  if (actionToken === 'run') {
    const script = args[1];
    return script && PACKAGE_VERIFICATION_SCRIPTS.has(script) ? 'verification' : 'deny';
  }
  return PACKAGE_VERIFICATION_ACTIONS[manager]?.has(actionToken) ? 'verification' : 'deny';
}

function gitSubcommand(argv: string[]): string | undefined {
  if (commandName(argv[0]) !== 'git') return undefined;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '-C') {
      i += 1;
      continue;
    }
    if (arg.startsWith('-')) continue;
    return arg.toLowerCase();
  }
  return undefined;
}

function hasForbiddenInterpreterEscape(argv: string[]): boolean {
  const first = commandName(argv[0]);
  if (SHELLS.has(first)) return true;
  if (!INTERPRETERS.has(first)) return false;
  return argv.slice(1).some((arg) => ['-e', '--eval', '-c', '-command'].includes(arg.toLowerCase()));
}

function hasFindMutation(argv: string[]): boolean {
  return commandName(argv[0]) === 'find' && argv.some((arg) =>
    ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprintf'].includes(arg.toLowerCase()),
  );
}

const REVIEWER_GIT_FLAGS: Record<string, Set<string>> = {
  diff: new Set(['--check', '--stat', '--shortstat', '--name-only', '--name-status', '--numstat', '--cached', '--staged', '--no-ext-diff', '--', '-w']),
  status: new Set(['--short', '-s', '--branch', '-b', '--porcelain', '--porcelain=v1', '--porcelain=v2', '--untracked-files=no', '--untracked-files=normal', '--untracked-files=all']),
  show: new Set(['--stat', '--shortstat', '--name-only', '--name-status', '--oneline', '--no-ext-diff', '--format=fuller', '--']),
  log: new Set(['--oneline', '--stat', '--shortstat', '--name-only', '--name-status', '--decorate', '--all', '--graph', '--no-merges']),
  grep: new Set(['-n', '--line-number', '-i', '--ignore-case', '-w', '--word-regexp', '-F', '--fixed-strings', '--cached', '--untracked', '--']),
};

function reviewerGitAllowed(argv: string[]): boolean {
  if (argv[0] !== 'git' || argv[1]?.startsWith('-')) return false;
  const sub = argv[1] ?? '';
  const flags = REVIEWER_GIT_FLAGS[sub];
  if (!flags) return false;
  for (const arg of argv.slice(2)) {
    if (!arg.startsWith('-') || /^-[0-9]+$/.test(arg)) continue;
    if (flags.has(arg)) continue;
    if (sub === 'log' && /^--max-count=[0-9]+$/.test(arg)) continue;
    if ((sub === 'diff' || sub === 'show') && /^--unified=[0-9]+$/.test(arg)) continue;
    return false;
  }
  return true;
}

function reviewerPackageTestAllowed(argv: string[]): boolean {
  const first = commandName(argv[0]);
  if (first === 'cargo') return argv[1] === 'test';
  if (first === 'go') return argv[1] === 'test';
  return packageCommandDisposition(argv) === 'verification';
}

function reviewerCommandAllowed(argv: string[]): boolean {
  const first = commandName(argv[0]);
  if (first === 'git') return reviewerGitAllowed(argv);
  if (['rg', 'grep', 'find', 'ls', 'pwd'].includes(first)) return true;
  return reviewerPackageTestAllowed(argv);
}

export function snapshotTrackedFiles(worktree: string): string {
  const listed = execFileSync('git', ['-C', worktree, 'ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const hash = createHash('sha256');
  for (const relative of listed.split('\0').filter(Boolean).sort()) {
    const target = canonicalPath(worktree, relative);
    if (!isWithin(worktree, target)) throw new Error('tracked file escaped worktree');
    hash.update(`${relative}\0`);
    hash.update(existsSync(target) ? readFileSync(target) : Buffer.from('<missing>'));
  }
  return hash.digest('hex');
}

export function createExecutionPolicy(context: ExecutionPolicyContext) {
  const reviewerHashes = new Map<string, string>();
  let reviewerIntegrityViolation = false;

  return {
    onToolCall(event: ToolCallLike): BlockResult | undefined {
      const name = event.toolName;
      const input = event.input ?? {};
      const reviewer = context.role === 'reviewer';

      if (reviewer && reviewerIntegrityViolation) {
        return block('reviewer-integrity-violation', 'reviewer 已改变受跟踪文件，本次运行不得继续或提交结果');
      }

      if (reviewer && (name === 'write' || name === 'edit')) {
        return block('reviewer-read-only', 'reviewer 角色禁止写文件');
      }

      if (name === 'write' || name === 'edit') {
        const raw = typeof input.path === 'string' ? input.path : '';
        if (!raw) return block('missing-path', '缺少写入路径');
        let target: string;
        try {
          target = canonicalPath(context.worktree, raw);
        } catch {
          return block('invalid-path', '写入路径无法安全解析');
        }
        if (!isWithin(context.worktree, target)) {
          return block('outside-worktree', '禁止写出任务工作区或符号链接逃逸');
        }
        if (isSensitivePath(target)) return block('sensitive-file', '禁止修改敏感/凭证/策略文件');
      }

      if (name !== 'bash') return undefined;
      const command = typeof input.command === 'string' ? input.command.trim() : '';
      if (!command) return block('missing-command', '缺少命令');
      // This check is deliberately first and applies to every role, including commands beginning with git.
      if (/[\r\n;&|`<>]|\$\(|\$\{|\btee\b/.test(command)) {
        return block('shell-escape', '禁止重定向/命令替换/链接/后台执行');
      }
      const argv = shellTokens(command);
      if (!argv?.length) return block('shell-parse', '命令参数无法安全解析');

      const executable = argv[0]!;
      const packageDisposition = packageCommandDisposition(argv);
      if (packageDisposition === 'deny') {
        return block('package-execution-wrapper', '禁止通过包管理器执行任意嵌套命令');
      }
      if (COMMAND_WRAPPERS.has(commandName(executable))) {
        return block('command-wrapper', '禁止通过命令包装器改变被审查的可执行命令');
      }
      if (isAbsolute(executable) || executable.startsWith('.') || executable.includes('/') || executable.includes('\\')) {
        return block('executable-path', '可执行命令必须使用不含路径的受分类名称');
      }

      if (hasFindMutation(argv)) return block('find-mutation', '禁止 find 删除或执行子命令');
      if (hasForbiddenInterpreterEscape(argv)) return block('interpreter-escape', '禁止 shell/interpreter 逃逸');
      if (packageDisposition === 'install') return block('install-forbidden', '禁止安装/发布依赖');
      const subcommand = gitSubcommand(argv);
      if (subcommand && DESTRUCTIVE_GIT.has(subcommand)) {
        return block('git-mutation', '禁止破坏性或变更型 git 命令');
      }
      if (firstOutsidePath(context.worktree, argv)) {
        return block('outside-worktree', '命令路径参数不得逃出任务工作区');
      }

      if (reviewer) {
        if (!reviewerCommandAllowed(argv)) {
          return block('reviewer-bash-allowlist', '审查 bash 仅允许精确的只读/验证命令');
        }
        try {
          reviewerHashes.set(event.toolCallId, snapshotTrackedFiles(context.worktree));
        } catch {
          return block('reviewer-hash-unavailable', '无法建立 reviewer 受跟踪文件完整性基线');
        }
      }
      return undefined;
    },

    onToolResult(event: ToolResultLike): ToolResultOverride | undefined {
      if (context.role !== 'reviewer' || event.toolName !== 'bash') return undefined;
      const before = reviewerHashes.get(event.toolCallId);
      reviewerHashes.delete(event.toolCallId);
      let changed = before === undefined;
      try {
        changed ||= snapshotTrackedFiles(context.worktree) !== before;
      } catch {
        changed = true;
      }
      if (!changed) return undefined;
      reviewerIntegrityViolation = true;
      return {
        content: [{ type: 'text', text: 'policy:reviewer-tracked-files-changed: reviewer 命令改变了受跟踪文件' }],
        isError: true,
      };
    },
  };
}

export default function executionPolicyExtension(pi: ExtensionAPI) {
  const policy = createExecutionPolicy({
    role: process.env.AI_DEVFLOW_ROLE ?? '',
    worktree: process.env.AI_DEVFLOW_WORKTREE ?? '',
  });
  pi.on('tool_call', async (event) => policy.onToolCall(event));
  pi.on('tool_result', async (event) => policy.onToolResult(event));
}
