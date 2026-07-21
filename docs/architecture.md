# ai-devflow 架构

ai-devflow 是一个基于 Electron 的本地 AI 开发工作台。它把“需求 → 开发 → 沟通 → 测试 → 归档”的完整研发流
程做成六泳道看板，由本地 AI Agent 桥接器（Claude Code、Codex、Pi）在隔离的 Git worktree 中真实执行任务，
并通过 SQLite 持久化全部状态、执行记录、检查点与通知，支持应用重启后恢复。

本文是维护者的权威参考：模块边界、数据流、安全模型、状态机、桥接器协议、调度器、通知系统，以及如何扩展
自定义 Agent。

## 1. 顶层目标与约束

- 本地优先：所有数据、worktree、执行日志都落在本机，不依赖远端服务。
- 真实执行：Agent 桥接器调用真实 CLI（`claude` / `codex` / `pi`），不伪造结果。
- 可恢复：SQLite 单一事实源，重启后能识别运行中/待沟通任务并恢复计时与上下文。
- 安全：Renderer 无 Node.js 权限，IPC 通道显式白名单，凭证用 `safeStorage` 加密落盘。
- 可扩展：新增 Agent 只需实现 `AgentAdapter` 协议并注册。

## 2. Monorepo 结构

pnpm workspace 管理，共享包源码直供（`main` 指向 `src/index.ts`），由 vite / esbuild / vitest 直接转译，
共享包无需单独构建步骤。

```
ai-devflow/
├── packages/
│   ├── core/          # 纯 TS（零 Node 依赖）：领域模型、状态机、门禁、校验、脱敏、超时/Webhook 计算、类型
│   ├── persistence/   # node:sqlite：迁移、事务、Repository
│   ├── agents/        # AgentAdapter 协议 + 三桥接器 + 可控测试适配器 + 检测
│   ├── scheduler/     # 编排：角色分派/流水线/并发/依赖/worktree/检查点/暂停/恢复/取消/重试/待沟通
│   └── notifications/ # 超时规则/桌面通知/深链/防重复/Webhook 配置/签名/重试/投递历史
├── apps/
│   └── desktop/       # Electron：main + preload + renderer(React)
│       ├── electron/  # main 进程、preload、类型化 IPC、服务装配
│       └── src/       # renderer：页面与组件
└── docs/architecture.md
```

边界纪律：`core` 不得 `import` 任何 Node 内建或第三方 Node 包——它是 Renderer 与 Main 的共享契约。
`persistence`/`agents`/`scheduler`/`notifications` 仅在 Main 进程运行。Renderer 只能通过 preload 暴露的
类型化 IPC 与 Main 通信。

## 3. 进程模型与安全

```
┌─────────────────────────────┐        typed IPC (显式通道)        ┌──────────────────────────┐
│  Renderer (React, 浏览器环境) │  ───────────────────────────────▶ │  Main (Node/Electron)     │
│  nodeIntegration=false       │                                    │  scheduler / agents       │
│  contextIsolation=true       │  ◀───────────────────────────────  │  persistence(sqlite)      │
│  sandbox=true                │        事件订阅(经 preload)         │  notifications            │
│  CSP 严格                    │                                    │  worktree / 子进程        │
└─────────────────────────────┘                                    └──────────────────────────┘
```

- `BrowserWindow` 配置 `webPreferences.nodeIntegration=false`、`contextIsolation=true`、`sandbox=true`。
- `preload.ts` 通过 `contextBridge` 仅暴露 `window.api`，每个方法对应一个显式 IPC 通道；不存在“任意命令执行”入口。
- CSP 通过 `session.defaultSession.webRequest.onHeadersReceived` 注入，禁止 `unsafe-inline`/远程脚本。
- 凭证（Webhook secret、Agent API key）通过 Electron `safeStorage.encryptString` 加密后写入 SQLite，
  读出时解密；DB 文件本身不含明文密钥。
- 危险操作（删除项目、归档、强制取消）在 Main 校验 + Renderer 二次确认。

## 4. 领域模型与六泳道状态机

实体：`Project`、`Iteration`、`Requirement`、`Task`、`ExecutionRecord`、`Checkpoint`、
`NotificationRule`/`NotificationDelivery`、`WebhookConfig`/`WebhookDelivery`、`Credential`。

六泳道（Task.status）：

