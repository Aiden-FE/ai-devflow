# 更新日志（CHANGELOG）

本文件记录各版本面向用户的变更。由发版工作流自动维护：每次发版时，
`scripts/gen-changelog.mjs` 会生成「上一版本 tag → 当前版本」的小节并 prepend 到此处，
GitHub Release 正文与本文件对应小节保持一致。

分组：新功能 / 问题修复 / 其他变更；自动过滤 merge、版本号提交等噪音，并附 compare 链接。

## v0.2.2

变更范围：[v0.2.1...v0.2.2](https://github.com/Aiden-FE/ai-devflow/compare/v0.2.1...v0.2.2)

### 新功能
- **scripts**：inspect:roles maintainer capability self-check（d6cb9a7）
- **agents**：per-role extensions on RoleProfile, validated at load（3e41b2d）
- **workspace**：open project folder via projects.openFolder IPC（81d34a8）
- **workspace**：collapse requirement subtasks with >10 pagination（a4c76f5）
- **provider**：drop allowInsecureLocal, allow any http/https baseURL（c4e439e）

### 问题修复
- **agents**：surface real root cause of Pi/provider failures（fe0f583）

### 其他变更
- add executed plan for workbench and maintainer improvements（ebaf527）
- maintainer guide for role agent skills/extensions/tools（fc65da9）
- design for workbench improvements and maintainer capability management（7e92641）

## v0.2.1

变更范围：[v0.2.0...v0.2.1](https://github.com/Aiden-FE/ai-devflow/compare/v0.2.0...v0.2.1)

### 新功能
- configurable provider models with compatible gateway model list (#6)（c458628）

## v0.2.0

变更范围：[v0.1.2...v0.2.0](https://github.com/Aiden-FE/ai-devflow/compare/v0.1.2...v0.2.0)

### 新功能
- mac ad-hoc signing + user-friendly README（b749084）
- **desktop**：provider-only AI settings UI; remove agent config sections（9d00e07）
- **desktop**：add sanitized providers IPC (list/save/remove/reorder/test/health)（d31c5b4）
- **agents**：bridge pi json events and attempt journals（329d054）
- **agents**：add isolated built-in pi role profiles（45b8952）
- **agents**：add provider routing and circuit breaking（44ab532）
- **desktop**：store ordered encrypted providers（d7a26b3）
- **persistence**：migrate to pi-only execution records（b46fd12）

### 问题修复
- accept Windows absolute paths in validateLocalPath; keep E2E non-blocking for release（0c7799a）
- remove non-deterministic openrouter/openai models from gate; add post-packaging symlink normalization for Windows（bad553b）
- remove non-deterministic openrouter/gpt-5.6-sol from catalog gate; set fail-fast false in smoke matrix（1075202）
- start xvfb before gnome-keyring for E2E on Linux CI（a8d32d3）
- add libsecret-1-0, improve safeStorage diagnostics on Linux CI（79af6c4）
- only normalize absolute symlinks on Windows（7a69452）
- normalize absolute symlinks in staged Pi runtime for Windows（1f68f11）
- set explicit executableName for deterministic Linux executable（a733176）
- harden execution policy, env safety and Pi interaction protocol（b918a92）
- harden execution policy and Pi interaction protocol（ea90312）
- enforce provider-wide auth readiness（67acab9）
- close execution policy wrapper escapes（5d05707）
- fail closed on pi terminal protocol（58b57a9）
- complete legacy provider migration（d72e492）
- prioritize provider configuration errors（9728786）
- restore bounded attempt context and cleanup（b73d884）
- align scheduler and provider failover lifecycle（1631800）
- fail closed on pi process framing（1d8542b）
- require clean pi conversation completion（2db8eda）
- enforce role execution policy evidence（eee9d1c）
- isolate provider profile snapshots（50e1a84）
- make provider migration atomic at startup（d2eea19）
- verify packaged pi links at startup（a1ca820）
- close packaged pi isolation gaps（885da63）
- **agents**：correct PI_PACKAGE_DIR root and non-interactive flag; pass real pi e2e（338b371）

### 其他变更
- drop macos-13 x64 smoke from release matrix（80f2c7b）
- add timeouts to E2E steps in release workflow（bd2922d）
- make E2E steps non-blocking for release (Pi verification already gates)（1153851）
- add diagnostic model list to pi-catalog-gate on failure（d191230）
- print expected/actual symlink target on verify mismatch（46c155f）
- add directory listing diagnostics to verify-packaged-pi on missing executable（202e9af）
- harden real Pi secret and planner gates（43c7876）
- require real reviewer policy denial（ef3174b）
- align packaged profile isolation checks（c3cc5e3）
- enforce the real pi provider gate（eb39d33）
- cover packaged pi link validation（bb9f50c）
- gate releases on bundled pi isolation（5edbc81）
- **desktop**：route all AI workloads through bundled Pi; remove legacy ai-sdk provider surface（ff6a9e7）
- remove agent types, capability config, agent IPC and copy (pi-only)（4e09c53）
- remove claude code/codex adapters, agent registry, detection and agent IPC（ad34c14）
- **desktop**：remove agent selection UI (badge, selectors, exec column)（3e81276）
- add real bundled pi provider verification（a5a7905）
- **scheduler**：execute all roles through pi runner（b9a5f32）
- **agents**：replace adapters with bundled pi runner（563927a）
- bundle and verify pi 0.80.10（fe303c2）
- **core**：replace agent selection with provider contracts（c7f2d59）
- add embedded pi implementation plan（d7ddc41）
- require real pi provider validation（d1001d2）
- design bundled pi-only agent runtime（06cdf61）

## v0.1.2

变更范围：[v0.1.1...v0.1.2](https://github.com/Aiden-FE/ai-devflow/compare/v0.1.1...v0.1.2)

### 问题修复
- 修复桌面端自动更新状态并支持未签名 macOS 手动升级（98a748e）

### 其他变更
- merge remote v0.1.1 release commit（610dd3b）

## v0.1.1

变更范围：[v0.1.0...v0.1.1](https://github.com/Aiden-FE/ai-devflow/compare/v0.1.0...v0.1.1)

### 新功能
- 品牌资产、桌面端 UI 与调度器优化（b77d7e8）

### 问题修复
- **release**：修复构件校验漏检（nullglob 把无匹配模式展开为空导致误判通过）+ Linux AppImage 命名为 x86_64 (#5)（aaabdda）

## v0.1.0

变更范围：[v0.0.3...v0.1.0](https://github.com/Aiden-FE/ai-devflow/compare/v0.0.3...v0.1.0)

### 新功能
- v0.1.0 — 测试中泳道与自动审查、依赖 DAG、配置继承、多平台发版等 12 项改造 (#2)（a3886c7）

### 问题修复
- **release**：build job 统一使用 bash shell（修复 Windows 上 PowerShell 解析 bash 语法失败） (#4)（ffad85a）
- **desktop**：createAtPath 初始提交在无全局 git 身份的环境（如 CI）确保仓库级回退身份 (#3)（0d542e1）

## v0.0.3

变更范围：[v0.0.2...v0.0.3](https://github.com/Aiden-FE/ai-devflow/compare/v0.0.2...v0.0.3)

### 问题修复

- **agents**：修复打包后桥接器检测不到 CLI（GUI 应用 PATH 缺失）（8aaf324）
- **release**：空签名凭据时 unset `CSC_*`/`APPLE_*`，避免 electron-builder 把空路径当证书文件（f62c8d6）
- **release**：修复 electron-builder 打包失败（mac 图标 + 跳过原生依赖重建）（3ebf2ac）

## v0.0.2

首个可用版本：泳道看板 + 本地 Agent 桥接器（Claude Code / Codex / Pi）在隔离 Git worktree 中真实执行任务，
含主题、任务对话与授权、自动更新与 macOS 发版链路。
