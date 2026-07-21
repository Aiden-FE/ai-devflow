# ai-devflow

本地优先的 AI 开发工作台。把自动化开发流程做成泳道看板，由本地 AI Agent 桥接器（Claude Code、Codex、Pi）在隔离的 Git worktree 中真实执行任务，SQLite 持久化全部状态、执行记录、对话消息、检查点与通知，支持应用重启后恢复。

## 架构

详见 [docs/architecture.md](docs/architecture.md)。要点：

- `packages/core`：纯 TS 领域模型、泳道状态机、门禁、超时/Webhook 计算、CLI 标准化、重试/恢复、校验/脱敏。
- `packages/persistence`：基于 Node 26 内建 `node:sqlite` 的迁移、事务、Repository。
- `packages/agents`：`AgentAdapter` 协议（含能力声明）+ Claude Code / Codex / Pi 三桥接器 + 可控测试适配器 + 检测。
- `packages/scheduler`：角色分派、能力解析、流水线、并发上限、阶段依赖、Git worktree 隔离、检查点、暂停/恢复/取消/重试、澄清/授权恢复、重启恢复。
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

## Agent 能力配置

能力配置采用**「全局默认 + 项目覆盖」**两层：

- 设置页“全局 Agent 能力默认配置”为所有项目设定按角色的默认值（默认 Agent、工具、插件、Skills、授权）。
- “项目 Agent 能力配置”按项目与角色（规划/开发/审查/测试）覆盖全局。运行时按**项目显式值 > 全局值 > 系统默认**逐字段合并；未填写的字段在 UI 标注「继承全局」并以占位符展示继承值，提供「恢复继承」清除覆盖。
- **字段语义**：`undefined`=未配置（继承）；`[]`=显式空覆盖（如 `tools=[]` 禁用全部工具、`skills=[]` 关闭全部 Skills）。留空保存**不会**把继承值固化为项目值。
- 各适配器声明自身支持的能力，不支持者在 UI 禁用并说明。审查 Agent（reviewer 角色）同样使用合并后的能力配置。
- Claude Code 通过 `--allowedTools/--disallowedTools`（工具）、`--plugin-dir/--plugin-url`（插件）、`--disable-slash-commands`（Skills 全开/全关）落地；授权模式下用 `--permission-mode manual` 把工具调用转为 `approval_request`。

## 任务对话与授权

任务详情以**聊天窗口**展示实时消息：消息气泡（角色/时间）、工具调用可折叠、长内容局部滚动、自动滚动到底部；刷新/重启后历史不丢失，旧 `log_entries` 保留兼容，执行记录折叠展示。**输入区固定在聊天窗口底部**，仅在 `awaiting_input`（等待澄清、手动暂停）时出现：澄清回复直接作为用户消息发送并恢复任务；授权/确认继续使用明确按钮并显示在同一对话流内。手动「标记待沟通」会创建一条澄清交互，确保用户始终可输入并恢复。等待期间不空转、不自动重试；拒绝授权不判定成功。

## AI 服务商

设置页“AI 服务商”支持 Anthropic（Claude）与 OpenAI 兼容服务：

- **baseURL 规范化（Anthropic）**：可填主机根地址（`https://host`）、`/v1` 前缀（`https://host/v1`）或完整 messages 地址，系统自动归一化为 `.../v1`，避免漏加或重复拼接 `/v1/messages` 导致的 404；OpenAI 兼容路径保持原样。
- Anthropic 同时携带 `x-api-key` 与 `Authorization: Bearer`，兼容不同网关的鉴权约定（不降级为 OpenAI 协议）。
- **「测试连接」**：返回脱敏后的最终请求地址、HTTP 状态与服务端摘要；API Key 只进请求头，绝不记录或回传。

## Pi CLI 检测

检测与启动均使用**解析后的绝对 CLI 路径**，并让 CLI 所在 bin 目录**优先进入 PATH**，使 `#!/usr/bin/env node` 的 shebang 命中与该 CLI 同源的 Node（避免「找到了 pi 却因命中旧 Node 不支持 `??=` 而启动失败」）。检测结果区分**「未找到 CLI」**与**「CLI 已找到但 Node 运行时不兼容」**，诊断中给出 CLI 路径与 Node 路径/版本（不硬编码用户路径）。

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
- **可选** Agent CLI：`claude`（Claude Code）、`codex`（Codex）、`pi`（Pi）。缺失时桥接器会如实报告不可用并给出验收步骤，不伪造通过。

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

## 配置桥接器

1. 安装对应 CLI 并登录（Claude Code：`claude`；Codex：`codex login`；Pi：按官方文档安装 `pi`）。
2. 在应用“设置 → Agent 桥接器检测”点击“重新检测”，确认可用性。
3. 创建任务时可指定 Agent，或按角色默认分派（规划/开发→Claude Code，审查/测试→Codex）。

## 扩展自定义 Agent

见 [docs/architecture.md §10](docs/architecture.md#10-扩展自定义-agent)。实现 `AgentAdapter`（`id`/`detect`/`run`），
在 `packages/agents/src/registry.ts` 注册，并在 `core` 的 `AgentType` 追加字面量。

## 测试策略

- 单元：状态机合法/非法迁移、门禁、超时计算、Webhook Payload/签名、CLI 标准化、重试/恢复、校验/脱敏。
- 集成：SQLite 迁移/事务/Repository、全生命周期、类型化 IPC、Agent 适配器（可控测试进程）、调度/取消/恢复、通知投递/重试、worktree 生命周期。
- Electron E2E：导入项目、迭代/需求、六泳道、检测 Agent、流式日志、待沟通恢复、通知规则、背景持久化、危险操作确认（`apps/desktop/scripts/run-e2e.mjs`）。

## 安全

- Renderer：`nodeIntegration=false`、`contextIsolation=true`、`sandbox=true`，仅通过 preload 暴露的类型化 IPC 访问主进程。
- IPC：每个通道显式 `ipcMain.handle`，不存在任意命令执行入口；状态迁移在主进程再用门禁校验。
- 凭证：Webhook 密钥用 Electron `safeStorage` 加密落盘，列表接口不回传明文。
- 子进程：Agent 以 `spawn`（无 shell）启动，cwd 为隔离 worktree；Codex 默认 `workspace-write` 沙箱。
- CSP：禁止远程脚本与内联脚本（开发模式为支持 HMR 放宽）。

## 已知限制

仅列真实限制：

- **Codex 真实任务**：Codex CLI 已安装(0.144.1)并登录(ChatGPT)，但执行时 ChatGPT 后端网络不可达，可验证小任务未能在本机完成；桥接器已正确调用真实 CLI 并产出终止事件，附可重复验收步骤（在可访问 chatgpt.com 后端的环境中于受信任 git 仓库内运行 `codex exec --sandbox read-only "Print exactly AI_DEVFLOW_CODEX_OK"`）。
- **Pi CLI**：本机未安装 `pi`；桥接器如实报告不可用并附安装/验收步骤。检测已能区分「未找到 CLI」与「CLI 找到但 Node 运行时不兼容（如不支持 `??=`）」，并给出 CLI/Node 路径与版本诊断（含多 Node/PATH/shebang 回归测试）。
- **打包**：三平台发版流水线（macOS/Windows/Linux）已在 `.github/workflows/release.yml` 落地并经 YAML 校验；本机现场执行的是 `build` 产物与 `dev`/`e2e` 运行，完整签名打包（dmg/nsis/AppImage）由 CI 触发。
