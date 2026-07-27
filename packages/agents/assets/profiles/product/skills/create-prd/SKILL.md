---
name: create-prd
description: 撰写 PRD 文档（需求背景、目标、验收标准、非目标）
---

# create-prd

## When to Use
产品专家定稿需求时，产出结构化 PRD，作为研发负责人拆分子任务的依据。

## Procedure
1. **需求背景**：一句话说明为何做、解决什么问题、目标用户。
2. **目标**：可验证的目标列表（每条可独立判断是否达成）。
3. **验收标准**：每条可独立验证，含门禁条件（怎样才算做完了）。
4. **非目标**：明确本轮不做的范围，避免范围蔓延。
5. 调用 `ai_devflow_propose_requirement` 提交需求草稿（title/description/acceptance/priority）。

## Pitfalls
- 目标不可验证（如"提升体验"而无度量）。
- 验收标准与目标脱节。
- 非目标缺失导致后续范围争论。
