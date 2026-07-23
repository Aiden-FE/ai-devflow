# 需求对话 brainstorming 独立技能设计

日期:2026-07-23
状态:已批准(待实现)

## 1. 背景与动机

ai-devflow 的"AI 完善需求"(`req.ai.create`)走 `apps/desktop/electron/pi-ai.ts` 的对话/结构化生成路径,与四角色(planner/coder/reviewer/tester)的 `PiRunner` 执行路径完全隔离:它用 `materializeChatProfile` 生成临时 profile(仅 settings.json + SYSTEM.md),Pi 启动参数为 `--no-tools --no-skills --no-extensions --no-themes` 全关。

用户希望在创建需求时,由 AI 以类似 brainstorming 的方式与用户梳理需求(一次一问、先澄清边界/用户/异常路径/完成定义,不急于生成)。由于对话路径不加载技能,需为其接通技能加载机制。

用户已表达后续架构意图:现有四角色 agent 机制不满意,计划重构为"工作流各环节的专用 agent"。因此本设计把 brainstorming 做成**独立技能**,不与四角色 `BUILTIN_SKILLS`/`ProfileMaterializer` 体系耦合,为未来重构预留迁移空间。

## 2. 目标与非目标

### 目标

- 新建独立 `brainstorming` 技能文件,承载需求梳理的交互范式。
- 为对话路径接通技能加载机制(显式加载,关闭自动发现)。
- 仅 `requirement_chat` workload 加载 brainstorming;其余三个 workload 行为不变。

### 非目标

- 不修改 `CHAT_SYSTEM_REQ` 提示词(技能补充行为,不替代系统提示)。
- 不动四角色 `BUILTIN_SKILLS`/`ProfileMaterializer`/`PiRunner`。
- 不重构为工作流专用 agent(后续架构工作,本次仅预留)。
- 不给 `requirement_proposal`/`task_chat`/`task_proposal` 加载技能。

## 3. 设计

### 3.1 技能资源

新建 `apps/desktop/electron/assets/chat/skills/brainstorming/SKILL.md`:

```markdown
---
name: brainstorming
description: 需求梳理时一次只问一个问题,先澄清边界/用户/异常路径/完成定义,不急于生成需求草稿。
---

# 需求梳理

- 一次只问一个问题,聚焦当前最关键的未知。
- 澄清维度优先级:目标用户 -> 使用边界 -> 异常路径 -> 完成定义(验收标准)。
- 不主动生成结构化需求;需求足够清晰时,提示用户点「生成需求草稿」。
- 拒绝过早收敛:用户给出模糊表述时,先反问而非假设。
```

放在 `apps/desktop/electron/assets/chat/skills/`(electron 侧新建),与四角色 `packages/agents/assets/profiles/<role>/skills/` 物理隔离,体现独立归属。

### 3.2 接通加载机制(`apps/desktop/electron/pi-ai.ts`)

**技能清单(集中一处,便于未来扩展):**

```ts
/** 对话 workload -> 加载的技能名列表(从 assets/chat/skills/<name>/ 读取)。 */
function chatSkillsFor(workload: ChatWorkload): string[] {
  return workload === 'requirement_chat' ? ['brainstorming'] : [];
}
```

**`materializeChatProfile` 增 skills 参数:**

```ts
function materializeChatProfile(sessionDir: string, systemPrompt: string, skills: string[] = []): string {
  const profileDir = join(sessionDir, 'pi-config');
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, 'settings.json'), CHAT_SETTINGS_JSON);
  writeFileSync(join(profileDir, 'SYSTEM.md'), systemPrompt);
  for (const name of skills) {
    cpSync(join(CHAT_ASSETS_ROOT, 'skills', name), join(profileDir, 'skills', name), { recursive: true });
  }
  return profileDir;
}
```

`CHAT_ASSETS_ROOT` 指向 `apps/desktop/electron/assets/chat`(相对 `pi-ai.ts` 所在目录解析,兼容源码与打包)。

**`buildChatPlan` 按 workload 加载技能:**

当前 `buildChatPlan` 硬编码 `--no-skills` 且 `_workload` 参数未用。改为:保留 `--no-skills`(关闭自动发现),对 `chatSkillsFor(workload)` 返回的技能逐个 `--skill <profileDir>/skills/<name>/SKILL.md` 显式加载。`_workload` 参数名改为 `workload`。

**`executeTextOnRoute` 传 workload:**

`executeTextOnRoute` 已接收 `workload: ChatWorkload` 参数(目前传给 `materializeChatProfile`/`buildChatPlan` 时未用其加载技能)。改为:

```ts
const skills = chatSkillsFor(workload);
const profileDir = materializeChatProfile(sessionDir, systemPrompt, skills);
const plan = buildChatPlan(entry, route, sessionDir, profileDir, workload, messagesText, deps.projectToolPath);
```

`buildChatPlan` 内部也调 `chatSkillsFor(workload)`(或接收 skills 参数),生成对应 `--skill` argv。

### 3.3 不变项

- `CHAT_SYSTEM_REQ`/`CHAT_SYSTEM_TASK`/`PROPOSE_*` 提示词内容不变。
- `CHAT_SETTINGS_JSON`(retry 配置)不变。
- env 白名单、隔离 HOME/tmp、凭证注入逻辑不变。
- 四角色 `BUILTIN_SKILLS`/`ProfileMaterializer`/`PiRunner`/`run-plan.ts` 不变。
- `requirement_proposal`/`task_chat`/`task_proposal` 的 Pi 启动参数与产物不变(无 `--skill`)。

### 3.4 资源路径解析与打包兼容

`CHAT_ASSETS_ROOT` 用 `import.meta.url` 解析(与现有 electron 模块一致),指向 `pi-ai.ts` 同级的 `assets/chat`。打包(electron-builder)需确认该目录被包含进产物--本次实现后验证打包配置是否需调整(若 `assets/` 已被 glob 纳入则无需改动)。

## 4. 影响面

| 文件 | 改动 |
|---|---|
| `apps/desktop/electron/assets/chat/skills/brainstorming/SKILL.md` | 新建 |
| `apps/desktop/electron/pi-ai.ts` | 新增 `chatSkillsFor`、`CHAT_ASSETS_ROOT`;`materializeChatProfile`/`buildChatPlan`/`executeTextOnRoute` 接通技能加载 |
| `apps/desktop/electron/__tests__/ai.test.ts` 或新增测试 | 物化断言 + argv 断言 |
| `CHANGELOG.md` | 记一条 |

## 5. 测试策略

### 新增测试

1. **技能物化**:`requirement_chat` 物化后 `<profileDir>/skills/brainstorming/SKILL.md` 存在;`task_chat` 不存在。
2. **argv 断言**:`requirement_chat` 的 plan.args 含 `--skill .../brainstorming/SKILL.md`;`task_chat` 不含 `--skill`。
3. **`chatSkillsFor` 单测**:四 workload 返回值符合预期。

### 既有测试保持通过

- `ai.test.ts`、`ipc.test.ts` 现有行为测试(输出契约不变,技能加载不改变返回结构)。

## 6. 验证命令

```bash
pnpm --filter @ai-devflow/desktop test
pnpm verify
```
