// PiProcessSupervisor：一次执行尝试 = 一个独立 Pi JSON 子进程。
// 完成边界同时等待 child close/error 与 stdout/stderr EOF；单行上限 2 MiB，stderr 脱敏后限 8 MiB。
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { redactText } from '@ai-devflow/core';
import type { PiRunPlan } from './run-plan.js';
import { clearPiProcessMarker, recordPiProcessMarker } from './orphan-processes.js';

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

const MAX_LINE_BYTES = 2 * 1024 * 1024;
const STDERR_LIMIT = 8 * 1024 * 1024;
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
    child.stdin?.end();
    let processMarker: string | undefined;
    try {
      processMarker = recordPiProcessMarker(
        plan.env.PI_CODING_AGENT_SESSION_DIR,
        child.pid,
        plan.args[0],
      );
    } catch (error) {
      try { child.kill('SIGKILL'); } catch { /* spawn already failed */ }
      throw error;
    }

    let settled = false;
    let settleResolve!: (value: { exitCode: number | null; signal: NodeJS.Signals | null }) => void;
    let settleReject!: (error: Error) => void;
    const settledPromise = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      settleResolve = resolve;
      settleReject = reject;
    });
    // Avoid an unhandled-rejection race when spawn fails before the consumer calls done().
    void settledPromise.catch(() => undefined);

    const wakeWaiters: Array<() => void> = [];
    const wake = (): void => {
      for (const waiter of wakeWaiters.splice(0)) waiter();
    };
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearPiProcessMarker(processMarker);
      settleResolve({ exitCode: code, signal });
      wake();
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearPiProcessMarker(processMarker);
      settleReject(error);
      wake();
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
        try {
          child.kill('SIGTERM');
        } catch {
          return;
        }
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, KILL_GRACE_MS);
        timer.unref?.();
      });
      if (!settled) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }
      }
    };

    const redact = makeLineRedactor(secrets);
    const queue: RawLine[] = [];
    let readers = 2;
    let readerError: Error | undefined;
    let stderrBytes = 0;

    const push = (line: RawLine): void => {
      queue.push(line);
      wake();
    };
    const overflow = (): void => {
      void killProcess();
    };
    const pump = async (stream: NodeJS.ReadableStream | null, kind: RawLine['stream']): Promise<void> => {
      try {
        for await (const raw of lineStream(stream, overflow)) {
          if (kind === 'stdout') {
            push({ stream: kind, text: raw });
          } else if (stderrBytes < STDERR_LIMIT) {
            const text = redact(raw);
            stderrBytes += Buffer.byteLength(text, 'utf8');
            if (stderrBytes <= STDERR_LIMIT) push({ stream: kind, text });
          }
        }
      } catch (error) {
        readerError ??= error instanceof Error ? error : new Error(String(error));
        void killProcess();
      } finally {
        readers -= 1;
        wake();
      }
    };
    void pump(child.stdout, 'stdout');
    void pump(child.stderr, 'stderr');

    async function* merged(): AsyncIterable<RawLine> {
      for (;;) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (readerError) throw readerError;
        if (readers === 0 && settled) return;
        await new Promise<void>((resolve) => wakeWaiters.push(resolve));
      }
    }

    const timer = setTimeout(() => void killProcess(), opts.timeoutMs);
    timer.unref?.();

    return {
      pid: child.pid,
      lines: merged(),
      async cancel() {
        clearTimeout(timer);
        await killProcess();
      },
      async done() {
        try {
          return await settledPromise;
        } finally {
          clearTimeout(timer);
        }
      },
    };
  }
}

function makeLineRedactor(secrets: string[]): (text: string) => string {
  return (text: string): string => {
    let out = text;
    for (const secret of secrets) if (secret) out = out.split(secret).join('***');
    return redactText(out);
  };
}

async function* lineStream(
  stream: NodeJS.ReadableStream | null,
  onOverflow: () => void,
): AsyncIterable<string> {
  if (!stream) return;
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  const check = (): void => {
    if (Buffer.byteLength(buffer, 'utf8') > MAX_LINE_BYTES) {
      onOverflow();
      throw new Error('protocol failure: Pi output line exceeds 2 MiB');
    }
  };
  for await (const chunk of stream as unknown as AsyncIterable<Buffer | string>) {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
        onOverflow();
        throw new Error('protocol failure: Pi output line exceeds 2 MiB');
      }
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) yield line;
    }
    check();
  }
  buffer += decoder.end();
  check();
  if (buffer.length > 0) yield buffer;
}
