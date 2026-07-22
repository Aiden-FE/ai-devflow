import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupOrphanPiProcesses, ORPHAN_MARKER } from '../orphan-processes.js';

describe('cleanupOrphanPiProcesses', () => {
  it('terminates only a marker whose live command matches the recorded Pi entry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-orphans-'));
    const owned = join(root, 'execution', 'attempt-owned');
    const stale = join(root, 'execution', 'attempt-stale');
    mkdirSync(owned, { recursive: true });
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(owned, ORPHAN_MARKER), JSON.stringify({
      schemaVersion: 1, pid: 111, runtimeEntry: '/runtime/pi.js', createdAt: 1,
    }));
    writeFileSync(join(stale, ORPHAN_MARKER), JSON.stringify({
      schemaVersion: 1, pid: 222, runtimeEntry: '/runtime/pi.js', createdAt: 1,
    }));
    const terminated: number[] = [];

    const result = await cleanupOrphanPiProcesses(root, {
      inspect: async (pid) => pid === 111 ? '/electron /runtime/pi.js --mode json' : '/usr/bin/unrelated',
      terminate: async (pid) => { terminated.push(pid); },
    });

    expect(terminated).toEqual([111]);
    expect(result).toEqual({ terminated: 1, stale: 1, failed: 0 });
  });

  it('ignores malformed marker payloads without invoking process operations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-orphans-'));
    mkdirSync(join(root, 'execution'), { recursive: true });
    writeFileSync(join(root, 'execution', ORPHAN_MARKER), '{bad json');
    let inspected = false;
    const result = await cleanupOrphanPiProcesses(root, {
      inspect: async () => { inspected = true; return undefined; },
      terminate: async () => undefined,
    });
    expect(inspected).toBe(false);
    expect(result).toEqual({ terminated: 0, stale: 1, failed: 0 });
  });
});
