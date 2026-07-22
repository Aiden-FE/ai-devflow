# 内置 Pi 单一 Agent 运行时 - 待修复报告

> 生成日期：2026-07-22
>
> 依据设计：`docs/superpowers/specs/2026-07-22-embedded-pi-runtime-design.md`
>
> 审查范围：`main` 分支当前代码（commit `ea90312`）
>
> 用途：记录审查发现的偏差，供后续逐项修复与验收。每一项含位置、问题、设计依据、建议改法与验收点。

## 0. 当前基线（修复前已通过）

| 检查 | 结果 |
| --- | --- |
| `pnpm -r typecheck` | ✅ 通过 |
| `pnpm -r lint` | ✅ 通过 |
| `pnpm -r --if-present test`（单元/集成） | ✅ 通过 |
| `pnpm test:real:pi`（真实供应商端到端） | ✅ 通过 |
| §19.4 禁止项 grep（`ClaudeCodeAdapter`/`CodexAdapter`/`AgentRegistry`/`AgentType`/`agentType`/`agentRoles`/`roleConfigs`） | ✅ 生产源码无残留 |
| 外部 CLI 调用（spawn `pi`/`claude`/`codex`） | ✅ 无 |

> 修复过程中每一项都应保持上述基线绿；修复后需重跑 `pnpm verify` 与 `pnpm test:real:pi`。

## 1. 待修复项总览

| ID | 严重度 | 设计章节 | 位置 | 主题 |
| --- | --- | --- | --- | --- |
| F-01 | 中 | §14 | `apps/desktop/electron/pi-runtime.ts:150` | 子进程 PATH 未受控 |
| F-02 | 中 | §14 | `packages/agents/src/run-plan.ts:58-121` | 环境白名单缺证书/代理 |
| F-03 | 中 | §7.4 | `packages/agents/src/pi-runner.ts`（interaction 分支） | interaction 后未主动终止 Pi 进程 |
| F-04 | 中 | §15 | `apps/desktop/electron/main.ts` | 应用退出未终止 Pi 进程组 |
| F-05 | 低 | §17/§19.4 | `apps/desktop/package.json:111-113` | 残留未使用的 ai-sdk 依赖 |
| F-06 | 低 | §16.5 | `packages/agents/package.json:19` | `verify:real` 脚本指向不存在的测试文件 |
| F-07 | 低 | §7.1/§9.1 | `packages/agents/src/profiles.ts:20-30`、`provider-router.ts:19-32` | `RoleProfile`/`ProviderRoute` 接口字段与设计漂移 |
| F-08 | 低 | §7.5 | `packages/agents/src/run-plan.ts:68` | `--print` 未纳入设计契约 |
| F-09 | 低 | §10 | `packages/agents/src/json-events.ts:103-110` | `AttemptJournal.lastCheckpointId` 恒为 undefined |
| F-10 | 低 | §11 | `packages/agents/src/json-events.ts:204-207` | 未知事件/`auto_retry_*` 未记录 debug 诊断 |
| F-11 | 低 | §8.2 | `apps/desktop/electron/pi-ai.ts:384-396` | 测试连接错误未走统一脱敏 |
| F-12 | 低 | §13.1 | `apps/desktop/src/i18n/{zh,en}.ts`、`Settings.tsx:107` | i18n 残留死键与缺失翻译键 |
| F-13 | 低 | §12.2 | `packages/persistence/src/pi-only-migration-v9.ts:7-9` | 注释声称 v9 未注册，与现状不符 |
| F-14 | 低 | §15 | `apps/desktop/electron/ipc.ts:290,305` | 状态迁移门禁口径与编排器不一致 |
| F-15 | 低 | §13.3 | `packages/core/src/provider.ts:67-70` | `ProviderSummary` 比设计多 `authType`/`revision` |

## 2. 详细修复项

### F-01 子进程 PATH 未受控（中）

- [x] 修复
- **位置**：`apps/desktop/electron/pi-runtime.ts:150`（`projectToolPath: process.env.PATH ?? '/usr/bin:/bin'`）
- **问题**：直接把应用启动时的完整 `process.env.PATH` 注入 Pi 子进程。设计 §14 要求"PATH 只保留角色工具执行所需的系统路径，不参与 Pi 入口解析"。当前可能把用户自定义目录带入 Pi，偏离隔离白名单意图（入口虽用绝对路径不受影响，但角色 bash 工具会沿该 PATH 解析可执行）。
- **建议改法**：构造受控 PATH：保留系统标准目录（如 `/usr/bin:/bin`、Windows 的 System32），并按需合并任务项目工具链所需路径；不直接透传 `process.env.PATH`。同步更新 `packages/agents/src/__tests__/real-pi.test.ts:292` 等测试桩。
- **验收**：新增/更新断言证明子进程 env.PATH 不等于 `process.env.PATH`，且不含用户级目录；`pnpm test:real:pi` 仍通过。

