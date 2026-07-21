// BundledPiLocator：从 manifest 解析并校验内置 Pi 运行时入口（设计 §6.2/§6.3）。
//
// 应用绝不执行 PATH 中的 `pi`。入口来自 staging 生成的 runtime-manifest.json（含 Pi 版本、
// 入口相对路径、文件摘要、角色资源摘要）。启动自检依次校验：manifest → 文件摘要 → 入口 →
// `pi --version` → 预期版本；requireProfiles 时还校验角色资源摘要与四角色目录。任一步失败抛
// 「运行时校验失败」，阻止 Agent 执行，绝不回退 PATH 或外部 Pi。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PiRuntimeManifest {
  schemaVersion: number;
  piVersion: string;
  entry: string;
  profilesDigest: string | null;
  files: Record<string, string>;
}

export interface ExecLike {
  (command: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;
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
    if (!manifest.piVersion || !manifest.entry) throw new Error('运行时校验失败：manifest 字段不完整');
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
    const result = await this.execFile(process.execPath, [entry, '--version']);
    const version = (result.stdout ?? '').trim();
    if (result.exitCode !== 0 || version !== manifest.piVersion) {
      throw new Error(`运行时校验失败：版本不匹配（期望 ${manifest.piVersion}，实际 ${version || '无输出'}）`);
    }
    return { entry, version };
  }

  /** 校验并返回绝对入口与版本（供 PiProcessSupervisor 以 ELECTRON_RUN_AS_NODE 启动）。 */
  async command(): Promise<VerifiedPiRuntime> {
    return this.verify();
  }
}

async function defaultExecFile(command: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileP = promisify(execFile);
  try {
    const { stdout, stderr } = await execFileP(command, args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    return { stdout: String(stdout), stderr: String(stderr), exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: unknown; stderr?: unknown; code?: number };
    return { stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? ''), exitCode: typeof e.code === 'number' ? e.code : 1 };
  }
}
