---
name: verification
description: 以实际运行的构建/测试/lint 作为完成证据，绝不以声明代替运行。
---

# 实现验证

- 完成后实际运行相关测试、构建与 lint，并记录输出摘要作为证据。
- 验证覆盖本任务改动的路径，包括新增/修改的测试。
- 任何失败都必须修复或如实记入 unresolved，不得忽略或弱化。
- `ai_devflow_report_result` 的 verification 字段必须填真实运行证据。
