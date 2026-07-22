import { execFile } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

export const ORPHAN_MARKER = '.ai-devflow-pi-process.json';
const MAX_MARKER_BYTES = 4 * 1024;

interface ProcessMarker {
  schemaVersion: 1;
  pid: number;
  runtimeEntry: string;
  createdAt: number;
}

export interface OrphanCleanupResult {
  terminated: number;
  stale: number;
  failed: number;
}

export interface OrphanCleanupDeps {
  inspect(pid: number): Promise<string | undefined>;
  terminate(pid: number): Promise<void>;
}

export function recordPiProcessMarker(
  sessionDir: string | undefined,
  pid: number | undefined,
  runtimeEntry: string | undefined,
): string | undefined {
  if (!sessionDir || !pid || !Number.isSafeInteger(pid) || pid <= 0 || !runtimeEntry || !isAbsolute(runtimeEntry)) {
    return undefined;
  }
  mkdirSync(sessionDir, { recursive: true });
  const path = join(sessionDir, ORPHAN_MARKER);
  const marker: ProcessMarker = { schemaVersion: 1, pid, runtimeEntry, createdAt: Date.now() };
  writeFileSync(path, JSON.stringify(marker), { mode: 0o600 });
  return path;
}

export function clearPiProcessMarker(path: string | undefined): void {
  if (!path) return;
  try {
    unlinkSync(path);
  } catch { /* stale marker is safe and will be reconsidered at startup */ }
}

/**
 * Clean up Pi processes whose app-owned session marker survived a crash. A PID is terminated only
 * when its live command still contains the exact recorded runtime entry, avoiding recycled PIDs.
 */
export async function cleanupOrphanPiProcesses(
  sessionsBaseDir: string,
  deps: OrphanCleanupDeps = defaultCleanupDeps(),
): Promise<OrphanCleanupResult> {
  const result: OrphanCleanupResult = { terminated: 0, stale: 0, failed: 0 };
  for (const markerPath of findMarkers(sessionsBaseDir)) {
    const marker = readMarker(markerPath);
    if (!marker) {
      result.stale += 1;
      clearPiProcessMarker(markerPath);
      continue;
    }
    try {
      const command = await deps.inspect(marker.pid);
      if (!command || !command.includes(marker.runtimeEntry)) {
        result.stale += 1;
        clearPiProcessMarker(markerPath);
        continue;
      }
      await deps.terminate(marker.pid);
      clearPiProcessMarker(markerPath);
      result.terminated += 1;
    } catch {
      // Preserve a valid marker after an operational failure so a later startup can retry.
      result.failed += 1;
    }
  }
  return result;
}

function findMarkers(root: string): string[] {
  const found: string[] = [];
  const visit = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name === ORPHAN_MARKER) found.push(path);
    }
  };
  visit(root);
  return found;
}

function readMarker(path: string): ProcessMarker | undefined {
  try {
    if (statSync(path).size > MAX_MARKER_BYTES) return undefined;
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<ProcessMarker>;
    if (
      value.schemaVersion !== 1
      || !Number.isSafeInteger(value.pid)
      || (value.pid ?? 0) <= 0
      || typeof value.runtimeEntry !== 'string'
      || !isAbsolute(value.runtimeEntry)
      || typeof value.createdAt !== 'number'
      || !Number.isFinite(value.createdAt)
      || value.createdAt <= 0
    ) return undefined;
    return value as ProcessMarker;
  } catch {
    return undefined;
  }
}

function defaultCleanupDeps(): OrphanCleanupDeps {
  return { inspect: inspectProcessCommand, terminate: terminateProcessTree };
}

async function inspectProcessCommand(pid: number): Promise<string | undefined> {
  const exec = promisify(execFile);
  try {
    if (process.platform === 'win32') {
      const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
      const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const { stdout } = await exec(
        powershell,
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`],
        { windowsHide: true, timeout: 5_000, env: { SystemRoot: systemRoot } },
      );
      return String(stdout).trim() || undefined;
    }
    const { stdout } = await exec('/bin/ps', ['-p', String(pid), '-o', 'command='], {
      timeout: 5_000,
      env: { PATH: '/usr/bin:/bin' },
    });
    return String(stdout).trim() || undefined;
  } catch {
    return undefined;
  }
}

async function terminateProcessTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const taskkill = join(systemRoot, 'System32', 'taskkill.exe');
    await new Promise<void>((resolve, reject) => {
      execFile(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    process.kill(pid, 'SIGTERM');
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 250);
    timer.unref?.();
  });
  try {
    process.kill(-pid, 0);
  } catch {
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* exited */ }
  }
}
