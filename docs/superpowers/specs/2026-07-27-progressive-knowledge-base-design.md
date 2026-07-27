# 渐进式知识库闭环设计

- 日期：2026-07-27
- 状态：已批准，待实施计划
- 关联：`2026-07-27-agent-role-restructure-design.md`、`2026-07-27-iteration-sprint-branch-and-chat-ux-design.md`
- 参考：`/Users/aiden/dev/aiden/prodflow` 的知识检索、项目启动、worker、review、sprint-close 与 release 文档机制

## 1. 背景

ai-devflow 已具备需求创建、任务拆分、开发、测试、人工验收和迭代分支归档流程，也能持久化执行消息、日志、checkpoint 与 attempt journal，但项目知识仍主要依赖临时代码检索和散落文档。任务之间缺少稳定的知识复用入口，迭代中的设计、计划和变更记录也没有统一生命周期。

prodflow 提供了可借鉴的 Markdown 知识分类、分层索引、L1-L4 渐进检索、任务后知识沉淀和迭代 CHANGELOG 机制，但其中巡检、相关性评分和关联检查大多依赖技能文本约定，缺少可测试的确定性实现。ai-devflow 需要保留其渐进披露思想，同时把状态门禁、引用校验、Git 安全和审计证据落实为产品能力。

本设计采用端到端薄闭环：首期贯通项目初始化、知识巡检、任务检索、审查后沉淀和迭代归档，不引入向量数据库或后台索引服务。

## 2. 目标与非目标

### 2.1 目标

1. 为项目提供明确的知识库入口，可初始化、轻检、完整巡检、预览并确认修复。
2. 以项目仓库内 Markdown 作为知识正文唯一事实源，纳入 Git 追踪和分支生命周期。
3. 为每个迭代建立专用文档目录，持续保存设计、实施计划、任务记忆和 CHANGELOG。
4. 在产品、UX、任务拆分、开发和测试执行前触发渐进式知识检索，只披露当前任务需要的内容。
5. 测试审查通过后强制产生知识价值评估；有价值时必须完成沉淀及校验，才能进入 `in_review`。
6. 迭代归档前聚合并校验迭代 CHANGELOG；生成、校验或分支合并失败均不得归档。
7. 新增可独立配置模型的“项目负责人” Agent，处理项目级语义知识治理。
8. 所有检索、巡检、沉淀和门禁结果可审计、可恢复、可在 UI 中解释。

### 2.2 非目标

首期不实现：

- 向量检索、Embedding 或后台常驻索引服务。
- 跨项目知识共享和组织级知识库。
- 无用户确认的大规模知识重写。
- 自动发布 Release Notes 或对接外部发布平台。
- 用 SQLite 复制或替代 Markdown 正文。
- 自动从代码推导并长期保存所有可推导事实。

## 3. 核心原则

1. **Markdown 是事实源**：正文、索引和关联关系都在项目仓库中；SQLite 只保存运行状态和审计记录。
2. **语义与确定性分离**：Agent 判断“内容意味着什么”，宿主验证“文件、引用、状态和门禁是否成立”。
3. **先索引后正文**：任何检索都从根索引和分类索引开始，按相关性与预算逐层展开。
4. **知识必须可追溯**：每项长期知识包含来源、更新时间、置信度和稳定 ID。
5. **条件式强门禁**：允许有证据地判断“无沉淀价值”；一旦判断有价值，写入失败不得放行。
6. **写入受控**：Agent 只能在指定 worktree 和文档路径内写入，Git 操作由宿主完成。
7. **兼容旧项目**：未初始化知识库不阻止普通任务启动，但缺失状态必须显式披露；需要沉淀时必须先确认初始化。

## 4. 仓库目录协议

### 4.1 长期知识库

```text
docs/knowledge/
├── index.md
├── context/
│   └── index.md
├── adr/
│   └── index.md
├── feature/
│   └── index.md
├── runbook/
│   └── index.md
├── product/
│   └── index.md
└── ux/
    └── index.md
```

六类知识职责如下：

| 类型 | 内容边界 |
|---|---|
| `context` | 技术栈、架构边界、工作流、编码与项目约定 |
| `adr` | 代价高、难回退或影响多个模块的决策及其后果 |
| `feature` | 稳定功能行为、关键入口、模块关系和扩展方式 |
| `runbook` | 可重复的诊断、恢复、发布和运维操作 |
| `product` | 产品策略、术语、用户规则、范围和长期产品约束 |
| `ux` | 交互模式、设计系统、可访问性和跨页面体验约束 |

每个文档必须包含可解析 frontmatter：

