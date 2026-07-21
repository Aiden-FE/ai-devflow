import { spawn, type ChildProcess } from 'node:child_process';
import { envWithCliPriority, resolveCommand } from './resolve-path.js';

export interface RawLine {
  stream: 'stdout' | 'stderr';
  text: string;
}

export interface SpawnedProcess {
  lines: AsyncIterable<RawLine>;
  cancel(): Promise<void>;
  pid?: number;
  done(): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
}

/**
 * 启动子进程并把 stdout/stderr 按行输出为异步迭代。
 * 取消时 SIGTERM，超时再 SIGKILL。
 */
export function spawnAgentProcess(opts: {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  input?: string;
}): SpawnedProcess {
  // 解析为绝对路径，并让 CLI 所在 bin 目录优先进入 PATH 后 spawn：
  // 保证 shebang `#!/usr/bin/env node` 的 CLI（如 pi）命中与自身同源的 Node，避免旧 Node 语法不兼容。
  const command = resolveCommand(opts.command);
  const child: ChildProcess = spawn(command, opts.args, {
    cwd: opts.cwd,
    env: envWithCliPriority(command, { ...process.env, ...opts.env }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (child.stdin) {
    if (opts.input !== undefined) {
      child.stdin.end(opts.input);
    } else {
      // 显式关闭 stdin，避免某些 CLI（如 codex exec）等待 stdin 而挂起。
      child.stdin.end();
    }
  }

  const stdoutLines = lineStream(child.stdout);
  const stderrLines = lineStream(child.stderr);

  async function* merged(): AsyncIterable<RawLine> {
    // 交错产出 stdout/stderr 行，保持各自的顺序。
    const queue: RawLine[] = [];
    let waiters: Array<() => void> = [];
    let done = false;

    const push = (l: RawLine) => {
      queue.push(l);
      const w = waiters.shift();
      if (w) w();
    };

    (async () => {
      try {
        for await (const l of stdoutLines) push({ stream: 'stdout', text: l });
      } catch { /* stream closed */ }
    })();
    (async () => {
      try {
        for await (const l of stderrLines) push({ stream: 'stderr', text: l });
      } catch { /* stream closed */ }
    })();

    child.once('exit', () => {
      done = true;
      waiters.forEach((w) => w());
      waiters = [];
    });

    while (true) {
      if (queue.length > 0) yield queue.shift()!;
      else if (done) return;
      else await new Promise<void>((resolve) => waiters.push(resolve));
    }
  }

  let exitInfo: { exitCode: number | null; signal: NodeJS.Signals | null } | null = null;
  const exitWaiters: Array<(i: { exitCode: number | null; signal: NodeJS.Signals | null }) => void> = [];

  child.once('exit', (code, signal) => {
    exitInfo = { exitCode: code, signal: signal };
    exitWaiters.splice(0).forEach((w) => w(exitInfo!));
  });

  return {
    pid: child.pid,
    lines: merged(),
    async cancel() {
      if (!child.killed) {
        child.kill('SIGTERM');
        await new Promise((r) => setTimeout(r, 500));
        if (!child.killed) child.kill('SIGKILL');
      }
    },
    done() {
      if (exitInfo) return Promise.resolve(exitInfo);
      return new Promise((resolve) => exitWaiters.push(resolve));
    },
  };
}

async function* lineStream(stream: NodeJS.ReadableStream | null): AsyncIterable<string> {
  if (!stream) return;
  let buffer = '';
  for await (const chunk of stream as unknown as Iterable<Buffer>) {
    buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (line.length > 0) yield line;
    }
  }
  if (buffer.length > 0) yield buffer;
}

/** 在增强 PATH 中解析可执行文件绝对路径（委托 resolve-path，修复 GUI 应用 PATH 缺失）。 */
export { resolveCommand } from './resolve-path.js';