### F-02 环境白名单缺证书/代理（中）

- [x] 修复
- **位置**：`packages/agents/src/run-plan.ts:58-121`（`LOCALE_PASSTHROUGH`/`WINDOWS_PASSTHROUGH`）
- **问题**：设计 §14 明确允许"平台限定的临时目录、locale、证书和代理白名单"。当前只透传 locale 与 Windows 系统变量，未透传证书（`SSL_CERT_FILE`/`SSL_CERT_DIR`/`NODE_EXTRA_CA_CERTS`）与代理（`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`）变量。企业代理或自签证书环境下可能导致提供商连接失败。
- **建议改法**：在白名单中显式加入上述证书/代理变量（仅这些具名变量，不做通配），并确保不含密钥/`PI_*`/`NODE_OPTIONS` 等。
- **验收**：单元测试覆盖证书/代理变量被透传、其它继承变量被剥离；`pnpm test:real:pi` 通过。

### F-03 interaction 后未主动终止 Pi 进程（中）

- [x] 修复
- **位置**：`packages/agents/src/pi-runner.ts`（`hadInteraction` 终态分支，约 254-268 行）
- **问题**：设计 §7.4 要求"`ai_devflow_interaction` 工具被调用后，supervisor 在工具结果落入 JSONL 后终止本次 Pi 进程并把任务交还 `awaiting_input` 流程"。当前 runner 不主动 `spawned.cancel()`/kill，而是等待子进程自行结束。真实测试因 Pi 自行结束而通过，但这是依赖 Pi 行为的非契约实现，Pi 版本变化后可能 hang 到超时。
- **建议改法**：在 translator 报告 `interactionOccurred` 且其 `tool_execution_end` 已落入后，调用 `spawned.cancel()` 主动终止进程组，再返回 interaction 终态。
- **验收**：fake-pi 新增"interaction 后继续运行"场景，断言 runner 在 interaction 工具结束后主动终止子进程；`pnpm test:real:pi` 通过。

### F-04 应用退出未终止 Pi 进程组（中）

- [x] 修复
- **位置**：`apps/desktop/electron/main.ts`（无 `before-quit`/`will-quit` 处理）
- **问题**：设计 §15 要求"应用退出或取消任务时，先终止 Pi 进程组，再封存 journal；孤儿进程清理由启动恢复流程处理"。当前仅靠取消路径与下次启动 `cleanupOrphans` 兜底，强制退出/崩溃场景下活跃 Pi 进程不会即时终止。
- **建议改法**：在 `main.ts` 注册 `app.on('before-quit', ...)`，对 orchestrator 活跃任务做受控停止，或调用 `piRuntime` 暴露的进程组终止接口；封存 journal 后再退出。
- **验收**：E2E 或集成测试模拟退出时活跃 Pi 进程被终止；`pnpm test:real:pi` 通过。

### F-05 残留未使用的 ai-sdk 依赖（低）

- [x] 修复
- **位置**：`apps/desktop/package.json:111-113`（`@ai-sdk/anthropic`、`@ai-sdk/openai`、`ai`）
- **问题**：源码已无任何 `ai`/`@ai-sdk` 导入（grep 确认），依赖残留可能误导后续维护者，且与"不再保留兼容层"精神不符。
- **建议改法**：删除这三条 `dependencies`，重装锁文件并确认 typecheck/test 通过。
- **验收**：`pnpm install` 后 `pnpm -r typecheck && pnpm -r test` 通过；打包产物不含 ai-sdk。

### F-06 `verify:real` 脚本指向不存在的测试文件（低）

- [x] 修复
- **位置**：`packages/agents/package.json:19`（`AI_DEVFLOW_REAL=1 vitest run src/__tests__/real-agents.test.ts`）
- **问题**：实际真实测试文件为 `real-pi.test.ts`，`real-agents.test.ts` 不存在。该脚本为陈旧遗留，执行会失败。
- **建议改法**：删除该脚本，或改为指向 `real-pi.test.ts` 并与根 `test:real:pi` 对齐说明。
- **验收**：`pnpm --filter @ai-devflow/agents verify:real`（若保留）可正常运行或被显式移除。