```yaml
id: feature:task-review-gate
type: feature
status: active
owner: project
updated: 2026-07-27
confidence: 0.85
sources:
  - packages/scheduler/src/orchestrator.ts
related:
  - adr:iteration-branching
```

统一状态为 `draft | review | active | superseded | archived`。稳定 ID 用于索引和文档间引用；路径可以调整而不破坏关联。分类索引记录文档 ID、标题、短摘要、状态、置信度和路径，根索引记录六类概览及项目知识入口。

### 4.2 迭代文档

```text
docs/iterations/<version>/
├── index.md
├── CHANGELOG.md
└── tasks/
    └── <task-id>/
        ├── index.md
        ├── DESIGN.md
        ├── PLAN.md
        ├── MEMORY.md
        └── CHANGELOG.md
```

- 创建迭代时初始化 `index.md` 和迭代级 `CHANGELOG.md`。
- 任务首次启动时初始化任务目录及任务级 `index.md`；该索引记录文档资产、缺失原因、依赖和关联知识 ID。
- `DESIGN.md` 与 `PLAN.md` 保存经任务执行形成的设计和实施计划。
- `MEMORY.md` 只保存当前任务中具有后续归并价值、但尚不适合成为长期知识的要点；不重复代码可直接推导的信息。
- 任务级 `CHANGELOG.md` 是并发友好的变更片段。迭代归档前由项目负责人聚合为迭代级 `CHANGELOG.md`。
- `index.md` 记录需求、任务、文档资产、依赖和关联知识 ID，形成迭代内导航入口。

任务允许按实际价值省略 `DESIGN.md`、`PLAN.md` 或 `MEMORY.md`，但任务索引必须明确记录缺失原因。任务级 `CHANGELOG.md` 在任务产生代码或知识变更时必需。

## 5. 总体架构

### 5.1 项目负责人 Agent

新增专家键 `project_lead`，UI 标签为“项目负责人”，并纳入 `AgentModelOverride`，允许用户单独选择 Provider 和模型。它是知识治理负责人，不参与普通业务编码。

首期职责：

- 扫描已有代码、文档和 Git 历史，生成知识库初始化草稿。
- 执行语义巡检，判断知识是否过期、冲突、缺失或应被归并。
- 根据测试专家的候选和证据更新长期知识、索引及任务文档。
- 归并多个任务的知识候选，避免重复或互相矛盾的文档。
- 迭代归档前聚合任务 CHANGELOG，更新迭代索引和知识关联。

工具权限包含只读检索与 `write/edit`，但宿主强制其写入路径仅限：

- `docs/knowledge/**`
- `docs/iterations/**`

项目负责人不执行 Git 命令，不改源码或配置。运行结束后宿主检查完整 diff，越界改动使本次运行失败。

### 5.2 ProjectKnowledgeService

新增宿主侧知识服务，负责确定性行为：

- 目录和模板初始化。
- frontmatter 解析和 schema 校验。
- 稳定 ID、索引完整性、引用存在性与孤立文档检查。
- Git 跟踪、`.gitignore`、路径白名单和变更范围检查。
- 渐进检索候选生成、层级推断、预算控制和 manifest 记录。
- 知识写入后的重新解析与关联校验。
- 任务、迭代门禁需要的结构化结论。

服务不判断文档内容是否语义正确；这部分由项目负责人完成。状态机只消费知识服务产生的结构化校验结果，不直接信任 Agent 的自然语言结论。

包边界固定如下：纯领域类型、schema 和门禁谓词放在 `packages/core`；新增 `packages/knowledge` 承载 Markdown/YAML、文件系统巡检、检索规划和 manifest，不依赖 Electron 或 SQLite；`packages/scheduler` 负责调用 Agent、worktree、串行锁、恢复和状态转换；`packages/persistence` 保存运行记录；Desktop 主进程通过类型化 IPC 编排项目级入口。

### 5.3 Agent 技能

新增并注册两类知识技能：

- `knowledge-retrieve`：供产品、UX、研发负责人、研发、测试和项目负责人使用。遵循先索引后正文、预算内下钻、记录实际读取和报告差异的协议。
- `knowledge-governance`：仅供项目负责人使用。负责初始化草稿、语义巡检、沉淀归并和 CHANGELOG 聚合，不负责 Git 与状态转换。

现有专家的 SYSTEM 与技能只声明何时调用知识技能；检索层级和初始 manifest 由宿主统一生成，避免不同模型自行决定是否检索。

### 5.4 持久化与 UI

SQLite 下一版本迁移只新增运行记录和 UI 状态，不存正文：

