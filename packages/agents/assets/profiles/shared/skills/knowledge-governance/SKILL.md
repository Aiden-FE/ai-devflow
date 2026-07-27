---
name: knowledge-governance
description: 项目负责人专用——初始化、语义巡检、修复、沉淀与迭代 CHANGELOG 聚合的知识治理契约，禁止 Git 与业务代码改动。
---

# 知识治理（Knowledge Governance）

仅供项目负责人（`project_lead`）使用。本技能定义知识治理各环节的结构化结果契约与写入边界。

## 写入边界

- 只允许写入 `docs/knowledge/**` 与 `docs/iterations/**`。
- 禁止执行 Git 命令、禁止修改源码或配置。Git 与状态转换由宿主完成。
- 修改正文时同步更新对应分类索引与根索引；稳定 ID 复用，不创建重复或矛盾文档。

## 环节契约

### knowledge_initialization（初始化草稿）

- 扫描代码、文档与 Git 历史，生成基础长期知识草稿及来源证据。
- 复用已有稳定 ID；为六类知识创建或补全索引。
- 结构化结果：`{ kind: 'knowledge_initialization', changedPaths, knowledgeIds }`。

### knowledge_audit（语义巡检）

- 判断知识是否过期、冲突、缺失或应被归并；产出语义候选问题。
- 宿主复核路径、引用与来源存在性；只读巡检不改写知识。
- 结构化结果：`{ kind: 'knowledge_audit', findings }`。

### knowledge_repair（修复）

- 针对选定的 finding 修复过期/断链/重复/非法元数据。
- 修复后重新校验关联与索引；resolvedFindingIds 必须对应本次修复的 finding。
- 结构化结果：`{ kind: 'knowledge_repair', changedPaths, knowledgeIds, resolvedFindingIds }`。

### knowledge_deposition（审查后沉淀）

- 基于测试专家的候选与证据、任务 diff、检索 manifest 与现有知识，更新长期知识、索引、任务 MEMORY 与任务 CHANGELOG。
- 归并多个候选，避免重复或互相矛盾的文档。
- 结构化结果：`{ kind: 'knowledge_deposition', changedPaths, knowledgeIds, assessment }`。

### iteration_changelog（迭代归档前聚合）

- 读取任务 CHANGELOG、沉淀记录与迭代 Git 差异，重建迭代级 `CHANGELOG.md`。
- 更新迭代 `index.md` 的任务资产与关联知识 ID。
- 覆盖全部任务；缺失任务需在结果中如实反映。
- 结构化结果：`{ kind: 'iteration_changelog', changedPaths, coveredTaskIds }`。

## 失败条件

- 仅凭自然语言叙述而未上报匹配的结构化结果——视为失败。
- 越界修改非知识/迭代文档——本次运行失败。
- 声称修复但未实际更新对应文件或索引——视为失败。
