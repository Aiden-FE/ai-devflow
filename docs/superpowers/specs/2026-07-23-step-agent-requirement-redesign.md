# 专用步骤 Agent 范式与需求环节重构设计

日期:2026-07-23
状态:已批准（无人值守实施）

## 1. 背景与目标

ai-devflow 当前有两套 AI 执行路径:

- **PiRunner 路径**(`packages/agents/src/pi-runner.ts` + `run-plan.ts`):四角色 `planner/coder/reviewer/tester`,每个角色有独立 `RoleProfile`(system prompt + skills + tools + extensions),通过 `ProfileMaterializer` 物化到内容寻址快照。AI 在完成时调用 `ai_devflow_report_result` 工具产出结构化结果。**这条路径已符合"每个环节独立干净配置 + AI 调工具产出"原则。**
- **pi-ai 对话路径**(`apps/desktop/electron/pi-ai.ts`):`requirement_chat`/`task_chat`/`requirement_proposal`/`task_proposal` 四个 workload 共享一个 throwaway profile(`--no-tools`),"产出草稿"靠**用户点按钮**触发独立 `propose*` 调用。**这条路径违反原则**:无独立配置、产出动作不可控。

用户目标:重新设计,使自动化工作流每个 AI 独立环节都有自己独立干净的配置状态;需求生成环节用 brainstorming 逐步与用户梳理需求,并由 AI 调用工具生成需求稿,而非用户在对话中随时点按钮。

本次范围(用户批准):**仅需求生成环节**。建立"专用步骤 Agent"范式(`STEP_AGENTS` 注册表 + step 驱动物化 + AI 调用工具产出),为后续 task/development/review 等环节迁移预留。四角色 `ROLE_PROFILES` 暂不动。

## 2. 关键设计决策(用户已批准)

1. **工具产物**:AI 调工具生成草稿 -> 填入表单 -> 用户点"创建"才持久化。AI 控制"何时生成",用户控制"是否入库"。移除"生成需求草稿"按钮,保留"创建"按钮。
2. **配置存放**:新建 `STEP_AGENTS` 注册表(与 `ROLE_PROFILES` 并列),每个工作流环节一个条目。不混入 `ROLE_PROFILES`。
3. **范围**:仅 `requirement_chat` workload 改造为 `requirement_refiner` 步骤 agent。其余三个 workload 行为不变。

## 3. 架构

### 3.1 `STEP_AGENTS` 注册表(`packages/agents/src/profiles.ts`)

```ts
export interface StepAgentProfile {
  step: string;               // 'requirement_refiner'
  version: number;
  systemPromptFile: string;   // 'SYSTEM.md' 相对 step 目录
  skills: string[];           // 引用 BUILTIN_SKILLS 池
  tools: string[];            // 该步骤启用的工具(非 Pi 内置 read/bash 等)
  extensions: string[];       // 引用 BUILTIN_EXTENSIONS 池
  timeoutMs: number;
}

export const STEP_AGENTS: Record<string, StepAgentProfile> = {
  requirement_refiner: {
    step: 'requirement_refiner', version: 1, systemPromptFile: 'SYSTEM.md',
    skills: ['brainstorming'],
    tools: ['ai_devflow_propose_requirement'],
    extensions: ['requirement-bridge'],
    timeoutMs: 10 * 60_000,
  },
};

/** workload -> step agent(无则 undefined,走原 chat/proposal 路径)。 */
export function stepAgentForWorkload(workload: ChatWorkload): StepAgentProfile | undefined;

export function validateStepAgents(
  steps: Record<string, StepAgentProfile> = STEP_AGENTS,
  extensionPool: readonly string[] = BUILTIN_EXTENSIONS,
  skillPool: readonly BuiltinSkill[] = BUILTIN_SKILLS,
): void; // 校验 skills/extensions 存在,模块加载期 fail-fast
```

- `BUILTIN_SKILLS` 增 `brainstorming`(source: `'shared'`)。
- `BUILTIN_EXTENSIONS` 增 `'requirement-bridge'`。

### 3.2 资源文件(统一在 `packages/agents/assets/profiles/`)

| 文件 | 说明 |
|---|---|
| `shared/skills/brainstorming/SKILL.md` | 从 `apps/desktop/electron/assets/chat/skills/brainstorming/SKILL.md` 迁移,内容不变 |
| `shared/extensions/requirement-bridge.ts` | 新建,`pi.registerTool('ai_devflow_propose_requirement', ...)`,参数 schema `{title, description, acceptance, priority}`,execute 返回该 payload |
| `steps/requirement_refiner/SYSTEM.md` | 新建,需求分析助手系统提示,**指示 AI 需求足够清晰时调用 `ai_devflow_propose_requirement` 工具生成草稿** |

`requirement-bridge.ts` 仿 `event-bridge.ts` 结构:

```ts
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'ai_devflow_propose_requirement',
    label: 'Propose requirement draft',
    description: '当需求已足够清晰时,调用此工具生成结构化需求草稿(标题/描述/验收标准/优先级)。',
    parameters: Type.Object({
      title: Type.String(),
      description: Type.String(),
      acceptance: Type.String(),
      priority: Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')]),
    }),
    async execute(_id, input) {
      return { content: [{ type: 'text', text: JSON.stringify({ aiDevflowRequirementProposal: input }) }], details: input };
    },
  });
}
```

### 3.3 对话路径改造(`apps/desktop/electron/pi-ai.ts`)

**`ProductionExecutorDeps` 增 `assetsRoot: string`**:`services.ts` 注入 `assetsRootFor()`(复用 pi-runtime 的解析,dev 指向 `packages/agents/assets/profiles`,packaged 指向 `resources/pi-runtime/profiles`)。删除 `CHAT_ASSETS_ROOT` 常量与 electron 侧 `assets/chat/` 目录。

