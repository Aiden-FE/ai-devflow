// 修复 GUI 启动的 Electron 应用 PATH 缺失问题。
//
// 从 Finder/Dock 启动的 macOS 应用不会继承用户登录 shell 的 PATH，
// 其 PATH 通常只有 /usr/bin:/bin:/usr/sbin:/sbin，导致安装在
// ~/.local/bin（claude/codex）、~/.nvm/versions/node/*/bin（pi）等处的 CLI 检测不到，
// 而用户在终端里 `where claude` 却能找到。此模块计算一个增强的 PATH：
//   1) 尽力读取用户登录 shell 的完整 PATH（带超时，失败忽略）；
//   2) 追加常见 CLI 安装目录与 nvm 各版本 bin；
//   3) 合并进程现有 PATH。
// 结果缓存，供 detect 与 spawn 复用。
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

let cached: string | undefined;

function splitPath(p: string | undefined): string[] {
  return (p ?? '').split(':').map((s) => s.trim()).filter(Boolean);
}

/** 计算增强后的 PATH（去重，用户 shell PATH 优先）。 */
export function resolveAgentPath(): string {
  if (cached) return cached;
  const parts: string[] = [];
  const seen = new Set<string>();
  const add = (p: string) => {
    if (p && !seen.has(p)) {
      seen.add(p);
      parts.push(p);
    }
  };

  // 1) 尽力获取登录 shell 的完整 PATH（最贴近用户 `where` 所见）。带超时，失败忽略。
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const out = execFileSync(shell, ['-lc', 'echo $PATH'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const p of splitPath(out)) add(p);
  } catch {
    /* 非交互 shell / 超时 / 无 SHELL：忽略，回退到常见目录 */
  }

  // 2) 常见 CLI 安装目录（覆盖 claude/codex 的 ~/.local/bin、Homebrew、各类版本管理器）。
  const home = homedir();
  const common = [
    join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    join(home, '.npm-global', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.asdf', 'shims'),
    join(home, '.deno', 'bin'),
  ];
  for (const p of common) {
    if (existsSync(p)) add(p);
  }

  // 2b) nvm：~/.nvm/versions/node/<version>/bin（pi 等常装于 nvm 管理的 node 下）。
  try {
    const nvmNode = join(home, '.nvm', 'versions', 'node');
    if (existsSync(nvmNode)) {
      for (const ver of readdirSync(nvmNode)) {
        const bin = join(nvmNode, ver, 'bin');
        if (existsSync(bin)) add(bin);
      }
    }
  } catch {
    /* ignore */
  }

  // 3) 合并进程现有 PATH（兜底）。
  for (const p of splitPath(process.env.PATH)) add(p);

  cached = parts.join(':');
  return cached;
}

/** 返回带有增强 PATH 的环境变量（供子进程使用）。 */
export function envWithAgentPath(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, PATH: resolveAgentPath() };
}

/**
 * 在增强 PATH 中解析命令的绝对路径（找不到则原样返回命令名）。
 * 用于检测回报真实位置，便于用户确认“终端里有、应用里也能找到”。
 */
export function resolveCommand(command: string): string {
  if (command.includes('/')) return command;
  for (const dir of splitPath(resolveAgentPath())) {
    const full = join(dir, command);
    try {
      accessSync(full, constants.X_OK);
      return full;
    } catch {
      /* 不在此目录，继续 */
    }
  }
  return command;
}

/** 重置缓存（测试用）。 */
export function _resetResolvedPath(): void {
  cached = undefined;
}
