import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PiProcessSupervisor,
  RawSecretDetector,
  type RawLine,
  type SpawnFn,
} from '../process-supervisor.js';
import { ORPHAN_MARKER } from '../orphan-processes.js';
import type { PiRunPlan } from '../run-plan.js';

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  pid = 2_147_483_000;
  killed = false;
  killCalls: Array<string | undefined> = [];

  kill(signal?: string): boolean {
    this.killed = true;
    this.killCalls.push(signal);
    return true;
  }
}

const PLAN: PiRunPlan = {
  command: process.execPath,
  args: ['/verified/pi.js'],
  env: {},
  initialMessage: '',
};

async function collect(lines: AsyncIterable<RawLine>): Promise<RawLine[]> {
  const result: RawLine[] = [];
  for await (const line of lines) result.push(line);
  return result;
}

function harness() {
  const child = new FakeChild();
  const spawnFn: SpawnFn = () => child as unknown as ChildProcess;
  const supervisor = new PiProcessSupervisor({ spawnFn });
  const spawned = supervisor.spawn(PLAN, { cwd: '/tmp', timeoutMs: 30_000, secrets: ['exact-secret'] });
  return { child, spawned };
}

describe('PiProcessSupervisor framing', () => {
  it('drains stdout and stderr EOF after child exit before completing lines', async () => {
    const { child, spawned } = harness();
    const lines = collect(spawned.lines);
    child.stdout.write('early\n');
    child.emit('exit', 0, null);
    await Promise.resolve();
    child.stdout.end('late\n');
    child.stderr.end('warning\n');
    child.emit('close', 0, null);

    const result = await lines;
    expect(result).toHaveLength(3);
    expect(result).toEqual(expect.arrayContaining([
      { stream: 'stdout', text: 'early' },
      { stream: 'stdout', text: 'late' },
      { stream: 'stderr', text: 'warning' },
    ]));
    expect(result.filter((line) => line.stream === 'stdout').map((line) => line.text)).toEqual([
      'early',
      'late',
    ]);
    await expect(spawned.done()).resolves.toMatchObject({ exitCode: 0 });
  });

  it('preserves fragmented lines across chunks', async () => {
    const { child, spawned } = harness();
    const lines = collect(spawned.lines);
    child.stdout.write('one');
    child.stdout.write('\ntw');
    child.stdout.end('o\n');
    child.stderr.end();
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    await expect(lines).resolves.toEqual([
      { stream: 'stdout', text: 'one' },
      { stream: 'stdout', text: 'two' },
    ]);
  });

  it('terminates and fails when a line exceeds 2 MiB incrementally', async () => {
    const { child, spawned } = harness();
    const lines = collect(spawned.lines);
    child.stdout.write(Buffer.alloc(2 * 1024 * 1024 + 1, 120));
    child.stdout.end();
    child.stderr.end();
    child.emit('exit', 1, null);
    child.emit('close', 1, null);
    await expect(lines).rejects.toThrow(/2 MiB/);
    expect(child.killCalls.length).toBeGreaterThan(0);
  });

  it('redacts exact and generic secrets from stderr', async () => {
    const { child, spawned } = harness();
    const lines = collect(spawned.lines);
    child.stdout.end();
    child.stderr.end('exact-secret Bearer abcdefghijklmnop sk-1234567890abcdefghijkl\n');
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    const result = await lines;
    expect(JSON.stringify(result)).not.toContain('exact-secret');
    expect(JSON.stringify(result)).not.toContain('abcdefghijklmnop');
    expect(result[0]?.text).toContain('***');
  });

  it('detects a secret split across raw chunks before stderr redaction', async () => {
    const child = new FakeChild();
    const detector = new RawSecretDetector(['exact-secret']);
    const supervisor = new PiProcessSupervisor({
      spawnFn: () => child as unknown as ChildProcess,
    });
    const spawned = supervisor.spawn(PLAN, {
      cwd: '/tmp',
      timeoutMs: 30_000,
      secrets: ['exact-secret'],
      onRawOutput: (stream, chunk) => detector.observe(stream, chunk),
    });
    const lines = collect(spawned.lines);
    child.stdout.end();
    child.stderr.write('prefix exact-');
    child.stderr.end('secret suffix\n');
    child.emit('exit', 0, null);
    child.emit('close', 0, null);

    const result = await lines;
    expect(detector.detected).toBe(true);
    expect(JSON.stringify(result)).not.toContain('exact-secret');
  });

  it('captures child spawn errors and rejects done without an unhandled error event', async () => {
    const { child, spawned } = harness();
    const done = spawned.done();
    expect(() => child.emit('error', new Error('spawn EACCES'))).not.toThrow();
    child.stdout.end();
    child.stderr.end();
    await expect(done).rejects.toThrow(/spawn EACCES/);
  });

  it('records process ownership for crash recovery and clears it after close', async () => {
    const child = new FakeChild();
    const sessionDir = mkdtempSync(join(tmpdir(), 'pi-owned-process-'));
    const supervisor = new PiProcessSupervisor({
      spawnFn: () => child as unknown as ChildProcess,
    });
    const spawned = supervisor.spawn({
      ...PLAN,
      env: { PI_CODING_AGENT_SESSION_DIR: sessionDir },
    }, { cwd: '/tmp', timeoutMs: 30_000, secrets: [] });
    const marker = join(sessionDir, ORPHAN_MARKER);
    expect(existsSync(marker)).toBe(true);
    child.stdout.end();
    child.stderr.end();
    child.emit('close', 0, null);
    await spawned.done();
    expect(existsSync(marker)).toBe(false);
  });
});
