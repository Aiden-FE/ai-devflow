# 迭代专用分支与对话体验改进设计

日期：2026-07-27
状态：实施中

## 背景

当前 ai-devflow 存在四个体验问题，本设计一次性解决：

1. 需求下的子任务在「任务详情」页（TaskDetail）的「同级子任务」列表始终展开，挤压主内容。Workspace 的 ReqItem 已实现默认收起，但 TaskDetail 未对齐。
2. 持续流式输出消息时，用户向上滚动查看历史会被新消息强制拉回底部。旧实现 `useStickToBottom` 仅在 `deps` 变化时滚动，缺少「上滚即暂停 + 未读计数 + 回到底部恢复」的完整语义。
3. 工具调用/结果消息与普通文本消息混用同一气泡，用户无法快速区分消息类型。
4. 迭代管理松散：开启迭代不创建专用分支，任务分支 `ai-devflow/<taskId>` 直接基于主分支开发，审查通过后直接合并回主分支；归档迭代只是单条 SQL UPDATE，无门禁、无二次确认、无分支合并。

## 设计

### 需求 1：子任务默认收起（TaskDetail）

- TaskDetail「同级子任务」改为可折叠区块，默认收起（与 ReqItem 行为一致）。
- 复用已有 i18n `ws.subtasks.expand`/`ws.subtasks.collapse`；标题显示数量。
- 不引入新 UI 原语，沿用 `useState` + `ChevronRight`/`ChevronDown` 手写模式（与 ReqItem 一致）。

### 需求 2：粘底滚动（上滚暂停）

- 统一聊天组件 `ChatThread`（新增）实现：
  - 首次挂载置底。
  - 用户上滚越过阈值（120px）→ 暂停粘底，新消息到达仅累计未读，不强制滚动。
  - 悬浮「新消息」按钮显示未读数，点击回到底部并清零。
  - 用户手动滚回底部 → 自动恢复粘底。
  - 顶部触顶加载更多历史（分页 30 条），保持视觉位置。
  - 程序触发的滚动设标志位，避免误判为用户上滚。
- TaskDetail 与 ChatPanel 均改用 ChatThread，删除各自重复的滚动逻辑。

### 需求 3：消息类型差异化渲染

ChatThread 按 `ChatItem.type` 分发不同渲染：

- `message`：ChatGPT 风格头像 + 圆角气泡（用户右对齐 primary 底色，助手左对齐 secondary）。
- `tool`：工具卡片（状态图标 CheckCircle/XCircle/Loader + 工具名 chip + 摘要），可展开查看「入参」「输出」两段折叠区域；错误态红色边框。
- `error`：居中红色胶囊（AlertCircle 图标）。
- `status`：居中灰色胶囊（Info 图标）。
- `custom`：透传节点（问答卡片等）。

TaskDetail 把 `TaskMessage` 映射为 ChatItem：`tool_call`→`tool`（input）、`tool_result`→`tool`（output）、`error`→`error`、`status`→`status`、其余→`message`。

### 需求 4：迭代专用分支

#### 分支命名

- 迭代专用分支：`ai-devflow-sprint/<version>`，其中 `<version>` 取自 `Iteration.version`（如 `v1.0.0` → `ai-devflow-sprint/v1.0.0`）。
- 版本号经清洗（非法 git ref 字符替换为 `-`，去首尾 `-`/`.`）。
- 任务特性分支仍为 `ai-devflow/<taskId>`，但基分支改为迭代分支（迭代激活时），而非主分支。

#### 生命周期

1. **创建迭代**：在 IPC `iterations:create` 中，创建迭代记录后立即从项目 `defaultBranch` 创建 `ai-devflow-sprint/<version>` 分支（幂等：已存在则复用）。分支创建失败不阻断迭代记录创建（降级：任务启动时仍会按需 ensure），但记录日志。
2. **启动任务**（orchestrator.runPipeline）：读取 `task.iterationId` → iteration；若 `status === 'active'`，则 worktree 的 `baseBranch` = 迭代分支（并 ensure 该分支存在）；否则回退 `defaultBranch`（保持旧行为）。
3. **审查通过**（orchestrator.reviewAndFinalize）：若迭代激活，合并任务分支 → 迭代分支（而非主分支）；否则保持旧行为（→ defaultBranch）。
4. **归档迭代**：
   - 门禁：该迭代下所有任务 `status === 'archived'`（`tasks.listByIteration`），否则 IPC 抛错、前端按钮禁用。
   - 二次确认：前端 Dialog 确认后才调用 archive。
   - 合并：迭代分支 → `defaultBranch`（复用 `mergeWorktreeBranch`，主工作区须停在 defaultBranch）。
   - 落库：`iterations.archive(id)`（追加 `archivedAt` 时间戳）。
   - 返回合并结果给前端展示。

#### 合并语义（任务分支 → 迭代分支）

主工作区停在 `defaultBranch`，不能直接 check out 迭代分支合并。采用两段策略：

- **快进**：若迭代分支是任务分支的祖先（`git merge-base --is-ancestor <sprint> <task>`），用 `git branch -f <sprint> <task>` 原子更新引用（无需 checkout，无工作区污染，并发安全）。
- **非快进**：临时 worktree 检出迭代分支 → `git merge --no-ff` 任务分支 → 移除临时 worktree。失败则中止合并，任务分支保留，记录原因。

迭代分支 → 主分支复用既有 `mergeWorktreeBranch`（主工作区在 defaultBranch，可 ff/no-ff 合并）。

#### 数据模型

- `Iteration` 增加可选字段 `archivedAt?: number`；DB `iterations` 表增加 `archived_at INTEGER` 列（迁移）。
- `IterationsRepo.archive(id, at)` 签名对齐 `RequirementsRepo.archive`。

#### 兼容与降级

- 迭代分支缺失（旧迭代、分支被误删）：`ensureSprintBranch` 幂等创建，任务仍可启动。
- 非 Git 项目（迭代所属项目无 Git 仓库）：分支操作 best-effort，不阻断迭代创建/归档的数据库操作；记录错误信息供前端展示。
- 版本号冲突（同项目同 version 已存在分支）：创建迭代时校验 version 在该项目内唯一（DB 查重 + 分支查重）。

## 影响范围

- `packages/core/src/types.ts`：`Iteration.archivedAt`。
- `packages/persistence/src/migrations.ts`：`iterations.archived_at` 列。
- `packages/persistence/src/repositories.ts`：`IterationsRepo.archive(id, at)`、map。
- `packages/scheduler/src/worktree.ts`：`sprintBranchName`、`ensureSprintBranch`、`mergeBranchInto`（ff/temp-worktree）。
- `packages/scheduler/src/orchestrator.ts`：runPipeline 基分支、reviewAndFinalize 合并目标。
- `apps/desktop/electron/ipc.ts`：iterations create/archive 逻辑。
- `apps/desktop/electron/preload.ts` + `api.ts`：archive 返回类型。
- `apps/desktop/src/pages/Workspace.tsx`：归档按钮禁用 + 二次确认 Dialog。
- `apps/desktop/src/pages/TaskDetail.tsx`：同级子任务折叠。
- `apps/desktop/src/components/ChatThread.tsx`（新增）、`ChatPanel.tsx`、i18n。
- 测试：worktree（sprint 分支）、orchestrator（基分支/合并目标）、ChatThread、TaskDetail 折叠。

## 验证

- `pnpm --filter @ai-devflow/scheduler test`：worktree + orchestrator 新增用例。
- `pnpm --filter @ai-devflow/desktop test`：ChatThread、TaskDetail、Workspace。
- `pnpm -r typecheck` + `pnpm -r lint`。
