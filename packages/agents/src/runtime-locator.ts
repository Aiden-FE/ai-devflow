// BundledPiLocator：从 manifest 解析并校验内置 Pi 运行时入口（设计 §6.2/§6.3）。
//
// 应用绝不执行 PATH 中的 `pi`。入口来自 staging 生成的 runtime-manifest.json（含 Pi 版本、
// 入口相对路径、文件摘要、角色资源摘要）。启动自检依次校验：manifest → 文件摘要 → 入口 →
// `pi --version` → 预期版本；requireProfiles 时还校验角色资源摘要与四角色目录。任一步失败抛
// 「运行时校验失败」，阻止 Agent 执行，绝不回退 PATH 或外部 Pi。
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

export interface PiRuntimeManifest {
  schemaVersion: number;
  piVersion: string;
  entry: string;
  profilesDigest: string | null;
  files: Record<string, string>;
  links: Record<string, string>;
}

export interface ExecLike {
  (
    command: string,
    args: string[],
    options: { env: Record<string, string> },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface BundledPiLocatorOptions {
  /** 可注入的版本探测执行器（测试用 fake；生产用 ELECTRON_RUN_AS_NODE 子进程）。 */
  execFile?: ExecLike;
  /** 生产组合应为 true：要求角色资源摘要非空且四角色目录齐全。 */
  requireProfiles?: boolean;
}

const ROLES = ['planner', 'coder', 'reviewer', 'tester'] as const;

export interface VerifiedPiRuntime {
  entry: string;
  version: string;
}

export class BundledPiLocator {
  private execFile: ExecLike;
  private requireProfiles: boolean;

  constructor(private root: string, opts: BundledPiLocatorOptions = {}) {
    this.requireProfiles = opts.requireProfiles ?? false;
    this.execFile = opts.execFile ?? defaultExecFile;
  }

  private readManifest(): PiRuntimeManifest {
    const manifestPath = join(this.root, 'runtime-manifest.json');
    if (!existsSync(manifestPath)) throw new Error('运行时校验失败：缺少 runtime-manifest.json');
    try {
      return JSON.parse(readFileSync(manifestPath, 'utf8')) as PiRuntimeManifest;
    } catch {
      throw new Error('运行时校验失败：runtime-manifest.json 无法解析');
    }
  }

  /** 全量自检：manifest → 摘要 → 入口 → 角色资源（可选）→ 版本。任一失败抛「运行时校验失败」。 */
  async verify(): Promise<VerifiedPiRuntime> {
    const manifest = this.readManifest();
    if (!manifest.piVersion || !manifest.entry || !isRecord(manifest.files)) {
      throw new Error('运行时校验失败：manifest 字段不完整');
    }
    if (!isRecord(manifest.links)) throw new Error('运行时校验失败：manifest 缺少 links');
    this.verifyLinks(manifest);
    for (const [rel, expected] of Object.entries(manifest.files)) {
      const abs = join(this.root, rel);
      if (!existsSync(abs)) throw new Error(`运行时校验失败：缺少文件 ${rel}`);
      const actual = createHash('sha256').update(readFileSync(abs)).digest('hex');
      if (actual !== expected) throw new Error(`运行时校验失败：${rel} 摘要不匹配`);
    }
    const entry = join(this.root, manifest.entry);
    if (!existsSync(entry)) throw new Error('运行时校验失败：入口缺失');
    if (this.requireProfiles) {
      if (!manifest.profilesDigest) throw new Error('运行时校验失败：缺少角色配置摘要');
      for (const role of ROLES) {
        if (!existsSync(join(this.root, 'profiles', role))) throw new Error(`运行时校验失败：缺少角色 ${role}`);
      }
    }
    const result = await this.execFile(process.execPath, [entry, '--version'], { env: buildProbeEnv(process.env) });
    const version = (result.stdout ?? '').trim();
    if (result.exitCode !== 0 || version !== manifest.piVersion) {
      throw new Error(`运行时校验失败：版本不匹配（期望 ${manifest.piVersion}，实际 ${version || '无输出'}）`);
    }
    return { entry, version };
  }

  private verifyLinks(manifest: PiRuntimeManifest): void {
    const actualLinks = collectLinks(this.root);
    const listedLinks = Object.keys(manifest.links).sort();
    const actualPaths = [...actualLinks.keys()].sort();
    for (const rel of actualPaths) {
      if (!Object.hasOwn(manifest.links, rel)) throw new Error(`运行时校验失败：manifest 缺少符号链接 ${rel}`);
    }
    for (const rel of listedLinks) {
      if (!actualLinks.has(rel)) throw new Error(`运行时校验失败：符号链接缺失或不是符号链接 ${rel}`);
      const expectedTarget = manifest.links[rel];
      if (typeof expectedTarget !== 'string' || actualLinks.get(rel) !== expectedTarget) {
        throw new Error(`运行时校验失败：符号链接被重定向 ${rel}`);
      }
    }

    const realRoot = realpathSync(this.root);
    const manifestFiles = Object.keys(manifest.files);
    for (const rel of listedLinks) {
      const linkPath = join(this.root, rel);
      let realTarget: string;
      try {
        realTarget = realpathSync(linkPath);
      } catch {
        throw new Error(`运行时校验失败：符号链接目标缺失 ${rel}`);
      }
      const targetRel = relative(realRoot, realTarget);
      if (targetRel === '..' || targetRel.startsWith(`..${sep}`) || isAbsolute(targetRel)) {
        throw new Error(`运行时校验失败：符号链接目标越出运行时 ${rel}`);
      }
      const normalizedTarget = normalizeRelative(targetRel);
      const target = statSync(linkPath);
      const checksumBound = target.isFile()
        ? Object.hasOwn(manifest.files, normalizedTarget)
        : target.isDirectory() && manifestFiles.some((file) => file.startsWith(`${normalizedTarget}/`));
      if (!checksumBound) throw new Error(`运行时校验失败：符号链接目标未受摘要保护 ${rel}`);
    }
  }

  /** 校验并返回绝对入口与版本（供 PiProcessSupervisor 以 ELECTRON_RUN_AS_NODE 启动）。 */
  async command(): Promise<VerifiedPiRuntime> {
    return this.verify();
  }
}

const PROBE_PASSTHROUGH = [
  'LANG', 'LC_ALL', 'LC_CTYPE',
  'SystemRoot', 'ComSpec', 'PATHEXT',
  'TMPDIR', 'TEMP', 'TMP',
  'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
] as const;

/** Minimal environment shared by packaged and development Pi startup probes. */
export function buildProbeEnv(source: NodeJS.ProcessEnv | Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {
    ELECTRON_RUN_AS_NODE: '1',
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
  };
  for (const key of PROBE_PASSTHROUGH) {
    const value = source[key];
    if (value) env[key] = value;
  }
  return env;
}

function isRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeRelative(path: string): string {
  return path.split(sep).join('/');
}

function collectLinks(root: string): Map<string, string> {
  const links = new Map<string, string>();
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const status = lstatSync(path);
      if (status.isSymbolicLink()) {
        links.set(normalizeRelative(relative(root, path)), readlinkSync(path));
      } else if (status.isDirectory()) {
        visit(path);
      }
    }
  };
  visit(root);
  return links;
}

async function defaultExecFile(
  command: string,
  args: string[],
  options: { env: Record<string, string> },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileP = promisify(execFile);
  try {
    const { stdout, stderr } = await execFileP(command, args, { env: options.env });
    return { stdout: String(stdout), stderr: String(stderr), exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: unknown; stderr?: unknown; code?: number };
    return { stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? ''), exitCode: typeof e.code === 'number' ? e.code : 1 };
  }
}
