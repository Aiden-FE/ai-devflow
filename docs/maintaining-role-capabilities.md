# 维护者指南：为角色 Agent 安装扩展、技能、工具

本文面向 ai-devflow 维护者。最终用户**不**可见这些配置--四角色 profile 由仓库维护、随应用发布。内置 Pi 运行时为 `@earendil-works/pi-coding-agent@0.80.10`。

## 角色能力来自哪里

- `packages/agents/src/profiles.ts` 的 `ROLE_PROFILES`：每角色的 `tools`/`excludedTools`/`skills`/`extensions`/`timeoutMs`。
- `packages/agents/assets/profiles/<role>/`：`SYSTEM.md`、`settings.json`、`skills/<name>/SKILL.md`。
- `packages/agents/assets/profiles/shared/extensions/<name>.ts`：扩展源文件；`BUILTIN_EXTENSIONS` 是其注册池。
- 运行时 `ProfileMaterializer` 把以上复制到内容寻址快照；`buildPiRunPlan` 用 `--skill`/`--extension`/`--tools` 显式注入（`--no-skills`/`--no-extensions` 关闭自动发现）。

## 新增一个 skill（按角色）

1. 创建 `packages/agents/assets/profiles/<role>/skills/<skill-name>/SKILL.md`。
2. 在 `ROLE_PROFILES[<role>].skills` 末尾加 `'<skill-name>'`。
3. `ROLE_PROFILES[<role>].version += 1`（触发新内容寻址快照，避免干扰在途执行）。
4. `pnpm --filter @ai-devflow/agents test` 与 `pnpm test:real:pi` 验证。

## 新增一个扩展（可按角色）

1. 创建 `packages/agents/assets/profiles/shared/extensions/<name>.ts`。
2. 在 `BUILTIN_EXTENSIONS`（注册池）加 `'<name>'`。
3. 在需要该扩展的 `ROLE_PROFILES[<role>].extensions` 加 `'<name>'`（默认四角色含 `event-bridge`/`execution-policy`/`structured-result`/`checkpoint-context` 四个基建扩展，勿删）。
4. `ROLE_PROFILES[<role>].version += 1`。
5. `validateRoleProfiles()`（模块加载时自动调用）会拒绝引用池外扩展名的配置。

## 新增/调整工具

- `ROLE_PROFILES[<role>].tools` 增减 Pi 内置工具名（`read`/`bash`/`edit`/`write`/`grep`/`find`/`ls`）。
- `excludedTools` 显式排除（如 reviewer 排除 `edit`/`write`）。
- `INTERNAL_TOOLS`（`ai_devflow_interaction`/`ai_devflow_report_result`）四角色强制启用，不可配。
- 自定义工具能力应通过扩展实现，而非 tools 白名单。

## MCP servers

**当前不支持。** Pi 0.80.10 的 dist 中无任何 MCP 引用（`mcpServers`/`--mcp` 均不存在）。安装 MCP servers 需先升级 Pi 版本，并按 `docs/architecture.md` §13.1 重新 staging、更新 manifest、校验和与四角色兼容性测试。

## settings.json

各角色 `settings.json` 的 `packages`/`extensions`/`skills` 保持 `[]`--应用通过 CLI 参数显式注入，不走 Pi 自动发现。仅在需要调整 `retry`/`defaultProjectTrust` 等运行时行为时编辑 settings.json。

## 打包与生效

- 开发态：`assetsRootFor()` 直读 `packages/agents/assets/profiles`，改完即可 `pnpm dev` 验证。
- 打包态：`pnpm stage:pi` 把 profiles 复制到 `build/pi-runtime/profiles` 并计算 `profilesDigest` 写入 manifest；electron-builder 经 `extraResources` 复制到 `resources/pi-runtime`（不入 asar）。

## 验证清单

- `pnpm inspect:roles`（见 `scripts/inspect-roles.mjs`）查看各角色生效的 tools/skills/extensions。
- `pnpm --filter @ai-devflow/agents test`：单测。
- `pnpm test:real:pi`：真实 Pi 四角色验证（需 `.env` 中的 `DEV_API_*`）。

## 安全

扩展是 Pi 子进程内执行的 TypeScript 文件（隔离 env）。新增自定义扩展须保持同等级安全姿态：不外泄凭证、尊重 worktree 写入边界（`execution-policy`）、不绕过 `ai_devflow_interaction`/`ai_devflow_report_result` 协议。
