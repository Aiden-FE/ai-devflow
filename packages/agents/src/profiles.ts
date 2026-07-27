// 角色 profile 注册表与物化器（设计 §7.3/§7.5/§5.1 角色隔离层）。
//
// RoleProfile 只存在于 Main 进程包，不通过 IPC 返回。每个应用版本发布一份显式、受测的角色
// 工具/技能/超时表；用户不能覆盖。ProfileMaterializer 把只读内置资源复制到内容寻址快照目录
// （provider/应用配置变化 → 新快照 → 原子切换；已有进程继续用旧快照，避免并发写与配置漂移）。
import { createHash, randomBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { ProviderKind, TaskRole, ExpertKey } from '@ai-devflow/core';

/**
 * 角色 profile（设计 §7.1）。
 *
 * 与设计 §7.1 契约的等价取舍（显式注明，非偏差）：
 * - `extensions` 逐角色声明启用子集：名称取自模块常量 `BUILTIN_EXTENSIONS`（§7.4 注册池），
 *   由 `validateRoleProfiles` 在模块加载期校验，避免引用池外扩展。
 * - `providerModels` 未列入本接口：模型由用户在 ProviderConfig 中配置（defaultModel/
 *   workloadModels，§7.2），由 ProviderRouter 按 workload 解析取用，不挂在单角色 profile 上。
 * RoleProfile 保留角色间可调维度：工具清单、排除工具、skills、扩展、超时。
 */
export interface RoleProfile {
  role: TaskRole;
  version: number;
  systemPromptFile: string;
  /** 角色 built-in tools（未含两个内部工具）。 */
  tools: string[];
  excludedTools: string[];
  /** 引用的内置 skills（来自 BUILTIN_SKILLS 注册池；source=角色名时取 <source>/skills/<name>/，source='shared' 时取 shared/skills/<name>/）。任意角色可引用池中任意技能。 */
  skills: string[];
  /** 该角色启用的扩展（名称取自 BUILTIN_EXTENSIONS 注册池）。 */
  extensions: string[];
  timeoutMs: number;
}

/** 两个内部工具：澄清/确认 与 结构化完成。对四角色都必须启用，非用户可配置（§7.5）。 */
export const INTERNAL_TOOLS = ['ai_devflow_interaction', 'ai_devflow_report_result'] as const;

/** 可用扩展注册池：shared/extensions/ 下维护的内置扩展名。各角色/步骤通过 .extensions 声明启用子集。 */
export const BUILTIN_EXTENSIONS = [
  'event-bridge',
  'execution-policy',
  'structured-result',
  'checkpoint-context',
  'requirement-bridge',
  'task-bridge',
  'ask-bridge',
  'ux-bridge',
] as const;

/** 技能物理来源：<角色名> 表示 assets/profiles/<source>/skills/<name>/，'shared' 表示 assets/profiles/shared/skills/<name>/。 */
export type SkillSource = TaskRole | 'shared' | 'product' | 'ux' | 'dev_lead' | 'project_lead';

/** 内置技能注册表条目：name 为技能目录名，source 仅表示物理文件位置，不限制哪些角色可引用。 */
export interface BuiltinSkill {
  name: string;
  source: SkillSource;
}

/**
 * 内置技能注册池：记录每个技能的物理位置。任意角色均可引用池中任意技能——source 仅用于
 * ProfileMaterializer 物化时定位源文件，不构成引用限制。物化后统一落在角色快照的 skills/<name>/。
 */
export const BUILTIN_SKILLS = [
  { name: 'brainstorming', source: 'shared' as const },
  { name: 'requirements-analysis',   source: 'planner' },
  { name: 'design-writing',          source: 'planner' },
  { name: 'implementation-planning', source: 'planner' },
  { name: 'test-driven-development', source: 'coder' },
  { name: 'systematic-debugging',    source: 'coder' },
  { name: 'verification',            source: 'coder' },
  { name: 'code-review',             source: 'reviewer' },
  { name: 'security-review',         source: 'reviewer' },
  { name: 'regression-review',       source: 'reviewer' },
  { name: 'test-design',             source: 'tester' },
  { name: 'failure-analysis',        source: 'tester' },
  { name: 'acceptance-verification', source: 'tester' },
  // 专家化新增技能（Task 3 资产）
  { name: 'create-prd',           source: 'product' as const },
  { name: 'ux-spec-writing',      source: 'ux' as const },
  { name: 'web-design-engineer',  source: 'ux' as const },
  { name: 'subtask-generation',   source: 'dev_lead' as const },
  // 知识技能（Task 6 资产）
  { name: 'knowledge-retrieve',    source: 'shared' as const },
  { name: 'knowledge-governance',  source: 'shared' as const },
] as const satisfies readonly BuiltinSkill[];

export const ROLE_PROFILES: Record<TaskRole, RoleProfile> = {
  planner: {
    role: 'planner', version: 1, systemPromptFile: 'SYSTEM.md',
    tools: ['read', 'grep', 'find', 'ls', 'write', 'edit'], excludedTools: ['bash'],
    skills: ['requirements-analysis', 'design-writing', 'implementation-planning'],
    extensions: ['event-bridge', 'execution-policy', 'structured-result', 'checkpoint-context'],
    timeoutMs: 20 * 60_000,
  },
  coder: {
    role: 'coder', version: 1, systemPromptFile: 'SYSTEM.md',
    tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'], excludedTools: [],
    skills: ['test-driven-development', 'systematic-debugging', 'verification'],
    extensions: ['event-bridge', 'execution-policy', 'structured-result', 'checkpoint-context'],
    timeoutMs: 45 * 60_000,
  },
  reviewer: {
    role: 'reviewer', version: 1, systemPromptFile: 'SYSTEM.md',
    tools: ['read', 'bash', 'grep', 'find', 'ls'], excludedTools: ['edit', 'write'],
    skills: ['code-review', 'security-review', 'regression-review'],
    extensions: ['event-bridge', 'execution-policy', 'structured-result', 'checkpoint-context'],
    timeoutMs: 15 * 60_000,
  },
  tester: {
    role: 'tester', version: 1, systemPromptFile: 'SYSTEM.md',
    tools: ['read', 'bash', 'grep', 'find', 'ls', 'write', 'edit'], excludedTools: [],
    skills: ['test-design', 'failure-analysis', 'acceptance-verification'],
    extensions: ['event-bridge', 'execution-policy', 'structured-result', 'checkpoint-context'],
    timeoutMs: 30 * 60_000,
  },
};

/** --tools 的最终值：角色 built-in tools ∪ 两个内部工具（§7.5）。 */
export function roleToolsArg(role: TaskRole): string {
  return [...ROLE_PROFILES[role].tools, ...INTERNAL_TOOLS].join(',');
}

/**
 * 专用步骤 Agent（设计 §2026-07-23-step-agent）：与 ROLE_PROFILES 并列，每个工作流环节一个条目。
 * step agent 有独立的系统提示 / skills / tools / extensions，经 materializeStepAgentProfile 物化到
 * 独立快照。AI 在环节完成时调用 step 声明的工具产出结果（而非用户点按钮）。
 */
export interface StepAgentProfile {
  step: string;
  version: number;
  systemPromptFile: string;
  /** 引用的内置 skills（来自 BUILTIN_SKILLS 池）。 */
  skills: string[];
  /** 该步骤启用的工具名称（非 Pi 内置 read/bash 等）。经 --tools 显式启用，取代 --no-tools。 */
  tools: string[];
  /** 引用的内置 extensions（来自 BUILTIN_EXTENSIONS 池）。 */
  extensions: string[];
  timeoutMs: number;
}

/** 对话 workload 名（与 apps/desktop/electron/pi-ai.ts 的 ChatWorkload 对齐）。 */
export type StepWorkload = 'task_chat' | 'requirement_chat' | 'task_proposal' | 'requirement_proposal';

export const STEP_AGENTS: Record<string, StepAgentProfile> = {
  requirement_refiner: {
    step: 'requirement_refiner',
    version: 3,
    systemPromptFile: 'SYSTEM.md',
    skills: ['brainstorming'],
    tools: ['ai_devflow_propose_requirement', 'ai_devflow_ask', 'ai_devflow_consult_ux'],
    extensions: ['requirement-bridge', 'ask-bridge', 'ux-bridge'],
    timeoutMs: 10 * 60_000,
  },
  task_proposer: {
    step: 'task_proposer',
    version: 3,
    systemPromptFile: 'SYSTEM.md',
    skills: ['brainstorming'],
    // read-only 探索工具用于「探索相关项目逻辑」：研读真实代码以判断子任务拆分与实施计划是否可行。
    // 不给写工具：本环节只产出任务草稿，不落地任何代码改动。
    tools: ['read', 'grep', 'find', 'ls', 'ai_devflow_propose_task', 'ai_devflow_ask'],
    extensions: ['task-bridge', 'ask-bridge'],
    timeoutMs: 15 * 60_000,
  },
};

/** workload -> step agent（无则返回 undefined，调用方走原 chat/proposal 路径）。 */
export function stepAgentForWorkload(workload: StepWorkload): StepAgentProfile | undefined {
  switch (workload) {
    case 'requirement_chat':
      return STEP_AGENTS['requirement_refiner'];
    case 'task_proposal':
      return STEP_AGENTS['task_proposer'];
    default:
      return undefined;
  }
}

/**
 * 校验每个 step agent 声明的 extensions/skills 都在注册池。模块加载期 fail-fast。
 * tools 不校验（步骤专用工具不由 BUILTIN 池约束，由对应 bridge extension 注册）。
 */
export function validateStepAgents(
  steps: Record<string, StepAgentProfile> = STEP_AGENTS,
  extensionPool: readonly string[] = BUILTIN_EXTENSIONS,
  skillPool: readonly BuiltinSkill[] = BUILTIN_SKILLS,
): void {
  const extSet = new Set(extensionPool);
  const skillNames = new Set(skillPool.map((s) => s.name));
  for (const step of Object.keys(steps)) {
    const profile = steps[step];
    if (profile.step !== step) throw new Error(`步骤 agent 键名 ${step} 与 profile.step ${profile.step} 不一致`);
    for (const ext of profile.extensions) {
      if (!extSet.has(ext)) throw new Error(`步骤 ${step} 引用了未注册的扩展：${ext}`);
    }
    for (const skill of profile.skills) {
      if (!skillNames.has(skill)) throw new Error(`步骤 ${step} 引用了未注册的技能：${skill}`);
    }
  }
}
validateStepAgents();

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
  /** 该角色在此提供商下解析出的模型 ID（单元素：用户配置解析出的唯一模型）。 */
  models: string[];
}

