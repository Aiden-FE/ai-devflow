# 更新日志（CHANGELOG）

本文件记录各版本面向用户的变更。由发版工作流自动维护：每次发版时，
`scripts/gen-changelog.mjs` 会生成「上一版本 tag → 当前版本」的小节并 prepend 到此处，
GitHub Release 正文与本文件对应小节保持一致。

分组：新功能 / 问题修复 / 其他变更；自动过滤 merge、版本号提交等噪音，并附 compare 链接。

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
