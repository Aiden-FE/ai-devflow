# 内置 Pi 单一 Agent 运行时设计

> 状态：已确认，可进入实施计划阶段
>
> 日期：2026-07-22
>
> 目标读者：goal 模式实施 Agent、维护者、评审者
>
> 目标版本：本设计落地后的下一主版本

## 1. 目标

ai-devflow 全面停止对 Claude Code CLI 和 Codex CLI 的支持，生产环境只使用随应用发布、版本固定、配置受控的 Pi。用户无需安装 Pi、Node.js 或任何 Agent CLI，也不能选择 Agent、模型、工具、扩展、skills 或系统提示词。

用户唯一需要管理的 AI 运行配置是一个有序的提供商列表。应用根据任务角色选择内置 Pi 配置和内置模型；首选提供商不可用时，自动尝试同提供商备用模型及列表中的后续提供商。

本设计的成功条件是：

- 安装包自带并只执行 `@earendil-works/pi-coding-agent@0.80.10`。
- `planner`、`coder`、`reviewer`、`tester` 各自使用独立、版本化的 Pi 配置。
- 同角色并发任务也使用互不干扰的 session 目录。
- 用户机器上的 Pi、Node、Pi 设置、Pi 扩展、Pi skills 和供应商环境变量均不能替换或重配置内置 Pi。Agent 的 `bash` 工具仍可有意使用项目自己的 Node、编译器和其他开发工具链。
- 生产领域模型、数据库、IPC、UI、文档和测试不再保留 Claude Code/Codex Agent 兼容层。
- 一个提供商故障时，在安全、有限、可观测的边界内自动降级。

## 2. 已确认的产品决策

1. Pi 随应用捆绑，固定版本，不读取 PATH 中的 `pi`。
2. 四个角色拥有不同的 Pi `settings.json`、系统提示词、扩展、skills、工具清单、思考等级和提供商模型映射。
3. 用户只配置提供商并拖拽排序；角色模型及其他 Pi 细节不向用户暴露。
4. 首版只支持 API Key，不实现 Pi 的 OAuth 订阅登录；领域接口预留 OAuth 扩展点。
5. 历史 Claude Code/Codex 配置自动迁移为“统一由 Pi 执行”的新语义，不保留双运行或回退开关。
6. 采用“一次执行尝试一个独立 Pi JSON 进程”，不采用长期 RPC worker，也不直接嵌入 Pi SDK。
7. 提供商降级同时服务于 Pi 任务执行和现有需求对话/结构化提案。
8. 本次目标实施必须使用项目根目录 `.env` 中的开发供应商执行真实端到端测试；变量契约以 `.env.example` 为准。该入口只属于开发验证，不进入产品配置。

## 3. 非目标

- 不允许用户安装、更新或加载第三方 Pi package、extension、skill、prompt template 或 theme。
- 不提供模型选择器、thinking level 选择器、工具编辑器或角色 prompt 编辑器。
- 不实现 ChatGPT Plus/Pro、Claude Pro/Max 等 OAuth 登录；只保留接口形状。
- 不复用用户的 `~/.pi/agent`、`.pi/settings.json`、`.pi/extensions` 或 `.agents/skills`。
- 不在首版引入远程 Agent、MCP、子 Agent、后台 Bash 或任意自定义工具市场。
- 不保留 Claude Code/Codex 适配器作为隐藏兼容能力。
- 不把 `.env` 或 `DEV_API_*` 作为生产运行时、Renderer 或已打包应用的配置来源。

## 4. Pi 官方能力依据

本设计只依赖 Pi 已公开的稳定能力：