/** 专家物化输入（与 MaterializeInput 同，键改 expert）。 */
export interface ExpertMaterializeInput {
  expert: ExecutionExpertKey;
  providerId: string;
  providerKind: ProviderKind;
  providerRevision: number;
  baseURL?: string;
  providerName: string;
  models: string[];
}

/** 专家 -> 物理资产目录名。dev/test 复用现有 coder/tester 资产（其 SYSTEM.md/skills 一致）。 */
export const EXPERT_ASSETS_DIR: Record<ExecutionExpertKey, string> = {
  product: 'product',
  ux: 'ux',
  dev_lead: 'dev_lead',
  dev: 'coder',
  test: 'tester',
  project_lead: 'project_lead',
};

/**
 * 把内置只读角色资源物化到内容寻址快照：`<baseDir>/profiles/<digest>/<role>/`，含 settings.json、
 * SYSTEM.md、skills/（角色私有技能 + 跨源引用的共享/他角技能副本）、共享 extensions/ 副本；兼容网关
 * 额外写 models.json。原子切换（临时目录 + rename），完成后写 `.complete` 标记；已存在则直接复用
 * （幂等）。每个角色快照自包含，互不可见。
 */
export class ProfileMaterializer {
  constructor(
    private assetsRoot: string,
    private baseDir: string,
    private readonly profiles: Record<TaskRole, RoleProfile> = ROLE_PROFILES,
    private readonly skillPool: readonly BuiltinSkill[] = BUILTIN_SKILLS,
    private readonly expertProfiles: Record<ExecutionExpertKey, ExpertProfile> = EXPERT_PROFILES,
  ) {}

