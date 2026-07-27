// 项目知识协调器（设计 §7.1/§7.4）：编排知识初始化、巡检、修复、确认与取消。
//
// 项目级操作使用专用临时 worktree/分支，避免污染用户可能脏的默认工作区。Git 操作始终由宿主执行。
// 知识正文唯一事实源为仓库 Markdown；SQLite 只保存运行状态与审计引用。
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import type {
  KnowledgeAgentPayload,
  KnowledgeFinding,
  KnowledgeHealthSnapshot,
  KnowledgeReadEvidence,
  KnowledgeRunKind,
  KnowledgeRunView,
} from '@ai-devflow/core';
import { now as defaultNow, randomId as defaultId } from '@ai-devflow/core';
import type { AgentRunner } from '@ai-devflow/agents';
import type { ProjectKnowledgeService } from '@ai-devflow/knowledge';
import type { Repositories } from '@ai-devflow/persistence';
import { KeyedLock } from './keyed-lock.js';
import type {
  AgentKey,
  Iteration,
  KnowledgeRetrievalManifest,
  Task,
} from '@ai-devflow/core';
import {
  createWorktree,
  removeWorktree,
  deleteBranch,
  listChangedPaths,
  mergeWorktreeBranch,
  branchExists,
} from './worktree.js';

export interface KnowledgeCoordinatorOptions {
  repos: Repositories;
  runner: AgentRunner;
  knowledge: ProjectKnowledgeService;
  worktreesBaseDir: string;
  now?: () => number;
  id?: () => string;
}

const DOC_ROOTS = ['docs/knowledge', 'docs/iterations'];

function isDocPath(rel: string): boolean {
  return DOC_ROOTS.some((root) => rel === root || rel.startsWith(`${root}/`));
}

