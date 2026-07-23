# 共享技能支持设计

日期:2026-07-23
状态:已批准(待实现)

## 1. 背景与动机

ai-devflow 四角色 `planner / coder / reviewer / tester` 各有独立 `RoleProfile`,技能通过 `ROLE_PROFILES[<role>].skills: string[]` 声明、`assets/profiles/<role>/skills/<name>/SKILL.md` 提供文件。`ProfileMaterializer.materialize` 用 `cpSync(<role>/, tmp, recursive)` 把角色目录整体拷进内容寻址快照,`buildPiRunPlan` 再用 `--no-skills` 关闭自动发现、对每个声明的技能用 `--skill <profileDir>/skills/<name>/SKILL.md` 显式加载。

现状下各角色快照自包含、互不可见。若想让多个角色共用同一技能(如 `git-workflow`、`commit-convention` 这类跨角色通用技能),只能在每个角色目录各放一份副本,导致重复维护、内容漂移风险。

代码库已有一套成熟的**共享扩展**机制作为参照:`assets/profiles/shared/extensions/<ext>.ts` + 角色用 `extensions: []` 声明启用子集 + `materialize` 从 shared 源拷进角色快照。本设计照此模式为技能建立对称的共享能力。

## 2. 目标与非目标

### 目标

- 支持在 `assets/profiles/shared/skills/<name>/SKILL.md` 放置共享技能,任意角色可声明引用。
- 支持单个注册技能被多个角色引用(含跨角色引用其他角色的私有技能)。
- 启动期 fail-fast 校验:角色引用的技能必须在注册池中存在。
- 与现有共享扩展机制对称,学习成本最低。

### 非目标

- 不引入运行时安装/卸载技能的命令;技能仍是源码内置。
- 不向用户暴露技能配置(用户可见契约不变,见架构 §7.1)。
- 不迁移现有 12 个私有技能为共享(四角色无重复技能,强行迁移反显刻意)。
- 不改变 `--skill` argv 形态与 `run-plan.ts` 路径逻辑。

## 3. 设计

### 3.1 数据模型(`packages/agents/src/profiles.ts`)

新增技能注册池,每条记录技能名与物理来源。`source` 仅表示技能文件所在目录,**不限制哪些角色可引用**。

```ts
export type SkillSource = TaskRole | 'shared';

export interface BuiltinSkill {
  name: string;
  source: SkillSource;
}

/**
 * 内置技能注册池:记录每个技能的物理位置。
 * source=<角色名>:文件在 assets/profiles/<source>/skills/<name>/
 * source='shared':文件在 assets/profiles/shared/skills/<name>/
 * 任意角色均可引用池中任意技能,source 仅用于物化时定位源文件。
 */
export const BUILTIN_SKILLS = [
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
] as const satisfies readonly BuiltinSkill[];
```

`RoleProfile.skills` 字段类型保持 `string[]` 不变,语义从"角色私有技能名"变为"引用的池中技能名"。四角色现有 `skills` 数组内容原样保留(12 个名字均已在池中登记)。

### 3.2 物化流程(`ProfileMaterializer.materialize`)

现有 `cpSync(join(assetsRoot, role), tmp, { recursive: true })` 已把角色目录(含其私有技能)整体拷入 `<tmp>/skills/<name>/`,保持不变。新增:遍历 `profile.skills`,经池解析 source,对 `source !== role` 的技能(共享技能或跨角色引用的其他角色私有技能),从 `assetsRoot/<source>/skills/<name>/` 拷到 `<tmp>/skills/<name>/`。

```ts
const skillByName = new Map(BUILTIN_SKILLS.map((s) => [s.name, s]));
// ...在 materialize 内,cpSync(role 目录)之后:
for (const skill of profile.skills) {
  const entry = skillByName.get(skill);
  if (!entry) throw new Error(`角色 ${input.role} 引用了未注册的技能:${skill}`);
  if (entry.source === input.role) continue;  // cpSync 已带入
  const src = join(this.assetsRoot, entry.source, 'skills', skill);
  if (!existsSync(src)) {
    throw new Error(`技能 ${skill} 的源目录不存在:${src}`);
  }
  cpSync(src, join(tmp, 'skills', skill), { recursive: true });
}
```