  digest(input: MaterializeInput): string {
    const profile = this.profiles[input.role];
    const key = JSON.stringify({
      role: input.role,
      profileVersion: profile.version,
      providerId: input.providerId,
      providerKind: input.providerKind,
      providerName: input.providerName,
      providerRevision: input.providerRevision,
      baseURL: input.baseURL ?? null,
      models: [...new Set(input.models)].sort(),
    });
    return createHash('sha256').update(key).digest('hex').slice(0, 16);
  }

  /** 专家快照摘要键（内容寻址，同输入同目录）。 */
  digestExpert(input: ExpertMaterializeInput): string {
    const profile = this.expertProfiles[input.expert];
    const key = JSON.stringify({
      expert: input.expert,
      profileVersion: profile.version,
      providerId: input.providerId,
      providerKind: input.providerKind,
      providerName: input.providerName,
      providerRevision: input.providerRevision,
      baseURL: input.baseURL ?? null,
      models: [...new Set(input.models)].sort(),
    });
    return createHash('sha256').update(key).digest('hex').slice(0, 16);
  }

  materialize(input: MaterializeInput): { profileDir: string; digest: string } {
    const digest = this.digest(input);
    const profileDir = join(this.baseDir, 'profiles', digest, input.role);
    if (validateSnapshot(profileDir, digest)) return { profileDir, digest };
    const tmp = `${profileDir}.tmp-${randomBytes(4).toString('hex')}`;
    mkdirSync(join(this.baseDir, 'profiles', digest), { recursive: true });
    try {
      const profile = this.profiles[input.role];
      const skillByName = new Map(this.skillPool.map((s) => [s.name, s]));
      cpSync(join(this.assetsRoot, input.role), tmp, { recursive: true });
      // 跨源技能：角色声明的 skills 中 source !== role 的（共享技能或跨角色引用的他角私有技能），
      // 从其物理来源目录拷入快照 skills/<name>/。source === role 的已由上方 cpSync 带入。
      for (const skill of profile.skills) {
        const entry = skillByName.get(skill);
        if (!entry) throw new Error(`角色 ${input.role} 引用了未注册的技能：${skill}`);
        if (entry.source === input.role) continue;
        const src = join(this.assetsRoot, entry.source, 'skills', skill);
        if (!existsSync(src)) throw new Error(`技能 ${skill} 的源目录不存在：${src}`);
        cpSync(src, join(tmp, 'skills', skill), { recursive: true });
      }
      const extDir = join(tmp, 'extensions');
      mkdirSync(extDir, { recursive: true });
      for (const ext of profile.extensions) {
        const src = join(this.assetsRoot, 'shared', 'extensions', `${ext}.ts`);
        if (existsSync(src)) cpSync(src, join(extDir, `${ext}.ts`));
      }
      if (isCompatibleKind(input.providerKind)) {
        writeFileSync(
          join(tmp, 'models.json'),
          buildCompatibleModelsJson(
            input.providerName,
            input.providerKind,
            input.baseURL,
            [...new Set(input.models)].sort(),
          ),
        );
      }
      const contentDigest = snapshotContentDigest(tmp);
      writeFileSync(join(tmp, '.complete'), JSON.stringify({ digest, contentDigest }));
      publishSnapshot(tmp, profileDir, digest);
    } finally {
      if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    }
    return { profileDir, digest };
  }

