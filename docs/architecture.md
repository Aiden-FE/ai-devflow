# ai-devflow 架构

ai-devflow 是一个基于 Electron 的本地 AI 开发工作台。它把“需求 → 开发 → 沟通 → 测试 → 归档”的完整研发流程做成六泳道看板，由**内置、版本固定的 Pi 运行时**（`@earendil-works/pi-coding-agent@0.80.10`，随应用打包）在隔离的 Git worktree 中真实执行任务，并通过 SQLite 持久化全部状态、执行记录、检查点与通知，支持应用重启后恢复。

用户无需安装 `claude`、`codex`、`pi` 或任何 Agent CLI，也无需管理 Node.js 版本、模型、工具、扩展、Skills 或系统提示词。用户唯一需要管理的 AI 运行配置是一个**有序的 AI 服务商列表**：应用按任务角色选择内置 Pi 配置与内置模型，首选服务商不可用时自动尝试同服务商备用模型及列表中的后续服务商。

本文是维护者的权威参考：模块边界、数据流、安全模型、状态机、内置 Pi 运行时、调度器、通知系统、持久化迁移与发版流程。

## 1. 顶层目标与约束

- **本地优先**：所有数据、worktree、执行日志都落在本机，不依赖远端服务。
- **真实执行**：由随应用发布的固定版本 Pi 在真实子进程中运行，不伪造结果。
- **单一运行时**：生产环境不再有 Agent registry、Agent 类型选择或外部 CLI 检测；调度器依赖单一 `AgentRunner` 接口，生产实现为 `PiRunner`。
- **可恢复**：SQLite 单一事实源，重启后能识别运行中/待沟通任务并恢复计时与上下文。
- **安全**：Renderer 无 Node.js 权限，IPC 通道显式白名单，凭证用 `safeStorage` 加密落盘，子进程环境从空白白名单构造。
- **可观测降级**：一个提供商故障时，在安全、有限、可观测的边界内自动降级；全部失败时进入可恢复状态。

## 2. Monorepo 结构

pnpm workspace 管理，共享包源码直供（`main` 指向 `src/index.ts`），由 vite / esbuild / vitest 直接转译，共享包无需单独构建步骤。

```
ai-devflow/
├── packages/
│   ├── core/          # 纯 TS（零 Node 依赖）：领域模型、状态机、门禁、校验、脱敏、超时/Webhook 计算、Provider 契约
│   ├── persistence/   # node:sqlite：迁移（含 v9 备份/回滚）、事务、Repository（含 provider_health / execution_attempts）
│   ├── agents/        # 内置 Pi 运行时：locator、profile registry、run-plan、process supervisor、JSON event translator、
│   │                  # ProviderRouter、AttemptJournal、PiRunner；测试 fake runner 仅用于集成测试
│   ├── scheduler/     # 编排：单一 AgentRunner 驱动、流水线、并发/依赖/worktree/检查点/暂停/恢复/取消/重试/待沟通
│   └── notifications/ # 超时规则/桌面通知/深链/防重复/Webhook 配置/签名/重试/投递历史
├── apps/
│   └── desktop/       # Electron：main + preload + renderer(React)
│       ├── electron/  # main 进程、preload、类型化 IPC、服务装配、ProviderStore、Pi AI 服务
│       └── src/       # renderer：页面与组件
├── packages/pi-runtime-bundle/  # 精确版本 Pi 生产依赖，用于 staging
├── docs/architecture.md
└── scripts/           # 真实 Pi 验证、发版 CHANGELOG 等
```

边界纪律：`core` 不得 `import` 任何 Node 内建或第三方 Node 包——它是 Renderer 与 Main 的共享契约。`persistence`/`agents`/`scheduler`/`notifications` 仅在 Main 进程运行。Renderer 只能通过 preload 暴露的类型化 IPC 与 Main 通信。

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

- `BrowserWindow` 配置 `webIntegration=false`、`contextIsolation=true`、`sandbox=true`。
- `preload.ts` 通过 `contextBridge` 仅暴露 `window.api`，每个方法对应一个显式 IPC 通道；不存在“任意命令执行”入口。
- CSP 通过 `session.defaultSession.webRequest.onHeadersReceived` 注入，禁止 `unsafe-inline`/远程脚本。
- 凭证（Webhook secret、Provider API Key）通过 Electron `safeStorage.encryptString` 加密后写入 SQLite；DB 文件本身不含明文密钥。
- 危险操作（删除项目、归档、强制取消）在 Main 校验 + Renderer 二次确认。