- 项目知识库状态快照和最近轻检时间。
- 巡检运行、问题、草稿分支和确认状态。
- 检索 manifest、实际读取、置信度、差异与预算。
- 知识价值评估、沉淀运行、关联知识 ID 和门禁结果。
- 迭代 CHANGELOG 聚合与归档校验结果。

项目页新增“知识库”入口，展示健康度、最近巡检、阻断/告警、索引关系和待确认草稿。任务执行详情展示检索与沉淀证据；设置页新增项目负责人模型配置。

## 6. 渐进式检索

### 6.1 披露层级

| 层级 | 默认读取范围 |
|---|---|
| L1 | 根索引和项目 Context 摘要 |
| L2 | 相关分类索引和直接高相关文档 |
| L3 | L2 加关联 ADR、Feature、Runbook 及依赖任务文档 |
| L4 | L3 加具体 Product/UX 文档和必要的关联链深挖 |

`KnowledgeRetrievalPlanner` 根据任务描述、当前阶段、专家、任务类型标签、前置任务和已知变更文件推断层级。默认建议：通用项目理解为 L1-L2；任务拆分、开发和测试为 L3；明确的产品或 UX 任务为 L4。层级是读取上限，不代表必须读取范围内的全部文档。

### 6.2 检索流程

1. 宿主解析根索引与相关分类索引。
2. 使用任务关键词、路径、专家、知识类型、稳定 ID 关联和来源路径产生确定性候选集。
3. 按相关性、置信度、状态和新鲜度排序，并应用文件数与内容预算。
4. 生成初始 retrieval manifest，注入 Agent 上下文。
5. Agent 通过 `knowledge-retrieve` 在 manifest 允许范围内读取正文；需要继续下钻时记录原因。
6. 执行完成后持久化实际读取、跳过项、发现的代码差异和过期候选。

首期不宣称精确语义评分。确定性排序必须有固定 tie-breaker，并可通过 fixture 测试复现。置信度只用于排序和告警，不能把知识自动判定为真实。

### 6.3 过期知识

检索发现知识与项目实际状态不一致时：

- 向当前 Agent 披露差异和来源证据。
- 将文档标记为巡检候选，不在只读检索中自动改写。
- 当前任务以代码和用户要求为更高优先级。
- 后续由项目负责人巡检或审查后沉淀流程更新知识。

## 7. 生命周期集成

### 7.1 项目打开、初始化与巡检

项目打开或导入时执行只读轻检，只判断知识入口、六类索引、迭代目录协议和元数据能否解析，不自动修改项目。

用户点击初始化后：

1. 宿主创建专用临时知识分支和 worktree。
2. 确定性创建目录、索引和模板骨架。
3. 项目负责人扫描代码、文档和 Git 历史，生成基础知识草稿及来源证据。
4. 宿主校验草稿并向 UI 返回新增、修改和问题预览。
5. 用户确认后宿主合并临时分支；取消则保留审计记录并清理临时 worktree。

完整巡检包含：

- 结构巡检：缺失索引、非法元数据、重复 ID、断链、孤立文档、非法路径、未跟踪或被忽略文件。
- 语义巡检：可能过期、来源不足、知识冲突、重复主题、缺失的重要 Context/ADR/Feature/Runbook/Product/UX。

语义巡检由项目负责人产出候选，确定性服务复核路径、引用和来源存在性。修复同样先预览、后确认。

### 7.2 创建迭代与启动任务

创建迭代时，在迭代分支初始化 `docs/iterations/<version>/index.md` 和 `CHANGELOG.md`。顺序固定为“准备或复用迭代分支与临时 worktree -> 幂等初始化并校验文档 -> 写入迭代数据库记录 -> 清理临时 worktree”。分支或文档失败时不写数据库；数据库写入失败时回滚本次新建的文档和分支（预先存在的分支不删除），并保留诊断记录。这样不留下“数据库已创建但文档未初始化”的半完成状态。

任务首次启动时初始化任务文档目录，并在产品、UX、拆分、开发或测试 Agent 启动前生成 retrieval manifest。知识库未初始化时任务仍可执行，但 manifest 状态为 `not_initialized`，UI 显示缺失，不伪装成“无相关知识”。

### 7.3 审查后知识沉淀

测试专家通过审查和验证时，结构化结果必须包含：

```typescript
type KnowledgeAssessment =
  | { verdict: 'none'; reason: string; evidence: string[] }
  | {
      verdict: 'valuable';
      candidates: Array<{
        type: 'context' | 'adr' | 'feature' | 'runbook' | 'product' | 'ux';
        summary: string;
        evidence: string[];
        suggestedTarget?: string;
        reuseScenario: string;
      }>;
    };
```

