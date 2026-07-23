# 工作台改进与维护者能力管理 - 设计文档

- 日期：2026-07-23
- 状态：已批准（待实施）
- 范围：5 项需求，分两类。需求 1/2/3 为用户侧改进；需求 4/5 为**维护者侧**，不暴露给最终用户。

## 1. 背景与范围

ai-devflow 是基于 Electron 的本地 AI 开发工作台，由内置、版本固定的 Pi 运行时（`@earendil-works/pi-coding-agent@0.80.10`）在隔离 Git worktree 中执行任务。架构详见 `docs/architecture.md`。

本设计覆盖以下 5 项需求：

1. 「本地兼容服务」勾选后再次编辑不回显 → 经澄清，**直接移除该配置项**，放行任意 http/https baseURL。
2. 工作台需求面板内已创建子任务的需求默认收起，可展开查看，超过 10 条分页。
3. 工作台顶部项目地址支持点击尾部 icon 打开目标文件夹。
4. 为不同角色 agent 安装扩展、技能、工具 → 经澄清为**维护者侧**问题（不暴露给用户），且需**支持按角色单独启用扩展**。
5. 查看各角色当前生效的能力 → 经澄清为**维护者自检 CLI 脚本**。

### 1.1 关键决策（已与用户确认）

| # | 决策点 | 结论 |
| --- | --- | --- |
| 1 | 勾选回显修复方式 | 移除「本地兼容服务」勾选框，放行任意 http/https baseURL（用户自担 API Key 明文风险） |
| 2 | 需求卡折叠范围 | 仅折叠子任务列表；头部（标题/优先级/子任务数/创建·归档按钮）常驻 |
| 3 | 打开文件夹方式 | 新 IPC `projects.openFolder(projectId)` + `shell.openPath`，按 projectId 解析校验 |
| 4 | 扩展粒度 | 增加按角色扩展（`RoleProfile` 携带 `extensions`），重构 materializer/run-plan/digest |
| 5 | 自检视图形态 | CLI 脚本 `pnpm inspect:roles`，无 UI、无运行时改动 |

### 1.2 架构一致性说明

需求 4/5 维护者侧定位与架构文档 §5/§7.1/§14 一致：不向最终用户暴露 tools/extensions/skills 配置，内置四角色 profile 接管所有 AI 运行行为。本设计仅为维护者提供「追加内置能力」的清晰机制与自检手段，不引入用户可见配置 UI，不反转既有架构决策。

## 2. 需求 1 - 移除「本地兼容服务」勾选，放行任意 http/https

### 2.1 根因

`allowInsecureLocal` 仅存在于 `ProviderInput`（`packages/core/src/provider.ts:73`），仅在校验时（`provider.ts:164`）使用后丢弃，**不进入持久化的 `ProviderConfig`**。`Settings.tsx:431` 的 `startEdit` 又硬编码 `setAllowLocal(false)`。用户决定直接移除该配置项。

协议限制仅存在于保存期校验 `normalizeProviderInput`（`provider.ts:161-169`）；运行时（`pi-ai.ts`/`provider-router.ts`）无 https 强制。`packages/core/src/sanitize.ts:33` 是 webhook 等通用协议校验（本就接受 http+https），与本需求无关，不动。

### 2.2 改动

- `packages/core/src/provider.ts`
  - 删除 `ProviderInput.allowInsecureLocal`（L73）。
  - 校验（L161-169）改为接受 `http:` 与 `https:` 任一；保留「禁止 URL 用户名/密码」「禁止 query/fragment」。
  - 删除 `LOCAL_HOSTS`（L127）及相关注释（L150、L72 注释）。
- `apps/desktop/electron/provider-store.ts`
  - 删除 `legacyAllowsLocalHTTP`（L57-65）及 L246 迁移处的 `allowInsecureLocal` 赋值。
- `apps/desktop/src/pages/Settings.tsx`
  - 删除 `allowLocal` state（L405）、`allowInsecureLocal: allowLocal`（L451）、checkbox（L561）、`startAdd`/`startReentry`/`startEdit` 中的 `setAllowLocal` 调用（L419、L426、L431）。
- i18n（`src/i18n/zh.ts` / `en.ts`）
  - 删除 `settings.providers.local`（zh L253）。
  - `settings.providers.baseURL.hint`（zh L252）改为「http/https 均可；http 会明文传输 API Key，请仅在可信网络使用」。

### 2.3 测试