## 4. 领域模型与五泳道状态机

实体：`Project`、`Iteration`、`Requirement`、`Task`、`ExecutionRecord`、`Checkpoint`、
`NotificationRule`/`NotificationDelivery`、`WebhookConfig`/`WebhookDelivery`、`Credential`、`TaskMessage`/`PendingInteraction`。

泳道（Task.status，可见 5 条 + 1 个暂停标识）：

| 状态               | 含义                       |
| ------------------ | -------------------------- |
| `ready`            | 待开发（新建任务直接进入） |
| `in_progress`      | 开发中（执行）             |
| `testing`          | 测试中（开发完成， reviewer 自动审查） |
| `awaiting_input`   | 待沟通/待授权（暂停标识，不独立成道，保留 pausedFrom） |
| `in_review`        | 待验收（审查通过后进入）   |
| `archived`         | 已归档（终态）             |

合法迁移（`core/state-machine.ts`）：

```
ready          --(gate: 已配置可用 AI 服务)--> in_progress
in_progress    --(Pi 调用 ai_devflow_interaction / 需授权 / 手动暂停)--> awaiting_input
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
- **测试中门禁**：进入 `testing` 需有执行产物；`testing -> in_review` 需 `reviewPassed === true`（由 reviewer 角色通过后设置），拖拽/IPC 无法提供该字段即被拒绝。
- **归档门禁**：`archived` 需 `accepted === true && hasArtifacts === true`。`accepted` 只能由 `tasks.accept` 显式人工验收设置；`tasks.updateStatus(archived)` 直接拒绝，看板拖拽无法绕过。
- **退回门禁**：`canReject(ctx)` 要求 `rejectReason` 非空；退回原因写入任务消息/审计（`tasks.reject` 专用操作，禁止用无原因的 `updateStatus` 代替）。
- 状态审计 `auditTask(task, ctx)` 比对任务记录与实际 worktree 产物/测试结果，输出 `inconsistencies[]`。

**自动审查（reviewer 角色）**：开发阶段完成后编排器把任务转入 `testing`，启动 reviewer 角色执行审查。reviewer 工具集只读，禁止写文件、安装、提交和破坏性命令。审查结论通过 `ai_devflow_report_result` 返回；通过则合并特性分支并进入待验收，不通过则退回开发中携反馈返工（受 `maxReviewRounds` 约束，避免无限循环）。

## 5. 内置 Pi 运行时架构

生产环境不再有 Agent registry 或 Agent 类型选择。AI 执行统一沿以下流水线：

```
Task / Stage
    │
    ▼
RoleProfileRegistry ──────── immutable built-in role assets
    │
    ▼
ProviderRouter ───────────── ordered user provider configs + health
    │
    ▼
RunPlanResolver ──────────── role + provider + model + tools + resources
    │
    ▼
PiProcessSupervisor ──────── bundled Pi, isolated env/config/session
    │
    ▼
PiJsonEventTranslator ────── JSONL → AgentEvent / AttemptJournal
    │
    ▼
