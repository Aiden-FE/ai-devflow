# Agent 角色重构实施计划：泳道驱动的阶段化专家

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移除任务可配置角色，改为按泳道/阶段派发专家（产品/UX/研发负责人/研发/测试/通用对话），融合 prodflow 独立闭环+小任务合并的拆分原则。

**Architecture:** 核心 `core` 包定义新 `ExpertKey` 与泳道->专家映射（纯函数）；`agents` 包把 `ROLE_PROFILES`+`STEP_AGENTS` 合并为 `EXPERT_PROFILES` 并迁移资产目录；`scheduler` 按泳道派发；主进程迁移 override 键、ipc 移除 role 输入、DB 加类型标签列；UI 改 6 专家键分配区并移除角色选择器。状态机与门禁不变，仅 `reviewPassed` 由测试专家置位。

**Tech Stack:** TypeScript（pnpm monorepo），Electron，node:sqlite，bundled Pi runtime（`@earendil-works/pi-coding-agent`）。

## Global Constraints

（逐字引自 spec `docs/superpowers/specs/2026-07-27-agent-role-restructure-design.md`）
- 内部 AgentKey 用稳定英文标识符，UI 显示中文标签：`product`=产品专家、`ux`=UX专家、`dev_lead`=研发负责人、`dev`=研发专家、`test`=测试专家、`chat`=通用对话。
- 状态机不变：`ready -> in_progress -> testing -> in_review -> archived` + `awaiting_input`，法定迁移表不动。
- `testing -> in_review` 仍要求 `reviewPassed === true`；现由测试专家在完成代码审查+功能验证（含新增用例验证）后置位。
- 测试专家工具含 `write/edit`，可新增/修改测试文件与夹具；业务实现代码修复退回研发专家（in_progress）。
- 已存任务的 `role`/`stages[]` 字段：编排器忽略，按泳道派发；字段保留不删。
- 新建三个技能资产：`create-prd`（产品专家）、`ux-spec-writing`（UX专家）、`subtask-generation`（研发负责人）。
- 每个任务结束需独立可测试交付 + 频繁提交（`feat`/`fix`/`test`/`refactor`/`docs` 前缀）。
- 仓库测试命令：`pnpm -w test`（全量）；单包 `pnpm --filter @ai-devflow/core test`。

---

## File Structure

**Create:**
- `packages/core/src/expert-routing.ts` — 专家派发契约：`ExpertKey`、`laneToExpert()`、`workloadToExpert()`、泳道->AgentKey 映射。
- `packages/core/src/__tests__/expert-routing.test.ts` — 派发纯函数单测。
- `packages/agents/assets/profiles/{product,ux,dev_lead}/SYSTEM.md` + `settings.json` + `skills/{create-prd,ux-spec-writing,subtask-generation}/SKILL.md`
- `packages/agents/assets/profiles/shared/extensions/ux-bridge.ts` — UX 子咨询桥接扩展。
- `packages/agents/src/__tests__/expert-profiles.test.ts` — 画像注册表校验单测。
- `packages/persistence/src/migrations/agent-role-migration-v11.ts` — v11 迁移（类型标签列）。
- `apps/desktop/electron/ux-consult.ts` — UX 子咨询桥接处理（产品专家->UX专家 step-agent run）。

**Modify:**
- `packages/core/src/provider.ts` — `AgentKey` 改 6 专家键；`Workload`/`workloadAgentKey` 路由到专家。
- `packages/core/src/types.ts` — `TaskRole` 标记废弃（保留兼容）；新增 `TaskTypeLabel`；`AiTaskProposal.role` 改可选 + 加 `typeLabel?`。
- `packages/agents/src/profiles.ts` — `ROLE_PROFILES`+`STEP_AGENTS` -> `EXPERT_PROFILES`；`BUILTIN_SKILLS` 加三个新技能；`validateExpertProfiles()`。
- `packages/agents/src/runner-types.ts` — `AgentRunRequest.role` -> `expert: ExpertKey`。
- `packages/agents/src/pi-runner.ts` — 用 `EXPERT_PROFILES[expert]` 取代 `ROLE_PROFILES[role]`。
- `packages/agents/src/run-plan.ts` — `role` -> `expert` 参数。
- `packages/scheduler/src/orchestrator.ts` — `runPipeline`/`runReview` 按泳道派发专家；废弃 stages 多角色。
- `packages/persistence/src/migrations.ts` — 接入 v11。
- `packages/persistence/src/repositories.ts` — `mapTask` 读 `type_label`。
- `apps/desktop/electron/provider-store.ts` — override 键迁移函数 `migrateAgentOverridesToExperts()`。
- `apps/desktop/electron/ipc.ts` — `tasks:create`/`createBatch`/`update` 移除 role 输入；加 typeLabel。
- `apps/desktop/electron/pi-ai.ts` — `buildChatPlan` 路由新专家；UX 子咨询路径。
- `apps/desktop/src/pages/Settings.tsx` — Agent 模型分配区改 6 专家键。
- `apps/desktop/src/pages/TaskDetail.tsx`（或任务创建组件）— 移除 role 选择器。

---

## Task 1: 核心契约 - 专家 AgentKey 与 workload 路由

**Files:**
- Modify: `packages/core/src/provider.ts`
- Modify: `packages/core/src/__tests__/provider.test.ts`（若不存在则 Create）
- Test: `pnpm --filter @ai-devflow/core test`

**Interfaces:**
- Produces: 新 `AgentKey` 联合类型；新 `Workload`（含 `ux_consultation`/`dev_execution`/`testing`）；重写 `workloadAgentKey(workload): AgentKey`。

- [ ] **Step 1: 写失败测试**

在 `packages/core/src/__tests__/provider.test.ts` 追加（文件不存在则新建并 `import { test } from 'node:test'`）：
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workloadAgentKey, type AgentKey, type Workload } from '../provider.js';

