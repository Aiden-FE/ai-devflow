# Provider 默认模型配置与模型列表查询设计

## 背景

当前 `ProviderRouter` 使用硬编码的 `MODEL_TABLE`（`packages/agents/src/provider-router.ts:71`）为每个服务商 kind 选择模型。这导致：

- 标准服务商（DeepSeek、OpenAI 等）必须使用代码写死的模型 ID。
- 兼容网关（`openai_compatible` / `anthropic_compatible`）被强制使用 OpenAI/Anthropic 的模型命名。
- 用户无法配置模型，第三方网关（火山引擎等）因模型名不匹配而测试失败。

本设计允许用户为每个服务商配置默认模型，并按 workload 可选覆盖；对兼容网关主动查询可用模型列表供选择或手动输入。

## 目标

1. 每个服务商可配置一个默认模型。
2. 可按 workload（planner / coder / reviewer / tester / chat / proposal）覆盖默认模型。
3. 对 `openai_compatible` 与 `anthropic_compatible` 网关，提供“刷新模型列表”功能，调用其 `/v1/models` 接口。
4. 用户既可以从下拉列表选择，也可以手动输入模型 ID。
5. 未配置模型的服务商视为 `configuration_error`，不进入路由。
6. 完成后提交并合并回主分支，触发 patch release。

## 非目标

- 不为标准服务商自动查询模型列表（按产品决策，仅兼容网关按需拉取）。
- 不保留 `MODEL_TABLE` 作为运行时回退（用户必须显式配置）。
- 不引入新数据表，模型配置保存在现有 provider 配置中。

## 数据模型

扩展 `ProviderConfig` / `ProviderInput`（`packages/core/src/provider.ts`）：

```ts
export type ModelRoleKey = 'planner' | 'coder' | 'reviewer' | 'tester' | 'chat' | 'proposal';

export interface ProviderConfig {
  // ... existing fields ...
  /** 默认模型；未设置且对应 workload 无覆盖时，该服务商对此 workload 不可用。 */
  defaultModel?: string;
  /** 按 workload 覆盖默认模型。 */
  workloadModels?: Partial<Record<ModelRoleKey, string>>;
}
```

- `normalizeProviderInput` 对模型 ID 做 `trim()`，空字符串视为未设置。
- 不校验模型 ID 是否真实存在（由运行时错误分类处理）。

## 路由变更

`ProviderRouter.routesFor()`（`packages/agents/src/provider-router.ts:196`）逻辑变更：

1. 取出 provider 的 `workloadModels` 与 `defaultModel`。
2. 根据当前 `workload` 映射到 `ModelRoleKey`：
   - `planner` / `coder` / `reviewer` / `tester` → 同名 role
   - `task_chat` / `requirement_chat` → `chat`
   - `task_proposal` / `requirement_proposal` → `proposal`
3. 解析模型：`workloadModels[role] ?? defaultModel`。
4. 若未解析到模型，跳过该 provider 的当前 workload。
5. 不再使用 `MODEL_TABLE` 作为运行时模型来源。`MODEL_TABLE` 可保留为“UI 建议值”或后续移除。

`ProviderRoute.model` 与 `ProviderRoute.models` 均来自用户配置。

## 兼容网关模型列表查询

新增 IPC 方法：

```ts
providers: {
  // ... existing methods ...
  listModels(providerId: string): Promise<{ id: string; name?: string }[]>;
}
```

实现（`apps/desktop/electron/api.ts` / `pi-ai.ts`）：

1. 仅当 provider.kind 为 `openai_compatible` 或 `anthropic_compatible` 时允许查询；否则返回空数组。
2. 从 `ProviderStore` 读取 provider 的 `baseURL` 与 secret。
3. 调用 `GET {baseURL}/models`：
   - `openai_compatible`：`Authorization: Bearer {secret}`
   - `anthropic_compatible`：`x-api-key: {secret}` + `anthropic-version: 2023-06-01`
4. 解析响应 `data[].id`，按字母序返回。
5. 超时 15 秒；任何错误返回空数组并在主进程日志记录（不暴露密钥）。

## UI 变更

`Settings.tsx` 的 provider 表单新增：

1. **默认模型**：文本输入框，必填（或所有 workload 覆盖必填）。
2. **按 workload 覆盖**：可折叠区域，内含 planner / coder / reviewer / tester / chat / proposal 六个输入框。
3. **刷新模型列表**：仅对兼容网关显示。点击调用 `providers.listModels()`，结果以下拉框形式展示；用户选择后填入默认模型输入框。
4. **手动输入**：下拉框支持可编辑（combo-box），允许用户直接输入不在列表中的模型 ID。
5. **未配置模型提示**：列表中无模型的服务商显示 `configuration_error` 状态与“请设置默认模型”横幅。

## 健康状态与迁移

- 已保存但无模型配置的老 provider：
  - `ProviderStore.list()` 返回的 `health` 改为 `configuration_error`（当前固定为 `untested`）。
  - `routesFor()` 直接跳过，不在冷却/重试逻辑中消耗尝试次数。
- 用户编辑保存 provider 并设置模型后，`revision` 递增，`ProviderStore.save()` 自动 `clearHealth(providerId)`，状态恢复为 `untested` 并可重新测试。

## 测试策略

1. **单元测试**
   - `normalizeProviderInput`：处理 `defaultModel` / `workloadModels` 的 trim 与空字符串。
   - `ProviderRouter.routesFor()`：
     - 使用用户配置模型生成 route。
     - 未配置模型时跳过 provider。
     - workload 覆盖优先级高于 defaultModel。
   - 模型列表 fetcher：
     - 成功解析 OpenAI 格式响应。
     - 成功解析 Anthropic 格式响应。
     - 非 2xx / 超时返回空数组。
     - 标准 provider 调用直接返回空数组。
2. **ProviderStore 测试**
   - 无模型配置时 `list()` 返回 `configuration_error`。
   - 保存带模型的 provider 后健康恢复 `untested`。
3. **E2E 烟雾测试**
   - 在 `run-e2e.mjs` 的 fake provider 增加 `/v1/models` 端点。
   - 验证“刷新模型列表”能正确填充下拉框并保存。

## 发布流程

1. 实现完成后本地运行完整测试套件：`pnpm test` 与各包 `verify`。
2. 提交 PR 到 `main`，标题前缀 `feat:` 或 `fix:`。
3. 合并后由仓库 CI 的 release workflow 自动基于 Conventional Commits 生成 patch 版本并部署。

## 相关文件

- `packages/core/src/provider.ts` — 契约与归一化
- `packages/agents/src/provider-router.ts` — 路由模型解析
- `packages/agents/src/profiles.ts` — `buildCompatibleModelsJson`
- `apps/desktop/electron/provider-store.ts` — 配置持久化与健康状态
- `apps/desktop/electron/api.ts` — IPC 路由
- `apps/desktop/electron/pi-ai.ts` — `testConnection`、模型列表查询
- `apps/desktop/src/pages/Settings.tsx` — provider 表单 UI