Orchestrator ─────────────── task state, checkpoint, worktree, retry
```

核心组件：

- **`BundledPiLocator`**（`packages/agents/src/runtime-locator.ts`）：从 `process.resourcesPath` 与 `runtime-manifest.json` 得到绝对 CLI 入口；自检清单版本、文件 SHA-256 摘要、入口可执行、`pi --version` 输出。任一失败即报告“应用运行组件损坏”，不回退 PATH。
- **`RoleProfileRegistry`**（`packages/agents/src/profiles.ts`）：维护 `planner`/`coder`/`reviewer`/`tester` 四角色的只读 profile，包含各自 `settings.json`、`SYSTEM.md`、内置 skills、工具白名单/排除项、模型映射、超时。
- **`ProfileMaterializer`**：将只读 profile 复制到内容寻址的隔离目录；兼容提供商生成引用环境变量名的 `models.json`，不把 API Key 写入快照。
- **`ProviderRouter`**（`packages/agents/src/provider-router.ts`）：按工作负载解析隐藏模型表，生成候选路线（primary → fallback → 下一提供商），维护持久化熔断健康状态，分类故障并执行有界降级。
- **`RunPlanResolver`**（`packages/agents/src/run-plan.ts`）：根据 route、role、execution/attempt ID 构造 Pi CLI 参数与空白白名单环境变量。
- **`PiProcessSupervisor`**（`packages/agents/src/process-supervisor.ts`）：以 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 启动 Pi，隔离 config/session/home/tmp，按角色超时管理进程生命周期。
- **`PiJsonEventTranslator`**（`packages/agents/src/json-events.ts`）：解析 JSONL 流，映射为 `AgentEvent`，维护 `AttemptJournal`，识别 `ai_devflow_interaction` 与 `ai_devflow_report_result`。
- **`AttemptJournalWriter`**（`packages/agents/src/attempt-journal.ts`）：持久化 attempt 状态、工具调用生命周期、观察到的副作用，为跨提供商接管提供上下文。
- **`PiRunner`**（`packages/agents/src/pi-runner.ts`）：`AgentRunner` 的唯一生产实现，包装路由、supervisor、translator 与 journal。

### 三级隔离

| 层级 | 隔离键 | 负责内容 |
| --- | --- | --- |
| 应用 | app version + Pi version | 内置 Pi、资源校验和、运行时入口 |
| 角色 | profile version + provider-config digest + role | `settings.json`、`SYSTEM.md`、extensions、skills、`models.json` |
| 执行尝试 | execution ID + attempt ID | Pi session、stdout/stderr、尝试日志、恢复上下文 |

运行目录：

```
<userData>/pi-runtime/
├── manifests/
│   └── runtime-v1.json
├── profiles/<profile-digest>/<planner|coder|reviewer|tester>/
└── sessions/<execution-id>/<attempt-id>/
```

角色快照使用内容摘要作为目录名。提供商或应用内置配置变化时生成新快照并原子切换；已有进程继续使用旧快照，避免并发写入和配置漂移。

## 6. 角色配置与运行计划

### 6.1 角色能力

| 角色 | Pi built-in tools | 内置 skills | 核心约束 |
| --- | --- | --- | --- |
| planner | `read,grep,find,ls,write,edit` | 需求分析、设计、实施计划 | 写入限制在任务授权的文档范围 |
| coder | `read,bash,edit,write,grep,find,ls` | TDD、系统调试、实现验证 | 在任务 worktree 内实现和验证 |
| reviewer | `read,bash,grep,find,ls` | 代码审查、安全和回归检查 | 禁止写文件、安装、提交和破坏性命令 |
| tester | `read,bash,grep,find,ls,write,edit` | 测试设计、失败归因、验收验证 | 默认只写测试与测试夹具 |

四个角色均额外启用两个内部工具：`ai_devflow_interaction`（澄清/确认）与 `ai_devflow_report_result`（结构化完成）。

### 6.2 Pi 启动参数

每个 attempt 按以下顺序构造参数：

```
--mode json
--no-extensions
--extension <absolute-builtin-extension> ...
--no-skills
--skill <absolute-builtin-skill> ...
--no-prompt-templates
--no-themes
--no-context-files
--no-approve
--tools <comma-separated-role-tools>
--exclude-tools <comma-separated-role-exclusions>
--provider <resolved-provider-name>
--model <resolved-model-id>
--thinking <resolved-level>
--session-dir <attempt-session-dir>
--name <execution-id-attempt-id>
<initial-message>
```

四套内置 `settings.json` 均设置 `retry.enabled: false`，避免 Pi 内部自动 retry 与 `ProviderRouter` 形成嵌套重试乘积。`--no-context-files` 禁止 Pi 自动读取 `AGENTS.md` / `CLAUDE.md`；应用按父目录到 worktree 的优先级合并适用的 `AGENTS.md`，作为项目指令注入初始消息。

### 6.3 子进程环境白名单

子进程环境从空白白名单构造，不使用 `{ ...process.env }`：

- 隔离的 `HOME`/`USERPROFILE` 与临时目录变量。
- 受角色策略约束的项目工具链 `PATH`。
- 平台必要变量：`SystemRoot`/`ComSpec`/`PATHEXT`（Windows）、locale、证书/代理白名单。
- `ELECTRON_RUN_AS_NODE=1`。
- `PI_CODING_AGENT_DIR`（当前角色配置目录）、`PI_CODING_AGENT_SESSION_DIR`（当前 attempt session）。
- `PI_PACKAGE_DIR=<bundled-readonly-package-dir>`。
- `PI_OFFLINE=1`、`PI_SKIP_VERSION_CHECK=1`、`PI_TELEMETRY=0`。
- 当前候选所需的唯一供应商凭证（兼容网关使用 `AI_DEVFLOW_ACTIVE_API_KEY`）。

明确删除所有继承的 `PI_*`、其它供应商 API key、`NODE_OPTIONS`、`NODE_PATH`、`NPM_CONFIG_*`、`DEV_API_*` 和可能改变模块解析/执行的变量。

## 7. 提供商配置与路由

### 7.1 用户可见契约

用户只配置：类型（`anthropic`/`openai`/`google`/`deepseek`/`openrouter`/`openai_compatible`/`anthropic_compatible`）、显示名称、API Key、兼容服务 Base URL、启用状态、排序。模型、备用模型、thinking、tools、extensions、skills、系统提示词均不向用户暴露。

API Key 经 `safeStorage` 加密后写入 `credentials`；`providers.list()` 只返回 `hasCredential: boolean`，不返回密文、明文或 `credentialRef`。

### 7.2 候选顺序与降级

```
当前角色在提供商 1 的 primary model
→ 提供商 1 的 fallback model（若有）
→ 提供商 2 的 primary model
→ 提供商 2 的 fallback model
→ 后续提供商
```

禁用、无凭证、无该 workload 模型映射或仍处于熔断冷却期的路线不进入本轮候选。若全部路线都在冷却，选择最早到期的一条执行一次 half-open 探测，禁止忙循环。

### 7.3 故障分类与熔断

| 故障 | 分类 | 行为 |
| --- | --- | --- |
| 缺少凭证、401、403 | `authentication` | 立即打开熔断，直到配置 revision 改变 |
| 429、额度耗尽 | `rate_limit` | 采用 `Retry-After`，否则指数冷却，立即降级 |
| DNS、连接、超时、5xx | `transient_provider` | 当前路线重试一次，再打开短冷却并降级 |
| 模型不存在/不支持 | `model_unavailable` | 当前模型路线熔断，尝试同提供商 fallback |
| Pi 非零退出/进程崩溃 | `runtime` | 原路线重启一次；再次失败后降级并上报运行时异常 |
| JSON 协议损坏 | `protocol` | 终止进程，原路线重启一次；保留脱敏诊断样本 |
| 工具失败、测试失败、审查不通过 | `task_result` | 不降级，按任务流程处理 |
| 澄清、确认 | `interaction` | 进入 `awaiting_input`，不降级 |

单路线瞬时错误最多重试一次；同一 execution 不重复访问仍处于冷却的失败路线；总尝试次数上限为 8；任一路线成功即停止降级。

## 8. 调度器与隔离

`scheduler/orchestrator.ts` 是 Main 进程的执行核心：

- **单一 runner**：任务 `role`（`planner`/`coder`/`reviewer`/`tester`）直接映射到内置 Pi profile，不再选择 Agent 类型。
- **流水线**：任务按 `stages: Stage[]` 顺序执行，每阶段产出 checkpoint。
- **并发上限**：信号量 `maxConcurrent`（默认 2），超出排队；保证不同任务的 worktree/日志互不覆盖。
- **阶段依赖**：后一阶段开始前校验前一阶段 checkpoint 存在且未失败。
- **Git worktree 隔离**：每个执行任务在 `<userData>/worktrees/<taskId>` 创建项目仓库的 worktree，分支名 `ai-devflow/<taskId>`；任务结束按策略保留或清理。
- **执行日志 / 检查点**：每个事件落 `ExecutionRecord`；checkpoint 序列化进 `Checkpoint` 表。
- **暂停 / 恢复 / 取消 / 失败 / 重试**：`pause()` 停在下一检查点；`resume()` 从 checkpoint 继续；`cancel()` 终止子进程组 + 清理 worktree；失败后 `retry()` 重新调度。
- **待沟通**：Pi 调用 `ai_devflow_interaction` → 任务转 `awaiting_input`；用户回答后 `resume(userInput)`，调度器把 `userInput` + 原 checkpoint 传给 `PiRunner`。
- **恢复**：启动时扫描 `in_progress`/`awaiting_input` 任务，重建内存状态与计时器；`in_progress` 中的子进程若已死则标记失败并允许重试。

## 9. 通知与超时

`notifications/`：
- **持久化超时规则**：`NotificationRule { id, projectId?, status, minutes, channels }`；计算“任务在某状态停留 > minutes”的下次触发时间。
- **桌面通知**：`Notification` API；点击通过深链 `ai-devflow://task/<id>` 聚焦窗口并跳转。防重复：同一任务同一规则在窗口期内只通知一次（记录在 `NotificationDelivery`）。
- **Webhook**：`WebhookConfig { url, secret, events }`；投递时 body=JSON，签名 `X-AiDevflow-Signature: sha256=<HMAC-SHA256(secret, body)>`；失败指数退避重试；`WebhookDelivery` 记录每次投递的状态码、耗时、响应摘要。
- **重启恢复计时**：启动时根据任务 `statusChangedAt` + 规则重新计算已逾期项，补发或标记；计时器基于绝对时间戳而非进程内存。

