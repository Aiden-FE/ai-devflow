# AI 生成流程增强 设计文档

> 日期：2026-07-24
> 范围：ai-devflow 桌面端 AI 生成需求/任务流程的 5 项增强
> 状态：已确认，待写实施计划

## 背景与现状

ai-devflow 桌面端的 AI 生成流程分两条执行路径：

- **PiRunner 路径**（`packages/agents/src/pi-runner.ts -> buildPiRunPlan`）：四角色开发执行 + 自动代码审查，有 tools/skills/extensions。
- **pi-ai chat 路径**（`apps/desktop/electron/pi-ai.ts`）：任务对话、需求对话、任务草稿生成、需求草稿生成。其中 `requirement_chat -> requirement_refiner`、`task_proposal -> task_proposer` 走 `STEP_AGENTS`（有 tools/skills/extensions）；`task_chat` / `requirement_proposal` 走 `--no-tools` 纯文本路径。

本设计涉及的 5 项需求全部落在 chat 路径及其前端弹窗上。

### 关键现状（来自代码探查）

- **前端**：无独立"需求详情页"，子任务内联在 `Workspace.tsx` 的 `ReqItem`；子任务列表只渲染 `StatusBadge + 标题`，**无删除入口**；`AiRefineRequirement` 与 `AiCreateTask` 各自内联一份聊天 UI（消息列表 `h-48` + 输入行），未抽共享组件；两弹窗均 `DialogContent className="max-w-lg"`（512px）。
- **流式**：`executeTextOnRoute` 把所有 delta 缓冲到进程结束才 `for (const delta of deltas) onDelta?.(delta)` 一次性 flush；`message_update` 分支只读 `ame.delta` 不看 `ame.type`，缓冲里可能混入 `thinking_delta`。
- **思维链抑制**：靠终态 content-block 过滤（`extractAssistantText` 只取 `type==='text'`）+ `done.fullText`，**不在参数层、不在 delta 事件过滤层**。
- **task_proposal 上下文**：只拼需求标题/描述/验收标准 + 真实仓库代码（`cwd=projectPath`）；**完全不传已有子任务**。
- **task_proposal 结果**：`{tasks:[{draftId,title,description,role,dependsOn:string[]}]}`，`dependsOn` 只引用同批 `draftId`。
- **进程通道**：`PiProcessSupervisor.spawn` 的 stdio = `['pipe','pipe','pipe']`，无 IPC 通道；stdin 被 `child.stdin?.end()` 立即关闭；工具 `execute()` 若返回未 resolve 的 Promise，子进程不发 stdout，120s 超时后 SIGKILL。
- **IPC**：聊天走 `ai-devflow:ai:chat`（renderer->main send）+ `ai-devflow:ai-stream` 反向推送，`AiStreamEvent` = `delta | done | error | requirement_proposal | task_proposal`。无"工具需 renderer 回答"的往返通道。
- **现有交互工具**：`ai_devflow_interaction`（仅 clarification/confirmation），只在 orchestrator 任务路径有暂停-恢复骨架（`json-events -> ask_user -> kill Pi -> awaiting_input -> resolveInteraction resume`）；chat 路径不处理它。

## 决策汇总

| 需求 | 决策 |
|---|---|
| 1 子任务删除 | 硬删除 + 依赖守卫（被 dependsOn 引用时拒绝删除） |
| 2 流式输出 | 立即转发 `text_delta` + 加类型守卫，保留终态覆盖与 done.fullText |
| 3 已有子任务 | 传入上下文 + 允许跨批依赖（dependsOn 可引用已有 taskId） |
| 4 问答工具 | 聊天路径落地（requirement_chat + task_proposal）；方案 A 子进程 IPC 通道 |
| 5 弹窗 | 大模态（~92vw×88vh）+ 统一 ChatPanel 组件 |

## 详细设计

### 需求 1：子任务删除（硬删除 + 依赖守卫）

