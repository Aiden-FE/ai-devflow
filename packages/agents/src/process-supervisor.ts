// PiProcessSupervisor：一次执行尝试 = 一个独立 Pi JSON 子进程（设计 §5/§6.3/§14/§15）。
//
// 以 process.execPath + ELECTRON_RUN_AS_NODE=1 + shell:false 启动捆绑 Pi 入口；stdout 只接受 JSONL，
// stderr 按行脱敏入有界诊断缓冲。POSIX 用独立进程组并向 -pid 发信号（SIGTERM→2s 后 SIGKILL）；
// Windows 用 taskkill /PID <pid> /T /F。角色超时触发受控终止。退出或取消时先终止进程组再封存 journal。
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import type { PiRunPlan } from './run-plan.js';

export interface RawLine {
  stream: 'stdout' | 'stderr';
  text: string;
}

export interface SpawnedPi {
  lines: AsyncIterable<RawLine>;
  cancel(): Promise<void>;
  done(): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
  pid?: number;
}

export type SpawnFn = (
  command: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; detached: boolean; stdio: ['pipe', 'pipe', 'pipe'] },
) => ChildProcess;

const STDERR_LIMIT = 8 * 1024 * 1024; // 8 MiB 环形上限，防止失控输出耗尽内存
const KILL_GRACE_MS = 2_000;

export interface ProcessSupervisorOptions {
  spawnFn?: SpawnFn;
  platform?: NodeJS.Platform;
  systemRoot?: string;
}

export class PiProcessSupervisor {
  private spawnFn: SpawnFn;
  private platform: NodeJS.Platform;
  private systemRoot: string;

  constructor(opts: ProcessSupervisorOptions = {}) {
    this.spawnFn = opts.spawnFn ?? (nodeSpawn as unknown as SpawnFn);
    this.platform = opts.platform ?? process.platform;
    this.systemRoot = opts.systemRoot ?? process.env.SystemRoot ?? 'C:\\Windows';
  }

  spawn(plan: PiRunPlan, opts: { cwd: string; timeoutMs: number; secrets?: string[] }): SpawnedPi {
    const secrets = opts.secrets ?? [];
    const detached = this.platform !== 'win32';
    const child = this.spawnFn(plan.command, plan.args, {
      cwd: opts.cwd,
      env: plan.env,
      detached,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (child.stdin) child.stdin.end();

    const redact = makeLineRedactor(secrets);
    const stdoutLines = lineStream(child.stdout);
    const stderrLines = lineStream(child.stderr);

    let stderrBytes = 0;
    async function* merged(): AsyncIterable<RawLine> {
      const queue: RawLine[] = [];
      let waiters: Array<() => void> = [];
      let done = false;
      const push = (l: RawLine) => {
        queue.push(l);
        const w = waiters.shift();
        if (w) w();
      };
      void (async () => {
        try {
          for await (const l of stdoutLines) push({ stream: 'stdout', text: l });
        } catch { /* closed */ }
      })();
      void (async () => {
        try {
          for await (const l of stderrLines) {
            if (stderrBytes >= STDERR_LIMIT) continue; // 丢弃超额 stderr
            const text = redact(l);
            stderrBytes += Buffer.byteLength(text, 'utf8');
            push({ stream: 'stderr', text });
          }
        } catch { /* closed */ }
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
      exitInfo = { exitCode: code, signal };
      exitWaiters.splice(0).forEach((w) => w(exitInfo!));
    });

    const killProcess = async (): Promise<void> => {
      if (child.pid === undefined || child.killed) return;
      if (this.platform === 'win32') {
        const taskkill = `${this.systemRoot}\\System32\\taskkill.exe`;
        const { execFile } = await import('node:child_process');
        await new Promise<void>((resolve) => {
          execFile(taskkill, ['/PID', String(child.pid), '/T', '/F'], () => resolve());
        });
        return;
      }
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
      }
      await new Promise((r) => {
        const t = setTimeout(r, KILL_GRACE_MS);
        t.unref?.();
      });
      if (!child.killed) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {
          try { child.kill('SIGKILL'); } catch { /* gone */ }
        }
      }
    };

    const timer = setTimeout(() => {
      void killProcess();
    }, opts.timeoutMs);
    timer.unref?.();

    return {
      pid: child.pid,
      lines: merged(),
      async cancel() {
        clearTimeout(timer);
        await killProcess();
      },
      async done() {
        const info = exitInfo ?? (await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => exitWaiters.push(resolve)));
        clearTimeout(timer);
        return { exitCode: info.exitCode, signal: info.signal };
      },
    };
  }
}

function makeLineRedactor(secrets: string[]): (text: string) => string {
  return (text: string): string => {
    let out = text;
    for (const s of secrets) if (s) out = out.split(s).join('***');
    return out;
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