`none` 允许任务继续，但理由和证据必须持久化。`valuable` 触发条件式强门禁：

1. 任务保持 `testing`，执行子阶段记为 `knowledge_deposition`。
2. 调度器取得迭代知识串行锁，并使任务分支同步最新迭代分支。
3. 项目负责人基于候选、任务 diff、检索 manifest 和现有知识更新长期知识、索引、任务 MEMORY 与任务 CHANGELOG。
4. 宿主检查路径白名单、schema、索引、引用、Git 跟踪和本次沉淀关联。
5. 校验成功后，任务分支才可合并到迭代分支并转为 `in_review`。

知识库未初始化且评估为 `valuable` 时，任务转 `awaiting_input`，提示用户确认初始化草稿；确认后从沉淀子阶段恢复。不得把未初始化等同于无沉淀价值。

### 7.4 并发任务

同一迭代的“同步最新迭代分支 -> 知识沉淀 -> 校验 -> 任务合并”必须串行执行。这样项目负责人总是基于最新知识更新，避免并发任务从旧索引写出互相覆盖的结果。

若同步或合并冲突：

- 任务保持 `testing/knowledge_deposition`。
- 保存冲突路径、当前 manifest、候选和 checkpoint。
- 重新读取最新 Git 状态后重试归并。
- 无法自动归并时转 `awaiting_input`，不产生重复知识文档。

### 7.5 迭代归档

所有任务归档后，归档操作依次执行：

1. 项目负责人读取任务 CHANGELOG、沉淀记录和迭代 Git 差异，重建迭代级 `CHANGELOG.md`。
2. 更新迭代 `index.md` 的任务资产和关联知识 ID。
3. 宿主校验每个任务都被 CHANGELOG 覆盖、路径存在、版本一致、文档已被 Git 跟踪。
4. 宿主合并迭代分支到默认分支。
5. 仅在合并成功后更新数据库迭代状态和 `archivedAt`。

CHANGELOG 生成、校验或分支合并任一步失败都阻止归档。该行为同时修复当前“迭代分支合并失败仍可归档”的宽松语义。

## 8. 失败处理与安全

### 8.1 问题分级

阻断问题：

- 根索引或必需分类索引缺失。
- frontmatter 无法解析或必需字段非法。
- 重复稳定 ID、断链或引用目标不存在。
- Agent 越界修改非知识/迭代文档。
- 本次写入的 Markdown 未被 Git 跟踪或被 `.gitignore` 忽略。
- 本次沉淀未覆盖已声明的 valuable 候选。
- 迭代 CHANGELOG 未覆盖全部任务。

告警问题：

- 低置信度、可能过期或来源不足。
- 孤立但仍可能有效的知识。
- 相似主题或潜在冲突。
- 缺少非必需任务文档。

只读检索不因告警失败。初始化、修复、沉淀和归档必须消除本次操作相关的阻断问题。

### 8.2 原子性与恢复

写操作遵循“草稿目录 -> 解析 -> 引用校验 -> 路径检查 -> 原子替换”。Agent、Provider 或解析失败时保存 checkpoint、manifest、草稿 diff 和诊断，可切换模型恢复。恢复前重新读取当前 Git 状态，不基于过期快照继续写。

项目级初始化和巡检修复使用专用临时 worktree/分支，避免污染用户可能脏的默认工作区。迭代级写入发生在任务或迭代分支对应的受控 worktree 中。Git 操作始终由宿主执行。

## 9. 状态、契约与影响范围

### 9.1 专家与配置

- `ExpertKey` 和执行画像加入 `project_lead`。
- `EXPERT_PROFILES` 注册项目负责人画像、`knowledge-governance` 和 `knowledge-retrieve`。
- 产品、UX、研发负责人、研发和测试画像注册 `knowledge-retrieve`。
- Settings 的 `AgentModelOverride` 新增项目负责人独立配置项。
- 画像注册和 `inspect:roles` 等维护工具应同步展示全部专家，避免新专家只存在于运行时代码。

### 9.2 结构化契约

至少新增以下领域对象：

- `KnowledgeHealthSnapshot`
- `KnowledgeAuditRun` / `KnowledgeFinding`
- `KnowledgeRetrievalManifest` / `KnowledgeReadEvidence`
- `KnowledgeAssessment`
- `KnowledgeDepositionRecord`
- `IterationChangelogVerification`

所有 Agent 输出通过 `structured-result` 校验。项目负责人运行必须同时通过结果 schema 和宿主 diff 校验。

### 9.3 状态机

任务主状态保持：

```text
ready -> in_progress -> testing -> in_review -> archived
```