| 状态               | 含义           |
| ------------------ | -------------- |
| `backlog`          | 需求池         |
| `ready`            | 待开发         |
| `in_progress`      | 开发中（执行） |
| `awaiting_input`   | 待沟通         |
| `in_review`        | 待测试         |
| `archived`         | 已归档（终态） |

合法迁移（`core/state-machine.ts`）：

```
backlog        --(gate: 有需求+验收标准)--> ready
ready          --(gate: 已分配 Agent)--> in_progress
in_progress    --(agent 提问)--> awaiting_input
awaiting_input --(用户回答，从检查点恢复)--> in_progress
in_progress    --(gate: agent 报告完成+有产物)--> in_review
in_review      --(gate: 测试失败，附证据)--> in_progress   # 退回开发
in_review      --(gate: 测试通过+审计 OK)--> archived
```

任何其它迁移为非法，状态机与拖拽校验共同拒绝。门禁判定见 `core/gates.ts`：
- `canTransition(task, target, ctx)` 返回 `{ ok, reasons[] }`。
- 拖拽时 Renderer 调用 `validateTransition`，Main 落库前再校验一次（防绕过）。
- 状态审计 `auditTask(task, ctx)` 比对任务记录与实际 worktree 产物/测试结果，输出 `inconsistencies[]`。

## 5. Agent 桥接器协议

`agents/types.ts`：

```ts
interface AgentAdapter {
  readonly id: AgentType;                 // 'claude_code' | 'codex' | 'pi' | 'test'
  detect(): Promise<AgentDetection>;      // { available, version?, path?, reason? }
  run(req: AgentRunRequest): AgentRun;    // 启动一次执行，返回事件流句柄
}
interface AgentRunRequest {
  taskId: string; prompt: string; cwd: string;
  resumeFrom?: Checkpoint; userInput?: string; // 待沟通恢复时携带
}
type AgentEvent =
  | { type: 'log'; level: 'info'|'warn'|'error'; text: string; t: number }
  | { type: 'file_change'; path: string; action: 'create'|'modify'|'delete'; t: number }
  | { type: 'test_result'; passed: boolean; summary: string; evidence: string; t: number }
  | { type: 'ask_user'; question: string; context: string; t: number }
  | { type: 'status'; stage: string; detail?: string; t: number }
  | { type: 'done'; summary: string; t: number }
  | { type: 'error'; message: string; recoverable: boolean; t: number };
interface AgentRun {
  events: AsyncIterable<AgentEvent>;
  cancel(): Promise<void>;
  pid?: number;
}
```

三桥接器实现：
- **ClaudeCodeAdapter**：`claude -p "<prompt>" --output-format stream-json`，逐行解析 JSON 事件映射为
  `AgentEvent`。`detect` 检查 `claude --version`。
- **CodexAdapter**：`codex exec --sandbox workspace-write "<prompt>"`（可配只读），解析 stdout/stderr。
  `detect` 检查 `codex --version`。
- **PiAdapter**：调用 `pi` CLI（若存在）。`detect` 报告 `available:false` 并给出原因与安装/验证步骤。
  运行时若不可用则返回 `error` 事件（不伪造成功）。
- **ControllableTestAdapter**：读取 `AI_DEVFLOW_TEST_SCRIPT` 环境变量指向的脚本，注入可控的
  日志/超时/提问/失败/协议边界，仅用于自动化测试。

`AgentRegistry` 按 `AgentType` 注册适配器；新增自定义 Agent 只需实现 `AgentAdapter` 并 `register(...)`。

## 6. 调度器与隔离

`scheduler/orchestrator.ts` 是 Main 进程的执行核心：

- **角色分派**：任务 `role`（如 `planner`/`coder`/`reviewer`）映射到 `AgentType`；可在项目设置覆盖。
- **流水线**：任务按 `stages: Stage[]` 顺序执行，每阶段产出 checkpoint。
- **并发上限**：信号量 `maxConcurrent`（默认 2），超出排队；保证不同任务的 worktree/日志互不覆盖。
- **阶段依赖**：后一阶段开始前校验前一阶段 checkpoint 存在且未失败。
- **Git worktree 隔离**：每个执行任务在 `<userData>/worktrees/<taskId>` 创建项目仓库的 worktree，
  分支名 `ai-devflow/<taskId>`；任务结束按策略保留或清理。`worktree.ts` 封装创建/列表/清理/异常诊断。
