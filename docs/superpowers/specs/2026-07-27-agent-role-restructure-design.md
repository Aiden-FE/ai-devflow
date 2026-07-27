# Agent 角色重构设计：泳道驱动的阶段化专家

- 日期：2026-07-27
- 状态：待评审
- 关联：本 spec 是「ai-devflow 持续迭代流程改进」两项工作的**第一份** spec。第二份「渐进式知识库体系」spec 将在此重构落地后启动。

## 1. 背景与动机

ai-devflow 当前采用四个内置任务角色 `planner | coder | reviewer | tester`，每个任务携带一个 `role` 字段选择 Pi 画像；用户唯一可调的杠杆是 `AgentModelOverride`（按 AgentKey 固定 provider+model）。`docs/superpowers/specs/2026-07-23-requirement-brainstorming-skill-design.md` 已记录用户架构意图：「现有四角色 agent 机制不满意，计划重构为工作流各环节的专用 agent」。

本 spec 落地该重构：移除可配置角色，改为**由任务所处泳道/流程阶段决定接管的专家**。同时融合 prodflow 的任务拆分原则（独立闭环、小任务合并防过度拆分），把需求创建、子任务拆分、开发、测试分别交给产品/UX/研发负责人/研发/测试专家，待验收泳道保持人工验收。

参考来源：`/Users/aiden/dev/aiden/prodflow` 的 `prodflow-subtask-gen`（拆分原则）、`prodflow-worker`/`prodflow-review`（阶段职责划分）。注意 prodflow 无独立专家 agent 或模型分配（专家以技能 persona 实现）；ai-devflow 将专家实现为真实 Pi 子进程画像。

## 2. 目标与非目标

### 目标
1. 移除任务上可配置的 `role`；执行者由当前泳道/阶段决定。
2. 引入五个专家 + 通用对话：产品专家、UX专家、研发负责人、研发专家、测试专家、chat。
3. 需求创建由产品专家主导，有 UX 面时子咨询 UX专家。
4. 子任务拆分由研发负责人负责，遵循独立闭环 + 小任务合并原则，防过度拆分。
5. `in_progress` 由研发专家执行；`testing` 由测试专家执行（合并当前 reviewer+tester 职责：代码审查 + 功能验证 + 新增用例验证）；`in_review` 保持人工验收。
6. AgentModelOverride 键集合重构为 6 个专家键，旧键一次性迁移。
7. 任务可选类型标签（前端/后端/全栈/联调），仅用于展示与拆分自检，不影响派发。

### 非目标（属第二份 spec「渐进式知识库体系」）
- 项目级知识库初始化与巡检入口。
- 迭代专用文档目录（设计文档/实施计划/CHANGELOG/MEMORY 等）。
- 任务执行时渐进式知识检索。
- 审查通过后的知识沉淀。
- 迭代归档前更新 CHANGELOG。

> 本 spec 在 C.4 预留「拆分报告写入迭代文档目录」的数据结构接口，但**不实现**存储，待第二份 spec 落地迭代文档目录后接入。

## 3. 总体架构：泳道 -> 专家映射与生命周期

核心原则：专家不再由任务 `role` 字段选择，由**当前所处泳道/流程阶段**决定。同一任务穿越泳道时由对应阶段专家接力。

| 流程阶段 / 泳道 | 接管专家 | 说明 |
|---|---|---|
| 需求创建（非泳道，对话式起草） | 产品专家主导；识别到 UX 面时子咨询 UX专家 | 取代当前 `requirement_refiner` step agent。无 UX 面的需求不调用 UX专家 |
| 研发子任务拆分（非泳道，从需求生成任务） | 研发负责人 | 取代当前 `task_proposer` step agent。遵循独立闭环原则 |
| `ready` 待开发 | 无 agent | 任务就绪，等待启动 |
| `in_progress` 开发中 | 研发专家 | 取代当前 planner+coder。一个专家完成 设计->实现->自验 |
| `testing` 测试中 | 测试专家 | 取代当前 reviewer+tester。先代码审查（质量/安全/回归）后功能验证（测试设计/失败分析/验收验证），两者均过才放行 |
| `in_review` 待验收 | 人工验收（无 agent） | 不变，由人 `tasks.accept` 归档 |
| `archived` 已归档 | - | 终态 |
| `awaiting_input` 待沟通 | 暂停标记，显示在原泳道 | 任意泳道可暂停，恢复后回原泳道由原专家继续 |

