# 工作台对话与 Agent 模型路由设计

> 日期：2026-07-24
> 状态：已确认（待实现）
> 关联：`2026-07-23-step-agent-requirement-redesign.md`、`2026-07-22-provider-model-config-design.md`

## 背景

v0.2.2 完成需求环节专用步骤 Agent（`requirement_refiner`）重构后，工作台交互暴露四类问题：

1. AI 对话新消息不自动滚动到底部（`AiRefineRequirement` / `AiCreateTask` 完全无自动滚动）；任务详情对话的无条件滚动会在用户上滚阅读历史时被打断。
2. AI 服务商设置难以理解如何让不同 agent 使用不同服务商/模型——现有 `workloadModels` 机制可按 6 个角色配模型，但无法把某个 agent 钉到指定 provider，且角色↔步骤 agent 的映射对用户不透明。
3. 新建需求应是 AI 优先的两步流程：先 AI 沟通出初稿，用户确认/修改后点击创建。
4. AI 生成任务弹窗应由用户点击生成按钮触发，草稿可逐条编辑，可补充说明重新生成，或直接一键创建。

## 目标与非目标

**目标**
- 统一的「粘底滚动」交互：自动滚到底，用户上滚越过阈值即暂停并提示新消息。
- 新增「按 agent 覆盖 provider + 模型」能力，并改善设置页可理解性。
- 需求创建改为 AI 两步流程为唯一入口。
- 任务生成弹窗默认 AI，支持逐条编辑、补充重生成、一键批量创建。

**非目标**
- 不重构四角色（planner/coder/reviewer/tester）为步骤 agent（仍按既定迁移路线后续推进）。
- 不为 `task_proposal` 新增正式步骤 Agent 与 tool（保持 no-tools JSON 路径；仅用 `task_proposer` 作为覆盖键占位）。
- 不变更现有流式 IPC 通道与 Pi 运行时打包流程。

## 架构总览

四项需求分两类：

- **前端交互类**（①③④）：集中在 `apps/desktop/src/pages/{TaskDetail,Workspace}.tsx`，共享一个滚动 hook。
- **后端路由类**（②）：扩展 `packages/core/src/provider.ts` 数据模型、`apps/desktop/electron/provider-store.ts` 存储、`packages/agents/src/provider-router.ts` 路由、`apps/desktop/src/pages/Settings.tsx` 设置 UI。

建议最终拆为两份实施计划（见「实施计划拆分」），但合入本设计文档。

---

## ① AI 对话自动滚动 + 用户上滚暂停

### 共享 hook

新建 `apps/desktop/src/hooks/useStickToBottom.ts`：

```ts
export interface StickToBottom {
  containerRef: React.RefObject<HTMLDivElement>;
  paused: boolean;          // 用户是否已上滚暂停
  unreadCount: number;      // 暂停期间累计的新消息数
  resume: () => void;       // 滚到底并清零
}

export function useStickToBottom(deps: unknown[], threshold = 120): StickToBottom;
```

行为：
- `deps` 变化（如 `messages`、`interactions`）时：若 `!paused` 则 `el.scrollTop = el.scrollHeight`；若 `paused` 则 `unreadCount++`。
- 监听容器 `scroll` 事件：`isAtBottom = scrollHeight - scrollTop - clientHeight < threshold`；用户从底部上滚越过阈值（`isAtBottom` 由 true 转 false 且非程序触发）-> `paused = true`。
- `resume()`：`scrollTop = scrollHeight`，`paused = false`，`unreadCount = 0`。
- 程序触发的滚动需设标志位避免误判为用户上滚。

### 悬浮「↓ 新消息」按钮

各聊天容器加 `relative`，按钮 `absolute bottom-2 right-2`，仅当 `paused && unreadCount > 0` 显示，文案 `↓ ${unreadCount} 条新消息`，点击 `resume()`。封装为 `<NewMessagesButton stick={...} />` 组件复用。

### 应用点

| 位置 | 改动 |
|---|---|
| `apps/desktop/src/pages/TaskDetail.tsx:74-77` | 删除无条件 `scrollTop=scrollHeight` effect，改用 `useStickToBottom([messages, interactions])`；容器（`:175`）加 `relative`；挂 `NewMessagesButton`。 |
| `apps/desktop/src/pages/Workspace.tsx` `AiRefineRequirement`（约 `:456`） | `h-48 overflow-y-auto` 容器接 hook + 按钮。 |
| `apps/desktop/src/pages/Workspace.tsx` `AiCreateTask` | 同上。 |

流式通道不变：任务详情走 `ai-devflow:stream`，AI 弹窗聊天走 `ai-devflow:ai-stream`。

### 边界