- Pi 支持 `--mode json`，并以 JSON Lines 输出 session、消息、工具开始/更新/结束和 agent 生命周期事件，适合桥接到现有事件系统：[JSON Event Stream Mode](https://pi.dev/docs/latest/json)。
- CLI 支持 `--provider`、`--model`、`--thinking`、`--tools`、`--exclude-tools`、`--extension`、`--skill`、`--no-*`、`--no-context-files`、`--no-approve` 和 `--session-dir`：[Using Pi / CLI Reference](https://pi.dev/docs/latest/usage#cli-reference)。
- `PI_CODING_AGENT_DIR` 可覆盖配置目录，`PI_CODING_AGENT_SESSION_DIR` 可覆盖 session 目录；`PI_OFFLINE`、`PI_SKIP_VERSION_CHECK`、`PI_TELEMETRY` 可关闭启动更新检查和遥测：[Using Pi / Environment Variables](https://pi.dev/docs/latest/usage#environment-variables)。
- Pi 支持 API Key 环境变量、`auth.json`、自定义提供商和 `models.json`；凭证解析顺序中 CLI/API 配置优先于环境来源：[Providers](https://pi.dev/docs/latest/providers)。
- Pi settings 可加载 packages、extensions、skills 和 prompts，并支持项目覆盖；本设计通过显式关闭发现和独立配置目录避免外部覆盖：[Settings](https://pi.dev/docs/latest/settings)。
- extensions 能注册工具并拦截工具调用；extensions 具有完整系统权限，因此本设计只允许应用内审计资源：[Extensions](https://pi.dev/docs/latest/extensions)。
- skills 支持显式路径和 `--no-skills`，其元数据会进入系统提示词并按需加载：[Skills](https://pi.dev/docs/latest/skills)。
- 自定义 OpenAI/Anthropic 兼容服务可通过 `models.json` 描述：[Custom Models](https://pi.dev/docs/latest/models)。
- 本设计锁定的 Pi 包及当前版本来自官方 npm 包页：[\@earendil-works/pi-coding-agent](https://www.npmjs.com/package/%40earendil-works%2Fpi-coding-agent)。

## 5. 总体架构

```text
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

生产环境不再有 Agent registry 或 Agent 类型选择。调度器依赖单一 `AgentRunner` 接口，其生产实现是 `PiRunner`；测试通过构造函数注入 `FakeAgentRunner`。

### 5.1 三级隔离

| 层级 | 隔离键 | 负责内容 |
| --- | --- | --- |
| 应用 | app version + Pi version | 内置 Pi、资源校验和、运行时入口 |
| 角色 | profile version + provider-config digest + role | `settings.json`、`SYSTEM.md`、extensions、skills、`models.json` |
| 执行尝试 | execution ID + attempt ID | Pi session、stdout/stderr、尝试日志、恢复上下文 |

运行目录：

```text
<userData>/pi-runtime/
├── manifests/
│   └── runtime-v1.json
├── profiles/<profile-digest>/
│   ├── planner/
│   ├── coder/
│   ├── reviewer/
│   └── tester/
└── sessions/<execution-id>/
    ├── attempt-01-<route-id>/
    ├── attempt-02-<route-id>/
    └── attempt-03-<route-id>/
```

角色快照使用内容摘要作为目录名。提供商或应用内置配置变化时生成新快照并原子切换；已有进程继续使用旧快照，避免并发写入和配置漂移。成功启动后可清理没有活跃引用的旧快照。

## 6. 打包与运行时定位

### 6.1 固定依赖

`@earendil-works/pi-coding-agent` 必须以精确版本 `0.80.10` 加入生产依赖，禁止 `^`、`~`、workspace 浮动或运行时下载。升级 Pi 必须通过应用 PR 完成：更新精确版本、锁文件、资源校验和、兼容性测试及发布说明。

### 6.2 构建产物

当前 Electron `files` 只包含 `dist/**`、`dist-electron/**` 和 `package.json`，不能满足 Pi 的动态依赖加载。构建流程需新增 Pi staging：

1. 从包清单解析 `bin.pi`，禁止硬编码 `node_modules` 内部路径。
2. 复制 Pi 及其生产依赖闭包到 `apps/desktop/build/pi-runtime/`。
3. 生成包含 Pi 版本、入口相对路径、文件摘要和角色资源版本的 `runtime-manifest.json`。
4. electron-builder 通过 `extraResources` 将 staging 目录复制到 `resources/pi-runtime`，不放入 ASAR。
5. macOS x64/arm64、Windows x64、Linux x64 构建后都执行入口与摘要校验。

### 6.3 启动方式

应用不执行 `pi` 命令名。`BundledPiLocator` 从 `process.resourcesPath` 和 manifest 得到绝对 CLI 入口，并使用 Electron 自带运行时的 Node 模式启动：

```text
command: process.execPath
args: [absolutePiEntry, ...piArgs]
env.ELECTRON_RUN_AS_NODE: "1"
shell: false
```

开发模式也从 workspace 中解析同一精确依赖，不允许回退 PATH。启动自检依次验证 manifest、摘要、入口、`pi --version` 和预期版本；任一步失败都阻止 Agent 执行并报告“应用运行组件损坏”。

## 7. 角色配置

### 7.1 内部契约

```ts
type TaskRole = 'planner' | 'coder' | 'reviewer' | 'tester';

interface RoleProfile {
  role: TaskRole;
  version: number;
  systemPromptFile: string;
  tools: string[];
  excludedTools: string[];
  extensions: string[];
  skills: string[];
  timeoutMs: number;
  providerModels: Partial<Record<ProviderKind, ModelRoute>>;
}

interface ModelRoute {
  primary: ModelChoice;
  fallback?: ModelChoice;
}

interface ModelChoice {
  model: string;
  thinking: 'low' | 'medium' | 'high' | 'xhigh';
}
```

`RoleProfile` 只存在于 Main 进程包，不能通过 IPC 返回。每个应用版本发布一份显式、受测的角色模型表；用户不能覆盖。

### 7.2 首版内置模型表

首版必须使用下表，不在实施时临时选择模型。表中 `primary / fallback` 是同一用户提供商内的尝试顺序，括号内是 thinking level。

| ProviderKind | planner | coder | reviewer | tester |
| --- | --- | --- | --- | --- |
| `anthropic` | `claude-sonnet-5` high / `claude-sonnet-4-6` high | `claude-sonnet-5` xhigh / `claude-sonnet-4-6` high | `claude-sonnet-5` high / `claude-sonnet-4-6` high | `claude-sonnet-4-6` medium / `claude-sonnet-4-5` medium |
| `openai` | `gpt-5.6-terra` high / `gpt-5.4` high | `gpt-5.6-sol` xhigh / `gpt-5.6-terra` high | `gpt-5.6-terra` high / `gpt-5.4` high | `gpt-5.6-luna` medium / `gpt-5.4-mini` medium |
| `google` | `gemini-3.1-pro-preview` high / `gemini-2.5-pro` high | `gemini-3.1-pro-preview` high / `gemini-2.5-pro` high | `gemini-3.1-pro-preview` high / `gemini-2.5-pro` medium | `gemini-3.5-flash` medium / `gemini-2.5-flash` medium |
| `deepseek` | `deepseek-v4-pro` high / `deepseek-v4-flash` medium | `deepseek-v4-pro` high / `deepseek-v4-flash` high | `deepseek-v4-pro` high / `deepseek-v4-flash` medium | `deepseek-v4-flash` medium / 无 |
| `openrouter` | `anthropic/claude-sonnet-5` high / `anthropic/claude-sonnet-4.6` high | `openai/gpt-5.6-sol` xhigh / `anthropic/claude-sonnet-5` high | `anthropic/claude-sonnet-4.6` high / `openai/gpt-5.6-terra` high | `deepseek/deepseek-v4-flash` medium / `google/gemini-3.5-flash` medium |

对话工作负载使用对应提供商的 tester primary；结构化任务/需求提案使用 planner primary。这样仍由同一隐藏表控制，不新增用户设置。

`openai_compatible` 必须接受 `openai` 行中的至少一个官方模型 ID；`anthropic_compatible` 必须接受 `anthropic` 行中的至少一个官方模型 ID。测试连接按工作负载顺序做最小探测并缓存首个成功模型；不提供任意模型名输入。若兼容网关不接受这些上游模型 ID，则标记为配置错误，而不是猜测未知模型。

构建测试必须调用 Pi `--list-models` 的离线 catalog，确认标准提供商的每个模型存在且支持工具调用。若模型不支持表中 thinking level，构建失败；不得在运行时静默降级 thinking。模型表更新必须与 Pi 版本更新一样经过真实提供商发布验证。

模型存在性依据 Pi 官方 [Model Catalog](https://pi.dev/models)。

`.env` 中的 `DEV_API_DEFAULT_MODEL` 是真实集成测试专用覆盖：它只验证当前开发端点与内置 Pi 的端到端协议，不写入 `RoleProfile`，不进入构建产物，也不能改变产品的首版内置模型表。

### 7.3 角色能力

| 角色 | Pi built-in tools | 内置 skills | 核心约束 |
| --- | --- | --- | --- |
| planner | `read,grep,find,ls,write,edit` | 需求分析、设计、实施计划 | 写入限制在任务授权的文档范围 |
| coder | `read,bash,edit,write,grep,find,ls` | TDD、系统调试、实现验证 | 在任务 worktree 内实现和验证 |
| reviewer | `read,bash,grep,find,ls` | 代码审查、安全和回归检查 | 禁止写文件、安装、提交和破坏性命令 |
| tester | `read,bash,grep,find,ls,write,edit` | 测试设计、失败归因、验收验证 | 默认只写测试与测试夹具 |

### 7.4 内置扩展

- `event-bridge`：注册 `ai_devflow_interaction`（澄清/确认）和 `ai_devflow_report_result`（结构化完成）工具，输出可映射的稳定事件。interaction 工具被调用后，supervisor 在工具结果落入 JSONL 后终止本次 Pi 进程并把任务交还现有 `awaiting_input` 流程。
- `execution-policy`：拦截工具调用，实施路径、命令、角色权限和敏感文件规则。
- `structured-result`：要求结束时输出摘要、验证证据、变更文件和未解决问题。
- `checkpoint-context`：为重试和提供商接管注入已完成、未完成和不确定动作。

这些扩展随仓库维护，不经 npm/git 动态下载。构建将扩展源文件摘要纳入 manifest。

### 7.5 精确资源加载

完整系统提示词放在角色目录的 `SYSTEM.md`，避免超长 prompt 暴露于进程参数或触发平台命令行长度限制。动态任务内容作为 Pi 初始 message；短小的恢复约束可并入该 message。

Pi 启动遵循“关闭发现，再显式加载”：

```text
--print
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

`--print` 强制非交互一次性执行：处理完初始 message 后即退出，避免 supervised 子进程进入 TUI。这是 supervised JSON 执行所必需的开关，入口已用绝对路径（§6.3），`--print` 不参与入口解析。

四套内置 `settings.json` 都必须设置 `retry.enabled: false`。提供商重试和退避只由 `ProviderRouter` 控制，不能同时启用 Pi 内部自动 retry。

`--tools` 的最终值是“表 7.3 的角色 built-in tools”与 `ai_devflow_interaction,ai_devflow_report_result` 的并集。两个内部工具对四个角色都必须启用，否则澄清和结构化完成协议无法工作；它们不作为用户可配置能力。

`--no-context-files` 禁止 Pi 自动读取 `AGENTS.md` 和 `CLAUDE.md`。应用自己只读取适用的 `AGENTS.md`，按父目录到 worktree 的既定优先级合并、限制大小并作为项目指令注入；`CLAUDE.md` 不再属于项目契约。

## 8. 提供商配置

### 8.1 用户可见契约

```ts
type ProviderKind =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'deepseek'
  | 'openrouter'
  | 'openai_compatible'
  | 'anthropic_compatible';

type AuthType = 'api_key' | 'oauth';

interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  displayName: string;
  enabled: boolean;
  priority: number;
  authType: AuthType;
  credentialRef: string;
  baseURL?: string;
  revision: number;
}
```

首版验证器只接受 `authType: 'api_key'`。`oauth` 保留在领域联合类型和 `ProviderAuthenticator` 接口，但没有实现、IPC 或 UI 入口。

用户能配置类型、名称、API Key、兼容服务 Base URL、启用状态和排序。模型、备用模型、thinking、tools、extensions、skills、系统提示词和 Pi 路径不进入 Renderer 契约。

### 8.2 凭证

- API Key 通过 Electron `safeStorage` 加密后写入 `credentials`。
- `providers.list()` 只返回 `hasCredential: boolean`，不返回密文、明文或 `credentialRef`。
- 标准提供商通过单次子进程环境变量传入，例如 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GEMINI_API_KEY`。
- 兼容提供商的角色快照包含生成的 `models.json`；`apiKey` 只引用进程专用环境变量，不包含明文。
- 禁止使用 `--api-key`，避免凭证出现在进程列表。
- 保存、测试、运行和错误记录都使用统一脱敏函数。

### 8.3 Base URL

- 默认只接受 `https:`。
- 用户显式选择“本地兼容服务”后，允许 `http://127.0.0.1`、`http://[::1]` 和 `http://localhost`。
- 拒绝 URL username/password、fragment、非 HTTP(S) scheme 和把 API Key 放入 query 的配置。
- 标准提供商不显示 Base URL；只有两类 compatible provider 显示。

## 9. ProviderRouter 与降级

### 9.1 路由输入

```ts
type Workload = TaskRole | 'task_chat' | 'requirement_chat' | 'task_proposal' | 'requirement_proposal';

interface ProviderRoute {
  providerId: string;
  providerKind: ProviderKind;
  model: string;
  routeId: string;
  priority: number;
}
```

四个 Agent workload 使用 `RoleProfile.providerModels`；对话和结构化提案使用同样隐藏的内置 workload model map。所有入口共享提供商顺序、健康状态、故障分类和脱敏逻辑。

### 9.2 候选顺序

```text
当前角色在提供商 1 的 primary model
→ 提供商 1 的 fallback model（若有）
→ 提供商 2 的 primary model
→ 提供商 2 的 fallback model
→ 后续提供商
```

禁用、无凭证、无该 workload 模型映射或仍处于熔断冷却期的路线不进入本轮候选。若全部路线都在冷却，选择最早到期的一条执行一次 half-open 探测，禁止忙循环。

### 9.3 健康状态

```ts
interface ProviderHealth {
  providerId: string;
  routeId: string;
  state: 'closed' | 'open' | 'half_open';
  consecutiveFailures: number;
  cooldownUntil?: number;
  lastFailureKind?: FailureKind;
  updatedAt: number;
}
```

健康状态持久化。修改提供商 key、Base URL、启用状态或 revision 时清除相关路线的旧健康状态。

### 9.4 故障分类

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

Pi 自带自动 retry 设置为关闭，由应用统一控制，避免 Pi 和调度器形成嵌套重试乘积。

### 9.5 尝试上限

- 单路线瞬时错误最多重试一次。
- 同一 execution 不重复访问仍处于冷却的失败路线。
- 总尝试次数为 `min(可用候选路线数 + 运行时重启次数, 8)`。
- 任一路线成功即停止降级并清除其连续失败计数。
- 候选耗尽后返回 recoverable error，由现有调度器退避重试。
- 调度器预算耗尽后任务进入 `awaiting_input`，提示用户检查提供商；不得无限重跑。

## 10. 中途失败与安全接管

每个 attempt 维护 `AttemptJournal`：

```ts
interface AttemptJournal {
  executionId: string;
  attemptId: string;
  routeId: string;
  mutationsObserved: boolean;
  toolCalls: Array<{
    id: string;
    name: string;
    state: 'started' | 'completed' | 'failed' | 'uncertain';
    summary: string;
  }>;
  changedFiles: Array<{ path: string; action: 'create' | 'modify' | 'delete' }>;
  lastCheckpointId?: string;
}
```

处理规则：

1. 第一次副作用前失败：下一路线接收原始任务和故障已处理标记。
2. 产生文件或命令副作用后失败：下一路线接收原始任务、完成动作、未完成动作、不确定工具、当前 diff 摘要和最近 checkpoint。
3. `tool_execution_start` 后没有对应 end 的调用标为 `uncertain`；接替 Agent 必须先检查工作区、进程和测试状态。
4. 文件系统和 Git diff 是最终事实源，不把前一模型的自然语言声明视为完成证据。
5. attempt 之间不复用 Pi 私有 session；应用 checkpoint 是跨模型/跨提供商恢复协议。
6. 不自动回滚已产生的代码改动。回滚可能破坏已完成工作；接替 Agent先验证并继续。
7. `execution-policy` 拦截无法安全接管的高风险操作，特别是工作区外写入、凭证修改、递归删除和系统级安装。

## 11. Pi JSON 事件桥接

`PiJsonEventTranslator` 必须解析 JSONL 流，而不是 stdout 正则：

| Pi event | ai-devflow 行为 |
| --- | --- |
| `session` | 记录 Pi session metadata，不向 Renderer 暴露内部路径 |
| `message_update` text delta | 流式 `log`/assistant message |
| `tool_execution_start` | 写入 task message，journal 标为 `started` |
| `tool_execution_update` | 更新可折叠工具消息，不直接判定完成 |
| `tool_execution_end` | 写入结果，journal 标为 `completed` 或 `failed`；从参数/结果提取文件变化 |
| `auto_retry_*` | 只做诊断；正常配置下不应出现，出现则记录配置违例 |
| `agent_end` | 等待 `structured-result`；不能仅凭进程退出 0 判成功 |

完成条件必须同时满足：Pi 正常结束、没有未解决 interaction、收到合法结构化结果、角色规定的验证门禁通过。未知事件按向前兼容原则记录为 debug 诊断，不导致崩溃；缺少必需事件或 schema 不合法属于 protocol failure。

stdout 只接受 JSONL；stderr 按行脱敏后进入诊断缓冲区。缓冲区有大小上限，防止失控输出耗尽内存。

## 12. 领域模型与持久化迁移

### 12.1 删除的生产契约

- `AgentType`
- `AgentDetection`
- `AgentCapabilities`
- `AgentCapabilitySupport`
- `RoleAgentConfig`
- `GlobalAgentConfig`
- `Task.agentType`
- `ExecutionRecord.agentType`
- `ProjectSettings.agentRoles`
- `ProjectSettings.roleConfigs`
- Agent registry、CLI detect 和默认 Agent 选择

`TaskRole` 保留，并成为选择内置 Pi profile 的唯一任务级维度。

### 12.2 schema v9

当前 schema 为 v8。v9 使用内置 SQLite 支持的 `ALTER TABLE ... DROP COLUMN`：

- 删除 `tasks.agent_type`。
- 删除 `execution_records.agent_type`。
- 使用 JSON 函数从全部 `projects.settings_json` 删除 `agentRoles` 和 `roleConfigs`，保留 `maxConcurrent` 等无关字段。
- 删除 `credentials.global_agent_config`。
- 新建 `provider_health` 表，主键为 `(provider_id, route_id)`。

若当前 Electron 内置 SQLite 不支持所需 DDL，应用自检直接阻止迁移；不得悄悄保留旧列。当前目标 Electron 43 满足要求，但实现仍需自动化验证实际 `sqlite_version()`。

### 12.3 一致性备份

当前 `openDatabase()` 会立即迁移，需重构为：打开数据库 → 读取版本 → `VACUUM INTO` 创建一致性备份 → 执行迁移 → 装配 repositories。备份文件名包含 schema version 和时间戳，只保留最近三份成功迁移前备份。

迁移运行在事务中；失败时回滚并保留备份，不启动 scheduler。

### 12.4 加密配置迁移

旧 `credentials.ai_provider` 是 safeStorage 加密 JSON，不能由纯 persistence 层迁移。Electron credential migrator 在 schema v9 成功后执行：

1. 读取并解密旧单提供商配置。
2. 映射为新列表第一项；旧 `model` 字段丢弃，由内置 workload map 接管。
3. 加密写入新的 provider list 和 provider secret key。
4. 在同一数据库事务中删除旧 key 并写入 credential migration marker。
5. 重复启动时根据 marker 和新 key 幂等返回。

无法解密旧配置时不伪造迁移成功：保留旧密文备份、创建空列表并要求用户重新输入密钥，同时给出明确错误。

## 13. UI 与 IPC

### 13.1 删除

- 设置页 Agent 检测。
- 全局/项目 Agent 能力配置。
- 任务创建、编辑和详情中的 Agent 选择。
- Agent Badge 和执行记录 Agent 列。
- 模型、tools、extensions、skills、授权模式和系统提示词配置。
- Claude Code、Codex、外部 Pi 安装/检测相关文案。

### 13.2 新 AI 服务商界面

提供商列表支持添加、编辑、启停、删除、拖拽排序、测试连接和高层健康状态。API Key 只允许替换或清除，保存后显示“已配置”，不回显。

可见状态限制为：

- 可用
- 未测试
- 冷却中
- 配置错误

不显示 route、模型、Pi attempt、thinking 或内部失败栈。任务日志可显示“首选服务不可用，已切换至备用服务”，但不暴露模型和角色策略。

### 13.3 IPC

```ts
interface ProviderSummary {
  id: string;
  kind: ProviderKind;
  displayName: string;
  enabled: boolean;
  priority: number;
  authType: AuthType;
  revision: number;
  hasCredential: boolean;
  baseURL?: string;
  health: 'available' | 'untested' | 'cooldown' | 'configuration_error';
}

`authType`（首版恒为 `api_key`，非敏感）与 `revision`（配置修订号，非敏感）随摘要返回：编辑现有提供商时需回传 `revision` 以保留版本并触发旧健康状态清除，`authType` 用于 UI 一致显示鉴权方式。两者均不含密文/明文。

providers.list(): Promise<ProviderSummary[]>;
providers.save(input: ProviderInput): Promise<ProviderSummary>;
providers.remove(id: string): Promise<void>;
providers.reorder(ids: string[]): Promise<void>;
providers.test(id: string): Promise<ProviderTestResult>;
providers.health(): Promise<ProviderHealthSummary[]>;
```

删除 `agents.detect*`、`agents.capabilities`、global agent config、project agent config 和旧单 AI provider IPC。

测试连接必须使用 `ProviderRouter` 和该 workload 的真实隐藏模型做最小调用，不能继续手工拼固定 OpenAI/Anthropic HTTP 请求。

## 14. 子进程安全

子进程环境从空白白名单构造，不使用 `{ ...process.env }`。允许项：

- OS 运行必要变量：平台限定的临时目录、locale、证书和代理白名单。
- `ELECTRON_RUN_AS_NODE=1`。
- 当前角色 `PI_CODING_AGENT_DIR`。
- 当前 attempt `PI_CODING_AGENT_SESSION_DIR`。
- `PI_PACKAGE_DIR=<bundled-readonly-package-dir>`。
- `PI_OFFLINE=1`、`PI_SKIP_VERSION_CHECK=1`、`PI_TELEMETRY=0`。
- 当前候选所需的唯一供应商凭证及显式允许的配套变量。

明确删除所有继承的 `PI_*`、供应商 API key、`NODE_OPTIONS`、`NODE_PATH`、`NPM_CONFIG_*` 和可能改变模块解析/执行的变量。PATH 只保留角色工具执行所需的系统路径，不参与 Pi 入口解析。

日志必须脱敏：Authorization、API Key、cookie、URL credential/query、用户目录、完整系统 prompt、完整 provider response 和内部配置绝对路径。

## 15. 错误处理与用户体验

- 没有有效提供商：禁止开始 AI 操作，直接引导设置。
- 内置 Pi 自检失败：禁止调度，不尝试系统 Pi。
- 单路线故障：后台降级，任务保持当前阶段；仅显示高层提示。
- 全路线故障但仍有 scheduler retry：任务保持可恢复，显示下次重试状态。
- scheduler retry 耗尽：任务进入 `awaiting_input`，提示检查提供商。
- 用户修改提供商后，可从现有 checkpoint 恢复，无需重建任务。
- 应用退出或取消任务时，先终止 Pi 进程组，再封存 journal；孤儿进程清理由启动恢复流程处理。

## 16. 测试策略

### 16.1 单元测试

- 角色 profile schema、资源路径、工具白名单和模型映射。
- Pi 参数构造，确保关闭所有自动发现并显式加载内置资源。
- 环境变量白名单与敏感信息脱敏。
- provider CRUD、排序、revision 和 safeStorage 包装。
- route 生成、故障分类、熔断、half-open 和上限。
- mutation 前后两种接管上下文。
- JSONL 分片、非法行、未知事件和 tool 生命周期。
- v9 schema 与 credential 迁移幂等性。

### 16.2 集成测试

创建仓库内 fake Pi CLI fixture，接受同样参数并输出官方 JSONL 形状，覆盖：

- 正常文本、工具调用、文件变化和结构化完成。
- stderr、退出码、崩溃、超时、取消和协议损坏。
- 澄清、确认、恢复。
- 401、429、5xx、网络断开和 model unavailable。
- mutation 前降级与 mutation 后接管。
- 全候选耗尽和 scheduler 重试边界。

### 16.3 打包冒烟

macOS x64/arm64、Windows x64、Linux x64 均验证：

1. 内置 Pi 版本为 `0.80.10`。
2. PATH 首位放置失败的同名 `pi`，应用仍完成 fake-provider 任务。
3. 用户目录放置恶意全局 Pi settings/extensions/skills，不被加载。
4. 仓库放置 `.pi/settings.json`、`.pi/extensions`、`.agents/skills` 和 `CLAUDE.md`，不被 Pi 自动加载。
5. 父进程注入错误供应商 key，子进程只使用 safeStorage 中当前候选凭证。
6. 四角色和同角色并发执行的 config/session 互不相同。

### 16.4 真实供应商发布验证

普通 PR 不使用真实密钥。发布候选在受控环境中对每种支持类型运行最小工具任务、结构化输出、流式对话和一次故障降级；验证通过后才能升级内置模型表或 Pi 版本。

### 16.5 本次目标的 `.env` 真实测试

本次实施不是普通无密钥 PR。项目根目录已有本地 `.env`，变量说明来自 `.env.example`：

| 变量 | 用途 | 约束 |
| --- | --- | --- |
| `DEV_API_KEY` | 开发供应商 API Key | 必填；不得输出、持久化或传给 Renderer |
| `DEV_API_URL` | 开发供应商 Base URL | 必填；日志只显示脱敏后的 origin |
| `DEV_API_DEFAULT_MODEL` | 真实测试模型 | 必填；仅覆盖测试 route，不改变产品模型表 |
| `DEV_API_TYPE` | 开发供应商协议类型 | 必填；值必须映射到受支持的 `ProviderKind` |

安全规则：

- `.env` 必须继续被 `.gitignore` 忽略，禁止暂存、提交、复制到测试产物或 Electron `extraResources`。
- `.env.example` 只能包含说明和非秘密占位符，可以纳入版本控制；不得包含可用凭证。
- 只有显式真实测试命令加载 `.env`。应用启动、普通 unit/integration/E2E、构建和打包不得自动读取。
- 使用 Node 的 `--env-file=.env` 或等价的显式进程环境注入，不把变量拼入 shell 命令或 argv。
- 真实测试日志必须通过与生产相同的脱敏器；失败时不得打印请求头、响应正文、完整 URL query、模型响应原文或环境快照。

实施必须新增独立命令 `pnpm test:real:pi`。它在临时目录创建一次性 Git 仓库和四个角色的最小任务，不修改当前 checkout，并按顺序验证：

1. 四个变量存在且类型合法；`.env` 仍被 Git ignore。
2. 使用 `DEV_API_TYPE`、`DEV_API_URL`、`DEV_API_DEFAULT_MODEL` 和密钥完成最小 provider 调用。
3. 通过应用解析出的固定 Pi 入口启动 `--mode json`，而不是 PATH `pi`。
4. planner 能读取并写入授权文档；coder 能修改 fixture 并运行测试；reviewer 能审查且无法写入；tester 能新增或执行测试。
5. `ai_devflow_interaction` 和 `ai_devflow_report_result` 的 JSON 事件可被完整解析。
6. 在开发供应商之前注入一个确定失败的候选，验证自动降级后仍完成任务。
7. 同角色并发两次运行，验证 config snapshot 和 session 无交叉污染。
8. 测试完成后扫描 stdout、stderr、journal、SQLite fixture 和临时文件，确认不含 `DEV_API_KEY`。

只要 `.env` 存在，本次 goal 模式的完成门禁就必须运行 `pnpm test:real:pi` 并得到退出码 0。网络、额度、鉴权或模型不兼容导致的失败都必须如实报告，不能以“可选真实测试”跳过，也不能因此改用外部 Pi。

## 17. 主要文件影响范围

### 17.1 重写或新增

- `packages/agents/src/`：重写为 Pi-only runner、runtime locator、profile registry、run-plan、process supervisor、JSON event translator、journal、provider router 和测试 fixture。
- `packages/agents/assets/profiles/`：新增四套 settings、SYSTEM、extensions 和 skills。
- `packages/core/src/types.ts`：删除 Agent 类型族，新增 provider、health、route 和 sanitized IPC 类型。
- `packages/persistence/src/migrations.ts`、`db.ts`、`repositories.ts`：v9、迁移前备份、provider health 和无 agent 列 repository。
- `packages/scheduler/src/orchestrator.ts`：直接依赖 `AgentRunner`，删除 registry、detect、能力合并和 Agent 分派。
- `apps/desktop/electron/provider-credentials.ts`：新增 safeStorage provider store 和旧配置迁移。
- `apps/desktop/electron/ai.ts`：改为共享 ProviderRouter，不再接受单个 `AiProviderConfig`。
- `apps/desktop/electron/services.ts`、`ipc.ts`、`api.ts`、`preload.ts`：装配 Pi runtime 和 providers IPC。
- `apps/desktop/src/pages/Settings.tsx`：删除 Agent 配置，改为有序 provider manager。
- `apps/desktop/package.json`、`build-electron.mjs`、staging script：固定 Pi 依赖及 extraResources。
- 根 `package.json`、`.env.example` 和真实测试脚本：定义 `test:real:pi` 及四个 `DEV_API_*` 变量契约；不得读取或改写 `.env`。
- `README.md`、`docs/architecture.md`、中英文 i18n：改写为 Pi-only 架构。

### 17.2 删除

- `packages/agents/src/adapters/claude-code.ts`
- `packages/agents/src/adapters/codex.ts`
- 旧 `packages/agents/src/adapters/pi.ts`
- `packages/agents/src/registry.ts`
- 外部 CLI detect/path resolution 代码及测试
- `packages/core/src/capability.ts` 及能力继承测试
- Renderer Agent Badge、Agent 选择和检测组件
- Claude Code/Codex 真实验收测试及相关 E2E 注入逻辑

测试 fake runner 保留在测试 fixture，不作为生产 Agent 类型导出。

## 18. 实施阶段边界

实施计划必须按以下可独立验收的顺序拆分，禁止先删旧运行时导致主分支长期不可运行：

1. Provider 新领域模型、加密存储、迁移前备份和 v9 数据迁移。
2. 固定 Pi 依赖、staging、manifest、locator 和跨平台自检。
3. 角色 profiles、内置 extensions/skills、run-plan 和环境隔离。
4. JSON event translator、journal、结构化完成和 fake Pi contract tests。
5. ProviderRouter、熔断、模型/提供商降级及中途接管。
6. 调度器切换为单一 `AgentRunner`；现有暂停、恢复、审查和 worktree 行为回归。
7. 对话/提案切换到共享 ProviderRouter。
8. Provider UI/IPC 上线并移除 Agent UI/IPC。
9. 删除 Claude Code/Codex/旧 Pi 兼容代码，更新文档和 E2E。
10. 使用本地 `.env` 完成 `test:real:pi`，再执行多平台打包冒烟和发布验证。

每一阶段都必须保持类型检查和相关测试通过。最后一次删除阶段之前，新 Pi 路径必须已具备完整替代能力；但最终发布产物不得包含双运行开关。

## 19. 验收标准

### 19.1 功能

- 新用户只配置一个 API Key 提供商即可使用需求对话和执行任务。
- 四角色分别加载预期 profile、工具、extensions、skills、system prompt、模型和 thinking。
- 两个提供商按 UI 排序；首选模拟失败后自动由第二项完成。
- 同提供商 primary 模型失败时先尝试 fallback，再进入下一提供商。
- mutation 后故障可由下一提供商检查当前工作区并继续，不重复已确认动作。
- 全部失败时有界停止并进入可恢复状态。
- 本地 `.env` 的开发供应商通过 `pnpm test:real:pi` 完成四角色、JSON 事件、降级和并发隔离验证。

### 19.2 隔离与安全

- 系统 Pi、用户 Node、用户 Pi 配置、项目 Pi 配置和父进程供应商变量均不能影响 Pi 的入口、版本和角色配置；项目工具链只能通过受角色策略约束的 Agent 工具调用使用。
- API Key 不出现在 argv、日志、IPC、Renderer state、错误文本或 models.json 明文中。
- `DEV_API_KEY` 不出现在真实测试 stdout、stderr、journal、SQLite fixture、临时文件、Git index 或打包产物中。
- 内置 Pi/扩展/skill 摘要不匹配时阻止运行。
- 角色/attempt 配置和 session 无交叉污染。

### 19.3 迁移

- 从 schema v8 及至少两个更早 fixture 升级成功，历史任务、消息、日志、checkpoint 和 execution 仍可读取。
- `tasks` 和 `execution_records` 不再包含 `agent_type`。
- 项目 settings 不再包含 `agentRoles`、`roleConfigs`。
- 旧单提供商配置变为新列表第一项，旧 model 被丢弃。
- 迁移失败回滚且备份可用；重复启动幂等。

### 19.4 代码退出标准

生产源码和生产类型中不存在：

- `ClaudeCodeAdapter`
- `CodexAdapter`
- 生产 `AgentRegistry`
- `AgentType`
- `agentType`
- `agentRoles`
- `roleConfigs`
- 调用命令名 `claude`、`codex` 或 PATH `pi` 的代码

OpenAI、Anthropic 等公司/协议名称可以作为 API provider 存在。“移除 Claude Code/Codex”指移除其 Agent CLI、领域类型、配置、检测、文案和兼容代码，不禁止相应公司的 API 模型。

所有 typecheck、lint、unit、integration、Electron E2E、多平台 package smoke、脱敏测试和迁移 fixture 必须通过。

## 20. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| Pi 升级改变 JSON event | 固定 0.80.10；contract fixture；未知事件向前兼容；升级单独 PR |
| Electron/ASAR 无法加载 Pi 动态依赖 | extraResources staging；构建后真实入口 smoke test |
| 多层 retry 导致成本和延迟失控 | 关闭 Pi auto retry；应用统一上限 8；持久化 route health |
| 中途切换重复副作用 | AttemptJournal、uncertain 状态、Git diff 事实源、接管前验证 |
| 兼容提供商协议差异 | 内置 provider adapter + models.json；发布候选真实验证 |
| extension 具备完整权限 | 只打包仓库内资源、摘要校验、禁止运行时 package 安装 |
| 迁移删除列不可逆 | `VACUUM INTO` 一致性备份、事务、SQLite 版本自检 |
| 隐藏配置难以诊断 | Main 进程结构化诊断包；用户只见高层状态；诊断全量脱敏 |

## 21. goal 模式交付约束

goal 模式应把本文件视为完整目标契约：

- 按第 18 节顺序制定并执行实施计划。
- 不以“保留旧适配器以兼容”为理由偏离最终状态。
- 不把角色配置、模型或 Pi 参数重新暴露给用户。
- 不用外部 Pi 完成测试或开发态兜底。
- 每完成一个阶段，运行对应测试并记录证据。
- `.env` 存在时必须把 `pnpm test:real:pi` 退出码 0 作为目标完成证据，同时不得读取或展示密钥值。
- 未满足第 19 节全部验收项前，不得宣告目标完成。
