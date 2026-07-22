# ai-devflow

本地优先的 AI 开发工作台。把自动化开发流程做成泳道看板，由**内置、版本固定的 Pi 运行时**（`@earendil-works/pi-coding-agent@0.80.10`，随应用打包）在隔离的 Git worktree 中真实执行任务，SQLite 持久化全部状态、执行记录、对话消息、检查点与通知，支持应用重启后恢复。用户无需安装任何 Agent CLI 或 Node.js，只需配置一个有序的 AI 服务商列表。

## 架构

详见 [docs/architecture.md](docs/architecture.md)。要点：

- `packages/core`：纯 TS 领域模型、泳道状态机、门禁、超时/Webhook 计算、Provider 契约、重试/恢复、校验/脱敏。
- `packages/persistence`：基于 Node 内建 `node:sqlite` 的迁移（schema v9，迁移前一致性备份）、事务、Repository（含 provider_health / execution_attempts）。
- `packages/agents`：内置 Pi 运行时——`BundledPiLocator`（清单/摘要/版本自检）、`RoleProfileRegistry`（四角色 versioned profile）、`ProfileMaterializer`（内容寻址快照）、`PiProcessSupervisor`（隔离子进程）、`PiJsonEventTranslator`（JSONL→事件 + AttemptJournal）、`ProviderRouter`（有序提供商 + 熔断降级）、`PiRunner`（单一 `AgentRunner` 生产实现）。
- `packages/scheduler`：单一 `AgentRunner` 驱动、流水线、并发上限、阶段依赖、Git worktree 隔离、检查点、暂停/恢复/取消/重试、澄清/授权恢复、重启恢复。
- `packages/notifications`：持久化超时规则、桌面通知+深链+防重复、Webhook 配置/签名/重试/投递历史。
- `apps/desktop`：Electron（main + preload + 类型化 IPC + 安全配置 + 自动更新）+ React 渲染器（项目/迭代/需求/看板/任务对话/设置/主题）。

## 看板与状态

可见泳道：`ready（待开发）→ in_progress（开发中）→ testing（测试中）→ in_review（待验收）→ archived（已归档）`。

- 需求池（backlog）已移除：新建任务直接进入待开发。
- `awaiting_input`（待沟通/待授权）不是独立泳道，而是暂停标识（保留 `pausedFrom` 在原泳道展示）。
- **开发任务禁止直接进入待验收**：开发 Agent 完成后进入**测试中**，由 reviewer 角色对应的审查 Agent 自动审查（上下文含需求/验收标准、任务目标、git diff/产物，覆盖需求覆盖、测试构建 lint、回归、安全、无关改动）。**审查通过才合并并进入待验收**；不通过退回开发中并携带反馈修复（有界返工）。审查结论与证据持久化到执行记录与任务对话。任何拖拽/IPC 都不得绕过门禁。
- **验收不通过退回**为专用操作：原因必填并写入任务消息/审计，目标状态可选「待开发」（仅改状态）或「开发中」（立即携原因执行修复），默认开发中。
- 归档必须经任务详情“验收通过并归档”并二次确认，看板拖拽不得绕过。

## 主题

支持 `浅色 / 深色 / 自动（跟随系统）`，默认自动。结合 Electron `nativeTheme.themeSource` 同步 `<html>` class、`color-scheme` 与窗口背景，避免亮色启动闪黑；设置页提供选择器并持久化。

## 任务对话与授权

任务详情以**聊天窗口**展示实时消息：消息气泡（角色/时间）、工具调用可折叠、长内容局部滚动、自动滚动到底部；刷新/重启后历史不丢失，旧 `log_entries` 保留兼容，执行记录折叠展示。**输入区固定在聊天窗口底部**，仅在 `awaiting_input`（等待澄清、手动暂停）时出现：澄清回复直接作为用户消息发送并恢复任务；授权/确认继续使用明确按钮并显示在同一对话流内。手动「标记待沟通」会创建一条澄清交互，确保用户始终可输入并恢复。等待期间不空转、不自动重试；拒绝授权不判定成功。

## AI 服务商（有序提供商列表）

用户唯一需要管理的 AI 运行配置是一个**有序的提供商列表**（设置页"AI 服务商"）。应用按任务角色选择**内置** Pi 配置与内置模型；首选提供商不可用时，自动尝试同提供商备用模型及列表中的后续提供商（熔断 + 有界降级）。