**前端**（`apps/desktop/src/pages/Workspace.tsx` 的 `ReqItem`）：
- 子任务每行加删除按钮（hover 显示 Trash 图标），点击弹确认（复用 `AlertDialog` 或轻量 `Popover`）。
- 删除失败（被引用）时 toast 提示"先解除 N 个任务的依赖：<标题列表>"。

**后端**：
- `packages/core` TaskRepo 加 `delete(taskId)`。
- electron IPC 加 `tasks.delete`（`apps/desktop/electron/ipc.ts` + `preload.ts` + `api.ts` 契约）。
- 删除前查 `tasks.filter(t => t.dependsOn?.includes(taskId))`；非空则**拒绝删除**，返回 `{ ok:false, blockedBy: [{id,title}] }`。

**守卫范围**：只挡 `dependsOn` 引用（含跨批依赖落地后旧批次任务被引用的情况）。

### 需求 2：AI 流式输出

**改动点**：`apps/desktop/electron/pi-ai.ts` 的 `executeTextOnRoute`，`message_update` 分支。

```ts
// 改前：缓冲
if (event.type === 'message_update') {
  const ame = event.assistantMessageEvent;
  const delta = typeof ame?.delta === 'string' ? ame.delta : '';
  if (delta) { full += delta; deltas.push(delta); }
}
// 末尾：for (const delta of deltas) onDelta?.(delta);

// 改后：立即转发 + 类型守卫
if (event.type === 'message_update') {
  const ame = event.assistantMessageEvent;
  if (ame?.type === 'text_delta') {
    const delta = typeof ame.delta === 'string' ? ame.delta : '';
    if (delta) { full += delta; onDelta?.(delta); }
  }
}
// 删除 deltas 数组与末尾 flush 循环
```

**保留不动**：
- 终态 `full = extractAssistantText(msg)`（text-block-only 权威覆盖）。
- `done.fullText`（ipc.ts / preload.ts）。
- `extractAssistantText` 的 thinking 块过滤。

**前端配合**（`Workspace.tsx` 两处聊天面板的 `catch`）：流式后错误前已发 delta 会让 assistant 占位消息非空；当前 catch 只删 `content === ''` 的占位。改为：错误时把该 assistant 消息标记为"（生成中断）"而非删除，避免残留半截无标注文本。

**适用范围**：所有 chat 模式（requirement/task_chat/task_proposal），无需区分 workload。

### 需求 3：已有子任务上下文 + 跨批依赖

**前端 context 拼装**（`AiCreateTask`）：在现有需求上下文后追加已有子任务清单——

```
【已有子任务】（请勿重复创建，新任务可依赖这些任务）
- [T-abc123] 「已实现登录页」 状态:done 依赖:[]
- [T-def456] 「对接后端API」 状态:todo 依赖:[T-abc123]
```

字段：`taskId`、`title`、`status`、`description`（截断）、`dependsOn`（已有任务的依赖 taskId）。

**工具 schema 扩展**（`packages/agents/assets/profiles/shared/extensions/task-bridge.ts`）：`dependsOn` 描述改为"依赖的任务标识列表，可引用同批次 draftId 或已有任务 taskId（形如 T-xxx）"。

**SYSTEM.md 更新**（`packages/agents/assets/profiles/steps/task_proposer/SYSTEM.md`）：增加"已有子任务清单"段落，明确"不得重复创建已存在任务；新任务依赖已有任务时用其 taskId"。

**后端校验**（`apps/desktop/electron/ipc.ts` 的 `task_proposal` 处理）：
- `dependsOn` 项若匹配已有 taskId 则原样保留。
- 若匹配同批 draftId 则在创建后解析为对应新任务的 taskId（draftId->新 taskId 映射替换）。
- 都不匹配则过滤并记日志（不阻断）。
- 同批依赖也要在创建后从 draftId 替换为真实 taskId，保证存储一致。