生命周期数据流：
```
[需求创建] 产品专家(+条件UX) -> Requirement
   ↓ (研发负责人拆分)
[子任务生成] -> Tasks(DAG, dependsOn) -> ready
   ↓ start
ready -> in_progress(研发专家·开发)
   ↓ 自动流转
-> testing(测试专家·审查+测试)
   ↓ 审查测试双过
-> in_review(人工验收)
   ↓ accept
-> archived
```

关键变化：
- 任务不再携带 `role` 字段决定执行者；编排器（Orchestrator）按**当前泳道**派发对应专家。
- 当前 `task_proposer`/`requirement_refiner` 两个 step agent 分别并入研发负责人与产品专家，不再是独立 AgentKey。
- `testing -> in_review` 门禁不变（仍需 `reviewPassed`），但 `reviewPassed` 现由测试专家在完成审查+测试后置位。

## 4. 专家画像与配置

### 4.1 专家画像表

| 专家 | 接管阶段 | 工具 | 内置工具 | 技能 | 扩展 | 超时 |
|---|---|---|---|---|---|---|
| 产品专家 | 需求创建 | read/grep/find/ls（无 bash） | propose_requirement, ask, consult_ux | brainstorming, requirements-analysis, design-writing, create-prd(新) | requirement-bridge, ask-bridge, event-bridge, structured-result | 15min |
| UX专家 | UX 子咨询 | read/grep/find/ls（无 bash） | ask | ux-spec-writing(新), web-design-engineer | requirement-bridge, ask-bridge, structured-result | 10min |
| 研发负责人 | 从需求生成子任务 | read/grep/find/ls（无 bash/edit/write） | propose_task, ask | brainstorming, implementation-planning, subtask-generation(新) | task-bridge, ask-bridge, event-bridge, structured-result | 15min |
| 研发专家 | in_progress 开发 | read/bash/edit/write/grep/find/ls | interaction, report_result | design-writing, implementation-planning, test-driven-development, systematic-debugging, verification | event-bridge, execution-policy, structured-result, checkpoint-context, task-bridge | 45min |
| 测试专家 | testing 泳道 | read/bash/grep/find/ls/write/edit | report_result | code-review, security-review, regression-review, test-design, failure-analysis, acceptance-verification | event-bridge, execution-policy, structured-result, checkpoint-context, task-bridge | 30min |
| chat | 通用对话 | 沿用现状 | - | - | - | 沿用 |

内部 AgentKey 用稳定英文标识符，UI 显示中文标签：

| AgentKey（内部） | UI 标签 |
|---|---|
| `product` | 产品专家 |
| `ux` | UX专家 |
| `dev_lead` | 研发负责人 |
| `dev` | 研发专家 |
| `test` | 测试专家 |
| `chat` | 通用对话 |

关键取舍：
- **测试专家具备用例验证能力**：工具含 `write/edit`，可在 testing 泳道新增/修改测试文件与夹具来复现/验证问题；但**业务实现代码的修复仍退回研发专家**（in_progress）。这样测试专家既能「用用例说话」又不越界改实现。
- **UX专家注册 `web-design-engineer`**（沿用现有重技能）+ 新建 `ux-spec-writing`（覆盖交互流程、视觉/结构要点、可访问性、响应式）。
- **产品专家注册 `create-prd`**（新建内置技能，PRD 撰写）。
- **研发负责人与研发专家分离**：研发负责人负责拆分规划（只读 + propose_task），研发专家专注开发执行（bash/edit/write）。二者为不同 AgentKey，避免单专家双模式歧义。

### 4.2 UX 子咨询机制（产品专家主导的实现）

产品专家是用户唯一对话面。当它在起草需求时识别到 UX 面（界面/交互/可视化/可访问性），调用新内置工具 `ai_devflow_consult_ux`（新桥接扩展 `ux-bridge`）：
1. 应用收到该调用 -> 以当前需求上下文启动一次 UX专家 step-agent 运行。
2. UX专家产出结构化 UX 建议（交互要点/视觉约束/可访问性/响应式）返回。
3. 产品专家把 UX 建议合并进需求草稿，继续与用户对话定稿。

无 UX 面的需求永不调用 UX专家，零额外开销。机制对称于现有 `ai_devflow_ask`（桥接到用户），只是这里桥接到另一个专家。

### 4.3 Workload -> AgentKey 路由（取代当前 `workloadAgentKey`）

```
requirement_chat / requirement_proposal  -> product
ux_consultation                          -> ux
task_proposal                            -> dev_lead
dev execution (in_progress)              -> dev
testing (review + test)                  -> test
task_chat / 其他通用对话                  -> chat
```