- 更新 `apps/desktop/electron/__tests__/provider-store.test.ts`：断言保存 `http://127.0.0.1:8080/v1` 与 `http://192.168.1.10/v1` 均成功（不再需要 loopback/勾选）。
- 更新 `packages/core` provider 校验测试：http 非 loopback baseURL 不再被拒；仍拒 `ftp:`、含凭证、含 query 的 URL。
- `apps/desktop/electron/__tests__/ipc.test.ts`：移除涉及 `allowInsecureLocal` 的断言。

### 2.4 风险

非回环 http 明文传输 API Key。已在 i18n hint 与本节注明，由用户显式选择承担。

## 3. 需求 2 - 需求卡折叠与分页

### 3.1 现状

`ReqItem`（`apps/desktop/src/pages/Workspace.tsx:234-275`）始终内联展开子任务（L262-271），头部展示标题/优先级/验收/子任务数（L255 `ws.subtasksCount`）/创建·归档按钮。

### 3.2 改动

- `ReqItem` 新增 `collapsed` state，默认值 `subtasks.length > 0`（有子任务才收起；无子任务的原样展示，无可折叠内容）。
- 头部（标题/优先级/验收/子任务数/创建·归档按钮）**常驻可见**。
- 子任务区上方加可点击切换头，使用 `ChevronRight`/`ChevronDown`（lucide-react；`TaskDetail.tsx:196-199`、`308-323` 已有同款折叠范式），点击切换 `collapsed`。
- 展开后若 `subtasks.length > 10`：分页，每页 10。新增 `page` state（默认 0），渲染 `subtasks.slice(page*10, page*10+10)`，附 Prev/Next 按钮 + `第 {cur}/{total} 页` 指示。子任务列表变更或收起时 `page` 重置为 0。
- 分页内联实现（仓库无现成 Pagination 组件）。仅一处使用，默认内联；如需复用可后续抽 `components/ui/pagination.tsx`，本期不做。
- i18n 新增：`ws.subtasks.expand`、`ws.subtasks.collapse`、`ws.subtasks.page`（`第 {cur}/{total} 页`）、`ws.subtasks.prev`、`ws.subtasks.next`（zh/en 同步）。

### 3.3 测试

- `apps/desktop/src/__tests__/` 新增 Workspace 渲染测试：有子任务的需求默认收起、点击展开、子任务 >10 出现分页且翻页正确、收起后 page 重置。

## 4. 需求 3 - 项目地址尾 icon 打开文件夹

### 4.1 现状

`Workspace.tsx:49` 的 `{activeProject.path}` 为纯文本，无法打开。

### 4.2 改动（三层 IPC，沿用 `projects.pickFolder` 范式）

- `apps/desktop/electron/ipc.ts`
  - electron 导入（L3）追加 `shell`。
  - 新增 `ipcMain.handle(channel('projects','openFolder'), (e, projectId) => {...})`：`repos.projects.get(projectId)` 取 `path` → 校验 `path.isAbsolute(path)` + `fs.existsSync(path)` → `shell.openPath(path)`；返回 `{ ok: boolean; error?: string }`。信任锚点为 DB 记录（按 projectId 解析），**不接受 renderer 传入的路径**。
- `apps/desktop/electron/api.ts`：`projects` 命名空间（L101-110）加 `openFolder(id: string): Promise<{ ok: boolean; error?: string }>`。
- `apps/desktop/electron/preload.ts`：`projects`（L21-28）加 `openFolder: (id) => invoke('projects','openFolder')(id)`。
- `apps/desktop/src/pages/Workspace.tsx`：L49 改为路径文本 + `FolderOpen`（lucide）icon 按钮，点击调 `api.projects.openFolder(activeProject.id)`；失败时 inline 提示。
- i18n：`ws.openFolder`（tooltip）+ 打开失败文案。

### 4.3 测试

- `apps/desktop/electron/__tests__/ipc.test.ts`：未知 projectId 返回 `ok:false`；存在且路径有效时调用 `shell.openPath`（mock）；路径不存在时 `ok:false`。

## 5. 需求 4 - 维护者侧：为角色 agent 安装能力（含按角色扩展）

### 5.1 现状机制