**草稿编辑器**（`AiCreateTask` 的 `dependsOn` 下拉）：选项同时列出"已有任务"和"本批草稿"，用户可手动调整。

### 需求 4：问答工具 `ai_devflow_ask`（方案 A：子进程 IPC）

改动最大，分四层。

#### 4.1 工具 schema 与 execute（`packages/agents/assets/profiles/shared/extensions/ask-bridge.ts`，新建）

注册 `ai_devflow_ask`，参数支持多 tab、单选/多选/自由描述：

```ts
parameters: Type.Object({
  tabs: Type.Array(Type.Object({
    id: Type.String(),
    title: Type.String(),
    questions: Type.Array(Type.Object({
      id: Type.String(),
      kind: Type.Union([Type.Literal("single"), Type.Literal("multi"), Type.Literal("text")]),
      question: Type.String(),
      options: Type.Optional(Type.Array(Type.Object({
        value: Type.String(), label: Type.String(),
      }))),   // single/multi 必填，text 可选作为占位提示
      required: Type.Optional(Type.Boolean()),
    }), { minItems: 1 }),
  }), { minItems: 1 }),
})
```

`execute(id, input)`：
1. `process.send?.({ kind: 'ask', toolUseId: id, payload: input })` 向父进程发请求。
2. `await new Promise((resolve) => { pending.set(id, resolve); })` 阻塞等待答案。
3. 收到 `process.on('message')` 的 `{ kind:'ask_answer', toolUseId: id, answers }` 后 resolve。
4. 返回 `{ content:[{type:'text', text:JSON.stringify({aiDevflowAsk:input, answers})}], details:{ input, answers } }`。

`pending` Map 在模块级维护（toolUseId -> resolve）。`process.on('message')` 监听器在扩展加载时注册一次。

#### 4.2 进程通道改造（`packages/agents/src/process-supervisor.ts`）

- `SpawnFn` 的 `stdio` 类型与实际 spawn 改为 `['pipe','pipe','pipe','ipc']`。
- `SpawnedPi` 暴露 `send(msg)` 与 `onMessage(cb)`，内部委托给 `child.send` / `child.on('message')`。
- stdin 仍 `end()`（不抢 stdin）。
- **超时**：问答暂停期间 120s 超时会误杀。设计采用：问答挂起期间暂停 supervisor 超时定时器，收到答案后恢复。具体：`SpawnedPi` 增加活动时间戳，或在 `onMessage` 收到 `ask` 时 `clearTimeout(timer)`、收到 `ask_answer` 后重设。

#### 4.3 main 侧桥接（`apps/desktop/electron/pi-ai.ts` + `ipc.ts`）

- `executeTextOnRoute` 的 spawn 后，注册 `spawned.onMessage(msg)`：`msg.kind === 'ask'` -> 经 `onAsk?.(msg)` 上报。
- `createPiAiService.chat` 的 opts 增加 `onAsk` 回调。
- `ipc.ts` 的 `ai:chat` handler：`onAsk` -> `sendAi({ type:'question', sessionId, toolUseId, tabs })` 推给 renderer。
- 新增反向 IPC：renderer `api.ai.answer(sessionId, toolUseId, answers)` -> `ipcMain.on('ai-devflow:ai:answer')` -> `resolveAsk(sessionId, toolUseId, answers)` -> `spawned.send({ kind:'ask_answer', toolUseId, answers })` 回灌子进程。
- `AiStreamEvent` 增 `{ type:'question'; sessionId; toolUseId; tabs }`。
- **会话隔离**：service 层维护 `Map<sessionId, SpawnedPi>`，`resolveAsk` 按 sessionId 查到对应实例。`executeTextOnRoute` 完成后清理 map 条目。

#### 4.4 前端 UI（统一 ChatPanel 内，见需求 5）