- 容器首次挂载且无消息：不滚动，无按钮。
- 用户在底部时新消息到来：自动粘底，`paused` 保持 false。
- 用户上滚后再次手动滚回底部（`isAtBottom`）：自动 `resume`（隐式恢复），按钮消失。

---

## ② 按 Agent 覆盖服务商/模型

### 数据模型

`packages/core/src/provider.ts` 新增：

```ts
export type AgentKey =
  | 'planner' | 'coder' | 'reviewer' | 'tester'
  | 'requirement_refiner' | 'task_proposer' | 'chat';

export interface AgentModelOverride {
  agentKey: AgentKey;
  providerId: string;   // 指向某个 ProviderConfig.id
  model: string;        // 强制使用的模型 id
}

// 工作负载 -> agent 键
export function workloadAgentKey(workload: Workload): AgentKey;
```

`workloadAgentKey` 映射：
- `requirement_chat` -> `requirement_refiner`
- `task_proposal` -> `task_proposer`
- `planner` / `coder` / `reviewer` / `tester` -> 同名
- `task_chat` -> `chat`
- `requirement_proposal` -> `chat`（目前 UI 未用，归并到 chat）

### 存储

复用 `apps/desktop/electron/provider-store.ts` 的加密元数据 blob，在其 JSON 中新增字段 `agentOverrides: AgentModelOverride[]`（无密钥，但与 provider 元数据同处便于一致性与原子保存）。新增方法：
- `listAgentOverrides(): AgentModelOverride[]`
- `saveAgentOverride(o: AgentModelOverride): void`（按 `agentKey` upsert）
- `removeAgentOverride(agentKey: AgentKey): void`

保存时 bump 对应 provider 的 `revision`？不必要——覆盖引用 providerId，provider 自身变更已通过 `revision` 清健康。覆盖变更不影响健康状态。

### IPC

新增通道（`apps/desktop/electron/ipc.ts`，前缀 `ai-devflow:agent-overrides:`）：
- `list` -> `AgentModelOverride[]`
- `save` (body: `AgentModelOverride`) -> `AgentModelOverride[]`
- `remove` (body: `AgentKey`) -> `AgentModelOverride[]`

preload `api.agentOverrides.{list,save,remove}`。

### 路由

`packages/agents/src/provider-router.ts`：
- `ProviderRouterDeps` 新增 `agentOverrideFor?: (workload: Workload) => { providerId: string; model: string } | undefined`（生产级，替代现有仅测试用的 `modelRouteFor` 测试缝——将 `modelRouteFor` 测试迁到 `agentOverrideFor`）。
- `routesFor(workload)`：若 `agentOverrideFor(workload)` 返回覆盖，则：
  1. 从 `listProviders()` 过滤 `id === override.providerId` 且 `enabled` 且有凭证；
  2. 命中则构造单条 `ProviderRoute`，`model = override.model`，`thinking` 取 `DEFAULT_THINKING_BY_ROLE[workloadRoleKey(workload)]`，`models` 取该 provider 的模型列表；
  3. **若该 provider 被熔断/不可用，回退到正常有序路由**（保留韧性）；
  4. 未命中（provider 不存在/禁用）也回退到正常路由，并经 health 记录 `configuration_error`。
- 无覆盖时走原 `workloadModels[role] ?? defaultModel`。

**决策**：覆盖不可用时**回退到默认路由**而非直接失败——保留既有熔断降级能力，UI 注明「专用服务商不可用时可能回退到默认路由」。

### 生产接线

`apps/desktop/electron/pi-runtime.ts:132-139` 的 `ProviderRouter` 构造增加：
```ts
agentOverrideFor: (workload) => {
  const o = providerStore.listAgentOverrides().find(x => x.agentKey === workloadAgentKey(workload));
  return o ? { providerId: o.providerId, model: o.model } : undefined;
},
```

### 设置 UI

`apps/desktop/src/pages/Settings.tsx` 新增 `AgentModelSection`（置于 `ProviderSection` 之后）：
- 表格列出全部 `AgentKey`（中文友好名 + 对应工作负载说明，如「需求细化（requirement_chat）」）。
- 每行显示「当前生效」：解析覆盖或默认路由得到的 provider 名 + model。
- 覆盖列：provider 下拉（含「跟随默认路由」空选项）+ model 下拉（选中 provider 后联动，兼容网关走 `listModels`，其余手动输入）。
- 保存即时调用 `api.agentOverrides.save/remove`。

同时改善现有 `workloadModels` 区块（`Settings.tsx:593-602`）的标签：在 `MODEL_ROLES` 旁补 agent 友好名与说明文案，解决「难以理解角色↔agent 映射」。

### 边界