## 10. 数据持久化

`persistence/db.ts` 使用 Node 内建 `node:sqlite`（`DatabaseSync`），无原生编译依赖。迁移在 `migrations.ts` 的 `MIGRATIONS` 数组版本化管理。

### 10.1 schema v9

当前 schema 为 v9，变更包括：

- 删除 `tasks.agent_type`。
- 删除 `execution_records.agent_type`。
- 使用 JSON 函数从 `projects.settings_json` 删除 `agentRoles` 和 `roleConfigs`。
- 删除 `credentials.global_agent_config`。
- 新建 `provider_health` 表，主键 `(provider_id, route_id)`。
- 新建 `execution_attempts` 表，记录每次 Pi attempt 的状态、journal、副作用观察。

### 10.2 迁移前备份

`openDatabase()` 在应用实际迁移前：读取 schema 版本 → 校验 `sqlite_version() >= 3.35.0` → `VACUUM INTO` 创建一致性备份 → 执行迁移 → 装配 repositories。备份文件名包含 schema version 与时间戳，只保留最近三份成功迁移前备份。迁移运行在事务中；失败时回滚并保留备份，不启动 scheduler。

### 10.3 旧 AI 提供商凭证迁移

旧 `credentials.ai_provider` 是 safeStorage 加密 JSON。schema v9 成功后，Electron credential migrator：

