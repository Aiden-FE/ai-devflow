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

## 4. 领域模型与五泳道状态机

实体：`Project`、`Iteration`、`Requirement`、`Task`、`ExecutionRecord`、`Checkpoint`、
`NotificationRule`/`NotificationDelivery`、`WebhookConfig`/`WebhookDelivery`、`Credential`、`TaskMessage`/`PendingInteraction`。

泳道（Task.status，可见 5 条 + 1 个暂停标识）：

| 状态               | 含义                       |
| ------------------ | -------------------------- |
| `ready`            | 待开发（新建任务直接进入） |
| `in_progress`      | 开发中（执行）             |
| `testing`          | 测试中（开发完成，审查 Agent 自动审查） |
| `awaiting_input`   | 待沟通/待授权（暂停标识，不独立成道，保留 pausedFrom） |
| `in_review`        | 待验收（审查通过后进入）   |
| `archived`         | 已归档（终态）             |

`backlog`（需求池）已移除：新建任务直接进入 `ready`；历史 backlog 任务由迁移改为 ready（含通知规则与 paused_from）。
`testing` 是 `status` TEXT 列的新取值，向后兼容，无需 DDL 迁移（既有数据不受影响）；`tasks.listRecoverable` 将 `testing` 纳入可恢复运行态。

合法迁移（`core/state-machine.ts`）：

```
ready          --(gate: 已分配 Agent)--> in_progress
in_progress    --(agent 提问/需授权/手动暂停)--> awaiting_input
in_progress    --(gate: 开发完成+有产物)--> testing（开发任务禁止直接进待验收）
testing        --(gate: 审查通过 reviewPassed)--> in_review（合并并待验收）
testing        --(审查不通过，携反馈返工)--> in_progress
testing        --(手动暂停)--> awaiting_input
awaiting_input --(用户回答/授权/确认，从检查点恢复)--> in_progress / testing / in_review
in_review      --(验收不通过退回：原因必填)--> in_progress（立即修复）/ ready（仅改状态）
in_review      --(gate: 人工验收 accepted + 有产物)--> archived
```

任何其它迁移为非法，状态机与拖拽校验共同拒绝。门禁判定见 `core/gates.ts`：
- `canTransition(task, target, ctx)` 返回 `{ ok, reasons[] }`。
- 拖拽时 Renderer 调用 `validateTransition`，Main 落库前再校验一次（防绕过）。
- **测试中门禁**：进入 `testing` 需有执行产物；`testing -> in_review` 需 `reviewPassed === true`（由审查 Agent 通过后设置），拖拽/IPC 无法提供该字段即被拒绝。
- **归档门禁**：`archived` 需 `accepted === true && hasArtifacts === true`。`accepted` 只能由 `tasks.accept` 显式人工验收设置；`tasks.updateStatus(archived)` 直接拒绝，看板拖拽无法绕过。
- **退回门禁**：`canReject(ctx)` 要求 `rejectReason` 非空；退回原因写入任务消息/审计（`tasks.reject` 专用操作，禁止用无原因的 `updateStatus` 代替）。
- 状态审计 `auditTask(task, ctx)` 比对任务记录与实际 worktree 产物/测试结果，输出 `inconsistencies[]`。

**自动审查（reviewer Agent）**：开发阶段完成后编排器把任务转入 `testing`，解析 reviewer 角色的能力配置（全局+项目合并）并启动审查 Agent。审查上下文含需求描述/验收标准、任务目标、git diff/产物与基本规则（需求覆盖、测试/构建/lint、明显回归、安全问题、无关改动）。审查结论以 `REVIEW_VERDICT: PASS|FAIL` 解析，结论与证据持久化到执行记录摘要与任务对话；通过则合并特性分支并进入待验收，不通过则退回开发中携反馈返工（受 `maxReviewRounds` 约束，避免无限循环）。

## 5. Agent 桥接器协议

`agents/types.ts`：