- 覆盖引用的 provider 被删除：`listAgentOverrides` 时过滤失效引用（或 UI 标红提示），保存路由时忽略失效覆盖。
- 覆盖的 model 不在该 provider 的模型列表中：仍允许（手动输入兜底），路由时直接使用。

---

## ③ 新建需求：AI 两步流程为唯一入口

### `CreateReqButton` 重构（`apps/desktop/src/pages/Workspace.tsx:344`）

移除 `mode: 'manual' | 'ai'` 切换，始终两步布局：

- **Step 1（上）AI 沟通**：复用 `AiRefineRequirement` 对话面板（含 ① 的自动滚动）。AI 调 `ai_devflow_propose_requirement` -> 草稿经 `onApplied` 填入 Step 2。
- **Step 2（下）确认需求**：可编辑 `title/description/priority/acceptance` 表单 + 「创建需求」按钮。草稿到达前字段为空但**允许直接编辑**（用户可在 AI 草稿基础上改，或清空重写）。创建按钮在 `title` 非空时启用。
- **无可用服务商**：Step 1 显示空态 + 「前往设置配置 AI 服务商」链接；Step 2 创建按钮 disabled。检测条件：`api.providers.list()` 无 `enabled && hasCredential && hasModelConfig` 的 provider。

落库链路不变：`submit()` -> `api.requirements.create` -> `ai-devflow:requirements:create` -> `repos.requirements.insert`。

### 边界

- AI 产出的草稿用户不满意：继续在 Step 1 对话补充，AI 重新调 tool 覆盖 Step 2 字段（提示「已更新草稿」）。
- 用户清空 Step 2 自行填写：允许，直接创建。

---

## ④ AI 生成任务弹窗：默认 AI + 逐条编辑 + 可重生成 + 一键创建

### `CreateTaskModal`（`Workspace.tsx:466`）

默认 `mode: 'ai'`；保留 `manual` 作为次级 tab（`ManualCreateTask` 不变）。

### `AiCreateTask` 重构（`Workspace.tsx:540`）

布局自上而下：
1. **需求摘要**（只读）：展示当前 requirement 的 title/description/acceptance（来自 context）。
2. **补充说明输入框**（可选）+ 「生成任务」按钮：
   - 首次生成允许空消息——仅用 requirement context 调 `api.ai.propose`（移除 `Workspace.tsx:622` 的 `messages.length === 0` 门禁；`propose` 在空消息时仅发送 context block，已支持）。
   - 携带补充说明时：将说明作为一条 user message 追加到历史，再 `propose`。
3. **草稿列表**：每行内联可编辑 `title/description/role/dependsOn`（dependsOn 为同 requirement 兄弟草稿的 `draftId` 复选）；支持删除行、「新增空行」。
4. **「补充说明并重新生成」**：在输入框填写说明 -> 重新 `api.ai.propose`（携带历史 + 补充）-> **替换**草稿列表（用户已编辑的内容会丢失，需二次确认）。
5. **「创建全部」**：`api.tasks.createBatch({ requirementId, proposals })`（已有原子批量落库 + DAG `draftId->real id` 重写）。

自动滚动复用 ① 的 hook（聊天区，若有；生成阶段为结构化返回，无流式滚动需求）。

### 边界

- 重新生成覆盖已编辑草稿：弹确认「重新生成将覆盖当前草稿，是否继续？」。
- 空草稿行（title 为空）在「创建全部」时过滤或拦截提示。
- DAG 校验失败（`validateProposalDag`）：在草稿列表上方展示错误原因，禁止创建。

---

## 实施计划拆分

建议拆为两份独立实施计划（各自可独立交付、独立测试）：

- **计划 A：工作台对话与需求/任务流 UX**（①③④）
  - 共享 `useStickToBottom` hook + `NewMessagesButton`
  - 三处聊天接入自动滚动
  - 需求 AI 两步唯一入口
  - 任务弹窗默认 AI + 逐条编辑 + 重生成 + 一键创建
- **计划 B：按 Agent 覆盖服务商/模型**（②）
  - 数据模型 + 存储 + IPC
  - 路由覆盖 + 回退 + 生产接线
  - 设置 UI `AgentModelSection` + 现有区块文案改善

两计划无硬依赖，可并行；计划 A 不依赖计划 B。

## 验证

- `pnpm verify`（typecheck + lint + test）通过。
- 新增单测：`useStickToBottom`（jsdom 模拟滚动）、`workloadAgentKey`、`routesFor` 覆盖+回退、`ProviderStore` 覆盖 CRUD。
- `pnpm --filter @ai-devflow/desktop e2e` 覆盖需求两步流与任务生成弹窗。
- 手测：三处聊天自动滚动/暂停/恢复；设置页覆盖配置生效；无服务商空态。
