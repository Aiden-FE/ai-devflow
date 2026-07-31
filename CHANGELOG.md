# 更新日志（CHANGELOG）

本文件记录各版本面向用户的变更。由发版工作流自动维护：每次发版时，
`scripts/gen-changelog.mjs` 会生成「上一版本 tag → 当前版本」的小节并 prepend 到此处，
GitHub Release 正文与本文件对应小节保持一致。

分组：新功能 / 问题修复 / 其他变更；自动过滤 merge、版本号提交等噪音，并附 compare 链接。

## v0.3.0

变更范围：[v0.2.2...v0.3.0](https://github.com/Aiden-FE/ai-devflow/compare/v0.2.2...v0.3.0)

### 新功能
- **knowledge**：initialization recovery, host verification bridge, and unified diff viewer（83dd02e）
- **desktop**：split interruptible task actions and allow abandoning awaiting_input（74f5bc1）
- **desktop**：add guarded knowledge project switcher（de7b01e）
- **desktop**：share project selection with knowledge（d863e0a）
- **desktop**：redesign provider usage dashboard（1cafd08）
- **desktop**：add usage analytics charts（8c52b78）
- **desktop**：add modular ECharts lifecycle（3a25de3）
- improve task workflows and provider analytics（50bf828）
- progressive knowledge base remediation（8b6f3f3）
- **desktop**：expose knowledge health and evidence（746fcd6）
- verify changelog before iteration archive（9ec180e）
- **scheduler**：gate review on knowledge deposition（2dc864e）
- integrate knowledge retrieval into workflow（6b537f5）
- add project knowledge lifecycle coordinator（f10c870）
- **agents**：add project lead knowledge expert（d3fbf61）
- **agents**：preserve typed knowledge results（0fe43f9）
- **persistence**：store knowledge workflow audit metadata（8007d67）
- **knowledge**：add progressive retrieval planning（a7911ae）
- **knowledge**：add markdown layout and structural audit（42e5de5）
- **core**：define knowledge workflow contracts（1a9849c）
- **desktop,agents**：pi-ai 路由新专家 + ux-bridge 子咨询 + Settings/UI 专家键与 typeLabel（087b9c9）
- **desktop**：AgentModelOverride 键迁移到 6 专家键（4d7f592）
- **persistence**：v11 迁移加 tasks.type_label + mapTask 读写（5bec800）
- **agents**：EXPERT_PROFILES 注册表 + validateExpertProfiles（f418af3）
- **agents**：新增 product/ux/dev_lead 专家资产与三个技能（653a96d）
- **core**：新增专家派发映射 laneToExpert + 任务类型标签（6f3ec37）
- **core**：AgentKey 重构为 6 专家键 + workload 路由（c5272eb）
- **scheduler,desktop**：迭代专用分支 + 对话体验四项改进（10e3c27）
- **agents**：requirement_refiner 与 task_proposer 接入 ai_devflow_ask 工具（6b9ccdb）
- **desktop**：问答卡片前端 UI（多 tab/单选多选/自由描述）（fed4b83）
- **desktop**：问答工具 main 侧桥接 + ai:answer 反向通道（d376d34）
- **agents**：PiProcessSupervisor 新增子进程 IPC 通道（问答暂停-恢复）（41ef802）
- **agents**：新增 ai_devflow_ask 问答工具扩展（4a640e7）
- **desktop,core**：createBatch 支持跨批依赖（dependsOn 引用已有 taskId）（d9f3fe4）
- **agents**：task_proposer 传入已有子任务上下文并支持跨批依赖（bf0959c）
- **desktop**：子任务列表删除按钮（依赖守卫提示）（972cede）
- **desktop**：子任务删除后端（硬删除+依赖守卫）（7c2dad0）
- **desktop**：AI 弹窗放大并统一使用 ChatPanel（effc196）
- **desktop**：抽取统一 ChatPanel 组件（12a1839）
- **desktop**：AI 对话流式输出（立即转发 text_delta + 思维链抑制）（7a1271a）
- **desktop,agents**：task_proposal 走 task_proposer 步骤 Agent 基线（AI 生成流程增强实施计划前置）（9fd84fc）
- **desktop**：设置页新增 Agent 模型分配区与 workload 标签改善（7defa05）
- **desktop**：agentOverrides IPC + preload + api 契约（8d59345）
- **desktop**：生产接线 agentOverrideFor 路由覆盖（0c78f5e）
- **agents**：ProviderRouter 支持按 agent 覆盖路由与回退（156481f）
- **desktop**：ProviderStore 新增 agentOverrides 加密存储（7c1f793）
- **core**：新增 AgentKey/AgentModelOverride/workloadAgentKey（500612e）
- **desktop**：AI 任务弹窗默认 AI + 逐条编辑 + 重生成 + 一键创建（4ca6e0e）
- **desktop**：需求创建改为 AI 两步唯一入口（44b4638）
- **desktop**：需求/任务 AI 对话接入粘底滚动（74244a9）
- **desktop**：任务详情对话接入粘底滚动与新消息提示（5e7831c）
- **desktop**：新增粘底滚动 hook 与新消息悬浮按钮（0fcb05e）
- **agents**：专用步骤 Agent 范式与需求环节重构（875f548）
- **agents**：需求对话 brainstorming 独立技能（309966c）
- **scripts**：inspect-roles 标注技能物理来源(source)（0e7e927）
- **agents**：共享技能注册池与跨角色引用支持（11b11c8）

### 问题修复
- **desktop**：drain pending ai:chat handlers in tests to avoid closed-DB races（327aa1a）
- **scheduler**：pause on review finalization failures and classify review contract failures（ceb5a2f）
- **scheduler**：exempt runtime scaffolding from knowledge and worktree commits（a96c647）
- **agents**：include source file digest in profile materialization cache key（7d7482e）
- **agents**：guard report_result payload and classify missing structured result as task_result（af31696）
- **desktop**：cover usage chart-error state and a11y labels（2c0fb37）
- **desktop**：include total tokens in successRate trend tooltip（ffc74dc）
- **desktop**：resolve provider usage labels（5c2a5e2）
- **persistence**：aggregate usage by provider id（6532223）
- **analytics**：capture canonical Pi token usage（28312e5）
- **agents**：expose redacted provider failure detail（00f75f7）
- **agents**：restore runtime fallback for expert routes（3c95d5a）
- **desktop**：AI 创建弹窗体验五连修（a31a97c）
- **agents,desktop**：评审修复（问答超时看门狗 + 无 IPC 不阻塞 + 流式判据测试 + AskCard 守卫）（ace6cf1）
- **desktop**：ai:chat 完成后发送 done 事件 + 抑制需求对话的思维链泄露（9aaeba3）

### 其他变更
- add knowledge initialization recovery design（7ea8bdc）
- **plans**：add knowledge switching and usage ECharts implementation plans（50ba43b）
- ignore local agent tooling scratch directories（c7cd15b）
- **desktop**：drop unused usage chart wrappers（53271e8）
- **desktop**：cover knowledge project synchronization（fb3e7fc）
- **desktop**：assert knowledge loading state on project reset（3d6fb8c）
- **desktop**：cover usage analytics dashboard（2249743）
- **desktop**：assert EChart observer disconnect on unmount（fda804a）
- design usage analytics and knowledge switching（8fc3f42）
- record workflow implementation plans（ccc1dff）
- design provider route runtime fallback（8d689c9）
- design workflow reliability and provider analytics（5eeded3）
- plan reliable AI task generation（56ddd2c）
- design reliable AI task generation（3cabeae）
- plan project-grounded AI creation（a78deb6）
- design project-grounded AI creation（0e19c3b）
- design structured result contract repair（2ec5a74）
- design default branch recovery（2a7d5f9）
- verify progressive knowledge workflow end to end（20822ba）
- plan progressive knowledge base implementation（4766088）
- design progressive knowledge base workflow（38e06dc）
- **desktop**：ipc 移除 role 输入，加 typeLabel + pi-runtime 专家覆盖（f409139）
- **scheduler**：按泳道派发专家（in_progress->dev, testing->test）（ad467a8）
- **agents**：AgentRunRequest 改 expert + PiRunner/ProviderRouter 用专家键（c369542）
- ignore local .worktrees directory（62f54c4）
- Agent 角色重构实施计划（13 任务 TDD）（a899312）
- Agent 角色重构设计（泳道驱动阶段化专家）（109d93f）
- **desktop**：buildChatPlan 用例适配 ai_devflow_ask 接入 step agent（51cd937）
- AI 生成流程增强实施计划（12 任务）（2d6ce1e）
- AI 生成流程增强设计（5 项需求）（9df4109）
- **desktop**：e2e 适配 AI 两步需求入口与默认 AI 任务弹窗（915b188）
- 工作台对话与 Agent 模型路由实施计划（fa58633）
- 工作台对话与 Agent 模型路由设计（3e5a390）
- 专用步骤 Agent 范式与需求环节重构设计（24a9c58）
- 需求对话 brainstorming 独立技能设计（878c3e0）
- 共享技能支持设计（088c7f8）

## v0.2.2

变更范围：[v0.2.1...v0.2.2](https://github.com/Aiden-FE/ai-devflow/compare/v0.2.1...v0.2.2)

### 新功能
- **agents**：专用步骤 Agent 范式与需求环节重构——需求对话改由 requirement_refiner 步骤 Agent 驱动,AI 调用 ai_devflow_propose_requirement 工具生成需求草稿,移除「生成需求草稿」按钮（24a9c58）
- **agents**：requirement brainstorming skill for AI refine requirement（878c3e0）
- **agents**：shared skills registry with cross-role borrow support（088c7f8）
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