- `RoleProfile`（`packages/agents/src/profiles.ts:30-40`）含 `role/version/systemPromptFile/tools/excludedTools/skills/timeoutMs`；`extensions` 未列入接口，四角色共用模块常量 `BUILTIN_EXTENSIONS`（L46-51）。
- `ROLE_PROFILES`（L53-78）四角色只读 profile。
- `INTERNAL_TOOLS`（L43）= `ai_devflow_interaction`/`ai_devflow_report_result`，四角色强制启用，不可配。
- `buildPiRunPlan`（`packages/agents/src/run-plan.ts:84-102`）：`--no-extensions` 后遍历 `BUILTIN_EXTENSIONS` 加 `--extension <profileDir>/extensions/<ext>.ts`（L85-87）；`--no-skills` 后遍历 `profile.skills` 加 `--skill <profileDir>/skills/<name>/SKILL.md`（L89-91）；`--tools roleToolsArg(role)`（L97-99），`roleToolsArg` = `profile.tools ∪ INTERNAL_TOOLS`（L81-83）。
- `ProfileMaterializer.materialize`（`profiles.ts:159-192`）：复制 `<role>/` 资源到内容寻址快照 `<baseDir>/profiles/<digest>/<role>/`，并把 `BUILTIN_EXTENSIONS` 全部复制到 `extensions/`（L167-172）；`digest()`（L144-157）以 `role/profileVersion/provider*` 为 key，**不含 skills/extensions 列表**。
- 资产目录：`packages/agents/assets/profiles/<role>/{SYSTEM.md,settings.json,skills/<name>/SKILL.md}` 与 `shared/extensions/<ext>.ts`。
- 运行时接入：`pi-runtime.ts:99-102` `assetsRootFor()`，dev 读 `packages/agents/assets/profiles`，打包读 `resources/pi-runtime/profiles`；`ProfileMaterializer(assetsRootFor(), join(userData,'pi-runtime'))`（L142）。
- 打包：`stage-pi-runtime.mjs` 把 `packages/agents/assets/profiles` 复制到 `build/pi-runtime/profiles`（L180）并算 `profilesDigest` 写入 manifest（L181、L199）；electron-builder `extraResources` 把 `build/pi-runtime` 复制到 `resources/pi-runtime`（不入 asar）。
- **MCP 不支持**：Pi 0.80.10 dist 中「mcp」仅出现在 `highlight.min.js`（语法高亮 vendor），无 `mcpServers`/`--mcp` 任何支持。Pi settings.json schema 含 `extensions/skills/packages/tools/enableSkillCommands`，无 MCP。

### 5.2 改动 A - 按角色扩展重构

- `RoleProfile`（profiles.ts:30-40）新增 `extensions: string[]`。
- `BUILTIN_EXTENSIONS`（L46-51）语义改为**扩展注册池**（`shared/extensions/` 下可用 `.ts` 文件清单），不再表示「全角色清单」。
- `ROLE_PROFILES`（L53-78）：每角色 `extensions` 默认列四个基建扩展 `event-bridge`/`execution-policy`/`structured-result`/`checkpoint-context`（支撑 `INTERNAL_TOOLS` 与 worktree 写入限制/检查点恢复，四角色都需要）；维护者可按角色追加自定义扩展名。
- `buildPiRunPlan`（run-plan.ts:85-87）：遍历 `profile.extensions` 替代全局 `BUILTIN_EXTENSIONS`。
- `ProfileMaterializer.materialize`（profiles.ts:167-172）：仅复制 `profile.extensions` 列出的扩展（从 `shared/extensions/<ext>.ts`）。
- `digest()`（L144-157）：**不改**。沿用既有 `profileVersion` 机制——扩展变更同样通过 bump `ROLE_PROFILES[role].version` 触发新内容寻址快照（与 skills/tools 变更一致），避免在途执行受干扰。
- 新增 `validateRoleProfiles()`（profiles.ts，模块加载时顶层调用）：断言每角色 `extensions` 每项 ∈ `BUILTIN_EXTENSIONS` 池、`skills` 目录存在、`tools` 合法，否则 fail-fast，避免运行期才暴露缺失的扩展文件。

### 5.3 改动 B - 维护者指南 `docs/maintaining-role-capabilities.md`