```ts
interface AgentAdapter {
  readonly id: AgentType;                 // 'claude_code' | 'codex' | 'pi' | 'test'
  detect(): Promise<AgentDetection>;      // { available, version?, path?, reason? }
  run(req: AgentRunRequest): AgentRun;    // 启动一次执行，返回事件流句柄
  capabilities(): AgentCapabilitySupport; // 声明支持的能力，不支持者在 UI 禁用并说明
}
interface AgentCapabilitySupport {
  tools: boolean;          // 工具白名单限制
  plugins: boolean;        // 插件加载
  skills: 'all-or-none' | false;  // Claude Code 仅全开/全关
  approval: boolean;       // 把权限请求转为人工 approval_request
}
interface AgentRunRequest {
  taskId: string; prompt: string; cwd: string;
  resumeFrom?: Checkpoint; userInput?: string;   // 待沟通恢复时携带
  capabilities?: AgentCapabilities;              // 由 Orchestrator 解析的最终能力配置
  interactionResponse?: { kind: InteractionKind; value: string }; // 授权/确认恢复
}
type AgentEvent =
  | { type: 'log'; level: 'info'|'warn'|'error'; text: string; t: number }
  | { type: 'file_change'; path: string; action: 'create'|'modify'|'delete'; t: number }
  | { type: 'test_result'; passed: boolean; summary: string; evidence: string; t: number }
  | { type: 'ask_user'; question: string; context: string; t: number }
  | { type: 'approval_request'; toolName: string; toolUseId: string; requestId?: string; description: string; input?: string; t: number }
  | { type: 'status'; stage: string; detail?: string; t: number }
  | { type: 'done'; summary: string; t: number }
  | { type: 'error'; message: string; recoverable: boolean; t: number };
interface AgentRun {
  events: AsyncIterable<AgentEvent>;
  cancel(): Promise<void>;
  pid?: number;
}
```

**能力配置 → CLI 参数（均来自各 CLI `--help`，未臆造）**：
- Claude Code：`--allowedTools` / `--disallowedTools`（工具白/黑名单）、`--plugin-dir` / `--plugin-url`（插件）、
  `--disable-slash-commands`（Skills 全关，非空列表=全开）、`--permission-mode manual`（授权模式下逐工具暂停）。
- Codex：非交互 `exec` 不支持逐工具人工授权与插件/Skills；权限模型是沙箱（`--sandbox`）。如实声明均不支持。
- Pi：本机未安装，能力未经验证，如实声明均不支持。

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

`persistence/db.ts` 用 Node 26 内建 `node:sqlite`（`DatabaseSync`），无原生编译依赖。迁移在
`migrations.ts` 的 `MIGRATIONS` 数组版本化（当前 v8：v1 初始 schema → … → v7 `task_messages`+`pending_interactions`
→ v8 `tasks.requirement_id` 索引，支撑依赖 DAG 兄弟查询）；新增 `testing` 状态为 `status` TEXT 列新取值，
向后兼容、无需 DDL。`tx(fn)` 封装事务（含嵌套 savepoint）；`tasks.insertMany` 事务化批量插入（AI 提议原子落库）。
每个实体一个 Repository。应用级设置存于 `credentials` KV 表（`locale`/`theme` 明文，`ai_provider` 加密 JSON，
`global_agent_config` 明文 JSON——全局 Agent 能力默认配置）。DB 文件位于 `<userData>/ai-devflow.db`，WAL 模式。
集成测试覆盖迁移、事务回滚、Repository 生命周期、批量插入原子性。

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

## 11. 自动更新与发版

**应用内更新**（`apps/desktop/electron/updater.ts`）：
- 基于 `electron-updater` + electron-builder 的 GitHub Provider。仅 `app.isPackaged` 时启用；
  开发/E2E 返回 no-op，`electron-updater` 不可用时降级为 no-op，均不影响应用。
- 启动后异步检查（不阻塞 ready），发现版本后静默下载（`autoDownload=true`，
  `autoInstallOnAppQuit=false`）。
- 状态经类型化 IPC `updates.status()/check()/installUpdate()` 暴露，并通过 `update-status`
  事件流转发 Renderer：`idle/checking/available/downloading/downloaded/installing/error/no-update`，
  downloading 时附带进度。
- 下载完成在设置页提示当前/新版本，仅保留「立即升级」（已移除「稍后」）。
- `installUpdate()` 返回 `InstallUpdateResult`：
  - Windows / Linux / 已签名 macOS：调用 `quitAndInstall()`，进入 `installing` 状态，返回
    `action='install-started'`（仅表示安装请求已发起，不保证成功）。
  - 未签名 macOS：不调用 `quitAndInstall()`，由主进程打开固定 GitHub Releases URL，返回
    `action='manual-download'`，保持 `downloaded` 状态允许再次点击。
  - 不可安装（如未下载完成）或打开浏览器失败时进入可见 `error` 状态并返回可诊断信息，**绝不静默 no-op**。
- `installing` 语义为“已请求原生安装器，等待应用退出”。调用 `quitAndInstall()` 后启动可注入超时；
  若应用未退出且未收到错误，超时后回到可恢复的 `error`，避免 UI 永久停留在“正在安装并重启…”。
  updater 异步 error 也会清理计时器并进入 `error`。