  /**
   * 把内置只读专家资源物化到内容寻址快照：`<baseDir>/profiles/<digest>/<expert>/`。
   * 与 materialize 同，但按专家画像取 SYSTEM.md/skills/extensions，资产目录经 EXPERT_ASSETS_DIR 映射。
   */
  materializeExpert(input: ExpertMaterializeInput): { profileDir: string; digest: string } {
    const digest = this.digestExpert(input);
    const profileDir = join(this.baseDir, 'profiles', digest, input.expert);
    if (validateSnapshot(profileDir, digest)) return { profileDir, digest };
    const tmp = `${profileDir}.tmp-${randomBytes(4).toString('hex')}`;
    mkdirSync(join(this.baseDir, 'profiles', digest), { recursive: true });
    try {
      const profile = this.expertProfiles[input.expert];
      const assetDir = EXPERT_ASSETS_DIR[input.expert];
      const skillByName = new Map(this.skillPool.map((s) => [s.name, s]));
      cpSync(join(this.assetsRoot, assetDir), tmp, { recursive: true });
      for (const skill of profile.skills) {
        const entry = skillByName.get(skill);
        if (!entry) throw new Error(`专家 ${input.expert} 引用了未注册的技能：${skill}`);
        // 技能 source 为 TaskRole（旧资产目录）或专家目录；比较 EXPERT_ASSETS_DIR 以判断是否同目录。
        const skillAssetDir =
          (typeof entry.source === 'string' && (entry.source as string) in EXPERT_ASSETS_DIR)
            ? EXPERT_ASSETS_DIR[entry.source as ExecutionExpertKey]
            : entry.source;
        if (skillAssetDir === assetDir) continue;
        const src = join(this.assetsRoot, skillAssetDir, 'skills', skill);
        if (!existsSync(src)) throw new Error(`技能 ${skill} 的源目录不存在：${src}`);
        cpSync(src, join(tmp, 'skills', skill), { recursive: true });
      }
      const extDir = join(tmp, 'extensions');
      mkdirSync(extDir, { recursive: true });
      for (const ext of profile.extensions) {
        const src = join(this.assetsRoot, 'shared', 'extensions', `${ext}.ts`);
        if (existsSync(src)) cpSync(src, join(extDir, `${ext}.ts`));
      }
      if (isCompatibleKind(input.providerKind)) {
        writeFileSync(
          join(tmp, 'models.json'),
          buildCompatibleModelsJson(
            input.providerName,
            input.providerKind,
            input.baseURL,
            [...new Set(input.models)].sort(),
          ),
        );
      }
      const contentDigest = snapshotContentDigest(tmp);
      writeFileSync(join(tmp, '.complete'), JSON.stringify({ digest, contentDigest }));
      publishSnapshot(tmp, profileDir, digest);
    } finally {
      if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    }
    return { profileDir, digest };
  }
}