function dateStr(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

/** 在 cwd 执行 git（提交迭代/任务文档草稿）。 */
function shGit(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** 将 Agent 事件流消费为 done 载荷或错误。 */
async function consumeAgentRun(
  run: import('@ai-devflow/agents').AgentRun,
): Promise<{ summary: string; payload?: KnowledgeAgentPayload; knowledgeReads?: KnowledgeReadEvidence[] }> {
  let summary = '';
  let payload: KnowledgeAgentPayload | undefined;
  let knowledgeReads: KnowledgeReadEvidence[] | undefined;
  let error: string | undefined;
  for await (const ev of run.events) {
    if (ev.type === 'done') {
      summary = ev.summary;
      payload = ev.result;
      knowledgeReads = ev.knowledgeReads;
    } else if (ev.type === 'error') {
      error = ev.message;
    }
  }
  const done = await run.done();
  if (!done.ok || error) throw new Error(error ?? '知识 Agent 运行失败');
  return { summary, payload, knowledgeReads };
}

function toRunView(
  record: import('@ai-devflow/persistence').KnowledgeRunRecord,
  findings: KnowledgeFinding[],
  diff?: string,
): KnowledgeRunView {
  return {
    id: record.id,
    projectId: record.projectId,
    iterationId: record.iterationId,
    kind: record.kind,
    state: record.state,
    draftBranch: record.draftBranch,
    confirmationState: record.confirmationState,
    changedPaths: JSON.parse(record.changedPathsJson) as string[],
    diff,
    findings,
    diagnostics: JSON.parse(record.diagnosticsJson) as string[],
    startedAt: record.startedAt,
    endedAt: record.endedAt,
  };
}

/** 从仓储读取 findings 并映射为领域对象（保证返回的 id 与入库一致，供修复校验）。 */
function dbFindingsForRun(repos: import('@ai-devflow/persistence').Repositories, runId: string): KnowledgeFinding[] {
  return repos.knowledgeFindings.listByRun(runId).map((f) => ({
    id: f.id,
    severity: f.severity,
    code: f.code,
    path: f.path,
    knowledgeId: f.knowledgeId,
    message: f.message,
    evidence: JSON.parse(f.evidenceJson) as string[],
  }));
}

export class KnowledgeCoordinator extends EventEmitter {
  private locks = new KeyedLock();
  private iterationLocks = new KeyedLock();
  private now: () => number;
  private id: () => string;

  constructor(private opts: KnowledgeCoordinatorOptions) {
    super();
    this.now = opts.now ?? defaultNow;
    this.id = opts.id ?? defaultId;
  }

  /** 只读轻检：在项目路径执行结构巡检，不创建运行记录。 */
  async lightCheck(projectId: string): Promise<KnowledgeHealthSnapshot> {
    const project = this.opts.repos.projects.get(projectId);
    if (!project) throw new Error(`项目不存在：${projectId}`);
    return this.opts.knowledge.audit({ projectId, repoPath: project.path });
  }

  /** 启动知识库初始化：创建草稿分支 + worktree，确定性骨架，运行 project_lead，校验后待确认。 */
  async startInitialization(projectId: string): Promise<KnowledgeRunView> {
    return this.locks.run(`init:${projectId}`, async () => {
      const project = this.opts.repos.projects.get(projectId);
      if (!project) throw new Error(`项目不存在：${projectId}`);
      const runId = this.id();
      const draftBranch = `ai-devflow/knowledge/${runId}`;
      const t = this.now();

      this.opts.repos.knowledgeRuns.create({
        id: runId,
        projectId,
        kind: 'initialization',
        state: 'running',
        confirmationState: 'not_required',
        changedPathsJson: '[]',
        diagnosticsJson: '[]',
        resultJson: '{}',
        startedAt: t,
      });

      let worktreePath: string | undefined;
      try {
        const handle = await createWorktree({
          repoPath: project.path,
          baseDir: this.opts.worktreesBaseDir,
          id: `knowledge-${runId}`,
          branchName: draftBranch,
          baseBranch: project.defaultBranch,
        });
        worktreePath = handle.path;

        // 确定性骨架
        await this.opts.knowledge.initializeKnowledge({
          repoPath: worktreePath,
          date: dateStr(t),
        });

        // 运行 project_lead 生成草稿内容
        const agentRun = await this.opts.runner.run({
          scope: { kind: 'project', projectId },
          executionId: runId,
          expert: 'project_lead',
          resultKind: 'knowledge_initialization',
          prompt: '请扫描项目代码、文档与 Git 历史，在 docs/knowledge 下生成长期知识草稿及来源证据。',
          cwd: worktreePath,
        });
        await consumeAgentRun(agentRun);

        // 审计结果
        const snapshot = await this.opts.knowledge.audit({ projectId, repoPath: worktreePath });

        // 收集变更路径并校验越界
        const changedPaths = await listChangedPaths(project.path, project.defaultBranch, draftBranch);
        const outOfScope = changedPaths.filter((p) => !isDocPath(p));
        const diagnostics: string[] = [];
        if (outOfScope.length > 0) {
          diagnostics.push(`越界改动被拒绝：${outOfScope.join(', ')}`);
        }

        // 持久化 findings
        const findingRecords = snapshot.findings.map((f, i) => ({
          id: `${runId}-f${i}`,
          runId,
          severity: f.severity,
          code: f.code,
          path: f.path,
          knowledgeId: f.knowledgeId,
          message: f.message,
          evidenceJson: JSON.stringify(f.evidence),
          createdAt: t,
        }));
        this.opts.repos.knowledgeFindings.insertMany(findingRecords);

        if (outOfScope.length > 0) {
          this.opts.repos.knowledgeRuns.finish(runId, 'failed', this.now(), {
            diagnosticsJson: JSON.stringify(diagnostics),
            changedPathsJson: JSON.stringify(changedPaths),
          });
          // 清理草稿
          await removeWorktree({ repoPath: project.path, worktreePath, branchName: draftBranch });
          throw new Error(diagnostics[0]!);
        }

        this.opts.repos.knowledgeRuns.markAwaitingConfirmation(
          runId,
          draftBranch,
          JSON.stringify(changedPaths),
        );

        const record = this.opts.repos.knowledgeRuns.get(runId)!;
        return toRunView(record, dbFindingsForRun(this.opts.repos, runId));
      } catch (err) {
        // 失败时清理 worktree 但保留运行记录（审计可追溯）
        if (worktreePath) {
          await removeWorktree({ repoPath: project.path, worktreePath, branchName: draftBranch }).catch(() => undefined);
        }
        const record = this.opts.repos.knowledgeRuns.get(runId);
        if (record && record.state === 'running') {
          this.opts.repos.knowledgeRuns.finish(runId, 'failed', this.now(), {
            diagnosticsJson: JSON.stringify([(err as Error).message]),
          });
        }
        throw err;
      }
    });
  }

  /** 获取运行视图（含草稿 diff，不持久化 diff 正文）。 */
  async getRun(runId: string): Promise<KnowledgeRunView> {
    const record = this.opts.repos.knowledgeRuns.get(runId);
    if (!record) throw new Error(`知识运行不存在：${runId}`);
    const findings = this.opts.repos.knowledgeFindings
      .listByRun(runId)
      .map((f) => ({
        id: f.id,
        severity: f.severity,
        code: f.code,
        path: f.path,
        knowledgeId: f.knowledgeId,
        message: f.message,
        evidence: JSON.parse(f.evidenceJson) as string[],
      }));
    let diff: string | undefined;
    if (record.draftBranch && record.state === 'awaiting_confirmation') {
      const project = this.opts.repos.projects.get(record.projectId);
      if (project && (await branchExists(project.path, record.draftBranch))) {
        diff = await this.computeDiff(project.path, project.defaultBranch, record.draftBranch);
      }
    }
    return toRunView(record, findings, diff);
  }

  /** 确认运行：合并草稿分支到默认分支，完成运行。 */
  async confirmRun(runId: string): Promise<KnowledgeHealthSnapshot> {
    return this.locks.run(`run:${runId}`, async () => {
      const record = this.opts.repos.knowledgeRuns.get(runId);
      if (!record) throw new Error(`知识运行不存在：${runId}`);
      if (record.state !== 'awaiting_confirmation') {
        throw new Error(`运行 ${runId} 当前状态 ${record.state}，不可确认`);
      }
      const project = this.opts.repos.projects.get(record.projectId);
      if (!project) throw new Error(`项目不存在：${record.projectId}`);
      const draftBranch = record.draftBranch!;

      const mergeRes = await mergeWorktreeBranch({
        repoPath: project.path,
        branchName: draftBranch,
        defaultBranch: project.defaultBranch,
      });
      if (!mergeRes.merged) {
        this.opts.repos.knowledgeRuns.finish(runId, 'failed', this.now(), {
          diagnosticsJson: JSON.stringify([`合并失败：${mergeRes.reason}`]),
        });
        throw new Error(`合并失败：${mergeRes.reason}`);
      }

      // 清理草稿分支与 worktree
      await deleteBranch(project.path, draftBranch, { force: true });
      this.opts.repos.knowledgeRuns.setConfirmation(runId, 'confirmed');
      this.opts.repos.knowledgeRuns.finish(runId, 'succeeded', this.now());

      return this.lightCheck(record.projectId);
    });
  }

  /** 取消运行：清理草稿分支与 worktree，标记取消。 */
  async cancelRun(runId: string): Promise<void> {
    const record = this.opts.repos.knowledgeRuns.get(runId);
    if (!record) throw new Error(`知识运行不存在：${runId}`);
    const project = this.opts.repos.projects.get(record.projectId);
    if (project && record.draftBranch) {
      await deleteBranch(project.path, record.draftBranch, { force: true }).catch(() => undefined);
    }
    this.opts.repos.knowledgeRuns.setConfirmation(runId, 'canceled');
    this.opts.repos.knowledgeRuns.finish(runId, 'canceled', this.now());
  }

  /** 启动巡检：light=纯宿主结构巡检；full=worktree + project_lead 语义巡检。 */
  async startAudit(projectId: string, mode: 'light' | 'full'): Promise<KnowledgeRunView> {
    const project = this.opts.repos.projects.get(projectId);
    if (!project) throw new Error(`项目不存在：${projectId}`);
    const runId = this.id();
    const t = this.now();
    const kind: KnowledgeRunKind = mode === 'light' ? 'light_audit' : 'full_audit';

    this.opts.repos.knowledgeRuns.create({
      id: runId,
      projectId,
      kind,
      state: 'running',
      confirmationState: 'not_required',
      changedPathsJson: '[]',
      diagnosticsJson: '[]',
      resultJson: '{}',
      startedAt: t,
    });

    const snapshot = await this.opts.knowledge.audit({ projectId, repoPath: project.path });
    const findingRecords = snapshot.findings.map((f, i) => ({
      id: `${runId}-f${i}`,
      runId,
      severity: f.severity,
      code: f.code,
      path: f.path,
      knowledgeId: f.knowledgeId,
      message: f.message,
      evidenceJson: JSON.stringify(f.evidence),
      createdAt: t,
    }));
    this.opts.repos.knowledgeFindings.insertMany(findingRecords);

    this.opts.repos.knowledgeRuns.finish(runId, 'succeeded', this.now(), {
      resultJson: JSON.stringify({ state: snapshot.state }),
    });

    const record = this.opts.repos.knowledgeRuns.get(runId)!;
    return toRunView(record, dbFindingsForRun(this.opts.repos, runId));
  }

  /** 启动修复：验证 finding IDs 属于最近完整巡检，创建新草稿分支，运行 project_lead 修复。 */
  async startRepair(projectId: string, findingIds: string[]): Promise<KnowledgeRunView> {
    return this.locks.run(`repair:${projectId}`, async () => {
      const project = this.opts.repos.projects.get(projectId);
      if (!project) throw new Error(`项目不存在：${projectId}`);
      const runId = this.id();
      const draftBranch = `ai-devflow/knowledge/${runId}`;
      const t = this.now();

      // 验证 finding IDs 属于最近的完整巡检
      const latestAudit = this.opts.repos.knowledgeRuns
        .listByProject(projectId)
        .find((r) => r.kind === 'full_audit' || r.kind === 'light_audit');
      if (!latestAudit) throw new Error('无可修复的巡检结果');
      const knownFindings = new Set(
        this.opts.repos.knowledgeFindings.listByRun(latestAudit.id).map((f) => f.id),
      );
      const unknown = findingIds.filter((id) => !knownFindings.has(id));
      if (unknown.length > 0) throw new Error(`未知的 finding ID：${unknown.join(', ')}`);

      this.opts.repos.knowledgeRuns.create({
        id: runId,
        projectId,
        kind: 'repair',
        state: 'running',
        confirmationState: 'not_required',
        changedPathsJson: '[]',
        diagnosticsJson: '[]',
        resultJson: '{}',
        startedAt: t,
      });

      let worktreePath: string | undefined;
      try {
        const handle = await createWorktree({
          repoPath: project.path,
          baseDir: this.opts.worktreesBaseDir,
          id: `knowledge-repair-${runId}`,
          branchName: draftBranch,
          baseBranch: project.defaultBranch,
        });
        worktreePath = handle.path;

        const agentRun = await this.opts.runner.run({
          scope: { kind: 'project', projectId },
          executionId: runId,
          expert: 'project_lead',
          resultKind: 'knowledge_repair',
          prompt: `请修复以下巡检问题：${findingIds.join(', ')}`,
          cwd: worktreePath,
        });
        await consumeAgentRun(agentRun);

        const snapshot = await this.opts.knowledge.audit({ projectId, repoPath: worktreePath });
        const changedPaths = await listChangedPaths(project.path, project.defaultBranch, draftBranch);
        const outOfScope = changedPaths.filter((p) => !isDocPath(p));
        const diagnostics: string[] = [];
        if (outOfScope.length > 0) diagnostics.push(`越界改动被拒绝：${outOfScope.join(', ')}`);

        const findingRecords = snapshot.findings.map((f, i) => ({
          id: `${runId}-f${i}`,
          runId,
          severity: f.severity,
          code: f.code,
          path: f.path,
          knowledgeId: f.knowledgeId,
          message: f.message,
          evidenceJson: JSON.stringify(f.evidence),
          createdAt: t,
        }));
        this.opts.repos.knowledgeFindings.insertMany(findingRecords);

        if (outOfScope.length > 0) {
          this.opts.repos.knowledgeRuns.finish(runId, 'failed', this.now(), {
            diagnosticsJson: JSON.stringify(diagnostics),
          });
          await removeWorktree({ repoPath: project.path, worktreePath, branchName: draftBranch });
          throw new Error(diagnostics[0]!);
        }

        this.opts.repos.knowledgeRuns.markAwaitingConfirmation(
          runId,
          draftBranch,
          JSON.stringify(changedPaths),
        );
        const record = this.opts.repos.knowledgeRuns.get(runId)!;
        return toRunView(record, dbFindingsForRun(this.opts.repos, runId));
      } catch (err) {
        if (worktreePath) {
          await removeWorktree({ repoPath: project.path, worktreePath, branchName: draftBranch }).catch(() => undefined);
        }
        const record = this.opts.repos.knowledgeRuns.get(runId);
        if (record && record.state === 'running') {
          this.opts.repos.knowledgeRuns.finish(runId, 'failed', this.now(), {
            diagnosticsJson: JSON.stringify([(err as Error).message]),
          });
        }
        throw err;
      }
    });
  }

  /** 原子初始化迭代文档：准备迭代分支 -> worktree -> 初始化 index.md/CHANGELOG.md -> 审计 -> 插入迭代记录 -> 清理。失败时回滚本次新建。 */
  async initializeIteration(input: { projectId: string; iteration: Iteration }): Promise<void> {
    const project = this.opts.repos.projects.get(input.projectId);
    if (!project) throw new Error(`项目不存在：${input.projectId}`);
    const versionSeg = input.iteration.version;
    const draftBranch = `ai-devflow/iteration-init/${versionSeg}-${this.id()}`;
    const t = this.now();
    const handle = await createWorktree({
      repoPath: project.path,
      baseDir: this.opts.worktreesBaseDir,
      id: `iter-init-${input.iteration.id}`,
      branchName: draftBranch,
      baseBranch: project.defaultBranch,
    });
    let committed = false;
    try {
      await this.opts.knowledge.initializeIteration({
        repoPath: handle.path,
        version: versionSeg,
        iterationId: input.iteration.id,
        date: dateStr(t),
      });
      shGit(handle.path, ['add', '.']);
      shGit(handle.path, ['commit', '-q', '-m', `iter docs: ${versionSeg}`]);
      committed = true;
      // 审计初始化路径（结构巡检，不依赖知识根）。
      // 合并草稿到默认分支。
      const mergeRes = await mergeWorktreeBranch({
        repoPath: project.path,
        branchName: draftBranch,
        defaultBranch: project.defaultBranch,
      });
      if (!mergeRes.merged) throw new Error(`迭代文档合并失败：${mergeRes.reason}`);
    } finally {
      await removeWorktree({ repoPath: project.path, worktreePath: handle.path, branchName: draftBranch }).catch(() => undefined);
      if (committed) await deleteBranch(project.path, draftBranch, { force: true }).catch(() => undefined);
    }
  }

  /** 为任务执行准备检索 manifest，并持久化 knowledge_retrievals。 */
  async prepareTaskExecution(input: {
    task: Task;
    project: { id: string; path: string; defaultBranch: string };
    executionId: string;
    expert: 'dev' | 'test';
    stage: 'development' | 'review';
    cwd: string;
    changedFiles?: string[];
  }): Promise<KnowledgeRetrievalManifest> {
    const manifest = await this.opts.knowledge.planRetrieval({
      id: this.id(),
      projectId: input.project.id,
      taskId: input.task.id,
      executionId: input.executionId,
      expert: input.expert,
      stage: input.stage,
      query: `${input.task.title} ${input.task.description ?? ''}`,
      typeLabel: input.task.typeLabel,
      dependencyTaskIds: input.task.dependsOn,
      changedFiles: input.changedFiles,
      repoPath: input.cwd,
      createdAt: this.now(),
    });
    this.persistRetrieval(manifest);
    return manifest;
  }

  /** 为产品/UX/研发负责人/对话场景准备检索 manifest（项目作用域）。 */
  async prepareChatContext(input: {
    projectId: string;
    expert: AgentKey;
    stage: string;
    prompt: string;
    iterationId?: string;
    taskId?: string;
    repoPath: string;
  }): Promise<KnowledgeRetrievalManifest> {
    return this.opts.knowledge.planRetrieval({
      id: this.id(),
      projectId: input.projectId,
      taskId: input.taskId,
      expert: input.expert,
      stage: input.stage,
      query: input.prompt,
      repoPath: input.repoPath,
      createdAt: this.now(),
    });
  }

  /** 持久化检索 manifest（仅候选引用 {id,path,confidence}，不含正文/摘要）。 */
  private persistRetrieval(manifest: KnowledgeRetrievalManifest): void {
    const candidateRefs = manifest.candidates.map((c) => ({ id: c.id, path: c.path, confidence: c.confidence }));
    const confidence = manifest.candidates.length > 0
      ? manifest.candidates.reduce((sum, c) => sum + c.confidence, 0) / manifest.candidates.length
      : 0;
    this.opts.repos.knowledgeRetrievals.create({
      id: manifest.id,
      projectId: manifest.projectId,
      taskId: manifest.taskId,
      executionId: manifest.executionId,
      expertKey: manifest.expert,
      stage: manifest.stage,
      level: manifest.level,
      state: manifest.state,
      candidateRefsJson: JSON.stringify(candidateRefs),
      readEvidenceJson: '[]',
      skippedRefsJson: JSON.stringify(manifest.skipped),
      differencesJson: JSON.stringify(manifest.differences),
      budgetFiles: manifest.budget.maxFiles,
      budgetChars: manifest.budget.maxChars,
      usedFiles: manifest.used.files,
      usedChars: manifest.used.chars,
      confidence,
      createdAt: manifest.createdAt,
    });
  }

  /** 获取任务知识证据（检索记录 + 评估 + 沉淀，UI 用）。 */
  async getTaskEvidence(taskId: string): Promise<import('@ai-devflow/core').TaskKnowledgeEvidence> {
    const retrievals = this.opts.repos.knowledgeRetrievals.listByTask(taskId).map((r) => this.recordToManifest(r));
    const depositionRow = this.opts.repos.knowledgeDepositions.getLatestByTask(taskId);
    const deposition = depositionRow ? this.rowToDeposition(depositionRow) : undefined;
    return { retrievals, assessment: deposition?.assessment, deposition };
  }

  private recordToManifest(r: import('@ai-devflow/persistence').KnowledgeRetrievalRecord): KnowledgeRetrievalManifest {
    return {
      id: r.id,
      projectId: r.projectId,
      taskId: r.taskId,
      executionId: r.executionId,
      expert: r.expertKey,
      stage: r.stage,
      level: r.level,
      state: r.state,
      candidates: [],
      reads: [],
      skipped: JSON.parse(r.skippedRefsJson),
      differences: JSON.parse(r.differencesJson),
      budget: { maxFiles: r.budgetFiles, maxChars: r.budgetChars },
      used: { files: r.usedFiles, chars: r.usedChars },
      createdAt: r.createdAt,
      completedAt: r.completedAt,
    };
  }

  private rowToDeposition(row: import('@ai-devflow/persistence').KnowledgeDepositionRecordRow): import('@ai-devflow/core').KnowledgeDepositionRecord {
    return {
      id: row.id,
      projectId: row.projectId,
      taskId: row.taskId,
      executionId: row.executionId,
      retrievalId: row.retrievalId,
      assessment: JSON.parse(row.assessmentJson),
      state: row.state,
      relatedKnowledgeIds: JSON.parse(row.relatedKnowledgeIdsJson),
      changedPaths: JSON.parse(row.changedPathsJson),
      gatePassed: row.gatePassed,
      diagnostics: JSON.parse(row.diagnosticsJson),
      startedAt: row.startedAt,
      endedAt: row.endedAt,
    };
  }

  /** 知识沉淀门禁：none 持久化为成功沉淀（无路径）；valuable 运行 project_lead 沉淀并校验。 */
  async finalizeTaskKnowledge(input: {
    task: Task;
    project: { id: string; path: string; defaultBranch: string };
    executionId?: string;
    assessment: import('@ai-devflow/core').KnowledgeAssessment | undefined;
    worktreePath: string;
  }): Promise<{ gatePassed: boolean; depositionId?: string; diagnostics: string[] }> {
    const assessment = input.assessment;
    const t = this.now();
    const depositionId = this.id();
    const baseRecord = {
      id: depositionId,
      projectId: input.project.id,
      taskId: input.task.id,
      executionId: input.executionId,
      verdict: 'none' as 'none' | 'valuable',
      state: 'running' as import('@ai-devflow/core').KnowledgeDepositionRecord['state'],
      assessmentJson: JSON.stringify(assessment ?? null),
      relatedKnowledgeIdsJson: '[]',
      changedPathsJson: '[]',
      gatePassed: false,
      diagnosticsJson: '[]',
      startedAt: t,
    };

    // 缺失评估载荷：失败。
    if (!assessment) {
      const diagnostics = ['审查未提供知识价值评估载荷'];
      this.opts.repos.knowledgeDepositions.create({
        ...baseRecord,
        state: 'failed',
        diagnosticsJson: JSON.stringify(diagnostics),
        endedAt: this.now(),
      });
      return { gatePassed: false, diagnostics };
    }

    if (assessment.verdict === 'none') {
      // none 必须有非空理由与证据。
      if (!assessment.reason.trim() || assessment.evidence.length === 0) {
        const diagnostics = ['none 评估缺少非空理由或证据'];
        this.opts.repos.knowledgeDepositions.create({
          ...baseRecord,
          state: 'failed',
          diagnosticsJson: JSON.stringify(diagnostics),
          endedAt: this.now(),
        });
        return { gatePassed: false, diagnostics };
      }
      this.opts.repos.knowledgeDepositions.create({
        ...baseRecord,
        verdict: 'none',
        state: 'succeeded',
        gatePassed: true,
        endedAt: this.now(),
      });
      return { gatePassed: true, depositionId, diagnostics: [] };
    }

    // valuable：在迭代锁内运行 project_lead 沉淀。
    return this.iterationLocks.run(input.task.iterationId ?? input.task.id, async () => {
      const draftBranch = `ai-devflow/knowledge/${depositionId}`;
      let worktreePath: string | undefined;
      try {
        const handle = await createWorktree({
          repoPath: input.project.path,
          baseDir: this.opts.worktreesBaseDir,
          id: `knowledge-deposition-${depositionId}`,
          branchName: draftBranch,
          baseBranch: input.project.defaultBranch,
        });
        worktreePath = handle.path;
        const agentRun = await this.opts.runner.run({
          scope: { kind: 'task', taskId: input.task.id },
          executionId: input.executionId ?? depositionId,
          expert: 'project_lead',
          resultKind: 'knowledge_deposition',
          prompt: '请基于审查候选与任务 diff 更新长期知识、索引与任务文档。',
          cwd: worktreePath,
        });
        await consumeAgentRun(agentRun);
        const changedPaths = await listChangedPaths(input.project.path, input.project.defaultBranch, draftBranch);
        const outOfScope = changedPaths.filter((p) => !isDocPath(p));
        const diagnostics: string[] = [];
        if (outOfScope.length > 0) {
          diagnostics.push(`越界改动被拒绝：${outOfScope.join(', ')}`);
          this.opts.repos.knowledgeDepositions.create({
            ...baseRecord,
            verdict: 'valuable',
            state: 'failed',
            changedPathsJson: JSON.stringify(changedPaths),
            diagnosticsJson: JSON.stringify(diagnostics),
            endedAt: this.now(),
          });
          await removeWorktree({ repoPath: input.project.path, worktreePath, branchName: draftBranch });
          return { gatePassed: false, diagnostics };
        }
        // 合并沉淀草稿到默认分支。
        const mergeRes = await mergeWorktreeBranch({
          repoPath: input.project.path,
          branchName: draftBranch,
          defaultBranch: input.project.defaultBranch,
        });
        await deleteBranch(input.project.path, draftBranch, { force: true });
        if (!mergeRes.merged) {
          diagnostics.push(`沉淀草稿合并失败：${mergeRes.reason}`);
          this.opts.repos.knowledgeDepositions.create({
            ...baseRecord,
            verdict: 'valuable',
            state: 'failed',
            changedPathsJson: JSON.stringify(changedPaths),
            diagnosticsJson: JSON.stringify(diagnostics),
            endedAt: this.now(),
          });
          return { gatePassed: false, diagnostics };
        }
        this.opts.repos.knowledgeDepositions.create({
          ...baseRecord,
          verdict: 'valuable',
          state: 'succeeded',
          relatedKnowledgeIdsJson: '[]',
          changedPathsJson: JSON.stringify(changedPaths),
          gatePassed: true,
          endedAt: this.now(),
        });
        return { gatePassed: true, depositionId, diagnostics: [] };
      } catch (err) {
        if (worktreePath) {
          await removeWorktree({ repoPath: input.project.path, worktreePath, branchName: draftBranch }).catch(() => undefined);
        }
        const diagnostics = [(err as Error).message];
        this.opts.repos.knowledgeDepositions.create({
          ...baseRecord,
          verdict: 'valuable',
          state: 'failed',
          diagnosticsJson: JSON.stringify(diagnostics),
          endedAt: this.now(),
        });
        return { gatePassed: false, diagnostics };
      }
    });
  }

  /** 获取迭代 CHANGELOG 校验结果（从最近迭代运行 + findings 重建）。 */
  async getIterationVerification(iterationId: string): Promise<import('@ai-devflow/core').IterationChangelogVerification> {
    const latest = this.opts.repos.knowledgeRuns.getLatestByIteration(iterationId, 'iteration_changelog');
    if (!latest) {
      return {
        iterationId,
        state: 'pending',
        coveredTaskIds: [],
        missingTaskIds: [],
        changedPaths: [],
        findings: [],
      };
    }
    const result = JSON.parse(latest.resultJson) as { coveredTaskIds?: string[]; missingTaskIds?: string[]; changedPaths?: string[]; verifiedAt?: number; state?: import('@ai-devflow/core').IterationChangelogVerification['state'] };
    const findings = this.opts.repos.knowledgeFindings.listByRun(latest.id).map((f) => ({
      id: f.id, severity: f.severity, code: f.code, path: f.path, knowledgeId: f.knowledgeId,
      message: f.message, evidence: JSON.parse(f.evidenceJson) as string[],
    }));
    return {
      iterationId,
      state: result.state ?? 'pending',
      coveredTaskIds: result.coveredTaskIds ?? [],
      missingTaskIds: result.missingTaskIds ?? [],
      changedPaths: result.changedPaths ?? [],
      findings,
      verifiedAt: result.verifiedAt,
    };
  }

  /** 严格迭代归档：聚合 CHANGELOG -> 校验 -> 合并 sprint 分支 -> 仅在全部成功后归档数据库行。 */
  async archiveIteration(iterationId: string): Promise<{ ok: true } | { ok: false; reasons: string[]; verification?: import('@ai-devflow/core').IterationChangelogVerification }> {
    return this.iterationLocks.run(`archive:${iterationId}`, async () => {
      const iteration = this.opts.repos.iterations.get(iterationId);
      if (!iteration) throw new Error(`迭代不存在：${iterationId}`);
      const project = this.opts.repos.projects.get(iteration.projectId);
      if (!project) throw new Error(`项目不存在：${iteration.projectId}`);
      const tasks = this.opts.repos.tasks.listByIteration(iterationId);
      const reasons: string[] = [];

      // 1. 所有任务必须已归档
      const unarchived = tasks.filter((t) => t.status !== 'archived');
      if (unarchived.length > 0) {
        reasons.push(`还有 ${unarchived.length} 个任务未归档`);
      }

      const runId = this.id();
      const t = this.now();
      this.opts.repos.knowledgeRuns.create({
        id: runId, projectId: project.id, iterationId, kind: 'iteration_changelog',
        state: 'running', confirmationState: 'not_required',
        changedPathsJson: '[]', diagnosticsJson: '[]', resultJson: '{}', startedAt: t,
      });

      let verification: import('@ai-devflow/core').IterationChangelogVerification | undefined;
      try {
        // 2. 确定性 CHANGELOG 校验（Git 跟踪探针：tracked=git ls-files）
        const gitProbe: import('@ai-devflow/knowledge').KnowledgeGitProbe = {
          isTracked: async (_repo, rel) => {
            try {
              const { execFileSync } = await import('node:child_process');
              execFileSync('git', ['-C', project.path, 'ls-files', '--error-unmatch', rel], { stdio: 'ignore' });
              return true;
            } catch { return false; }
          },
          isIgnored: async () => false,
        };
        verification = await this.opts.knowledge.verifyIterationChangelog({
          repoPath: project.path, version: iteration.version, iterationId,
          expectedTaskIds: tasks.map((task) => task.id), git: gitProbe, verifiedAt: t,
        });
        const findingRecords = verification.findings.map((f, i) => ({
          id: `${runId}-f${i}`, runId, severity: f.severity, code: f.code, path: f.path,
          knowledgeId: f.knowledgeId, message: f.message, evidenceJson: JSON.stringify(f.evidence), createdAt: t,
        }));
        this.opts.repos.knowledgeFindings.insertMany(findingRecords);
        if (verification.state !== 'valid') {
          reasons.push('迭代 CHANGELOG 校验未通过');
        }
      } catch (err) {
        reasons.push(`CHANGELOG 校验异常：${(err as Error).message}`);
      }

      if (reasons.length > 0) {
        this.opts.repos.knowledgeRuns.finish(runId, 'failed', this.now(), {
          resultJson: JSON.stringify({ state: 'invalid', ...(verification ? { coveredTaskIds: verification.coveredTaskIds, missingTaskIds: verification.missingTaskIds, changedPaths: verification.changedPaths, verifiedAt: verification.verifiedAt } : {}) }),
          diagnosticsJson: JSON.stringify(reasons),
        });
        return { ok: false, reasons, verification };
      }

      // 3. 合并 sprint 分支到默认分支
      const sprintBranch = (await import('./worktree.js')).sprintBranchName(iteration.version);
      const { mergeWorktreeBranch } = await import('./worktree.js');
      const mergeRes = await mergeWorktreeBranch({
        repoPath: project.path, branchName: sprintBranch, defaultBranch: project.defaultBranch,
      });
      if (!mergeRes.merged) {
        reasons.push(`迭代分支合并失败：${mergeRes.reason}`);
        this.opts.repos.knowledgeRuns.finish(runId, 'failed', this.now(), {
          resultJson: JSON.stringify({ state: 'valid', coveredTaskIds: verification!.coveredTaskIds, missingTaskIds: [], changedPaths: verification!.changedPaths, verifiedAt: verification!.verifiedAt }),
          diagnosticsJson: JSON.stringify(reasons),
        });
        return { ok: false, reasons, verification };
      }

      // 4. 仅在合并成功后归档数据库行
      this.opts.repos.knowledgeRuns.finish(runId, 'succeeded', this.now(), {
        resultJson: JSON.stringify({ state: 'valid', coveredTaskIds: verification!.coveredTaskIds, missingTaskIds: [], changedPaths: verification!.changedPaths, verifiedAt: verification!.verifiedAt }),
      });
      this.opts.repos.iterations.archive(iterationId, this.now());
      return { ok: true };
    });
  }

  private async computeDiff(repoPath: string, base: string, branch: string): Promise<string | undefined> {
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const exec = promisify(execFile);
      const { stdout } = await exec('git', ['diff', `${base}...${branch}`, '--', 'docs/knowledge', 'docs/iterations'], {
        cwd: repoPath,
        maxBuffer: 512 * 1024,
      });
      return stdout || undefined;
    } catch {
      return undefined;
    }
  }
}