- **执行日志 / 检查点**：每个事件落 `ExecutionRecord`；checkpoint 序列化进 `Checkpoint` 表。
- **暂停 / 恢复 / 取消 / 失败 / 重试**：`pause()` 停在下一检查点；`resume()` 从 checkpoint 继续；
  `cancel()` 终止子进程 + 清理 worktree（可选保留）；失败后 `retry()` 重新调度（保留 taskId，新建执行记录）。
- **待沟通**：Agent 发 `ask_user` → 任务转 `awaiting_input`，记录提问与上下文快照；用户回答后
  `resume(userInput)`，调度器把 `userInput` + 原 checkpoint 传给适配器 `run({resumeFrom, userInput})`。
- **恢复**：启动时扫描 `in_progress`/`awaiting_input` 任务，重建内存状态与计时器；`in_progress` 中
  的子进程若已死则标记失败并允许重试。

## 7. 通知与超时

`notifications/`：
- **持久化超时规则**：`NotificationRule { id, projectId?, status, minutes, channels }`；计算
  “任务在某状态停留 > minutes”的下次触发时间（`computeNextTrigger`，单元测试覆盖）。
- **桌面通知**：`Notification` API；点击通过深链 `ai-devflow://task/<id>` 聚焦窗口并跳转。
  防重复：同一任务同一规则在窗口期内只通知一次（记录在 `NotificationDelivery`）。
- **Webhook**：`WebhookConfig { url, secret, events }`；投递时 body=JSON，签名
  `X-AiDevflow-Signature: sha256=<HMAC-SHA256(secret, body)>`；失败指数退避重试（最多 N 次）；
  `WebhookDelivery` 记录每次投递的状态码、耗时、响应摘要。提供“测试投递”按钮。
- **重启恢复计时**：启动时根据任务 `statusChangedAt` + 规则重新计算已逾期项，补发或标记，
  计时器基于绝对时间戳而非进程内存，重启后正确恢复。

## 8. 数据持久化

`persistence/db.ts` 用 Node 26 内建 `node:sqlite`（`DatabaseSync`），无原生编译依赖。迁移系统
`migrations/` 版本化；`tx(fn)` 封装事务；每个实体一个 Repository。DB 文件位于
`<userData>/ai-devflow.db`，WAL 模式。集成测试覆盖迁移、事务回滚、Repository 生命周期。

## 9. 测试策略映射

| 要求 | 位置 |
| --- | --- |
| 状态机合法/非法迁移 | `core/__tests__/state-machine.test.ts` |
| 门禁判定 | `core/__tests__/gates.test.ts` |
| 超时规则计算 | `core/__tests__/timeout.test.ts` |
| Webhook Payload/签名 | `core/__tests__/webhook.test.ts` |
| CLI 输出标准化 | `core/__tests__/cli.test.ts` |
| 重试与恢复策略 | `core/__tests__/retry.test.ts` |
| 输入校验/脱敏 | `core/__tests__/sanitize.test.ts` |
| SQLite 迁移/事务/Repository | `persistence/__tests__/` |
| 全生命周期 | `persistence/__tests__/lifecycle.test.ts` |
| 类型化 IPC | `apps/desktop/electron/__tests__/ipc.test.ts` |
| Agent Adapter + 可控进程 | `agents/__tests__/adapter.test.ts` |
| 调度/取消/恢复 | `scheduler/__tests__/orchestrator.test.ts` |
| 通知投递/重试 | `notifications/__tests__/webhook.test.ts` |
| worktree 生命周期 | `scheduler/__tests__/worktree.test.ts` |
| Electron E2E | `apps/desktop/e2e/*.spec.ts`（Playwright Electron） |

## 10. 扩展自定义 Agent

1. 在 `packages/agents/src/` 新增 `my-agent.ts`，实现 `AgentAdapter`（`id`/`detect`/`run`）。
2. 在 `agents/src/registry.ts` `register(new MyAdapter())`。
3. 在 `core` 的 `AgentType` 联合类型追加字面量，并在设置页提供配置项。
4. 用 `ControllableTestAdapter` 的模式写一个针对该适配器的协议边界测试。

桥接器只负责把 CLI 输出归一化为 `AgentEvent`，调度器、worktree、检查点逻辑对所有适配器通用。