test('workloadAgentKey 路由到 6 专家键', () => {
  const cases: Array<[Workload, AgentKey]> = [
    ['requirement_chat', 'product'],
    ['requirement_proposal', 'product'],
    ['ux_consultation', 'ux'],
    ['task_proposal', 'dev_lead'],
    ['dev_execution', 'dev'],
    ['testing', 'test'],
    ['task_chat', 'chat'],
  ];
  for (const [wl, expected] of cases) {
    assert.equal(workloadAgentKey(wl), expected, `${wl} -> ${expected}`);
  }
});

test('AgentKey 仅含 6 个专家键', () => {
  const keys: AgentKey[] = ['product', 'ux', 'dev_lead', 'dev', 'test', 'chat'];
  assert.equal(keys.length, 6);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ai-devflow/core test`
Expected: FAIL（旧 `AgentKey` 无新键，`workloadAgentKey` 无 `ux_consultation` 等分支）

- [ ] **Step 3: 修改 `packages/core/src/provider.ts`**

把 `AgentKey` 与 `Workload` 替换为：
```ts
/** 专家键（内部稳定英文标识符；UI 显示中文标签）。 */
export type AgentKey =
  | 'product'   // 产品专家
  | 'ux'        // UX专家
  | 'dev_lead'  // 研发负责人
  | 'dev'       // 研发专家
  | 'test'      // 测试专家
  | 'chat';     // 通用对话

/** ProviderRouter 的 workload 维度（专家化重构）。 */
export type Workload =
  | 'requirement_chat'
  | 'requirement_proposal'
  | 'ux_consultation'
  | 'task_proposal'
  | 'dev_execution'
  | 'testing'
  | 'task_chat';

/** workload -> 专家 AgentKey（用于覆盖路由解析）。 */
export function workloadAgentKey(workload: Workload): AgentKey {
  switch (workload) {
    case 'requirement_chat':
    case 'requirement_proposal':
      return 'product';
    case 'ux_consultation':
      return 'ux';
    case 'task_proposal':
      return 'dev_lead';
    case 'dev_execution':
      return 'dev';
    case 'testing':
      return 'test';
    case 'task_chat':
      return 'chat';
  }
}
```
同时删除旧 `ModelRoleKey` 与 `workloadModels` 中对四角色的引用（`ProviderConfig.workloadModels` 改为 `Partial<Record<AgentKey, string>>`）。更新 `normalizeWorkloadModels` 入参类型为 `Partial<Record<AgentKey, string>>`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @ai-devflow/core test`
Expected: PASS

- [ ] **Step 5: 提交**
```bash
git add packages/core/src/provider.ts packages/core/src/__tests__/provider.test.ts
git commit -m "feat(core): AgentKey 重构为 6 专家键 + workload 路由"
```

---

## Task 2: 核心契约 - 专家派发映射（泳道->专家）

**Files:**
- Create: `packages/core/src/expert-routing.ts`
- Create: `packages/core/src/__tests__/expert-routing.test.ts`
- Modify: `packages/core/src/types.ts`（加 `TaskTypeLabel`、`AiTaskProposal` 调整）
- Test: `pnpm --filter @ai-devflow/core test`

**Interfaces:**
- Consumes: `TaskStatus`（types.ts）、`AgentKey`（provider.ts）。
- Produces: `ExpertKey`（= AgentKey 别名，语义化）、`laneToExpert(status): ExpertKey | undefined`、`workloadToExpert`（转调 workloadAgentKey）。

- [ ] **Step 1: 写失败测试**

Create `packages/core/src/__tests__/expert-routing.test.ts`：
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { laneToExpert, type ExpertKey } from '../expert-routing.js';

test('泳道映射到执行专家', () => {
  assert.equal(laneToExpert('in_progress'), 'dev');
  assert.equal(laneToExpert('testing'), 'test');
});

test('非执行泳道返回 undefined（无 agent）', () => {
  assert.equal(laneToExpert('ready'), undefined);
  assert.equal(laneToExpert('in_review'), undefined);
  assert.equal(laneToExpert('archived'), undefined);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @ai-devflow/core test`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 修改 `packages/core/src/types.ts`**

在文件末尾追加类型标签与 proposal 调整：
```ts
/** 任务类型标签（仅展示与拆分自检，不影响执行者派发）。 */
export type TaskTypeLabel = 'frontend' | 'backend' | 'fullstack' | 'integration';
```
把 `AiTaskProposal` 改为（`role` 变可选、加 `typeLabel?`）：
```ts
export interface AiTaskProposal {
  draftId: string;
  title: string;
  description: string;
  /** @deprecated 按泳道派发，不再使用；保留兼容旧草稿。 */
  role?: TaskRole;
  /** 任务类型标签（前端/后端/全栈/联调），仅展示。 */
  typeLabel?: TaskTypeLabel;
  dependsOn?: string[];
}
```

- [ ] **Step 4: 创建 `packages/core/src/expert-routing.ts`**

```ts
// 专家派发契约：任务执行专家由当前泳道决定（非任务 role 字段）。
import type { TaskStatus } from './types.js';
import type { AgentKey } from './provider.js';

/** 专家键：与 AgentKey 同集合，语义化别名。 */
export type ExpertKey = AgentKey;

/**
 * 泳道 -> 执行专家。仅执行泳道（in_progress/testing）返回专家；
 * ready/in_review/archived 无 agent（待开发/人工验收/终态）。
 * awaiting_input 是暂停标识，恢复后回原泳道由原专家继续（此处不映射）。
 */
export function laneToExpert(status: TaskStatus): ExpertKey | undefined {
  switch (status) {
    case 'in_progress':
      return 'dev';
    case 'testing':
      return 'test';
    default:
      return undefined;
  }
}
```

- [ ] **Step 5: 运行确认通过**

Run: `pnpm --filter @ai-devflow/core test`
Expected: PASS

- [ ] **Step 6: 提交**
```bash
git add packages/core/src/expert-routing.ts packages/core/src/__tests__/expert-routing.test.ts packages/core/src/types.ts
git commit -m "feat(core): 新增专家派发映射 laneToExpert + 任务类型标签"
```

---

## Task 3: 画像资产 - 新建三个技能 + 资产目录迁移

**Files:**
- Create: `packages/agents/assets/profiles/product/{SYSTEM.md,settings.json}`
- Create: `packages/agents/assets/profiles/product/skills/{create-prd}/SKILL.md`
- Create: `packages/agents/assets/profiles/ux/{SYSTEM.md,settings.json}`
- Create: `packages/agents/assets/profiles/ux/skills/{ux-spec-writing,web-design-engineer}/SKILL.md`
- Create: `packages/agents/assets/profiles/dev_lead/{SYSTEM.md,settings.json}`
- Create: `packages/agents/assets/profiles/dev_lead/skills/{subtask-generation}/SKILL.md`
- Test: `pnpm --filter @ai-devflow/agents test`（画像校验在加载期 fail-fast）

**Interfaces:**
- Consumes: spec §4.1 画像表。
- Produces: 新资产目录，供 Task 4 `EXPERT_PROFILES` 引用。

> 说明：`web-design-engineer` 技能 spec 要求"沿用现有重技能"。先确认仓库内是否已有该技能资产（`find packages/agents/assets -name 'web-design-engineer'`）。若 Pi 运行时自带（非本仓库资产），则在 UX专家 SYSTEM.md 的技能引用改为 Pi 内置技能名，并在 `EXPERT_PROFILES.ux.skills` 中保留字符串引用、由 `--skill` 加载 Pi 内置路径。若无任何来源，则本任务内新建精简版 SKILL.md。

- [ ] **Step 1: 确认 web-design-engineer 来源**

Run: `find packages/agents/assets -name 'web-design-engineer' -type d; find . -path ./node_modules -prune -o -name 'web-design-engineer' -print 2>/dev/null | head`
据结果决定：仓库已有->复用；Pi 内置->引用；都没有->新建精简版。

- [ ] **Step 2: 创建产品专家资产**

`packages/agents/assets/profiles/product/SYSTEM.md`：
```markdown
# 产品专家系统提示

你是 ai-devflow 的产品专家，负责需求创建。主导与用户的需求对话，产出 PRD、验收标准、优先级。

原则：
- 使用 brainstorming 技能澄清需求，一次一个问题。
- 识别到 UX 面（界面/交互/可视化/可访问性）时，调用 `ai_devflow_consult_ux` 工具咨询 UX专家，把建议合并进需求草稿。
- 无 UX 面的需求不调用 UX专家。
- 定稿时调用 `ai_devflow_propose_requirement` 产出需求草稿。
- 遇阻塞调用 `ai_devflow_ask` 询问用户。
- 禁止使用 bash、禁止修改代码。
```
`packages/agents/assets/profiles/product/settings.json`：`{}`（沿用其他角色 settings 风格，读取现有 `assets/profiles/planner/settings.json` 作模板）。

`packages/agents/assets/profiles/product/skills/create-prd/SKILL.md`：
```markdown
---
name: create-prd
description: 撰写 PRD 文档（需求背景、目标、验收标准、非目标）
---

# create-prd

## When to Use
产品专家定稿需求时，产出结构化 PRD。

## Procedure
1. 需求背景：一句话说明为何做。
2. 目标：可验证的目标列表。
3. 验收标准：每条可独立验证。
4. 非目标：明确本轮不做的范围。
5. 调用 ai_devflow_propose_requirement 提交草稿。
```

- [ ] **Step 3: 创建 UX专家资产**

`packages/agents/assets/profiles/ux/SYSTEM.md`：
```markdown
# UX专家系统提示

你是 ai-devflow 的 UX专家，被产品专家经 `ai_devflow_consult_ux` 子咨询调用。针对需求中的 UX 面，产出结构化建议：交互要点、视觉/结构约束、可访问性、响应式。

原则：
- 只读研读项目代码与现有 UX 知识，不改代码。
- 输出结构化建议供产品专家合并。
- 遇不明调用 `ai_devflow_ask` 询问。
```
`settings.json`：`{}`。
`skills/ux-spec-writing/SKILL.md`：
```markdown
---
name: ux-spec-writing
description: 撰写 UX 规格（交互流程、视觉/结构要点、可访问性、响应式）
---

# ux-spec-writing

## When to Use
UX专家被咨询时，产出 UX 规格。

## Procedure
1. 交互流程：关键路径状态流转。
2. 视觉/结构要点：布局、组件层级。
3. 可访问性：键盘、读屏、对比度。
4. 响应式：断点与适配。
```
`skills/web-design-engineer/SKILL.md`：若 Step 1 判定需新建，写精简版（指向 Pi 内置同名技能的引用说明）；否则跳过。

- [ ] **Step 4: 创建研发负责人资产**

`packages/agents/assets/profiles/dev_lead/SYSTEM.md`：
```markdown
# 研发负责人系统提示

你是 ai-devflow 的研发负责人，负责从需求拆分可独立闭环的子任务。

原则（注入 subtask-generation 技能）：
- 独立闭环优先：每个子任务可独立开发、独立验证、独立关闭。
- 小任务合并：前后端小且紧耦合时合并为全栈单任务，不强行拆分。
- 粒度适中、上游优先、避免重复。
- 拆分草案先示用户确认（HARD-GATE），禁止未经确认创建任务。
- 正确标注 dependsOn DAG；无依赖=parallel-safe，有依赖=ordered。
- 可标注类型标签（前端/后端/全栈/联调）供展示。
- 只读研读代码，不落地代码改动。定稿调用 `ai_devflow_propose_task`。
```
`settings.json`：`{}`。
`skills/subtask-generation/SKILL.md`：
```markdown
---
name: subtask-generation
description: 从需求拆分可独立闭环的子任务（独立闭环 + 小任务合并）
---

# subtask-generation

## When to Use
研发负责人从需求生成子任务时。

## Procedure
1. 读需求 PRD + 验收标准 + 已有子任务（避免重复）。
2. 按独立闭环边界生成草稿；每任务标注 typeLabel 与 dependsOn。
3. 自检合并条件：前后端小且紧耦合且无并行收益 -> 合并全栈。
4. 展示草稿给用户确认（HARD-GATE）。
5. 确认后调用 ai_devflow_propose_task 产出 AiTaskProposal[]。

## Pitfalls
- 过度拆分：一个字段改动拆成碎片。
- 拆分不足：把不相关模块塞一个巨任务。
```

- [ ] **Step 5: 提交**
```bash
git add packages/agents/assets/profiles/product packages/agents/assets/profiles/ux packages/agents/assets/profiles/dev_lead
git commit -m "feat(agents): 新增 product/ux/dev_lead 专家资产与三个技能"
```

---

## Task 4: 画像注册表 - EXPERT_PROFILES 重构

**Files:**
- Modify: `packages/agents/src/profiles.ts`
- Create: `packages/agents/src/__tests__/expert-profiles.test.ts`
- Test: `pnpm --filter @ai-devflow/agents test`

**Interfaces:**
- Consumes: spec §4.1 画像表、Task 3 新资产。
- Produces: `EXPERT_PROFILES: Record<ExpertKey, ExpertProfile>`；`materializeExpertProfile`；`validateExpertProfiles()`（加载期 fail-fast）。`ExpertKey` 从 `@ai-devflow/core` 导入。

- [ ] **Step 1: 写失败测试**

Create `packages/agents/src/__tests__/expert-profiles.test.ts`：
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXPERT_PROFILES, validateExpertProfiles } from '../profiles.js';

test('EXPERT_PROFILES 含 5 个执行专家', () => {
  const keys = Object.keys(EXPERT_PROFILES);
  assert.deepEqual(keys.sort(), ['dev', 'dev_lead', 'product', 'test', 'ux']);
});

test('测试专家含 write/edit 工具用于用例验证', () => {
  assert.ok(EXPERT_PROFILES.test.tools.includes('write'));
  assert.ok(EXPERT_PROFILES.test.tools.includes('edit'));
});

test('研发负责人无 bash/edit/write', () => {
  const t = EXPERT_PROFILES.dev_lead.tools;
  assert.ok(!t.includes('bash'));
  assert.ok(!t.includes('edit'));
  assert.ok(!t.includes('write'));
});

test('validateExpertProfiles 不抛', () => {
  assert.doesNotThrow(() => validateExpertProfiles());
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @ai-devflow/agents test`
Expected: FAIL（`EXPERT_PROFILES` 未导出）

- [ ] **Step 3: 重构 `packages/agents/src/profiles.ts`**

在文件顶部 import 加 `ExpertKey`：
```ts
import type { ProviderKind, ExpertKey } from '@ai-devflow/core';
```
新增 `ExpertProfile` 接口（结构与 `RoleProfile` 同，`role` 字段改 `expert: ExpertKey`）：
```ts
export interface ExpertProfile {
  expert: ExpertKey;
  version: number;
  systemPromptFile: string;
  tools: string[];
  excludedTools: string[];
  skills: string[];
  extensions: string[];
  timeoutMs: number;
}
```
扩展 `BUILTIN_SKILLS`（追加三项，source 指向新目录）：
```ts
{ name: 'create-prd', source: 'product' as const },
{ name: 'ux-spec-writing', source: 'ux' as const },
{ name: 'subtask-generation', source: 'dev_lead' as const },
```
扩展 `SkillSource` 类型：`export type SkillSource = TaskRole | 'shared' | 'product' | 'ux' | 'dev_lead' | 'dev' | 'test';`

定义 `EXPERT_PROFILES`（按 spec §4.1 表）：
```ts
export const EXPERT_PROFILES: Record<ExpertKey, ExpertProfile> = {
  product: {
    expert: 'product', version: 1, systemPromptFile: 'SYSTEM.md',
    tools: ['read', 'grep', 'find', 'ls'],
    excludedTools: ['bash', 'edit', 'write'],
    skills: ['brainstorming', 'requirements-analysis', 'design-writing', 'create-prd'],
    extensions: ['requirement-bridge', 'ask-bridge', 'event-bridge', 'structured-result'],
    timeoutMs: 15 * 60_000,
  },
  ux: {
    expert: 'ux', version: 1, systemPromptFile: 'SYSTEM.md',
    tools: ['read', 'grep', 'find', 'ls'],
    excludedTools: ['bash', 'edit', 'write'],
    skills: ['ux-spec-writing', 'web-design-engineer'],
    extensions: ['requirement-bridge', 'ask-bridge', 'structured-result'],
    timeoutMs: 10 * 60_000,
  },
  dev_lead: {
    expert: 'dev_lead', version: 1, systemPromptFile: 'SYSTEM.md',
    tools: ['read', 'grep', 'find', 'ls'],
    excludedTools: ['bash', 'edit', 'write'],
    skills: ['brainstorming', 'implementation-planning', 'subtask-generation'],
    extensions: ['task-bridge', 'ask-bridge', 'event-bridge', 'structured-result'],
    timeoutMs: 15 * 60_000,
  },
  dev: {
    expert: 'dev', version: 1, systemPromptFile: 'SYSTEM.md',
    tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'],
    excludedTools: [],
    skills: ['design-writing', 'implementation-planning', 'test-driven-development', 'systematic-debugging', 'verification'],
    extensions: ['event-bridge', 'execution-policy', 'structured-result', 'checkpoint-context', 'task-bridge'],
    timeoutMs: 45 * 60_000,
  },
  test: {
    expert: 'test', version: 1, systemPromptFile: 'SYSTEM.md',
    tools: ['read', 'bash', 'grep', 'find', 'ls', 'write', 'edit'],
    excludedTools: [],
    skills: ['code-review', 'security-review', 'regression-review', 'test-design', 'failure-analysis', 'acceptance-verification'],
    extensions: ['event-bridge', 'execution-policy', 'structured-result', 'checkpoint-context', 'task-bridge'],
    timeoutMs: 30 * 60_000,
  },
};
```
新增 `validateExpertProfiles()`（仿 `validateRoleProfiles`，键集为 `ExpertKey`）：
```ts
export function validateExpertProfiles(
  profiles: Record<ExpertKey, ExpertProfile> = EXPERT_PROFILES,
  extensionPool: readonly string[] = BUILTIN_EXTENSIONS,
  skillPool: readonly BuiltinSkill[] = BUILTIN_SKILLS,
): void {
  const extSet = new Set(extensionPool);
  const skillNames = new Set(skillPool.map((s) => s.name));
  for (const expert of Object.keys(profiles) as ExpertKey[]) {
    for (const ext of profiles[expert].extensions) {
      if (!extSet.has(ext)) throw new Error(`专家 ${expert} 引用了未注册的扩展：${ext}`);
    }
    for (const skill of profiles[expert].skills) {
      if (!skillNames.has(skill)) throw new Error(`专家 ${expert} 引用了未注册的技能：${skill}`);
    }
  }
}
validateExpertProfiles();
```
> 注：`web-design-engineer` 必须在 `BUILTIN_SKILLS` 注册（source 取决于 Task 3 Step 1 结论：仓库内则指向其目录，否则指向 `ux` 并由 Task 3 建精简版）。先在 `BUILTIN_SKILLS` 加 `{ name: 'web-design-engineer', source: 'ux' as const }`。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @ai-devflow/agents test`
Expected: PASS（加载期 `validateExpertProfiles()` 不抛 + 单测过）

- [ ] **Step 5: 提交**
```bash
git add packages/agents/src/profiles.ts packages/agents/src/__tests__/expert-profiles.test.ts
git commit -m "feat(agents): EXPERT_PROFILES 注册表 + validateExpertProfiles"
```

---

## Task 5: 运行时 - AgentRunRequest 改 expert + PiRunner 适配

**Files:**
- Modify: `packages/agents/src/runner-types.ts`
- Modify: `packages/agents/src/pi-runner.ts`
- Modify: `packages/agents/src/run-plan.ts`
- Modify: `packages/agents/src/__tests__/pi-runner.test.ts`（若存在）
- Test: `pnpm --filter @ai-devflow/agents test`

**Interfaces:**
- Consumes: `ExpertKey`（core）、`EXPERT_PROFILES`（profiles.ts）。
- Produces: `AgentRunRequest.expert: ExpertKey`（取代 `role: TaskRole`）；`PiRunner.run` 用 `EXPERT_PROFILES[expert]`。

- [ ] **Step 1: 改 `runner-types.ts`**

```ts
import type { AgentEvent, Checkpoint, InteractionKind } from '@ai-devflow/core';
import type { ExpertKey } from '@ai-devflow/core';

export interface AgentRunRequest {
  taskId: string;
  executionId: string;
  expert: ExpertKey;   // 取代 role: TaskRole
  prompt: string;
  cwd: string;
  resumeFrom?: Checkpoint;
  userInput?: string;
  interactionResponse?: { kind: InteractionKind; value: string };
}
```
移除 `TaskRole` import（若无其他引用）。

- [ ] **Step 2: 改 `pi-runner.ts`**

把所有 `request.role` 替换为 `request.expert`，把 `ROLE_PROFILES[request.role]` 替换为 `EXPERT_PROFILES[request.expert]`：
- `router.execute(request.role, ...)` -> `router.execute(request.expert, ...)`（router 签名在 Task 6/ProviderRouter 同步改）
- `materialize({ role: request.role, ... })` -> `materialize({ expert: request.expert, ... })`
- `ROLE_PROFILES[request.role].timeoutMs` -> `EXPERT_PROFILES[request.expert].timeoutMs`
- `validateRoleCompletion(request.role, ...)` -> `validateExpertCompletion(request.expert, ...)`（重命名该校验函数，内部按专家取期望结果结构）
- `buildPiRunPlan({ role: request.role, ... })` -> `buildPiRunPlan({ expert: request.expert, ... })`

- [ ] **Step 3: 改 `run-plan.ts`**

`buildPiRunPlan` 入参 `role: TaskRole` -> `expert: ExpertKey`；内部用 `EXPERT_PROFILES[expert]` 取 systemPrompt/skills 路径。`roleToolsArg` 改为 `expertToolsArg(expert)` 用 `EXPERT_PROFILES[expert].tools`。

- [ ] **Step 4: 运行测试**

Run: `pnpm --filter @ai-devflow/agents test`
Expected: 编译可能因 `ProviderRouter.execute` 签名未改而 FAIL——记录错误，Task 6 修。若仅类型错误且单测逻辑不依赖 router，先标注待 Task 6 联动。

- [ ] **Step 5: 提交（含 WIP 标记若跨包未联动）**
```bash
git add packages/agents/src/runner-types.ts packages/agents/src/pi-runner.ts packages/agents/src/run-plan.ts
git commit -m "refactor(agents): AgentRunRequest 改 expert 字段 + PiRunner 用 EXPERT_PROFILES"
```

---

## Task 6: 调度器 - 按泳道派发专家

**Files:**
- Modify: `packages/scheduler/src/orchestrator.ts`
- Modify: `packages/scheduler/src/__tests__/orchestrator.test.ts`（若存在）
- Test: `pnpm --filter @ai-devflow/scheduler test`

**Interfaces:**
- Consumes: `laneToExpert`（core）、`AgentRunRequest.expert`（agents）。
- Produces: `runPipeline` 用 `laneToExpert('in_progress')='dev'` 构造 `AgentRunRequest`；`runReview` 用 `laneToExpert('testing')='test'`。

- [ ] **Step 1: 改 `runPipeline`（orchestrator.ts:214）**

当前：`const stages = task.stages.length > 0 ? task.stages : [{ id: IMPLICIT_STAGE_ID, name: '执行', role: task.role }];` 与 `role: stage.role`（行 287）。

改为按泳道派发单专家执行（废弃多角色 stages）：
```ts
private async runPipeline(task: Task, project: Project, init: StartInit | undefined, entry: ActivePipeline): Promise<void> {
  // 按泳道派发：in_progress -> 研发专家(dev)。废弃多角色 stages。
  const expert = laneToExpert(task.status) ?? 'dev';
  // ...保留 worktree/初始化逻辑...
  const request: AgentRunRequest = {
    taskId: task.id,
    executionId: entry.executionId,
    expert,
    prompt: /* 现有 prompt 构造 */,
    cwd: entry.worktree,
    resumeFrom: init?.resumeFrom,
    userInput: init?.userInput,
    interactionResponse: init?.interactionResponse,
  };
  const run = await this.runner.run(request);
  // ...保留事件消费逻辑...
}
```
删除 `stages` 遍历与 `task.currentStage` 推进（保留字段兼容但不再驱动执行）。`runPipeline` 内若仍引用 `stage.role`/`task.currentStage`，替换为单次 expert 执行。

- [ ] **Step 2: 改 `runReview`（orchestrator.ts:454）与 `reviewAndFinalize`**

`runReview` 把 reviewer 角色调用改为测试专家：
```ts
private async runReview(task: Task, project: Project, entry: ActivePipeline): Promise<ReviewVerdict | undefined> {
  const expert = laneToExpert('testing')!; // 'test'
  const request: AgentRunRequest = { taskId: task.id, executionId: entry.executionId, expert, prompt: /* 审查+测试 prompt */, cwd: entry.worktree };
  // ...运行测试专家，解析 ReviewVerdict...
}
```
`reviewAndFinalize`（行 380）逻辑不变（pass->合并->transition in_review {reviewPassed:true}；fail->退回 in_progress，受 maxReviewRounds 约束），只是 verdict 来源改为测试专家。

- [ ] **Step 3: 改 `start`（行 191 附近）与 `runPipeline` 调用处**

确认 `start` 内不再读 `task.role`/`task.stages` 选执行者；进入 in_progress 后 `runPipeline` 自行按泳道取专家。

- [ ] **Step 4: 运行测试**

Run: `pnpm --filter @ai-devflow/scheduler test`
Expected: PASS（或因 pi-runner 联动类型错误，标注待 Task 5 联动后回归）

- [ ] **Step 5: 提交**
```bash
git add packages/scheduler/src/orchestrator.ts
git commit -m "refactor(scheduler): 按泳道派发专家（in_progress->dev, testing->test）"
```

---

## Task 7: 持久化 - DB 迁移 v11（类型标签列）

**Files:**
- Create: `packages/persistence/src/migrations/agent-role-migration-v11.ts`
- Modify: `packages/persistence/src/migrations.ts`
- Modify: `packages/persistence/src/repositories.ts`（`mapTask`）
- Test: `pnpm --filter @ai-devflow/persistence test`

**Interfaces:**
- Produces: v11 迁移加 `tasks.type_label TEXT`；`mapTask` 读 `type_label`。

- [ ] **Step 1: 写失败测试**

在 `packages/persistence/src/__tests__/` 找现有迁移测试文件，追加：v11 后 `tasks` 表含 `type_label` 列；插入任务带 type_label 可读回。

- [ ] **Step 2: 创建 v11 迁移文件**

`packages/persistence/src/migrations/agent-role-migration-v11.ts`：
```ts
import type { Migration } from '../migrations.js';

export const AGENT_ROLE_MIGRATION_V11: Migration = {
  version: 11,
  description: 'agent role restructure: add tasks.type_label (前端/后端/全栈/联调)',
  sql: `
    ALTER TABLE tasks ADD COLUMN type_label TEXT;
  `,
};
```

- [ ] **Step 3: 接入 `migrations.ts`**

在 `MIGRATIONS` 数组末尾追加：
```ts
import { AGENT_ROLE_MIGRATION_V11 } from './agent-role-migration-v11.js';
// ...在数组末尾...
AGENT_ROLE_MIGRATION_V11,
```

- [ ] **Step 4: 改 `repositories.ts` `mapTask`**

读取现有 `mapTask`（用 grep 定位），加 `typeLabel: row.type_label ?? undefined`；`Task` 接口在 types.ts 加 `typeLabel?: TaskTypeLabel`（Task 2 已加类型，此处加字段）。insert/update 同步写 `type_label`。

- [ ] **Step 5: 运行测试**

Run: `pnpm --filter @ai-devflow/persistence test`
Expected: PASS

- [ ] **Step 6: 提交**
```bash
git add packages/persistence/src/migrations/agent-role-migration-v11.ts packages/persistence/src/migrations.ts packages/persistence/src/repositories.ts packages/persistence/src/__tests__/
git commit -m "feat(persistence): v11 迁移加 tasks.type_label + mapTask 读写"
```

---

## Task 8: 主进程 - AgentModelOverride 键迁移

**Files:**
- Modify: `apps/desktop/electron/provider-store.ts`
- Modify: `apps/desktop/electron/__tests__/provider-store-overrides.test.ts`
- Test: `pnpm --filter desktop test`（或对应测试脚本，读取 `apps/desktop/package.json` scripts.test）

**Interfaces:**
- Produces: `migrateAgentOverridesToExperts(): { migrated: string[]; conflicts: string[] }`；应用启动调用一次。

- [ ] **Step 1: 写失败测试**

在 `provider-store-overrides.test.ts` 追加：存旧键 `{agentKey:'planner',...}`/`{agentKey:'task_proposer',...}` -> 调 `migrateAgentOverridesToExperts()` -> `listAgentOverrides()` 仅含 `dev`/`dev_lead`，旧键清理；多旧键映射同新键记 conflict。

- [ ] **Step 2: 实现 `migrateAgentOverridesToExperts`**

在 `provider-store.ts` 加（旧->新映射表）：
```ts
const LEGACY_TO_EXPERT: Record<string, AgentKey> = {
  requirement_refiner: 'product',
  task_proposer: 'dev_lead',
  planner: 'dev',
  coder: 'dev',
  reviewer: 'test',
  tester: 'test',
  chat: 'chat',
};

migrateAgentOverridesToExperts(): { migrated: string[]; conflicts: string[] } {
  const list = this.listAgentOverrides();
  if (list.length === 0) return { migrated: [], conflicts: [] };
  const seenNew = new Set<string>();
  const migrated: AgentModelOverride[] = [];
  const conflicts: string[] = [];
  for (const o of list) {
    const newKey = LEGACY_TO_EXPERT[o.agentKey];
    if (!newKey) { migrated.push(o); continue; } // 已是新键或未知，保留
    if (seenNew.has(newKey)) { conflicts.push(`${o.agentKey}->${newKey}（已存在，丢弃）`); continue; }
    seenNew.add(newKey);
    migrated.push({ ...o, agentKey: newKey });
  }
  this.credentials.upsert(AGENT_OVERRIDES_KEY, this.crypto.encrypt(JSON.stringify(migrated)));
  return { migrated: migrated.map((m) => m.agentKey), conflicts };
}
```

- [ ] **Step 3: 在应用启动调用**

在 `services.ts` 或 `main.ts` 初始化 `providerStore` 后调用 `providerStore.migrateAgentOverridesToExperts()`，日志记录 conflicts。

- [ ] **Step 4: 运行测试**

Run: 对应 desktop 测试脚本
Expected: PASS

- [ ] **Step 5: 提交**
```bash
git add apps/desktop/electron/provider-store.ts apps/desktop/electron/__tests__/provider-store-overrides.test.ts apps/desktop/electron/services.ts
git commit -m "feat(desktop): AgentModelOverride 键迁移到 6 专家键"
```

---

## Task 9: 主进程 - ipc 移除 role 输入 + typeLabel

**Files:**
- Modify: `apps/desktop/electron/ipc.ts`
- Modify: `apps/desktop/electron/__tests__/ipc.test.ts`
- Test: `pnpm --filter desktop test`

**Interfaces:**
- Produces: `tasks:create`/`createBatch`/`update` 不再接受 `role`；接受 `typeLabel?`。

- [ ] **Step 1: 写失败测试**

ipc 测试：`tasks:create` 不传 role 仍成功创建（role 默认 'coder' 兼容字段或留空）；传 `typeLabel:'fullstack'` 可读回。

- [ ] **Step 2: 改 `tasks:create`（ipc.ts:279）**

```ts
const t: Task = {
  // ...
  role: 'coder',   // 兼容字段保留（编排器忽略），不再取 input.role
  stages: [{ id: 'impl', name: '实现', role: 'coder' }],  // 兼容字段保留
  typeLabel: input.typeLabel,
  // ...
};
```
移除 `input.role` 读取。

- [ ] **Step 3: 改 `tasks:createBatch`（ipc.ts:324）**

```ts
created.push({
  // ...
  role: 'coder',
  stages: [{ id: 'impl', name: '实现', role: 'coder' }],
  typeLabel: p.typeLabel,
  // ...
});
```
移除 `p.role` 读取与 role 校验（行 588 附近的 `o.role === 'planner'...` 改为忽略 role，保留 typeLabel 透传）。

- [ ] **Step 4: 改 `tasks:update`（ipc.ts:346）**

移除 `if (input.role !== undefined) t.role = input.role;`；加 `if (input.typeLabel !== undefined) t.typeLabel = input.typeLabel;`。

- [ ] **Step 5: 运行测试**

Run: `pnpm --filter desktop test`
Expected: PASS

- [ ] **Step 6: 提交**
```bash
git add apps/desktop/electron/ipc.ts apps/desktop/electron/__tests__/ipc.test.ts
git commit -m "refactor(desktop): ipc 移除 role 输入，加 typeLabel"
```

---

## Task 10: 主进程 - pi-ai 路由新专家 + UX 子咨询桥接

**Files:**
- Modify: `apps/desktop/electron/pi-ai.ts`
- Create: `apps/desktop/electron/ux-consult.ts`
- Create: `packages/agents/assets/profiles/shared/extensions/ux-bridge.ts`
- Test: `pnpm --filter desktop test`

**Interfaces:**
- Produces: `buildChatPlan` 按 workload 路由产品/UX/研发负责人专家画像；`ai_devflow_consult_ux` 工具经 ux-bridge 触发 UX专家 step-agent run。

- [ ] **Step 1: 写 ux-bridge 扩展**

`packages/agents/assets/profiles/shared/extensions/ux-bridge.ts`：仿 `ask-bridge.ts` 结构（读取现有 ask-bridge.ts 作模板），注册工具 `ai_devflow_consult_ux`，接收 `{ requirementContext: string }`，经子进程 IPC 通道把请求发回主进程（机制同 `ai_devflow_ask`，参考 `apps/desktop/electron/pi-ai.ts` 的 onAsk/pendingAsks）。

- [ ] **Step 2: 写 `ux-consult.ts`**

`apps/desktop/electron/ux-consult.ts`：导出 `runUxConsultation(requirementContext, services, providerStore): Promise<UxAdvice>`，内部启动一次 UX专家 step-agent run（用 `EXPERT_PROFILES.ux` + 产品专家同款 chat 机制），返回结构化 UX 建议。

- [ ] **Step 3: 改 `buildChatPlan` 路由（pi-ai.ts:159）**

把 `stepAgentForWorkload` 返回的 step agent 映射改为新专家：
- `requirement_chat`/`requirement_proposal` -> 产品专家画像（tools/skills/extensions 取 `EXPERT_PROFILES.product`，加 `ai_devflow_propose_requirement`/`ai_devflow_ask`/`ai_devflow_consult_ux`）
- `task_proposal` -> 研发负责人画像（取 `EXPERT_PROFILES.dev_lead`，加 `ai_devflow_propose_task`/`ai_devflow_ask`）
- `task_chat` -> chat（无工具）

删除 `STEP_AGENTS`/`stepAgentForWorkload` 旧引用，改为读 `EXPERT_PROFILES` + workload 决定附加工具。

- [ ] **Step 4: 接入 consult_ux 回调**

在 `ai-devflow:ai:chat` 的 `onToolResult` 中加 `ai_devflow_consult_ux` 分支：调用 `runUxConsultation`，把建议作为 tool_result 回灌 Pi（机制同 `pendingAsks` 但同步返回结果而非推 question 事件）。

- [ ] **Step 5: 运行测试**

Run: `pnpm --filter desktop test`
Expected: PASS（含 buildChatPlan 用例适配）

- [ ] **Step 6: 提交**
```bash
git add packages/agents/assets/profiles/shared/extensions/ux-bridge.ts apps/desktop/electron/ux-consult.ts apps/desktop/electron/pi-ai.ts
git commit -m "feat(desktop,agents): pi-ai 路由新专家 + ux-bridge 子咨询"
```

---

## Task 11: UI - Settings Agent 模型分配区改 6 专家键

**Files:**
- Modify: `apps/desktop/src/pages/Settings.tsx`
- Modify: `apps/desktop/src/i18n/*`（专家键中文标签）
- Test: `pnpm --filter desktop test` + 手动验证

**Interfaces:**
- Produces: Settings 页 6 行专家键（产品/UX/研发负责人/研发/测试/通用对话），无旧键。

- [ ] **Step 1: 改 Settings.tsx Agent 分配区**

把渲染 AgentKey 列表处改为 6 专家键：
```tsx
const EXPERT_KEYS: Array<{ key: AgentKey; label: string }> = [
  { key: 'product', label: '产品专家' },
  { key: 'ux', label: 'UX专家' },
  { key: 'dev_lead', label: '研发负责人' },
  { key: 'dev', label: '研发专家' },
  { key: 'test', label: '测试专家' },
  { key: 'chat', label: '通用对话' },
];
```
移除旧 7 键引用。

- [ ] **Step 2: i18n 标签**

在 i18n 资源加 6 专家键中文标签。

- [ ] **Step 3: 运行测试 + 手动验证**

Run: `pnpm --filter desktop test`
手动：打开 Settings，确认 6 行专家键，无旧键。

- [ ] **Step 4: 提交**
```bash
git add apps/desktop/src/pages/Settings.tsx apps/desktop/src/i18n/
git commit -m "feat(desktop): Settings Agent 分配区改 6 专家键"
```

---

## Task 12: UI - 移除任务创建 role 选择器

**Files:**
- Modify: `apps/desktop/src/pages/TaskDetail.tsx` 或任务创建组件（grep 定位 role 选择器）
- Test: `pnpm --filter desktop test` + e2e

- [ ] **Step 1: 定位 role 选择器**

Run: `grep -rn "role.*planner\|role.*coder\|role.*select\|TaskRole" apps/desktop/src/`
找到任务创建/编辑表单中的 role 下拉。

- [ ] **Step 2: 移除 role 选择器，加可选 typeLabel**

删除 role 下拉组件；加 typeLabel 可选下拉（前端/后端/全栈/联调 + 未标注）。

- [ ] **Step 3: 运行测试 + e2e**

Run: `pnpm --filter desktop test`；若有 e2e 跑 e2e。
Expected: PASS

- [ ] **Step 4: 提交**
```bash
git add apps/desktop/src/
git commit -m "refactor(desktop): 移除任务 role 选择器，加 typeLabel"
```

---

## Task 13: 收尾 - 清理旧测试引用 + 端到端验证

**Files:**
- 全仓 grep `TaskRole`/`ROLE_PROFILES`/`STEP_AGENTS`/`requirement_refiner`/`task_proposer`/`planner`/`coder`/`reviewer`/`tester` 残留
- Test: `pnpm -w test`

- [ ] **Step 1: 全量回归**

Run: `pnpm -w test`
Expected: 全部 PASS

- [ ] **Step 2: grep 残留旧引用**

Run: `grep -rn "ROLE_PROFILES\|STEP_AGENTS\|requirement_refiner\|task_proposer" packages/ apps/ --include='*.ts' --include='*.tsx' | grep -v node_modules | grep -v __tests__`
逐一清理（保留兼容字段/迁移代码中的引用）。

- [ ] **Step 3: 端到端手动验证**

启动应用，走完：需求创建（产品专家，含 UX 子咨询）-> 研发负责人拆分 -> 任务 start（in_progress 研发专家）-> 自动 testing（测试专家）-> in_review 人工 accept -> archived。确认 spec §7 验收标准 1-9。

- [ ] **Step 4: 提交**
```bash
git add -A
git commit -m "chore: 清理旧角色引用 + 端到端验证通过"
```

---

## Self-Review

**1. Spec coverage:**
- §3 泳道->专家映射：Task 2（laneToExpert）+ Task 6（orchestrator 派发）✓
- §4.1 画像表：Task 3（资产）+ Task 4（EXPERT_PROFILES）✓
- §4.2 UX 子咨询：Task 10（ux-bridge + ux-consult）✓
- §4.3 workload 路由：Task 1（workloadAgentKey）✓
- §4.4 画像清单重构：Task 4 ✓
- §4.5 三个新技能：Task 3 ✓
- §5 拆分原则：Task 3（subtask-generation 技能 + dev_lead SYSTEM.md）✓
- §5.2 基础设施对接：Task 9（createBatch 保留 DAG）✓
- §5.3 类型标签：Task 2（类型）+ Task 7（DB）+ Task 9（ipc）+ Task 12（UI）✓
- §6.1 移除可配置角色：Task 6（orchestrator 忽略 role）+ Task 9（ipc）+ Task 12（UI）✓
- §6.2 override 键迁移：Task 8 ✓
- §6.3 状态机/门禁/编排器：Task 6（不变+派发）✓
- §6.4 迁移兼容：Task 7（字段保留）+ Task 8（override 迁移）✓
- §7 验收标准 1-9：Task 13 端到端验证 ✓

**2. Placeholder scan:** 无 TBD/TODO；Task 3 web-design-engineer 来源用 Step 1 显式判断（非占位符，是条件分支）；Task 6 prompt 构造引用"现有 prompt 构造"因 orchestrator 内已有构造逻辑、本任务只改 expert 字段（合理）。

**3. Type consistency:** `ExpertKey`=AgentKey 别名（Task 2 定义）；`AgentRunRequest.expert`（Task 5）与 orchestrator（Task 6）一致；`TaskTypeLabel`（Task 2）与 DB（Task 7）/ipc（Task 9）/UI（Task 12）一致；`EXPERT_PROFILES: Record<ExpertKey, ExpertProfile>`（Task 4）与 pi-runner（Task 5）一致。