### F-07 `RoleProfile`/`ProviderRoute` 接口字段与设计漂移（低）

- [x] 修复
- **位置**：`packages/agents/src/profiles.ts:20-30`、`packages/agents/src/provider-router.ts:19-32`
- **问题**：设计 §7.1 的 `RoleProfile` 含 `extensions`/`providerModels`，§9.1 的 `ProviderRoute` 含 `priority`。实现中 `extensions` 由 `BUILTIN_EXTENSIONS` 常量替代、`providerModels` 由 `MODEL_TABLE` 替代、`priority` 未保留（生成顺序已按 priority 排序）。功能等价但类型契约漂移。
- **建议改法**：将 `extensions`/`providerModels`/`priority` 补入对应接口，或在接口注释/设计文档中显式注明等价替代的取舍。
- **验收**：typecheck 通过；接口与设计一致或注释说明偏差。

### F-08 `--print` 未纳入设计契约（低）

- [x] 修复
- **位置**：`packages/agents/src/run-plan.ts:68`
- **问题**：Pi 参数最前面插入了 `--print`，设计 §7.5 的参数清单未列出该开关。
- **建议改法**：确认 Pi 0.80.10 对 `--print` 的行为，将其写入设计 §7.5 契约或在代码注释中显式说明偏差原因（避免 TUI）。
- **验收**：设计文档或代码注释更新；`pnpm test:real:pi` 通过。

### F-09 `AttemptJournal.lastCheckpointId` 恒为 undefined（低）

- [x] 修复
- **位置**：`packages/agents/src/json-events.ts:103-110`
- **问题**：`AttemptJournal` 接口声明 `lastCheckpointId?`，但 `createPiEventTranslator` 初始化的 journal 从未设置该字段，运行实例恒为 undefined。
- **建议改法**：在注入恢复 checkpoint 时把其 ID 写入 journal，或在接口/注释中说明该字段当前不使用。
- **验收**：单元测试覆盖 checkpoint 恢复时 `lastCheckpointId` 被填充，或注释说明。

### F-10 未知事件/`auto_retry_*` 未记录 debug 诊断（低）

- [x] 修复
- **位置**：`packages/agents/src/json-events.ts:204-207`（`default` 分支）
- **问题**：设计 §11 要求未知事件按向前兼容原则"记录为 debug 诊断"，`auto_retry_*` 出现时"记录配置违例"。当前仅静默丢弃，未产生任何诊断。
- **建议改法**：在 default 分支收集未知事件类型与 `auto_retry_*` 到一个有上限的诊断缓冲区，经脱敏后可被诊断包读取。
- **验收**：单元测试断言未知事件与 `auto_retry_*` 被记录为诊断且不崩溃。

### F-11 测试连接错误未走统一脱敏（低）

- [x] 修复
- **位置**：`apps/desktop/electron/pi-ai.ts:384-396`
- **问题**：`testConnectionWithRouter` 把 `executeText` 抛出的原始错误消息直接写入 `ProviderTestResult.error` 返回 Renderer，未调用 `redactText`。设计 §8.2 要求"保存、测试、运行和错误记录都使用统一脱敏函数"。
- **建议改法**：对错误 `message` 调用 `redactText` 后再写入 `ProviderTestResult.error`。
- **验收**：单元测试注入含密钥形态的错误消息，断言返回结果不含密钥。

### F-12 i18n 残留死键与缺失翻译键（低）

- [x] 修复
- **位置**：`apps/desktop/src/i18n/zh.ts`、`apps/desktop/src/i18n/en.ts`（整段旧 `settings.ai.*` 键与"全局/项目 Agent 能力配置"注释）；`apps/desktop/src/pages/Settings.tsx:107`（引用未定义的 `settings.agents.col.version`）
- **问题**：UI 已不引用 `settings.ai.*` 旧键，属待清理残留；`Settings.tsx:107` 的翻译键在 zh/en 均未定义，会显示原始键名。
- **建议改法**：删除 `settings.ai.*` 死键与空注释段；为 `settings.agents.col.version` 补充中英文翻译或改用已有版本号键。
- **验收**：i18n 类型检查通过；Settings 页面版本号正常显示。

### F-13 v9 迁移注释与现状不符（低）