1. 读取并解密旧单提供商配置。
2. 映射为新 provider list 第一项；旧 `model` 字段丢弃，由内置 workload map 接管。
3. 加密写入新的 provider list 和 provider secret key。
4. 在同一数据库事务中删除旧 key 并写入 `provider-migration:v1` marker。
5. 重复启动时根据 marker 和新 key 幂等返回。

无法解密旧配置时不伪造迁移成功：保留旧密文备份、创建空列表并要求用户重新输入密钥。

## 11. 安全与凭证

- **API Key 不落地明文**：通过 `safeStorage` 加密；禁止 `--api-key` 参数；models.json 只引用环境变量名。
- **IPC  sanitized**：Renderer 只能看到 `ProviderSummary`（无 `credentialRef`、无 model、无内部路径）。
- **日志脱敏**：Authorization、API Key、cookie、URL credential/query、用户目录、完整系统 prompt、完整 provider response 和内部配置绝对路径均经过统一脱敏函数。
- **子进程隔离**：环境白名单、独立 session、独立配置快照；Pi 自动发现全部关闭，仅显式加载仓库内资源。
- **运行时完整性**：manifest、摘要、版本任一 mismatch 即阻止运行，不回退 PATH 或系统 Pi。

## 12. 测试策略

| 要求 | 位置 |
| --- | --- |
| Provider 校验与路由/熔断 | `core/__tests__/provider.test.ts`、`agents/__tests__/provider-router.test.ts` |
| 运行计划与环境隔离 | `agents/__tests__/run-plan.test.ts`、`agents/__tests__/project-instructions.test.ts` |
| JSON 事件翻译与 journal | `agents/__tests__/json-events.test.ts` |
| Pi 运行链路（fake Pi 夹具驱动真实 supervisor/translator/router） | `agents/__tests__/pi-runner.test.ts` |
| SQLite 迁移/备份/Repository | `persistence/__tests__/pi-migration.test.ts` 等 |
| Provider 加密存储与旧凭证迁移 | `apps/desktop/electron/__tests__/provider-store.test.ts` |
| 调度/取消/恢复/待沟通 | `scheduler/__tests__/orchestrator.test.ts` |
| 类型化 IPC / provider UI | `apps/desktop/electron/__tests__/ipc.test.ts` |
| 真实 bundled Pi 四角色验证 | `pnpm test:real:pi`（使用项目根 `.env`，含密钥泄露扫描） |
| Electron E2E | `apps/desktop/e2e/*.spec.ts`（Playwright Electron） |
| 打包隔离冒烟 | `apps/desktop/scripts/verify-packaged-pi.mjs`、`run-e2e.mjs --packaged` |

真实端到端命令：

```bash
pnpm test:real:pi
```