function snapshotContentDigest(root: string): string {
  const hash = createHash('sha256');
  const visit = (relative: string): void => {
    const absolute = relative ? join(root, relative) : root;
    for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!relative && entry.name === '.complete') continue;
      const child = relative ? join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) {
        hash.update(`d:${child}\0`);
        visit(child);
      } else if (entry.isFile()) {
        hash.update(`f:${child}\0`);
        hash.update(readFileSync(join(root, child)));
      } else {
        throw new Error(`角色快照包含不支持的文件类型：${child}`);
      }
    }
  };
  visit('');
  return hash.digest('hex');
}

function validateSnapshot(profileDir: string, digest: string): boolean {
  try {
    const marker = JSON.parse(readFileSync(join(profileDir, '.complete'), 'utf8')) as {
      digest?: string;
      contentDigest?: string;
    };
    return marker.digest === digest && marker.contentDigest === snapshotContentDigest(profileDir);
  } catch {
    return false;
  }
}

/** Publish a fully completed candidate; a concurrent valid winner is reused after byte validation. */
function publishSnapshot(tmp: string, profileDir: string, digest: string): void {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      renameSync(tmp, profileDir);
      return;
    } catch (error) {
      if (!existsSync(profileDir)) throw error;
      if (validateSnapshot(profileDir, digest)) return;

      const invalid = `${profileDir}.invalid-${randomBytes(4).toString('hex')}`;
      try {
        renameSync(profileDir, invalid);
        rmSync(invalid, { recursive: true, force: true });
      } catch {
        // Another publisher may have replaced/quarantined the same invalid directory; retry and validate it.
      }
    }
  }
  if (!validateSnapshot(profileDir, digest)) {
    throw new Error('角色配置快照发布冲突且获胜内容无效');
  }
}