- **只配置**：类型（anthropic/openai/google/deepseek/openrouter 或两类兼容网关）、显示名称、API Key、兼容服务 Base URL、启用状态、拖拽排序。**模型、备用模型、thinking、工具、扩展、Skills、系统提示词均不向用户暴露**。
- **API Key**：经系统安全存储加密，仅可替换或清除，保存后显示"已配置"，不回显。
- **Base URL**：默认仅 HTTPS；显式勾选"本地兼容服务"后允许 `http://127.0.0.1` / `[::1]` / `localhost`。拒绝 URL 凭证/fragment/query 携带 Key。
- **「测试连接」**：经 ProviderRouter 解析该提供商可用路线，返回高层可达性（不暴露模型/密钥）。
- **健康状态**（高层）：可用 / 未测试 / 冷却中 / 配置错误。

## 内置 Pi 运行时

- **捆绑固定版本** `@earendil-works/pi-coding-agent@0.80.10`，随应用打包（`extraResources`，不入 ASAR），绝不读取 PATH 中的 `pi`，也不运行时下载/自更新。升级 Pi 必须通过应用 PR（更新精确版本、锁文件、资源校验和与兼容性测试）。
- **启动自检**：依次校验 `runtime-manifest.json`、全量文件摘要、入口、`pi --version` 与预期版本；任一失败即阻止 Agent 执行并报「应用运行组件损坏」，绝不回退系统 Pi。
- **三级隔离**：应用（版本 + Pi 版本）/ 角色（profile + 提供商配置摘要）/ 执行尝试（execution + attempt 独立 session）。`--no-*` 关闭一切自动发现（extensions/skills/prompt-templates/themes/context-files），仅显式加载内置资源；四套 settings 均 `retry.enabled:false`，重试/退避只由 ProviderRouter 控制（避免嵌套重试乘积）。
- **子进程安全**：环境从空白白名单构造（隔离 HOME/临时目录、受控 PATH、PI_* 隔离、唯一候选凭证），不使用 `process.env`；日志统一脱敏（凭证、URL query、用户目录、完整 prompt、内部绝对路径）。
- **四角色**（planner/coder/reviewer/tester）各有独立 versioned profile（settings/SYSTEM/extensions/skills/工具/thinking/模型映射），互不干扰；reviewer 只读、禁止写文件与安装。

## 自动更新与发版

使用 electron-builder GitHub Provider + `electron-updater`：仅打包后启用，启动后异步检查、静默下载，下载完成提示当前/新版本。**「立即升级」**进入安装中状态并真正退出安装重启；不可安装时进入可见 error 状态并展示可诊断信息（绝不静默 no-op）。已移除「稍后」按钮。

发版通过 `.github/workflows/release.yml` 的**三段多平台流水线**（`workflow_dispatch` 输入 semver，仅基于 main，拒绝重复 Tag/Release，先 typecheck/lint/test）：

1. **prepare**：质量门禁 → 生成 CHANGELOG/Release Notes → 版本号 bump → 打 tag 推送（唯一写 git 的阶段）。
2. **build**（matrix: macOS / Windows / Linux）：checkout tag，`electron-builder --publish never` 构建并校验本平台预期构件齐全后上传 artifact（`if-no-files-found: error`，缺失即失败）。
3. **publish**：汇总三平台构件并复核齐全后，**统一创建唯一一个 GitHub Release**（正文=生成的 Release Notes），避免矩阵并发创建 Release。

