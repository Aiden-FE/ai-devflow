---
name: failure-analysis
description: 对测试失败做归因：区分实现缺陷、测试缺陷与环境因素，给出证据。
---

# 失败归因

- 运行失败测试，读完整输出与栈，定位实际失败点。
- 区分：实现缺陷 / 测试本身缺陷 / 环境或偶发因素。
- 用最小复现与对照实验确认归因，避免误判。
- 把归因结论与证据写入 report_result 的 verification/unresolved。