### 4.4 画像清单重构

当前 `ROLE_PROFILES`（4 角色，`packages/agents/src/profiles.ts`）+ `STEP_AGENTS`（2 step agent）合并重构为 **`EXPERT_PROFILES`**，按专家键索引，每个专家单模式子画像。`validateRoleProfiles()` 改为 `validateExpertProfiles()`，启动时 fail-fast 校验技能/扩展引用。`ProfileMaterializer` 继续按 专家+provider 摘要生成内容寻址快照目录。

资产目录重构：`assets/profiles/{planner,coder,reviewer,tester,steps/}` -> `assets/profiles/{product,ux,dev_lead,dev,test}/`（chat 沿用），每个含 `SYSTEM.md` + `settings.json` + `skills/`。`shared/` 保留。

### 4.5 新增技能资产

本 spec 需新建三个内置技能：
1. `create-prd`（产品专家）：PRD 撰写技能。
2. `ux-spec-writing`（UX专家）：交互流程、视觉/结构要点、可访问性、响应式。
3. `subtask-generation`（研发负责人）：承载 §5 拆分原则。

## 5. 研发负责人子任务拆分原则

研发负责人取代当前 `task_proposer`，从需求生成可独立闭环的子任务。原则融合 prodflow 的 `prodflow-subtask-gen`，并对接 ai-devflow 现有基础设施。

### 5.1 拆分核心原则（注入 `subtask-generation` 技能 + 研发负责人 SYSTEM.md）

1. **独立闭环优先**：每个子任务必须能独立开发、独立验证、独立关闭。若必须依赖另一任务，在 `dependsOn` 写明，且依赖不得使任务自身无法交付可验收结果。
2. **小任务合并（反过度拆分）**：当前后端改动都小且围绕同一功能紧耦合时，合并为单个全栈任务，不强行拆前后端。合并需**同时**满足：围绕同一交付紧耦合；规模一人一 worktree 可端到端交付；拆开任一侧都无法独立验证；无并行收益。反之，任一侧有可观独立可验证范围、或可在稳定契约上并行、或后端是多前端的上游、或分属不同模块/关注点，才拆分。
3. **粒度适中**：不把所有前端塞一个巨任务，也不把一个字段改动拆成碎片。
4. **上游优先**：后端 API/数据/权限/迁移类任务作为上游，前端依赖它。
5. **避免重复**：复用需求下已有子任务，只在实际有改动时才生成对应端任务。
6. **HARD-GATE**：拆分草案先示用户确认，禁止未经确认直接创建任务。（现有 `tasks:createBatch` 流程已含确认环节，保留。）

### 5.2 与 ai-devflow 现有基础设施对接

| prodflow 概念 | ai-devflow 映射 |
|---|---|
| 子任务草稿（dev-task Issue） | `AiTaskProposal[]`（带 `draftId` + `dependsOn`），已有 |
| 依赖关系校验 | `validateProposalDag()`（`packages/core/src/proposals.ts`）查无环/自引，已有 |
| 创建顺序 | `topoSortProposals()` 拓扑排序 + `createBatch` 单事务，已有 |
| 并发安全 `parallel-safe` | 无 `dependsOn` 的任务，可与兄弟任务并行启动 |
| 并发安全 `ordered` / `blocked-by-upstream` | 有 `dependsOn` 的任务，`checkTaskDependencies` 门禁阻塞启动（前置须 `in_review`/`archived`） |
| MR baseline（base/after-upstream/stacked） | **统一 sprint 分支为 worktree base**（ai-devflow 不引入 stacked MR，依赖靠 DAG 门禁而非分支堆叠） |

与 prodflow 的有意差异：prodflow 用三态 MR baseline（含 stacked-on-upstream）；ai-devflow 用统一的 sprint 分支 base + DAG 硬依赖门禁。worktree/分支模型保持简单，依赖通过启动门禁而非分支堆叠表达。研发负责人拆分时只需正确标注 `dependsOn`，无需选 MR baseline 策略。

### 5.3 可选任务类型标签

研发负责人可在子任务草稿上标注类型（前端/后端/全栈/联调），存于任务元数据（非 `role`），仅用于展示与拆分报告，不影响执行者选择（执行者恒由泳道决定）。类型标签帮助研发负责人自检拆分合理性（如避免全是联调、识别应合并的全栈）。

### 5.4 拆分报告输出

确认创建后，研发负责人输出报告：子任务清单（标题/类型/dependsOn/闭环说明）、合并决策记录（哪些本可拆但选择合并及理由）、依赖链说明。报告写入需求关联的迭代文档目录。