`knowledge_deposition` 是 `testing` 内可持久化、可恢复的执行子阶段，不新增泳道。需要用户确认或人工处理时沿用 `awaiting_input`，并通过 `pausedFrom` 与 checkpoint 恢复。

`testing -> in_review` 的门禁扩展为：

- 审查和测试通过。
- 存在合法的 `KnowledgeAssessment`。
- 若 verdict 为 `valuable`，对应沉淀记录和确定性校验均成功。
- 任务分支合并到迭代分支成功。

## 10. UI 设计

项目页“知识库”入口提供：

- 初始化状态和最近轻检时间。
- 六类知识数量、状态和健康概览。
- “初始化”“完整巡检”“查看问题”操作。
- 初始化或修复草稿的文件 diff 预览与确认。
- 阻断、告警、来源和关联图的可读列表。

任务详情提供：

- 本次检索层级、命中文档和实际读取证据。
- 过期或冲突知识警告。
- 测试专家的知识价值评估。
- 项目负责人沉淀结果和阻断原因。

迭代详情提供：

- 迭代文档入口和任务文档覆盖状态。
- CHANGELOG 聚合状态、缺失任务和关联知识。
- 归档门禁失败的可操作诊断。

UI 不直接编辑结构化索引。首期所有正文修改仍通过草稿 diff 确认或受控 Agent 流程完成。

## 11. 测试策略

### 11.1 单元测试

- `core`：知识领域类型、L1-L4 规则、评估 schema 和状态门禁。
- 知识服务：初始化幂等性、YAML 解析、稳定 ID、索引、断链、孤立、重复 ID、路径白名单、Git ignore、排序 tie-breaker 和预算。
- `agents`：项目负责人画像、模型覆盖、技能物化、manifest prompt 和结构化结果校验。
- `persistence`：下一 schema 迁移、运行记录、checkpoint 和旧数据库兼容。

### 11.2 集成测试

- `testing -> knowledge_deposition -> in_review` 成功链路。
- `none` 有证据跳过与 `valuable` 强制沉淀。
- 沉淀失败、未初始化确认、Provider 切换和 checkpoint 恢复。
- 两个任务并发沉淀时的串行锁与最新知识同步。
- 冲突时保持状态并可恢复，不产生重复文档。
- 迭代归档前 CHANGELOG 聚合、覆盖校验和合并失败阻断。
- 脏默认工作区不被项目级初始化或修复污染。
- 越界 Agent 修改和被忽略 Markdown 被拒绝。

### 11.3 UI 与真实运行验证

- Desktop 测试覆盖知识入口、初始化确认、巡检报告、任务证据、归档反馈和项目负责人模型设置。
- 至少一条真实 Pi fixture 流程覆盖：初始化 -> 渐进检索 -> valuable 沉淀 -> `in_review` -> 任务归档 -> 迭代 CHANGELOG -> 迭代归档。
- 验证实际模型输出满足结构化协议，且完整知识正文没有被一次性注入 prompt。

## 12. 验收标准

1. 既有项目可在不改源码的前提下预览并确认初始化 `docs/knowledge`。
2. 巡检稳定发现缺索引、断链、非法元数据、重复 ID、过期候选和未跟踪文档。
3. 六类知识均有模板、索引和统一关联协议。
4. 每次相关专家执行都有 retrieval manifest，并只展开与任务相关的正文。
5. 每个测试通过结果都包含知识价值评估；有价值时未成功沉淀绝不能进入 `in_review`。
6. 项目负责人可单独配置模型，只能修改知识和迭代文档。
7. 每个迭代拥有 `docs/iterations/<version>`，任务资产和 CHANGELOG 可追溯。
8. 归档前迭代 CHANGELOG 覆盖全部任务；生成、校验或分支合并失败均不能归档。
9. 尚未初始化知识库不会破坏旧项目普通任务执行，但缺失状态和后续门禁必须明确可见。
10. 检索、巡检、沉淀和归档门禁均有可持久化、可解释、可恢复的证据。

## 13. 实施分解建议

本设计仍属于一个端到端能力，但实施计划应按可独立验证的纵向步骤推进：

1. Markdown 协议、领域类型、解析器与确定性巡检。
2. 项目负责人画像、模型配置和知识技能资产。
3. 项目知识入口、初始化草稿与确认流程。
4. 渐进检索 planner、manifest 和各专家运行时注入。
5. 迭代/任务文档生命周期。
6. 测试后知识评估、沉淀子阶段和条件式强门禁。
7. CHANGELOG 聚合、严格迭代归档和端到端验证。

每一步都必须保持旧项目可运行，并在合并前具备对应单元或集成测试。