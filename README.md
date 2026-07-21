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

可见泳道：`ready（待开发）→ in_progress（开发中）→ in_review（待验收）→ archived（已归档）`。

- 需求池（backlog）已移除：新建任务直接进入待开发。
- `awaiting_input`（待沟通/待授权）不是独立泳道，而是暂停标识（保留 `pausedFrom` 在原泳道展示）。
- 任务完成进入**待验收**；归档必须经任务详情“验收通过并归档”并二次确认，看板拖拽不得绕过。

## 主题

支持 `浅色 / 深色 / 自动（跟随系统）`，默认自动。结合 Electron `nativeTheme.themeSource` 同步 `<html>` class、`color-scheme` 与窗口背景，避免亮色启动闪黑；设置页提供选择器并持久化。

## Agent 能力配置

设置页“项目 Agent 能力配置”可按项目与角色（规划/开发/审查/测试）配置：默认 Agent、允许/禁用工具、插件、Skills、是否要求人工授权。各适配器声明自身支持的能力，不支持者在 UI 禁用并说明。任务显式指定的 Agent 优先于角色默认。Claude Code 通过 `--allowedTools/--disallowedTools`（工具）、`--plugin-dir/--plugin-url`（插件）、`--disable-slash-commands`（Skills 全开/全关）落地；授权模式下用 `--permission-mode manual` 把工具调用转为 `approval_request`。

## 任务对话与授权

任务详情以对话窗口展示实时消息（user/assistant/system/tool、tool_call/tool_result、澄清/授权/确认请求、错误/状态），刷新/重启后历史不丢失；旧 `log_entries` 保留兼容，执行记录折叠展示。等待交互时进入 `awaiting_input`，回答/批准/确认后从检查点或 Agent session 恢复；等待期间不空转、不自动重试；拒绝授权不判定成功。

## 自动更新与发版

使用 electron-builder GitHub Provider + `electron-updater`：仅打包后启用，启动后异步检查、静默下载，下载完成提示当前/新版本，点击“立即升级”才退出安装；提供手动检查。发版通过 `.github/workflows/release.yml`（`workflow_dispatch` 输入 semver，仅基于 main，拒绝重复 Tag/Release，先 typecheck/lint/test 再构建安装包与更新 metadata，创建 `v<version>` Tag 与 GitHub Release）。详见 [docs/architecture.md §11](docs/architecture.md#11-自动更新与发版)。

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
| `pnpm typecheck` / `pnpm lint` | 6 包全部通过 |
| `pnpm test` | core 63 + persistence 18 + agents 20(+4 skipped) + scheduler 12 + notifications 10 + desktop 7 = **130 通过 / 4 按需跳过** |
| `pnpm --filter @ai-devflow/agents verify:real` | 真实 Agent 验收（Claude ✅ 完成；Codex/Pi 诊断+步骤） |
| `pnpm --filter @ai-devflow/desktop build` | renderer（vite）+ electron（esbuild）构建成功 |
| `pnpm dev` | Electron 应用启动成功（已实测） |
| `pnpm --filter @ai-devflow/desktop e2e` | Playwright Electron E2E **8/8 全部通过**（已实测） |

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
- **Pi CLI**：本机未安装 `pi`；桥接器如实报告不可用并附安装/验收步骤。
- **打包**：`electron-builder --dir`（`package` 脚本）未现场执行完整签名打包（dmg），仅验证了 `build` 产物与 `dev`/`e2e` 运行。