- 与 extensions 从 `shared/extensions/` 拷贝的模式对称。
- `snapshotContentDigest` 已递归扫描整个 tmp,共享/借用技能自动纳入内容指纹;`digest()` 的 key 不含技能清单(编译期常量),无需改。
- 改 `ROLE_PROFILES` 后 `validateSnapshot` 因内容指纹变化自动重生物化。

### 3.3 启动期校验(`validateRoleProfiles`)

扩展为同时校验 extensions 与 skills,模块加载时 fail-fast。技能校验**只校验名字在池中存在**,不校验 source 与引用角色的匹配(允许跨角色引用):

```ts
export function validateRoleProfiles(
  profiles: Record<TaskRole, RoleProfile> = ROLE_PROFILES,
  extensionPool: readonly string[] = BUILTIN_EXTENSIONS,
  skillPool: readonly BuiltinSkill[] = BUILTIN_SKILLS,
): void {
  const extSet = new Set(extensionPool);
  const skillByName = new Map(skillPool.map((s) => [s.name, s]));
  for (const role of Object.keys(profiles) as TaskRole[]) {
    for (const ext of profiles[role].extensions) {
      if (!extSet.has(ext)) throw new Error(`角色 ${role} 引用了未注册的扩展:${ext}`);
    }
    for (const skill of profiles[role].skills) {
      if (!skillByName.has(skill)) {
        throw new Error(`角色 ${role} 引用了未注册的技能:${skill}`);
      }
    }
  }
}
```

### 3.4 目录结构

新增 `assets/profiles/shared/skills/`(与 `shared/extensions/` 并列),放 `.gitkeep` 占位,供后续放置共享技能:

```
assets/profiles/
  shared/
    extensions/   # 既有
    skills/       # 新增
      .gitkeep
  planner/skills/...
  coder/skills/...
  reviewer/skills/...
  tester/skills/...
```

## 4. 影响面

| 文件 | 改动 |
|---|---|
| `packages/agents/src/profiles.ts` | 新增 `SkillSource`/`BuiltinSkill`/`BUILTIN_SKILLS`;`materialize` 增跨源技能拷贝;`validateRoleProfiles` 增 skill 存在性校验 |
| `packages/agents/src/__tests__/profiles.test.ts` | 增共享技能物化测试、跨角色引用物化测试、validate 拒绝未注册技能测试、validate 接受跨角色引用测试 |
| `packages/agents/assets/profiles/shared/skills/.gitkeep` | 新建占位 |
| `docs/architecture.md` §6.1/§7.5 | 说明 shared/skills 来源与池校验 |
| `CHANGELOG.md` | 记一条 |

### 不变项

- `run-plan.ts`、`pi-runner.ts`、`process-supervisor.ts`。
- `RoleProfile.skills` 字段类型(`string[]`)。
- 四角色现有技能清单(12 个名字原样保留,均已在池中登记)。
- `digest()` 的 key 算法。
- `scripts/inspect-roles.mjs` 核心逻辑(仍读 `profile.skills` 字符串数组)。
- 用户可见契约(§7.1:技能不向用户暴露)。

## 5. 测试策略

### 新增测试

1. **共享技能物化**:构造临时 assetsRoot,放 `shared/skills/<x>/SKILL.md` + 角色 dir,角色 profile 引用 `<x>`,物化后断言 `<profileDir>/skills/<x>/SKILL.md` 存在、内容指纹含该文件。
2. **跨角色引用物化**:构造临时 assetsRoot,角色 A 的 `skills/` 放 `<y>`,角色 B 引用 `<y>`,物化 B 后断言 `<profileDir_B>/skills/<y>/SKILL.md` 存在。
3. **validate 拒绝未注册技能**:断言引用池外技能名时抛错。
4. **validate 接受跨角色引用**:断言角色引用其他角色的非共享技能时不抛错(回归保护)。
5. **validate 接受 shared 引用**:断言角色引用 source='shared' 技能时不抛错。

### 既有测试保持通过

- 12 个私有技能物化测试(池已登记全部 12 个,校验通过)。
- extensions 物化与校验测试(逻辑未变)。
- digest/idempotency/内容校验测试(digest key 不变)。

## 6. 验证命令

```bash
pnpm --filter @ai-devflow/agents test    # 单元测试
node scripts/inspect-roles.mjs           # 打印各角色生效 skills(确认无回归)
pnpm verify                              # typecheck + lint + test + scripts
```