它读取项目根 `.env`（必须已被 `.gitignore` 忽略）中的 `DEV_API_KEY`、`DEV_API_URL`、`DEV_API_DEFAULT_MODEL`、`DEV_API_TYPE`，在临时目录验证四角色、JSON 事件、降级、并发隔离，并在测试后扫描输出/临时文件确认不含 `DEV_API_KEY`。

## 13. 打包与发版

### 13.1 Pi 运行时打包

- `@earendil-works/pi-coding-agent` 以精确版本 `0.80.10` 加入 `packages/pi-runtime-bundle/package.json`。
- `apps/desktop/scripts/stage-pi-runtime.mjs` 使用 `pnpm deploy --prod` 将 Pi 及其生产依赖闭包复制到 `apps/desktop/build/pi-runtime/`。
- 生成 `runtime-manifest.json`，包含 Pi 版本、入口相对路径、全量文件 SHA-256、角色资源摘要。
- electron-builder 通过 `extraResources` 将 `build/pi-runtime` 复制到 `resources/pi-runtime`，**不入 ASAR**。
- macOS x64/arm64、Windows x64、Linux x64 构建后均执行入口与摘要校验。

### 13.2 打包隔离冒烟

`apps/desktop/scripts/verify-packaged-pi.mjs <release-root>`：

- 定位每个 unpacked 应用目录（含 `resources/app.asar`）。
- 校验 `resources/pi-runtime/runtime-manifest.json` 存在且摘要通过。
- 校验入口文件存在、版本为 `0.80.10`。
- 校验无 `.env`、无 `DEV_API_KEY`、无旧适配器源码或命令字符串。
- 对主机架构目录，用该 Electron 可执行文件以 `ELECTRON_RUN_AS_NODE=1` 运行 `pi --version`，要求输出 `0.80.10`。

`apps/desktop/scripts/run-e2e.mjs --packaged <release-root>`：

- 启动本机 unpacked 应用，绑定 loopback 假提供商 HTTP 服务。
- 在 PATH 前段放置会退出 97 的同名 `pi` 可执行文件。
- 在用户目录/项目目录放置恶意 Pi settings/extensions/skills。
- 执行一个确定性任务，断言应用仍通过真实 bundled Pi 完成、`pi` 诱饵未触发、无恶意 marker 写入。

### 13.3 发版工作流

`.github/workflows/release.yml` 三段流水线：

1. **prepare**：校验 semver、拒绝重复 tag/release、质量门禁（`pnpm typecheck/lint/test`）、生成 CHANGELOG/Release Notes、版本号 bump、打 tag 推送。
2. **pi-runtime-smoke**（新增，matrix: `macos-13/x64`、`macos-14/arm64`、`windows-latest/x64`、`ubuntu-latest/x64`）：检出 tag、安装冻结依赖、构建 desktop、执行 `electron-builder --dir`（仅当前矩阵架构）、运行 `verify-packaged-pi.mjs` 与 `run-e2e.mjs --packaged`。Linux 在 `dbus-run-session` 中启动 `gnome-keyring` 并提供 `DISPLAY`（`xvfb-run -a`），避免 `safeStorage` 回退到 `basic_text`。
3. **build**（matrix mac/win/linux，`needs: pi-runtime-smoke`）：执行完整打包并上传 artifact。
4. **publish**（`needs: [prepare, build]`）：汇总 artifact 并统一创建 GitHub Release。

### 13.4 自动更新

`apps/desktop/electron/updater.ts` 基于 `electron-updater` + electron-builder 的 GitHub Provider。仅 `app.isPackaged` 时启用；开发/E2E 返回 no-op。启动后异步检查，发现版本后静默下载；下载完成在设置页提示升级。未签名 macOS 打开 GitHub Releases 手动下载，其它平台调用 `quitAndInstall()`。详见 `updater.ts` 注释。

## 14. 从旧多 Agent 架构迁移

旧版本支持 Claude Code / Codex / 外部 Pi 三桥接器，相关代码已在本次重构中移除。迁移路径：

- 数据库 schema v9 自动删除 `agent_type` 列与 `agentRoles`/`roleConfigs` 设置，并备份旧数据库。
- 旧 `credentials.ai_provider` 自动迁移为新的有序 provider list 第一项。
- 用户此前配置的“全局/项目 Agent 能力”不再生效；应用内置四角色 profile 接管所有 AI 运行行为。
- 用户只需在设置页重新确认或补充一个 API Key 即可继续使用。