**`materializeChatProfile` 重构为 step 驱动** → `materializeStepAgentProfile(sessionDir, step, assetsRoot)`:
- 写 `settings.json`(沿用 `CHAT_SETTINGS_JSON`)
- 从 `<assetsRoot>/steps/<step>/SYSTEM.md` 拷 system prompt
- 从 `<assetsRoot>/shared/skills/<name>/` 拷声明的 skills
- 从 `<assetsRoot>/shared/extensions/<name>.ts` 拷声明的 extensions

**`buildChatPlan` 按 step agent 驱动**:
- `--no-extensions` + 显式 `--extension <profileDir>/extensions/<name>.ts`
- `--no-skills` + 显式 `--skill <profileDir>/skills/<name>/SKILL.md`
- **`--tools <step.tools.join(',')>`**(取代 `--no-tools`):仅启用步骤声明的工具,不启用 Pi 默认 read/bash/edit
- 无 step agent 的 workload(如 task_chat)保持原 `--no-tools` 路径

**`executeTextOnRoute` 解析工具调用事件**:
- 在 JSON 事件循环新增分支:捕获 `tool_call`/`tool_result` 事件
- 对 `ai_devflow_propose_requirement` 的 tool result,提取 payload,经新回调 `onToolResult(toolName, payload)` 上报
- 文本流(`message_update`/`agent_end`)解析不变

**`PiTextExecutor` 签名增 `onToolResult`**:
```ts
export type PiTextExecutor = (
  workload, messages, onDelta?, options?,
  onToolResult?: (toolName: string, payload: unknown) => void,
) => Promise<string>;
```
`piAi.chat` 同步增 `onToolResult`,仅在 `requirement_chat` 下传递(其他 workload 无工具)。

### 3.4 事件流与 UI

**IPC `ai:chat`**(`apps/desktop/electron/ipc.ts`):
- `piAi.chat(messages, onDelta, { mode, context, onToolResult })`
- `onToolResult('ai_devflow_propose_requirement', payload)` → `sendAi({ type: 'requirement_proposal', sessionId, draft: payload })`

**Renderer**(`apps/desktop/src/pages/Workspace.tsx` `AiRefineRequirement`):
- **移除「生成需求草稿」按钮**及 `propose()` 函数
- 监听 `requirement_proposal` 事件 → 调 `onApplied(draft)` 填入父表单(与原 `propose` 回调同路径)
- 父表单「创建」按钮保留(用户确认入库)
- `api.ai.proposeRequirement` IPC 保留(对称、未来 task 侧迁移用),但需求 UI 不再调用

### 3.5 打包兼容

- `assetsRootFor()` 已处理 dev/packaged 两种根(dev: workspace 源码;packaged: `resources/pi-runtime/profiles`)。
- 打包配置 `extraResources: build/pi-runtime -> pi-runtime` 已包含 agents assets(需确认 staging 流程把 `packages/agents/assets/profiles` 拷入 `build/pi-runtime/profiles`,本次不改打包配置,验证确认)。
- `build-electron.mjs` 中为 electron 侧 `assets/chat/` 加的 cpSync 可删除(资源迁回 agents 包);但若其他 electron 资源仍需,保留无害。本次删除 `electron/assets/chat/` 目录与对应 cpSync。

## 4. 不变项

- `ROLE_PROFILES`/`ProfileMaterializer`/`PiRunner`/`run-plan.ts`/orchestrator 四角色执行路径完全不动。
- `task_chat`/`task_proposal`/`requirement_proposal` 三个 workload 行为不变(无 step agent,保持 `--no-tools`)。
- `CHAT_SYSTEM_TASK`/`PROPOSE_*` 提示词不变。
- provider 测试、retry、隔离机制不变。
- `requirement_proposal` workload(IPC `proposeRequirement`)保留,仅 UI 不再调用。

## 5. 测试策略

### 新增测试

1. **`packages/agents/src/__tests__/profiles.test.ts`**:
   - `STEP_AGENTS['requirement_refiner']` 注册存在
   - `validateStepAgents` 拒绝未注册 skill/extension
   - `stepAgentForWorkload('requirement_chat')` 返回 requirement_refiner;其他 workload 返回 undefined
   - `materializeStepAgentProfile` 物化后 `skills/brainstorming/SKILL.md` + `extensions/requirement-bridge.ts` + `SYSTEM.md` 存在

2. **`apps/desktop/electron/__tests__/ai.test.ts`**:
   - `buildChatPlan` requirement_chat:argv 含 `--tools ai_devflow_propose_requirement`、`--extension .../requirement-bridge.ts`、`--skill .../brainstorming/SKILL.md`
   - `buildChatPlan` task_chat:argv 含 `--no-tools`,不含 `--skill`/`--extension`
   - `executeTextOnRoute` 给定含 `tool_result` 事件的 stdout,触发 `onToolResult('ai_devflow_propose_requirement', payload)`

### 既有测试保持通过

- `ai.test.ts` 现有 18 个测试(输出契约不变,工具加载不改变非 requirement_chat 行为)
- `ipc.test.ts`、`profiles.test.ts` 现有测试
- `pnpm verify` 全绿

## 6. 为后续环节迁移预留

`STEP_AGENTS` + `materializeStepAgentProfile` + `buildChatPlan` step 分支 + `onToolResult` 回调链 建立了专用步骤 agent 范式。后续 task_refiner / dev_executor / reviewer 等环节逐步迁入:
- 新增 `STEP_AGENTS[step]` 条目 + 资源文件 + 对应 bridge extension
- workload 映射到 step
- UI 移除对应按钮,监听工具事件

最终四角色 `ROLE_PROFILES` 可退役,与用户"工作流各环节专用 agent"架构意图对齐。
