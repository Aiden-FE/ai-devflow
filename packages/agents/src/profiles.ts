// 角色 profile 注册表与物化器（设计 §7.3/§7.5/§5.1 角色隔离层）。
//
// RoleProfile 只存在于 Main 进程包，不通过 IPC 返回。每个应用版本发布一份显式、受测的角色
// 工具/技能/超时表；用户不能覆盖。ProfileMaterializer 把只读内置资源复制到内容寻址快照目录
// （provider/应用配置变化 → 新快照 → 原子切换；已有进程继续用旧快照，避免并发写与配置漂移）。
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderKind, TaskRole } from '@ai-devflow/core';

export interface RoleProfile {
  role: TaskRole;
  version: number;
  systemPromptFile: string;
  /** 角色 built-in tools（未含两个内部工具）。 */
  tools: string[];
  excludedTools: string[];
  /** 内置 skills（<profile>/skills/<name>/SKILL.md）。 */
  skills: string[];
  timeoutMs: number;
}

/** 两个内部工具：澄清/确认 与 结构化完成。对四角色都必须启用，非用户可配置（§7.5）。 */
export const INTERNAL_TOOLS = ['ai_devflow_interaction', 'ai_devflow_report_result'] as const;

/** 四个随仓库维护的内置扩展（Task 7 提供源文件）。 */
export const BUILTIN_EXTENSIONS = [
  'event-bridge',
  'execution-policy',
  'structured-result',
  'checkpoint-context',
] as const;

export const ROLE_PROFILES: Record<TaskRole, RoleProfile> = {
  planner: {
    role: 'planner', version: 1, systemPromptFile: 'SYSTEM.md',
    tools: ['read', 'grep', 'find', 'ls', 'write', 'edit'], excludedTools: ['bash'],
    skills: ['requirements-analysis', 'design-writing', 'implementation-planning'],
    timeoutMs: 20 * 60_000,
  },
  coder: {
    role: 'coder', version: 1, systemPromptFile: 'SYSTEM.md',
    tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'], excludedTools: [],
    skills: ['test-driven-development', 'systematic-debugging', 'verification'],
    timeoutMs: 45 * 60_000,
  },
  reviewer: {
    role: 'reviewer', version: 1, systemPromptFile: 'SYSTEM.md',
    tools: ['read', 'bash', 'grep', 'find', 'ls'], excludedTools: ['edit', 'write'],
    skills: ['code-review', 'security-review', 'regression-review'],
    timeoutMs: 15 * 60_000,
  },
  tester: {
    role: 'tester', version: 1, systemPromptFile: 'SYSTEM.md',
    tools: ['read', 'bash', 'grep', 'find', 'ls', 'write', 'edit'], excludedTools: [],
    skills: ['test-design', 'failure-analysis', 'acceptance-verification'],
    timeoutMs: 30 * 60_000,
  },
};

/** --tools 的最终值：角色 built-in tools ∪ 两个内部工具（§7.5）。 */
export function roleToolsArg(role: TaskRole): string {
  return [...ROLE_PROFILES[role].tools, ...INTERNAL_TOOLS].join(',');
}

/** 兼容网关类型 → Pi `api` 取值。 */
export const COMPATIBLE_API: Record<'openai_compatible' | 'anthropic_compatible', string> = {
  openai_compatible: 'openai-completions',
  anthropic_compatible: 'anthropic-messages',
};

/** 运行时注入兼容网关密钥的专用环境变量名（models.json 只引用该变量，不含明文）。 */
export const ACTIVE_API_KEY_ENV = 'AI_DEVFLOW_ACTIVE_API_KEY';

export function isCompatibleKind(kind: ProviderKind): kind is 'openai_compatible' | 'anthropic_compatible' {
  return kind === 'openai_compatible' || kind === 'anthropic_compatible';
}

/**
 * 生成兼容网关的 models.json（§8.2）：apiKey 只引用进程专用环境变量 `$AI_DEVFLOW_ACTIVE_API_KEY`，
 * 绝不包含明文密钥。
 */
export function buildCompatibleModelsJson(
  providerName: string,
  kind: 'openai_compatible' | 'anthropic_compatible',
  baseURL: string | undefined,
  models: string[],
): string {
  return JSON.stringify(
    {
      providers: {
        [providerName]: {
          baseUrl: baseURL ?? '',
          api: COMPATIBLE_API[kind],
          apiKey: `$${ACTIVE_API_KEY_ENV}`,
          models: models.map((id) => ({ id })),
        },
      },
    },
    null,
    2,
  );
}

export interface MaterializeInput {
  role: TaskRole;
  providerId: string;
  providerKind: ProviderKind;
  providerRevision: number;
  baseURL?: string;
  /** 生成的 Pi provider 名（兼容网关为 ai-devflow-<hash>；标准提供商为 catalog 名）。 */
  providerName: string;
  /** 该角色在此提供商下需要声明的模型 ID（primary + fallback）。 */
  models: string[];
}

/**
 * 把内置只读角色资源物化到内容寻址快照：`<baseDir>/profiles/<digest>/<role>/`，含 settings.json、
 * SYSTEM.md、skills/ 与共享 extensions/ 副本；兼容网关额外写 models.json。原子切换（临时目录 + rename），
 * 完成后写 `.complete` 标记；已存在则直接复用（幂等）。每个角色快照自包含，互不可见。
 */
export class ProfileMaterializer {
  constructor(private assetsRoot: string, private baseDir: string) {}

  digest(input: MaterializeInput): string {
    const profile = ROLE_PROFILES[input.role];
    const key = JSON.stringify({
      role: input.role,
      profileVersion: profile.version,
      providerKind: input.providerKind,
      providerRevision: input.providerRevision,
      baseURL: input.baseURL ?? null,
    });
    return createHash('sha256').update(key).digest('hex').slice(0, 16);
  }

  materialize(input: MaterializeInput): { profileDir: string; digest: string } {
    const digest = this.digest(input);
    const profileDir = join(this.baseDir, 'profiles', digest, input.role);
    if (existsSync(join(profileDir, '.complete'))) return { profileDir, digest };
    const tmp = `${profileDir}.tmp-${randomBytes(4).toString('hex')}`;
    mkdirSync(join(this.baseDir, 'profiles', digest), { recursive: true });
    cpSync(join(this.assetsRoot, input.role), tmp, { recursive: true });
    const extDir = join(tmp, 'extensions');
    mkdirSync(extDir, { recursive: true });
    for (const ext of BUILTIN_EXTENSIONS) {
      const src = join(this.assetsRoot, 'shared', 'extensions', `${ext}.ts`);
      if (existsSync(src)) cpSync(src, join(extDir, `${ext}.ts`));
    }
    if (isCompatibleKind(input.providerKind)) {
      writeFileSync(join(tmp, 'models.json'), buildCompatibleModelsJson(input.providerName, input.providerKind, input.baseURL, input.models));
    }
    renameSync(tmp, profileDir);
    writeFileSync(join(profileDir, '.complete'), digest);
    return { profileDir, digest };
  }
}