- `createUpdater(deps)` 支持注入 `loadAutoUpdater`/`quitAndInstall`/`startDelayMs`，便于对状态机与
  事件做单元测试（开发环境 no-op 不再作为唯一验收依据）。
- 更新失败、无更新、校验失败仅记录错误状态，绝不抛出影响应用。

**electron-builder 配置**（`apps/desktop/package.json` `build`）：
- `appId=com.ai-devflow.desktop`、`productName=ai-devflow`、`asar=true`、构件命名含版本/平台/架构。
- `publish` 指向 GitHub（`Aiden-FE/ai-devflow`）；mac 产出 `dmg`+`zip`（x64+arm64，更新链路用 zip），
  win `nsis`（x64），linux `AppImage`（x64）；图标 `build/icon.icns`（mac）、`build/icon.ico`（win）、`build/icon.png`（linux，1024px 容器版栅格源）。\n  品牌矢量源与生成脚本位于 `apps/desktop/brand/*.svg` 与 `apps/desktop/scripts/gen-brand-assets.mjs`，可重复产出全尺寸 PNG/ICNS/ICO/Linux 图标集。
- `directories.output=release`，`files` 打包 `dist/`+`dist-electron/`+`package.json`。

**发版工作流**（`.github/workflows/release.yml`，三段多平台流水线，依赖关系明确，避免并发创建同一 Release）：
- `workflow_dispatch` 输入 semver；`if: github.ref == 'refs/heads/main'` 仅允许基于 main 发布；
  校验 semver 合法性；用 `git ls-remote` + `gh release view` 拒绝重复 Tag/Release。
- **prepare**（ubuntu，唯一写 git 的阶段）：`pnpm install --frozen-lockfile` → `typecheck` → `lint` →
  `test` → `node scripts/gen-changelog.mjs`（生成「上一版本 tag → 当前版本」的 Release Notes 并 prepend
  到 `CHANGELOG.md`）→ 版本号 bump（根 + desktop）→ 提交 + 打 `v<version>` Tag + 推送。
- **build**（matrix: `macos-latest` / `windows-latest` / `ubuntu-latest`，`needs: prepare`）：checkout 该 Tag，
  `pnpm --filter @ai-devflow/desktop build` 后 `electron-builder --publish never`（只产构件 + blockmap +
  `latest*.yml`，**不创建 Release**），显式校验本平台预期构件齐全后 `upload-artifact`（`if-no-files-found: error`，
  任一预期构件缺失即失败，不以 ignore 掩盖）。
- **publish**（`needs: [prepare, build]`）：`download-artifact` 汇总三平台构件并复核完整构件集齐全后，
  `gh release create --verify-tag -F RELEASE_NOTES.md` **统一创建唯一一个 GitHub Release** 并附全部构件。
- `permissions: contents: write`（最小权限）。

**CHANGELOG / Release Notes**（`scripts/gen-changelog.mjs`，纯函数 + `node --test` 单测）：
- 计算上一版本 tag（semver 排序），取 `prevTag..HEAD` 提交，按约定式前缀分组为「新功能 / 问题修复 / 其他变更」，
  过滤 merge、`chore(release)` 版本号提交、dependabot 等噪音，附 GitHub compare 链接。
- Release 正文与仓库 `CHANGELOG.md` 对应小节一致，面向用户而非原始 commit log；重跑幂等（同版本小节去重）。

**Secrets**（仓库 Settings → Secrets → Actions）：
- 必需：`RELEASE_TOKEN`（contents:write，供推送 Tag、创建 Release 与上传构件）。
- 可选（mac 正式签名/公证；缺失则 `CSC_IDENTITY_AUTO_DISCOVERY=false` 产出未签名构件）：
  `MAC_CERTS`（base64 .p12）、`MAC_CERTS_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`。
  未签名 macOS 只能检测、下载更新，无法自动安装；从该版本升级到首个签名版本需要手动安装。

**验证流程**：触发发版后，Releases 出现 `vX.Y.Z` 与三平台安装包及 `latest-mac.yml`/`latest.yml`/`latest-linux.yml`/blockmap；
本地安装低于该版本的旧包，启动后 `electron-updater` 检测到更新并下载。
- Windows / Linux / 已签名 macOS：点击「立即升级」后自动退出并安装。
- 未签名 macOS：点击「立即升级」后主进程打开 GitHub Releases，用户需下载对应架构包并手动安装。

**仍受签名环境限制**：本机/CI 无 Apple 开发者证书时，mac 构件为未签名（首次打开需绕过 Gatekeeper），
无法做完整公证；未签名 macOS 不能自动安装，需手动下载并替换应用。GitHub Release 的实际创建依赖仓库存在且 `RELEASE_TOKEN` 具备写权限。