- [x] 修复
- **位置**：`packages/persistence/src/pi-only-migration-v9.ts:7-9`
- **问题**：注释声称 v9"保持未注册（不在 MIGRATIONS 中、openDatabase 不调用），在 Task 9 原子启用"，但 `migrations.ts:261` 已注册、`db.ts` 已调用，v9 实际生效。注释易误导维护者。
- **建议改法**：更新注释为 v9 已注册并随 openDatabase 应用，保留备份/版本自检说明。
- **验收**：注释与代码行为一致。

### F-14 状态迁移门禁口径与编排器不一致（低）

- [x] 修复
- **位置**：`apps/desktop/electron/ipc.ts:290,305`（`hasAgentAssigned: services.providerStore ? services.providerStore.list().length > 0 : true`）
- **问题**：此处用"任意提供商存在"判定，而编排器用 `hasUsableProvider`（启用+有凭证+runtime ready）。这两处非 AI 操作（状态迁移/归档），不违反"禁止开始 AI 操作"门禁，但口径不一致。
- **建议改法**：统一使用 `hasUsableProvider`，或在注释中说明此处仅判定"是否配置过提供商"的语义差异。
- **验收**：IPC 测试通过；门禁口径一致或有注释说明。

### F-15 `ProviderSummary` 比设计多 `authType`/`revision`（低）

- [x] 修复
- **位置**：`packages/core/src/provider.ts:67-70`
- **问题**：设计 §13.3 的 `ProviderSummary` 不含 `authType`/`revision`，实现多了这两个非敏感字段，属接口轻微漂移。
- **建议改法**：将 `authType`/`revision` 显式纳入设计 §13.3，或从渲染契约收敛掉。
- **验收**：接口与设计一致或文档更新。

## 3. 修复后验收清单

- [x] F-01 ~ F-04 四项中等缺口全部修复
- [x] F-05 ~ F-15 低级项按需清理
- [x] `pnpm -r typecheck` 通过
- [x] `pnpm -r lint` 通过
- [x] `pnpm -r --if-present test` 通过
- [x] `pnpm test:real:pi` 退出码 0
- [x] §19.4 禁止项 grep 仍无生产残留
- [x] 子进程 env/PATH 白名单、interaction 终止、退出终止进程组有对应测试覆盖

> 修复完成于 2026-07-22。验收证据：`pnpm -r typecheck`/`lint`/`test` 全绿（agents 134、persistence 38、scheduler 47、notifications 10、desktop 70）；`pnpm test:real:pi` 退出码 0（4 项真实场景通过，100161 文件密钥扫描 PASS）；§19.4 在 `packages/*/src` + `apps/desktop/{src,electron}` 生产源码中无 `ClaudeCodeAdapter`/`CodexAdapter`/`AgentRegistry`/`AgentType`/`agentType` 残留，`agentRoles`/`roleConfigs` 仅存在于删除它们的 v9 迁移 SQL/注释中。新增/更新测试：`env-safety.test.ts`（受控 PATH）、`run-plan.test.ts`（证书/代理白名单）、`json-events.test.ts`（lastCheckpointId + 未知/auto_retry 诊断）、`pi-runner.test.ts`（interaction 后主动终止进程组，断言信号退出）、`orchestrator.test.ts`（shutdown 退出终止）、`ai.test.ts`（测试连接错误脱敏）。

## 4. 参考证据文件

- 打包/定位：`apps/desktop/scripts/stage-pi-runtime.mjs`、`apps/desktop/scripts/verify-packaged-pi.mjs`、`apps/desktop/electron/pi-runtime.ts`、`packages/agents/src/runtime-locator.ts`
- 角色配置：`packages/agents/src/profiles.ts`、`packages/agents/src/run-plan.ts`、`packages/agents/assets/profiles/`
- 路由降级：`packages/agents/src/provider-router.ts`、`packages/core/src/provider.ts`
- 子进程/事件：`packages/agents/src/process-supervisor.ts`、`packages/agents/src/json-events.ts`、`packages/agents/src/pi-runner.ts`
- 持久化/UI：`packages/persistence/src/migrations.ts`、`packages/persistence/src/pi-only-migration-v9.ts`、`apps/desktop/electron/provider-store.ts`、`apps/desktop/src/pages/Settings.tsx`
- 真实测试：`packages/agents/src/__tests__/real-pi.test.ts`、`scripts/run-real-pi-test.mjs`