产物：macOS dmg/zip（x64+arm64）、Windows NSIS（x64）、Linux AppImage（x64）及各自 `latest*.yml`/blockmap。`CHANGELOG.md` 与 Release 正文均只描述「上一版本 tag → 当前版本」，按新功能/问题修复/其他变更分组并附 compare 链接。详见 [docs/architecture.md §11](docs/architecture.md#11-自动更新与发版)。

## 环境要求

- Node.js ≥ 22（开发用 26；Electron 43 内建 Node 24，`node:sqlite` 无标志可用）
- pnpm 11
- git

> 内置 Pi 运行时随应用打包，**无需**安装任何 Agent CLI（`claude`/`codex`/`pi`）或额外 Node.js。

## 安装

```bash
pnpm install
```

仓库根目录 `.npmrc` 已配置 Electron 二进制走 npmmirror 镜像（GitHub 释放物在国内网络慢/不可达）。
若镜像不可用，可设置 `ELECTRON_MIRROR` 指向可达镜像后 `pnpm rebuild electron`。

## 验证命令（实际脚本名，均已在开发机实测）

| 命令 | 结果 |
| --- | --- |
| `pnpm install` | 成功（Electron 43 二进制经 npmmirror 下载） |
| `pnpm verify` | typecheck + lint + test + scripts，6 包全部通过 |
| `pnpm test` | core 98 + persistence 32 + agents 50(+4 skipped) + scheduler 34 + notifications 10 + desktop 46 + scripts 8 = **278 通过 / 4 按需跳过** |
| `pnpm --filter @ai-devflow/agents verify:real` | 真实 Agent 验收（Claude ✅ 完成；Codex/Pi 诊断+步骤） |
| `pnpm --filter @ai-devflow/desktop build` | renderer（vite）+ electron（esbuild）构建成功 |
| `pnpm dev` | Electron 应用启动成功（已实测） |
| `pnpm --filter @ai-devflow/desktop e2e` | Playwright Electron E2E **10/10 全部通过**（已实测，含测试中审查流转与设置页语言切换） |

## 运行

```bash
pnpm install
pnpm dev          # 开发模式（vite + electron）
```

生产模式：

```bash
pnpm --filter @ai-devflow/desktop start   # 构建后启动
pnpm --filter @ai-devflow/desktop package # 打包（electron-builder --dir）
```

## 配置 AI 服务商

1. 打开应用"设置 → AI 服务商"，点击"新增提供商"。
2. 选择类型（如 openai_compatible）、填显示名称与 API Key（兼容网关再填 Base URL），保存。
3. （可选）再添加其它提供商并拖拽排序；首选不可用时会自动降级到后续提供商。
4. 用「测试」验证可达性，然后即可使用需求对话与执行任务。

## 测试策略

- 单元：状态机合法/非法迁移、门禁、超时计算、Webhook Payload/签名、Provider 校验、路由/熔断降级、运行计划与环境隔离、JSON 事件翻译、重试/恢复、校验/脱敏。
- 集成：SQLite 迁移/备份/Repository、全生命周期、类型化 IPC、Pi 运行链路（fake Pi 夹具驱动的真实 supervisor/translator/router）、调度/取消/恢复、通知投递/重试、worktree 生命周期。
- 真实端到端：`pnpm test:real:pi` 用本地 `.env` 的开发供应商驱动内置 Pi 完成四角色、JSON 事件、降级与并发隔离验证（含密钥泄露扫描）。
- Electron E2E：导入项目、迭代/需求、六泳道、流式日志、待沟通恢复、通知规则、背景持久化、危险操作确认（`apps/desktop/scripts/run-e2e.mjs`）。

## 安全

- Renderer：`nodeIntegration=false`、`contextIsolation=true`、`sandbox=true`，仅通过 preload 暴露的类型化 IPC 访问主进程。
- IPC：每个通道显式 `ipcMain.handle`，不存在任意命令执行入口；状态迁移在主进程再用门禁校验。
- 凭证：API Key 与 Webhook 密钥用 Electron `safeStorage` 加密落盘，列表接口不回传明文；API Key 不进 argv/日志/IPC/Renderer。
- 子进程：内置 Pi 以 `process.execPath` + `ELECTRON_RUN_AS_NODE`（无 shell）启动，环境从空白白名单构造，cwd 为隔离 worktree，独立 session，角色策略限制写入/命令。
- CSP：禁止远程脚本与内联脚本（开发模式为支持 HMR 放宽）。

## 已知限制

仅列真实限制：

- **真实供应商验证**：发布候选需在受控环境对每种支持的提供商类型运行最小工具任务、结构化输出、流式对话与一次故障降级（普通 PR 不使用真实密钥；`pnpm test:real:pi` 为本机开发验证）。
- **打包**：`extraResources` 已将 `build/pi-runtime` 随应用分发；macOS x64/arm64、Windows x64、Linux x64 的完整签名打包与打包后隔离冒烟由发版流水线执行。
- **Pi CLI**：本机未安装 `pi`；桥接器如实报告不可用并附安装/验收步骤。检测已能区分「未找到 CLI」与「CLI 找到但 Node 运行时不兼容（如不支持 `??=`）」，并给出 CLI/Node 路径与版本诊断（含多 Node/PATH/shebang 回归测试）。
- **打包**：三平台发版流水线（macOS/Windows/Linux）已在 `.github/workflows/release.yml` 落地并经 YAML 校验；本机现场执行的是 `build` 产物与 `dev`/`e2e` 运行，完整签名打包（dmg/nsis/AppImage）由 CI 触发。

## 品牌资产

标识为原创矢量重建：右半圆环代表持续流转，左侧尖角代表代码括号「<」，四节点代表智能节点；\n配色以电光蓝/青色为主，紫罗兰作克制点缀。AI 图仅作母稿，未嵌入 PNG。

- 单一矢量源：`apps/desktop/brand/*.svg`
  - `icon.svg` 容器版（应用图标主源）
  - `mark.svg` 独立标识、`mark-mono.svg` 单色版
  - `light.svg` / `dark.svg` 深浅容器版
  - `lockup.svg` / `lockup-mono.svg` 横版「图标 + ai-devflow」
- 栅格产物：`apps/desktop/build/icon.png`、`build/icon.icns`、`build/icon.ico`、`build/icons/**`
- 可重复生成脚本：`node apps/desktop/scripts/gen-brand-assets.mjs`（优先 @resvg/resvg-js，否则回退 macOS `qlmanage` + `sips` + 纯 Node ICO/ICNS）