> 注：迭代文档目录属第二份 spec「渐进式知识库体系」，本 spec 不实现目录存储，但拆分报告的数据结构在本 spec 预留接口，待第二 spec 落地存储后接入。

## 6. 移除可配置角色 + 模型配置重构 + 数据模型/迁移

### 6.1 移除可配置角色

| 当前 | 变更后 |
|---|---|
| 任务创建输入含 `role`（planner/coder/reviewer/tester） | 移除 `role` 输入；编排器按当前泳道派发专家，忽略已存 `role` |
| 任务 `stages[]`（每 stage 带 role，多角色串行） | 废弃多角色 stages；研发专家在 in_progress 单次执行内自行完成 设计->实现->自验（由 implementation-planning 技能编排子步骤）；DB 字段保留兼容 |
| Settings 页角色/Agent 分配区（7 行旧键） | 6 行新专家键，无角色选项 |

### 6.2 模型配置键迁移（AgentModelOverride）

旧 7 键 -> 新 6 键映射：

| 旧 AgentKey | 新 AgentKey |
|---|---|
| `requirement_refiner` | `product` |
| `task_proposer` | `dev_lead` |
| `planner`、`coder` | `dev`（多旧键映射同一新键，取首个有效 override，冲突告警） |
| `reviewer`、`tester` | `test`（同上） |
| `chat` | `chat`（不变） |
| （无） | `ux`（新建，默认用 provider defaultModel） |

迁移在应用启动时一次性执行：读取加密存储的旧 override -> 映射 -> 写回新键 -> 清理旧键。多旧键映射同一新键时取首个有效项，并在日志/UI 提示冲突。

### 6.3 数据模型 / 状态机 / 门禁调整

- **状态机不变**：`ready -> in_progress -> testing -> in_review -> archived` + `awaiting_input`，法定迁移表不动。
- **门禁**：`testing -> in_review` 仍要求 `reviewPassed === true`；现由测试专家在完成代码审查 + 功能验证（含新增用例验证）后置位。其余门禁（accept 归档、依赖前置、需求归档、reject 理由、awaiting_input 恢复）不变。
- **编排器**：进入 `in_progress` 跑研发专家（替代 planner+coder stages）；进入 `testing` 跑测试专家（合并审查+测试，替代 `reviewAndFinalize` 的 reviewer）；测试专家 PASS -> 置 reviewPassed -> 自动 `in_review`；FAIL -> 退回 `in_progress` 带反馈（受 `maxReviewRounds` 默认 2 轮约束，现约束 测试专家 <-> 研发专家 往返）。
- **新增任务元数据**：可选类型标签（前端/后端/全栈/联调），通过一次 DB 迁移加列。非 `role`，不影响派发。

### 6.4 迁移兼容

- 已存任务的 `role` / `stages[]` 字段：编排器忽略，按泳道派发；字段保留不删，避免破坏旧数据。
- 已存 `AgentModelOverride`：启动一次性迁移到新键（§6.2）。
- 已存任务无类型标签：视为「未标注」，不影响流转。
- 现有 worktree/分支模型、跨批依赖 DAG、问答桥接（`ai_devflow_ask`）全部保留不动。

## 7. 验收标准

1. 任务创建与 UI 中不再出现 `role` 选择；编排器按泳道派发对应专家。
2. Settings 页 Agent 模型分配区显示 6 行新专家键（产品/UX/研发负责人/研发/测试/通用对话），无旧键残留。
3. 启动后已存 `AgentModelOverride` 按 §6.2 映射迁移，旧键清理，冲突有日志/UI 提示。
4. 需求创建由产品专家主导；含 UX 面的需求经 `ai_devflow_consult_ux` 子咨询 UX专家，无 UX 面的需求不调用。
5. 子任务拆分由研发负责人执行，遵循独立闭环 + 小任务合并；拆分草案需用户确认后才创建；`dependsOn` DAG 经 `validateProposalDag` 校验。
6. `in_progress` 由研发专家执行；`testing` 由测试专家执行（审查 + 测试 + 必要时新增用例验证），双过才置 `reviewPassed` 进入 `in_review`；FAIL 退回 `in_progress` 且受 `maxReviewRounds` 约束。
7. 新建三个技能资产 `create-prd`、`ux-spec-writing`、`subtask-generation` 注册到对应专家画像。
8. 启动时 `validateExpertProfiles()` fail-fast 校验通过。
9. 已存任务在重构后仍可正常流转（role/stages 被忽略、按泳道派发）。