/**
 * 校验每个角色声明的扩展都在 BUILTIN_EXTENSIONS 注册池、声明的技能都在 BUILTIN_SKILLS 注册池。
 * 模块加载时调用，使配置错误在应用启动期 fail-fast，而非运行期才暴露。
 * 技能 source 仅表示物理来源，不限制引用角色——任意角色可引用池中任意技能（含共享与他角私有技能）。
 */
export function validateRoleProfiles(
  profiles: Record<TaskRole, RoleProfile> = ROLE_PROFILES,
  extensionPool: readonly string[] = BUILTIN_EXTENSIONS,
  skillPool: readonly BuiltinSkill[] = BUILTIN_SKILLS,
): void {
  const extSet = new Set(extensionPool);
  const skillNames = new Set(skillPool.map((s) => s.name));
  for (const role of Object.keys(profiles) as TaskRole[]) {
    for (const ext of profiles[role].extensions) {
      if (!extSet.has(ext)) throw new Error(`角色 ${role} 引用了未注册的扩展：${ext}`);
    }
    for (const skill of profiles[role].skills) {
      if (!skillNames.has(skill)) throw new Error(`角色 ${role} 引用了未注册的技能：${skill}`);
    }
  }
}
validateRoleProfiles();

// ---- 专家画像注册表（设计 §4.1）----

/** 执行专家键：6 专家中除 chat 外的 5 个执行专家（chat 沿用现状，无独立画像）。 */
export type ExecutionExpertKey = Exclude<ExpertKey, 'chat'>;

/** 专家画像（结构与 RoleProfile 同，键改 expert: ExpertKey）。 */
export interface ExpertProfile {
  expert: ExpertKey;
  version: number;
  systemPromptFile: string;
  /** 专家 built-in tools（未含内部工具）。 */
  tools: string[];
  excludedTools: string[];
  /** 引用的内置 skills（来自 BUILTIN_SKILLS 注册池）。任意专家可引用池中任意技能。 */
  skills: string[];
  /** 该专家启用的扩展（名称取自 BUILTIN_EXTENSIONS 注册池）。 */
  extensions: string[];
  timeoutMs: number;
}

/**
 * 专家画像注册表（设计 §4.1）。
 * product/ux/dev_lead 为新增资产；dev/test 复用现有 coder/tester 资产目录的技能与 SYSTEM.md
 * （dev/test 的资产在 Task 5 ProfileMaterializer 专家化时迁移；此处仅声明引用以驱动执行）。
 */
