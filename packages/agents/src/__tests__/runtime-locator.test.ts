import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { buildProbeEnv, BundledPiLocator } from '../runtime-locator.js';

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

function createDirectoryLink(root: string, linkPath: string, target: string): string {
  const platformTarget = process.platform === 'win32' ? join(root, target) : target;
  symlinkSync(platformTarget, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  return readlinkSync(linkPath);
}

function makeLinkedRuntimeFixture(): { root: string; linkPath: string; rawTarget: string } {
  const root = mkdtempSync(join(tmpdir(), 'pi-runtime-links-'));
  const linkPath = join(root, 'alias');
  mkdirSync(join(root, 'package'), { recursive: true });
  mkdirSync(join(root, 'targets', 'a'), { recursive: true });
  mkdirSync(join(root, 'targets', 'b'), { recursive: true });
  writeFileSync(join(root, 'package', 'cli.js'), 'console.log("0.80.10")');
  writeFileSync(join(root, 'targets', 'a', 'value.txt'), 'a');
  writeFileSync(join(root, 'targets', 'b', 'value.txt'), 'b');
  const rawTarget = createDirectoryLink(root, linkPath, 'targets/a');
  writeRuntimeManifest(root, 'package/cli.js', '0.80.10', null, { alias: rawTarget }, [
    'targets/a/value.txt',
    'targets/b/value.txt',
  ]);
  return { root, linkPath, rawTarget };
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
  it('builds a minimal probe environment that excludes hostile parent configuration', () => {
    const env = buildProbeEnv({
      LANG: 'en_US.UTF-8',
      SystemRoot: 'C:\\Windows',
      PATH: '/hostile/bin',
      OPENAI_API_KEY: 'parent-provider-secret',
      PI_CODING_AGENT_DIR: '/hostile/pi',
      NODE_OPTIONS: '--require /hostile.js',
      NODE_PATH: '/hostile/modules',
      NPM_CONFIG_PREFIX: '/hostile/npm',
      AI_DEVFLOW_DEV: '1',
      DEV_API_KEY: 'dev-secret',
    });
    expect(env).toMatchObject({
      ELECTRON_RUN_AS_NODE: '1',
      PI_OFFLINE: '1',
      PI_SKIP_VERSION_CHECK: '1',
      PI_TELEMETRY: '0',
      LANG: 'en_US.UTF-8',
      SystemRoot: 'C:\\Windows',
    });
    for (const key of ['PATH', 'OPENAI_API_KEY', 'PI_CODING_AGENT_DIR', 'NODE_OPTIONS', 'NODE_PATH', 'NPM_CONFIG_PREFIX', 'AI_DEVFLOW_DEV', 'DEV_API_KEY']) {
      expect(env[key]).toBeUndefined();
    }
  });

  it('passes only the minimal environment to the version probe', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-runtime-clean-env-'));
    mkdirSync(join(root, 'package'), { recursive: true });
    writeFileSync(join(root, 'package', 'cli.js'), 'console.log("0.80.10")');
    writeRuntimeManifest(root, 'package/cli.js', '0.80.10');
    let received: Record<string, string> | undefined;
    const locator = new BundledPiLocator(root, {
      execFile: async (_command, _args, options) => {
        received = options.env;
        return { stdout: '0.80.10\n', stderr: '', exitCode: 0 };
      },
    });
    await locator.verify();
    expect(received).toEqual(buildProbeEnv(process.env));
  });

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
    const { root } = makeLinkedRuntimeFixture();
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
    const { root, linkPath, rawTarget } = makeLinkedRuntimeFixture();
    unlinkSync(linkPath);
    createDirectoryLink(root, linkPath, 'targets/b');
    expect(readlinkSync(linkPath)).not.toBe(rawTarget);
    await expect(new BundledPiLocator(root, { execFile: fakeVersionExec }).verify()).rejects.toThrow(
      /运行时校验失败：符号链接被重定向 alias/,
    );
  });

  it('rejects a manifest-covered link that escapes the real runtime root', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'pi-runtime-outside-'));
    writeFileSync(join(outside, 'value.txt'), 'outside');
    const root = mkdtempSync(join(tmpdir(), 'pi-runtime-escape-'));
    mkdirSync(join(root, 'package'), { recursive: true });
    writeFileSync(join(root, 'package', 'cli.js'), 'console.log("0.80.10")');
    const linkPath = join(root, 'alias');
    symlinkSync(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    writeRuntimeManifest(root, 'package/cli.js', '0.80.10', null, { alias: readlinkSync(linkPath) });
    await expect(new BundledPiLocator(root, { execFile: fakeVersionExec }).verify()).rejects.toThrow(
      /运行时校验失败：符号链接目标越出运行时 alias/,
    );
  });

  it('rejects a manifest link path occupied by a regular file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-runtime-non-link-'));
    mkdirSync(join(root, 'package'), { recursive: true });
    writeFileSync(join(root, 'package', 'cli.js'), 'console.log("0.80.10")');
    writeFileSync(join(root, 'alias'), 'not a link');
    writeRuntimeManifest(root, 'package/cli.js', '0.80.10', null, { alias: 'unused-target' });
    await expect(new BundledPiLocator(root, { execFile: fakeVersionExec }).verify()).rejects.toThrow(
      /运行时校验失败：符号链接缺失或不是符号链接 alias/,
    );
  });

  it('rejects a manifest link path that is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-runtime-missing-link-'));
    mkdirSync(join(root, 'package'), { recursive: true });
    writeFileSync(join(root, 'package', 'cli.js'), 'console.log("0.80.10")');
    writeRuntimeManifest(root, 'package/cli.js', '0.80.10', null, { alias: 'unused-target' });
    await expect(new BundledPiLocator(root, { execFile: fakeVersionExec }).verify()).rejects.toThrow(
      /运行时校验失败：符号链接缺失或不是符号链接 alias/,
    );
  });

  it('rejects a link whose captured target later disappears', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-runtime-broken-link-'));
    const target = join(root, 'targets', 'a');
    const linkPath = join(root, 'alias');
    mkdirSync(join(root, 'package'), { recursive: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(root, 'package', 'cli.js'), 'console.log("0.80.10")');
    const rawTarget = createDirectoryLink(root, linkPath, 'targets/a');
    writeRuntimeManifest(root, 'package/cli.js', '0.80.10', null, { alias: rawTarget });
    rmSync(target, { recursive: true });
    await expect(new BundledPiLocator(root, { execFile: fakeVersionExec }).verify()).rejects.toThrow(
      /运行时校验失败：符号链接目标缺失 alias/,
    );
  });

  it('rejects an in-root link target absent from manifest file hashes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-runtime-unbound-link-'));
    const linkPath = join(root, 'alias');
    mkdirSync(join(root, 'package'), { recursive: true });
    mkdirSync(join(root, 'targets', 'a'), { recursive: true });
    writeFileSync(join(root, 'package', 'cli.js'), 'console.log("0.80.10")');
    writeFileSync(join(root, 'targets', 'a', 'unlisted.txt'), 'unbound');
    const rawTarget = createDirectoryLink(root, linkPath, 'targets/a');
    writeRuntimeManifest(root, 'package/cli.js', '0.80.10', null, { alias: rawTarget });
    await expect(new BundledPiLocator(root, { execFile: fakeVersionExec }).verify()).rejects.toThrow(
      /运行时校验失败：符号链接目标未受摘要保护 alias/,
    );
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
