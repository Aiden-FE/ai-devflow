import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { BundledPiLocator } from '../runtime-locator.js';

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const fakeVersionExec = async (): Promise<ExecResult> => ({ stdout: '0.80.10\n', stderr: '', exitCode: 0 });

function writeRuntimeManifest(
  root: string,
  entry: string,
  version: string,
  profilesDigest: string | null = null,
  links: Record<string, string> = {},
  extraFiles: string[] = [],
): void {
  const files = Object.fromEntries([entry, ...extraFiles].map((rel) => [
    rel,
    createHash('sha256').update(readFileSync(join(root, rel))).digest('hex'),
  ]));
  writeFileSync(join(root, 'runtime-manifest.json'), JSON.stringify({
    schemaVersion: 1, piVersion: version, entry, profilesDigest, files, links,
  }));
}

function makeLinkedRuntimeFixture(actualTarget = 'targets/a', expectedTarget = actualTarget): string {
  const root = mkdtempSync(join(tmpdir(), 'pi-runtime-links-'));
  mkdirSync(join(root, 'package'), { recursive: true });
  mkdirSync(join(root, 'targets', 'a'), { recursive: true });
  mkdirSync(join(root, 'targets', 'b'), { recursive: true });
  writeFileSync(join(root, 'package', 'cli.js'), 'console.log("0.80.10")');
  writeFileSync(join(root, 'targets', 'a', 'value.txt'), 'a');
  writeFileSync(join(root, 'targets', 'b', 'value.txt'), 'b');
  symlinkSync(actualTarget, join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  writeRuntimeManifest(root, 'package/cli.js', '0.80.10', null, { alias: expectedTarget }, [
    'targets/a/value.txt',
    'targets/b/value.txt',
  ]);
  return root;
}

function makeCorruptRuntimeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'pi-runtime-corrupt-'));
  mkdirSync(join(root, 'package'), { recursive: true });
  writeFileSync(join(root, 'package', 'cli.js'), 'changed');
  writeFileSync(join(root, 'runtime-manifest.json'), JSON.stringify({
    schemaVersion: 1, piVersion: '0.80.10', entry: 'package/cli.js', profilesDigest: null,
    files: { 'package/cli.js': '0'.repeat(64) }, links: {},
  }));
  return root;
}

describe('BundledPiLocator', () => {
  it('returns an absolute verified entry and never consults PATH', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-runtime-'));
    mkdirSync(join(root, 'package'), { recursive: true });
    writeFileSync(join(root, 'package', 'cli.js'), 'console.log("0.80.10")');
    writeRuntimeManifest(root, 'package/cli.js', '0.80.10');
    const locator = new BundledPiLocator(root, { execFile: fakeVersionExec });
    const command = await locator.command();
    expect(command.entry).toBe(join(root, 'package', 'cli.js'));
    expect(command.version).toBe('0.80.10');
  });

  it('accepts an exact in-root link whose target is checksum-bound', async () => {
    const root = makeLinkedRuntimeFixture();
    const command = await new BundledPiLocator(root, { execFile: fakeVersionExec }).verify();
    expect(command.entry).toBe(join(root, 'package', 'cli.js'));
  });

  it('rejects a manifest without mandatory links metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-runtime-no-links-'));
    mkdirSync(join(root, 'package'), { recursive: true });
    writeFileSync(join(root, 'package', 'cli.js'), 'console.log("0.80.10")');
    const digest = createHash('sha256').update(readFileSync(join(root, 'package', 'cli.js'))).digest('hex');
    writeFileSync(join(root, 'runtime-manifest.json'), JSON.stringify({
      schemaVersion: 1, piVersion: '0.80.10', entry: 'package/cli.js', profilesDigest: null,
      files: { 'package/cli.js': digest },
    }));
    await expect(new BundledPiLocator(root, { execFile: fakeVersionExec }).verify()).rejects.toThrow(/links/);
  });

  it('rejects an in-root link retargeted despite a successful version probe', async () => {
    const root = makeLinkedRuntimeFixture('targets/b', 'targets/a');
    await expect(new BundledPiLocator(root, { execFile: fakeVersionExec }).verify()).rejects.toThrow(/符号链接/);
  });

  it('rejects a manifest-covered link that escapes the real runtime root', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'pi-runtime-outside-'));
    writeFileSync(join(outside, 'value.txt'), 'outside');
    const root = mkdtempSync(join(tmpdir(), 'pi-runtime-escape-'));
    mkdirSync(join(root, 'package'), { recursive: true });
    writeFileSync(join(root, 'package', 'cli.js'), 'console.log("0.80.10")');
    symlinkSync(outside, join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    writeRuntimeManifest(root, 'package/cli.js', '0.80.10', null, { alias: outside });
    await expect(new BundledPiLocator(root, { execFile: fakeVersionExec }).verify()).rejects.toThrow(/越出/);
  });

  it('rejects a checksum mismatch instead of falling back', async () => {
    const root = makeCorruptRuntimeFixture();
    await expect(new BundledPiLocator(root).verify()).rejects.toThrow(/校验失败/);
  });

  it('rejects a version mismatch reported by the entry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-runtime-ver-'));
    mkdirSync(join(root, 'package'), { recursive: true });
    writeFileSync(join(root, 'package', 'cli.js'), 'x');
    writeRuntimeManifest(root, 'package/cli.js', '0.80.10');
    const lyingExec = async (): Promise<ExecResult> => ({ stdout: '0.99.99\n', stderr: '', exitCode: 0 });
    const locator = new BundledPiLocator(root, { execFile: lyingExec });
    await expect(locator.verify()).rejects.toThrow(/校验失败/);
  });

  it('requires a non-null profiles digest and all four roles when requireProfiles is set', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-runtime-prof-'));
    mkdirSync(join(root, 'package'), { recursive: true });
    writeFileSync(join(root, 'package', 'cli.js'), 'x');
    // No profiles digest yet → requireProfiles must reject.
    writeRuntimeManifest(root, 'package/cli.js', '0.80.10', null);
    await expect(new BundledPiLocator(root, { execFile: fakeVersionExec, requireProfiles: true }).verify()).rejects.toThrow(/校验失败/);
    // With digest + all four role dirs → passes.
    for (const role of ['planner', 'coder', 'reviewer', 'tester']) {
      mkdirSync(join(root, 'profiles', role), { recursive: true });
    }
    writeRuntimeManifest(root, 'package/cli.js', '0.80.10', 'abc123');
    const ok = await new BundledPiLocator(root, { execFile: fakeVersionExec, requireProfiles: true }).verify();
    expect(ok.version).toBe('0.80.10');
  });

  it('rejects when the manifest is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-runtime-nomanifest-'));
    await expect(new BundledPiLocator(root).verify()).rejects.toThrow(/校验失败/);
  });
});