export const EXPERT_PROFILES: Record<ExecutionExpertKey, ExpertProfile> = {
  product: {
    expert: 'product', version: 2, systemPromptFile: 'SYSTEM.md',
    tools: ['read', 'grep', 'find', 'ls'],
    excludedTools: ['bash', 'edit', 'write'],
    skills: ['brainstorming', 'requirements-analysis', 'design-writing', 'create-prd', 'knowledge-retrieve'],
    extensions: ['requirement-bridge', 'ask-bridge', 'event-bridge', 'structured-result'],
    timeoutMs: 15 * 60_000,
  },
  ux: {
    expert: 'ux', version: 2, systemPromptFile: 'SYSTEM.md',
    tools: ['read', 'grep', 'find', 'ls'],
    excludedTools: ['bash', 'edit', 'write'],
    skills: ['ux-spec-writing', 'web-design-engineer', 'knowledge-retrieve'],
    extensions: ['requirement-bridge', 'ask-bridge', 'structured-result'],
    timeoutMs: 10 * 60_000,
  },
  dev_lead: {
    expert: 'dev_lead', version: 2, systemPromptFile: 'SYSTEM.md',
    tools: ['read', 'grep', 'find', 'ls'],
    excludedTools: ['bash', 'edit', 'write'],
    skills: ['brainstorming', 'implementation-planning', 'subtask-generation', 'knowledge-retrieve'],
    extensions: ['task-bridge', 'ask-bridge', 'event-bridge', 'structured-result'],
    timeoutMs: 15 * 60_000,
  },
  dev: {
    expert: 'dev', version: 2, systemPromptFile: 'SYSTEM.md',
    tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'],
    excludedTools: [],
    skills: ['design-writing', 'implementation-planning', 'test-driven-development', 'systematic-debugging', 'verification', 'knowledge-retrieve'],
    extensions: ['event-bridge', 'execution-policy', 'structured-result', 'checkpoint-context', 'task-bridge'],
    timeoutMs: 45 * 60_000,
  },
  test: {
    expert: 'test', version: 2, systemPromptFile: 'SYSTEM.md',
    tools: ['read', 'bash', 'grep', 'find', 'ls', 'write', 'edit'],
    excludedTools: [],
    skills: ['code-review', 'security-review', 'regression-review', 'test-design', 'failure-analysis', 'acceptance-verification', 'knowledge-retrieve'],
    extensions: ['event-bridge', 'execution-policy', 'structured-result', 'checkpoint-context', 'task-bridge'],
    timeoutMs: 30 * 60_000,
  },
  project_lead: {
    expert: 'project_lead', version: 1, systemPromptFile: 'SYSTEM.md',
    tools: ['read', 'grep', 'find', 'ls', 'write', 'edit'],
    excludedTools: ['bash'],
    skills: ['knowledge-governance', 'knowledge-retrieve'],
    extensions: ['event-bridge', 'execution-policy', 'structured-result', 'checkpoint-context'],
    timeoutMs: 30 * 60_000,
  },
};

/** --tools 的最终值：专家 built-in tools ∪ 两个内部工具。 */
export function expertToolsArg(expert: ExecutionExpertKey): string {
  return [...EXPERT_PROFILES[expert].tools, ...INTERNAL_TOOLS].join(',');
}

/**
 * 校验每个专家声明的扩展都在 BUILTIN_EXTENSIONS 注册池、声明的技能都在 BUILTIN_SKILLS 注册池。
 * 模块加载时调用，使配置错误在应用启动期 fail-fast。
 */
export function validateExpertProfiles(
  profiles: Record<ExecutionExpertKey, ExpertProfile> = EXPERT_PROFILES,
  extensionPool: readonly string[] = BUILTIN_EXTENSIONS,
  skillPool: readonly BuiltinSkill[] = BUILTIN_SKILLS,
): void {
  const extSet = new Set(extensionPool);
  const skillNames = new Set(skillPool.map((s) => s.name));
  for (const expert of Object.keys(profiles) as ExecutionExpertKey[]) {
    for (const ext of profiles[expert].extensions) {
      if (!extSet.has(ext)) throw new Error(`专家 ${expert} 引用了未注册的扩展：${ext}`);
    }
    for (const skill of profiles[expert].skills) {
      if (!skillNames.has(skill)) throw new Error(`专家 ${expert} 引用了未注册的技能：${skill}`);
    }
  }
}
validateExpertProfiles();