- 加 skill：创建 `packages/agents/assets/profiles/<role>/skills/<name>/SKILL.md` → 加入 `ROLE_PROFILES[role].skills` → bump `ROLE_PROFILES[role].version`。
- 加扩展（含按角色）：创建 `packages/agents/assets/profiles/shared/extensions/<name>.ts` → 加入 `BUILTIN_EXTENSIONS` 池 → 加入目标 `ROLE_PROFILES[role].extensions` → bump `version`。
- 加工具：`ROLE_PROFILES[role].tools`/`excludedTools`（仅 Pi 内置工具 `read/bash/edit/write/grep/find/ls`）；`INTERNAL_TOOLS` 不可配。
- **MCP 不支持**：明确写出；安装 MCP servers 需升级 Pi 版本（按架构 §13.1 重新 staging/manifest/校验和/兼容性测试）。
- settings.json 的 `packages/extensions/skills` 保持 `[]`（app 用 CLI 参数显式注入，不走 Pi 自动发现）。
- 版本与物化：bump `version` 触发新内容寻址快照，避免干扰在途执行；dev 直读源资产；`pnpm stage:pi` 复制 + 算 profilesDigest；build 经 extraResources 入 `resources/pi-runtime`。
- 验证：`pnpm test:real:pi` + 需求 5 的 `inspect:roles` 脚本。
- 安全：扩展为 Pi 子进程内执行的 TS 文件（隔离 env），自定义扩展须审查同等级安全姿态（不外泄、尊重 worktree 写入边界）。

### 5.4 测试

- `packages/agents/src/__tests__/profiles.test.ts`：按角色 extensions 物化正确（仅复制声明扩展）；digest 随 `profile.extensions` 变化；引用池外扩展名时 fail-fast。
- `packages/agents/src/__tests__/run-plan.test.ts`：argv 的 `--extension` 来自 `profile.extensions`，非全局常量。
- `pi-runner.test.ts` 维持绿（fake Pi 夹具）。

## 6. 需求 5 - 维护者能力自检 CLI 脚本

### 6.1 改动

- 新增 `scripts/inspect-roles.mjs`：从 `@ai-devflow/agents` 导入 `ROLE_PROFILES`/`INTERNAL_TOOLS`/`BUILTIN_EXTENSIONS`（`packages/agents/src/index.ts:19-31` 已导出），按角色打印 `role / version / tools(profile.tools ∪ INTERNAL_TOOLS) / excludedTools / skills / extensions(profile.extensions) / timeoutMs / systemPromptFile`；支持 `--json` 供 CI 消费。
- 根 `package.json` 加 `"inspect:roles": "node scripts/inspect-roles.mjs"`。
- 零运行时改动：无 IPC、无 UI、不进打包产物。纯静态读常量。

### 6.2 测试

- smoke：`pnpm inspect:roles` 退出码 0 且含四角色名（planner/coder/reviewer/tester）；`pnpm inspect:roles -- --json` 输出可 JSON 解析且字段与 `ROLE_PROFILES` 一致。可纳入 CI 质量门禁或 `pnpm test`。

## 7. 实施计划与排序

1. 需求 1（小，core + Settings + i18n + 测试）
2. 需求 2（中，Workspace + i18n + 测试）
3. 需求 3（小，三层 IPC + Workspace + i18n + 测试）
   - 1/2/3 相互独立，可并行。
4. 需求 4（中，agents refactor + 指南 + 测试）
5. 需求 5（小，脚本，依赖 4 的 `extensions` 字段）

## 8. 测试策略汇总

| 需求 | 位置 |
| --- | --- |
| 1 | `packages/core` provider 校验测试、`apps/desktop/electron/__tests__/provider-store.test.ts`、`ipc.test.ts` |
| 2 | `apps/desktop/src/__tests__/` Workspace 渲染测试 |
| 3 | `apps/desktop/electron/__tests__/ipc.test.ts` |
| 4 | `packages/agents/src/__tests__/profiles.test.ts`、`run-plan.test.ts`、`pi-runner.test.ts` |
| 5 | `scripts/inspect-roles.mjs` smoke（CI） |

真实 Pi 验证（`pnpm test:real:pi`）与 Electron E2E（`apps/desktop/e2e`）维持既有基线；需求 4 改动后应重跑真实 Pi 四角色验证。

## 9. 风险与备注

- 需求 1：非回环 http 明文 API Key（用户已确认承担）；i18n hint 须明示。
- 需求 4：按角色扩展重构改变 `BUILTIN_EXTENSIONS` 语义（全角色清单 -> 注册池）与 `RoleProfile` 形状；须保证四角色默认仍含四个基建扩展，不破坏现有 `pi-runner`/真实 Pi 行为。`digest()` 不改；扩展/skills/tools 变更统一靠 bump `version` 生成新快照目录，旧快照自然淘汰，无数据迁移。
- 需求 4：MCP 在当前 Pi 版本不可用；若未来 Pi 升级支持 MCP，需另立设计（凭证存储、子进程 env 白名单、settings schema）。
- 需求 5：脚本只读静态常量，不反映运行时 provider/健康状态；仅展示内置角色能力清单。