- 收到 `question` 事件：在消息列表插入一条"问答卡片"消息（区别于普通气泡），渲染 tab 切换 + 每个问题的表单控件（single=Radio、multi=Checkbox、text=Textarea）。
- 底部"提交"按钮：校验所有 `required` 问题已答 -> 调 `api.ai.answer` -> 卡片转"已提交"只读态，Pi 收到答案后继续。
- 一次问答只提交一次，提交后卡片锁定。

#### 4.5 step agent 接线

- `STEP_AGENTS['requirement_refiner'].tools` 与 `['task_proposer'].tools` 增加 `'ai_devflow_ask'`。
- `BUILTIN_EXTENSIONS` 池加 `ask-bridge`；两个 step 的 `extensions` 增加 `'ask-bridge'`。
- 两个 SYSTEM.md 增加工具使用说明（何时该问、问什么粒度）。

### 需求 5：大模态 + 统一 ChatPanel

**新组件** `apps/desktop/src/components/ChatPanel.tsx`：
- 封装消息列表（含问答卡片渲染槽）+ 输入行，复用 `useStickToBottom` + `NewMessagesButton`。
- props：`messages`、`onSend`、`renderSpecialMessage`（问答卡片渲染回调）、`loading`。
- 消息类型扩展：`AiChatMessage` 增加可选 `kind?: 'text' | 'question'` 与 `question?: { toolUseId, tabs, submitted }` 字段，承载问答卡片状态。

**弹窗尺寸**：两处 `DialogContent` 改为 `className="max-w-[min(1200px,92vw)] w-[92vw] h-[88vh] max-h-[88vh]"`，内部 flex 布局：上方 ChatPanel（弹性高度）+ 下方草稿/确认区（固定高度可滚动）。

**重构**：`AiRefineRequirement`/`AiCreateTask` 改为消费 `ChatPanel`，删除内联的 `h-48` 列表与输入行。问答卡片作为 ChatPanel 的特殊消息类型渲染（需求 4 的 UI 落点）。

## 需求间依赖与实施顺序

1. **需求 2（流式）** 独立，最先做，风险低、立即改善体验。
2. **需求 5（大模态+ChatPanel）** 次之，为需求 4 的问答卡片提供渲染容器。
3. **需求 1（子任务删除）** 独立，可与 2/5 并行。
4. **需求 3（已有子任务上下文）** 依赖需求 1 的删除能力（删除会改变已有子任务清单），建议在 1 之后；改动分散在 context 拼装 + schema + SYSTEM.md + 校验。
5. **需求 4（问答工具）** 最复杂，依赖需求 5 的 ChatPanel（问答卡片渲染）、依赖需求 2 的流式基线（避免与流式改造冲突），放最后。

## 待验证风险点

- **Pi 子进程是否占用 ipc 通道**：方案 A 前提是 Pi 不使用 `process.send`/ipc。Pi 是独立 node CLI 入口，按设计不声明 ipc 使用。实现第一步需用最小 spawn 验证 `child.on('message')` 可收发。若冲突，回退方案 C（文件协议）。
- **问答超时**：需确保问答挂起期间不被 120s 超时杀进程（设计已含"挂起超时定时器"）。
- **流式错误残留**：错误前已发 delta 的半截消息需前端标注清理（设计已含"标记生成中断"）。

## 与现有架构的一致性

- `STEP_AGENTS` 注册表模式延续（`requirement_refiner` / `task_proposer` 增量扩展 tools/extensions），不引入新范式。
- chat 路径的 `AiStreamEvent` 增量扩展（新增 `question` 类型），不破坏现有 delta/done/error/proposal 协议。
- 工具沿用 `pi.registerTool` + typebox schema 的现有约定，`ask-bridge.ts` 与 `task-bridge.ts`/`requirement-bridge.ts` 同构。
- 问答工具 schema 设计为可复用：未来 orchestrator 路径若要支持，可复用 schema，只需在 `json-events.ts` 识别新工具并扩展 `PendingInteraction`。
