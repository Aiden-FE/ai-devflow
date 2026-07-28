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
  /** 通过 Node IPC 向子进程发消息（问答答案回灌）。 */
  send(msg: unknown): boolean;
  /** 注册子进程 IPC 消息监听（问答请求接收）；问答挂起期间暂停超时，收到答案后恢复。 */
  onMessage(cb: (msg: unknown) => void): void;
}

export type RawOutputObserver = (stream: RawLine['stream'], chunk: Buffer) => void;

export interface SpawnPiOptions {
  cwd: string;
  timeoutMs: number;
  secrets?: string[];
  /** Receives child bytes before UTF-8 decoding, line framing, redaction, or persistence. */
  onRawOutput?: RawOutputObserver;
}

/** Streaming exact-secret detector. It exposes only a boolean and never stores complete output. */
export class RawSecretDetector {
  private readonly needles: Buffer[];
  private readonly maxTailBytes: number;
  private readonly tails = new Map<RawLine['stream'], Buffer>();
  private found = false;

  constructor(secrets: string[]) {
    this.needles = secrets.filter(Boolean).map((secret) => Buffer.from(secret, 'utf8'));
    this.maxTailBytes = Math.max(0, ...this.needles.map((needle) => needle.byteLength - 1));
  }

  get detected(): boolean {
    return this.found;
  }

  observe(stream: RawLine['stream'], chunk: Buffer): void {
    if (this.found || this.needles.length === 0 || chunk.byteLength === 0) return;
    const previous = this.tails.get(stream);
    const combined = previous?.byteLength ? Buffer.concat([previous, chunk]) : chunk;
    if (this.needles.some((needle) => combined.includes(needle))) {
      this.found = true;
      this.tails.clear();
      return;
    }
    if (this.maxTailBytes > 0) {
      const start = Math.max(0, combined.byteLength - this.maxTailBytes);
      // Copy only the bounded suffix; a subarray would retain the entire raw chunk's backing store.
      this.tails.set(stream, Buffer.from(combined.subarray(start)));
    }
  }
}

export type SpawnFn = (
  command: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; detached: boolean; stdio: ['pipe', 'pipe', 'pipe', 'ipc'] },
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

  spawn(plan: PiRunPlan, opts: SpawnPiOptions): SpawnedPi {
    const secrets = opts.secrets ?? [];
    const detached = this.platform !== 'win32';
    const child = this.spawnFn(plan.command, plan.args, {
      cwd: opts.cwd,
      env: plan.env,
      detached,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
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
      await waitForSettlement(settledPromise, KILL_GRACE_MS);
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
        for await (const raw of lineStream(
          stream,
          overflow,
          (chunk) => opts.onRawOutput?.(kind, chunk),
        )) {
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
    // 问答挂起期间的看门狗：用户长时间不提交答案（如关闭弹窗）时，避免子进程与 pendingAsks 条目永久泄漏。
    // 设计 §“待验证风险点”将“问答超时”列为需保障项；此处给一个宽裕上限（10 分钟）后强制杀死进程。
    const ASK_WATCHDOG_MS = 10 * 60_000;
    let askWatchdog: NodeJS.Timeout | undefined;
    const armAskWatchdog = (): void => {
      if (askWatchdog) clearTimeout(askWatchdog);
      askWatchdog = setTimeout(() => void killProcess(), ASK_WATCHDOG_MS);
      askWatchdog.unref?.();
    };
    const clearAskWatchdog = (): void => {
      if (askWatchdog) { clearTimeout(askWatchdog); askWatchdog = undefined; }
    };

    return {
      pid: child.pid,
      lines: merged(),
      send(msg: unknown): boolean {
        if (typeof child.send === 'function') return child.send(msg as Parameters<typeof child.send>[0]);
        return false;
      },
      onMessage(cb: (msg: unknown) => void): void {
        if (typeof child.on !== 'function') return;
        child.on('message', (msg: unknown) => {
          // 问答挂起期间暂停超时，避免用户思考时被 120s 超时误杀；收到答案后恢复。
          // 另上 10 分钟看门狗：用户放弃提交（关闭弹窗）时强制终止，避免子进程永久阻塞。
          const m = msg as { kind?: string };
          if (m?.kind === 'ask') { clearTimeout(timer); armAskWatchdog(); }
          else if (m?.kind === 'ask_answer') { clearAskWatchdog(); timer.refresh(); }
          cb(msg);
        });
      },
      async cancel() {
        clearTimeout(timer);
        clearAskWatchdog();
        await killProcess();
      },
      async done() {
        try {
          return await settledPromise;
        } finally {
          clearTimeout(timer);
          clearAskWatchdog();
        }
      },
    };
  }
}

async function waitForSettlement(
  settledPromise: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>,
  timeoutMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      settledPromise.then(() => undefined, () => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
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
  onRawChunk?: (chunk: Buffer) => void,
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
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    onRawChunk?.(bytes);
    buffer += decoder.write(bytes);
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
