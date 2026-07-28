// 项目知识协调器（设计 §7.1/§7.4）：编排知识初始化、巡检、修复、确认与取消。
//
// 项目级操作使用专用临时 worktree/分支，避免污染用户可能脏的默认工作区。Git 操作始终由宿主执行。
// 知识正文唯一事实源为仓库 Markdown；SQLite 只保存运行状态与审计引用。
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import type {
  KnowledgeAgentPayload,
  KnowledgeFinding,
  KnowledgeHealthSnapshot,
  IterationChangelogVerification,
  KnowledgeReadEvidence,
  KnowledgeRunKind,
  KnowledgeRunView,
} from '@ai-devflow/core';
import { now as defaultNow, randomId as defaultId } from '@ai-devflow/core';
import type { AgentRunner } from '@ai-devflow/agents';
import { sanitizePathSegment, type ProjectKnowledgeService } from '@ai-devflow/knowledge';
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
  mergeBranchInto,
  mergeWorktreeBranch,
  branchExists,
  compareAndSwapBranchRef,
  ensureSprintBranch,
  requireCanonicalBranchSegment,
  sprintBranchName,
} from './worktree.js';

export interface KnowledgeCoordinatorOptions {
  repos: Repositories;
  runner: AgentRunner;
  knowledge: ProjectKnowledgeService;
  worktreesBaseDir: string;
  now?: () => number;
  id?: () => string;
  removeWorktree?: typeof removeWorktree;
  mergeBranchInto?: typeof mergeBranchInto;
  mergeWorktreeBranch?: typeof mergeWorktreeBranch;
}

const DOC_ROOTS = ['docs/knowledge', 'docs/iterations'];

interface IterationArchiveProgress {
  state: 'valid';
  phase: 'validated' | 'awaiting_default_merge' | 'completed';
  aggregation?: Extract<KnowledgeAgentPayload, { kind: 'iteration_changelog' }>;
  coveredTaskIds: string[];
  missingTaskIds: string[];
  changedPaths: string[];
  verifiedAt?: number;
  sprintBaseCommit?: string;
  draftCommit?: string;
  sprintCommit?: string;
}

interface DepositionProgress {
  phase: 'validated' | 'integrated';
  targetBranch: string;
  taskCommit: string;
  draftCommit: string;
  integrationCommit?: string;
}

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

function gitOutput(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function gitIsAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function parseArchiveProgress(resultJson: string): IterationArchiveProgress | undefined {
  try {
    const value = JSON.parse(resultJson) as Partial<IterationArchiveProgress>;
    if (
      value.state === 'valid' &&
      (value.phase === 'validated' || value.phase === 'awaiting_default_merge' || value.phase === 'completed') &&
      Array.isArray(value.coveredTaskIds) &&
      Array.isArray(value.missingTaskIds) &&
      Array.isArray(value.changedPaths)
    ) {
      return value as IterationArchiveProgress;
    }
  } catch {
    // 非归档进度载荷不参与恢复。
  }
  return undefined;
}

function parseDepositionProgress(progressJson: string | undefined): DepositionProgress | undefined {
  try {
    const value = JSON.parse(progressJson ?? '{}') as Partial<DepositionProgress>;
    if (
      (value.phase === 'validated' || value.phase === 'integrated') &&
      typeof value.targetBranch === 'string' &&
      typeof value.taskCommit === 'string' &&
      typeof value.draftCommit === 'string' &&
      (value.integrationCommit === undefined || typeof value.integrationCommit === 'string')
    ) {
      return value as DepositionProgress;
    }
  } catch {
    // 无效或旧版进度不能作为 Git 已集成证据。
  }
  return undefined;
}

function splitNul(output: string): string[] {
  return output.split('\0').map((item) => item.trim()).filter(Boolean);
}

function isManagedNodeModulesLink(cwd: string, projectPath: string, relativePath: string): boolean {
  if (relativePath !== 'node_modules') return false;
  const worktreeDependencies = joinPath(cwd, relativePath);
  try {
    return lstatSync(worktreeDependencies).isSymbolicLink()
      && realpathSync(worktreeDependencies) === realpathSync(joinPath(projectPath, 'node_modules'));
  } catch {
    return false;
  }
}

/** Agent 只负责写文件；宿主在提交前读取完整工作区变化并执行路径门禁。 */
function workingTreeChangedPaths(cwd: string, projectPath: string): string[] {
  const paths = new Set<string>();
  for (const probe of [
    { args: ['diff', '--name-only', '-z'], allowManagedDependencies: false },
    { args: ['diff', '--cached', '--name-only', '-z'], allowManagedDependencies: false },
    { args: ['ls-files', '--others', '--exclude-standard', '-z'], allowManagedDependencies: true },
  ]) {
    for (const path of splitNul(gitOutput(cwd, probe.args))) {
      if (!probe.allowManagedDependencies || !isManagedNodeModulesLink(cwd, projectPath, path)) {
        paths.add(path);
      }
    }
  }
  return [...paths].sort();
}

function commitKnowledgeDraft(cwd: string, projectPath: string, message: string): string[] {
  const changedPaths = workingTreeChangedPaths(cwd, projectPath);
  const outOfScope = changedPaths.filter((path) => !isDocPath(path));
  if (outOfScope.length > 0) {
    throw new Error(`越界改动被拒绝：${outOfScope.join(', ')}`);
  }
  if (changedPaths.length === 0) return [];
  shGit(cwd, ['add', '-A', '--', ...changedPaths]);
  shGit(cwd, ['commit', '-q', '-m', message]);
  return changedPaths;
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

  /** 同一迭代的沉淀、任务合并与归档必须共享一个串行边界。 */
  async withIterationLock<T>(iterationId: string, action: () => Promise<T>): Promise<T> {
    return this.iterationLocks.run(iterationId, action);
  }

  private async cleanupWorktree(input: Parameters<typeof removeWorktree>[0]): Promise<void> {
    await (this.opts.removeWorktree ?? removeWorktree)(input);
  }

  /** 只读轻检：在项目路径执行结构巡检，不创建运行记录。 */
  async lightCheck(projectId: string): Promise<KnowledgeHealthSnapshot> {
    const project = this.opts.repos.projects.get(projectId);
    if (!project) throw new Error(`项目不存在：${projectId}`);
    return this.opts.knowledge.audit({ projectId, repoPath: project.path, git: this.gitProbe() });
  }

  /** 启动恢复：中断的写运行不可基于过期快照续跑，标记失败并清理草稿；待用户初始化的沉淀原样保留。 */
  async recoverInterrupted(): Promise<{ failedRuns: string[]; failedDepositions: string[] }> {
    const failedRuns: string[] = [];
    const failedDepositions: string[] = [];

    for (const iteration of this.opts.repos.iterations.listInitializing()) {
      const project = this.opts.repos.projects.get(iteration.projectId);
      if (!project) continue;
      const versionSeg = requireCanonicalBranchSegment(iteration.version);
      await this.withIterationLock(`create:${iteration.projectId}:${versionSeg}`, async () => {
        await this.completeClaimedIteration(project, iteration, true);
      }).catch(() => undefined);
    }

    for (const project of this.opts.repos.projects.list()) {
      const projectRuns = this.opts.repos.knowledgeRuns.listByProject(project.id);
      const interrupted = projectRuns.filter((record) => record.state === 'running');
      for (const record of interrupted) {
        const diagnostics = this.parseStringArray(record.diagnosticsJson);
        diagnostics.push('应用重启，知识运行已中断');
        const archiveProgress = record.kind === 'iteration_changelog'
          ? parseArchiveProgress(record.resultJson)
          : undefined;
        const draftBranch = record.kind === 'full_audit'
          ? `ai-devflow/knowledge/audit-${record.id}`
          : `ai-devflow/knowledge/${record.id}`;
        const worktreeId = record.kind === 'repair'
          ? `knowledge-repair-${record.id}`
          : record.kind === 'full_audit'
            ? `knowledge-audit-${record.id}`
            : record.kind === 'iteration_changelog'
              ? `knowledge-changelog-${record.id}`
              : `knowledge-${record.id}`;
        if (record.kind !== 'light_audit') {
          await this.cleanupWorktree({
            repoPath: project.path,
            worktreePath: joinPath(this.opts.worktreesBaseDir, worktreeId),
            branchName: draftBranch,
            keepBranch: archiveProgress?.phase === 'validated',
          }).catch(() => undefined);
        }
        this.opts.repos.knowledgeRuns.finish(record.id, 'failed', this.now(), {
          diagnosticsJson: JSON.stringify(diagnostics),
        });
        failedRuns.push(record.id);
      }

      for (const record of projectRuns) {
        if (!['succeeded', 'failed', 'canceled'].includes(record.state) || record.kind === 'light_audit') continue;
        const archiveProgress = record.kind === 'iteration_changelog'
          ? parseArchiveProgress(record.resultJson)
          : undefined;
        if (archiveProgress?.phase === 'validated') continue;
        const draftBranch = record.kind === 'full_audit'
          ? `ai-devflow/knowledge/audit-${record.id}`
          : `ai-devflow/knowledge/${record.id}`;
        const worktreeId = record.kind === 'repair'
          ? `knowledge-repair-${record.id}`
          : record.kind === 'full_audit'
            ? `knowledge-audit-${record.id}`
            : record.kind === 'iteration_changelog'
              ? `knowledge-changelog-${record.id}`
              : `knowledge-${record.id}`;
        await this.cleanupWorktree({
          repoPath: project.path,
          worktreePath: joinPath(this.opts.worktreesBaseDir, worktreeId),
          branchName: draftBranch,
        }).catch(() => undefined);
      }
    }

    for (const project of this.opts.repos.projects.list()) {
      for (const task of this.opts.repos.tasks.listByProject(project.id)) {
        for (const record of this.opts.repos.knowledgeDepositions.listByTask(task.id)) {
          if (record.state === 'running' && this.reconcileIntegratedDeposition(record, project.path)) {
            await this.cleanupWorktree({
              repoPath: project.path,
              worktreePath: joinPath(this.opts.worktreesBaseDir, `knowledge-deposition-${record.id}`),
              branchName: `ai-devflow/knowledge/${record.id}`,
            }).catch(() => undefined);
            continue;
          }
          let cleanupError: string | undefined;
          try {
            await this.cleanupWorktree({
              repoPath: project.path,
              worktreePath: joinPath(this.opts.worktreesBaseDir, `knowledge-deposition-${record.id}`),
              branchName: `ai-devflow/knowledge/${record.id}`,
            });
          } catch (error) {
            cleanupError = `启动清理沉淀残留失败：${(error as Error).message}`;
          }
          const diagnostics = this.parseStringArray(record.diagnosticsJson);
          if (cleanupError) diagnostics.push(cleanupError);
          if (record.state !== 'running') {
            if (cleanupError) {
              this.opts.repos.knowledgeDepositions.finish(record.id, {
                state: record.state,
                relatedKnowledgeIdsJson: record.relatedKnowledgeIdsJson,
                changedPathsJson: record.changedPathsJson,
                gatePassed: record.gatePassed,
                diagnosticsJson: JSON.stringify(diagnostics),
                endedAt: record.endedAt ?? this.now(),
              });
            }
            continue;
          }
          diagnostics.push('应用重启，知识沉淀已中断；Git 未包含已验证草稿，需重新执行沉淀');
          this.opts.repos.knowledgeDepositions.finish(record.id, {
            state: 'failed',
            relatedKnowledgeIdsJson: record.relatedKnowledgeIdsJson,
            changedPathsJson: record.changedPathsJson,
            gatePassed: false,
            diagnosticsJson: JSON.stringify(diagnostics),
            endedAt: this.now(),
          });
          failedDepositions.push(record.id);
        }
      }
    }

    for (const retrieval of this.opts.repos.knowledgeRetrievals.listByState('planned')) {
      const differences = JSON.parse(retrieval.differencesJson) as KnowledgeFinding[];
      differences.push({
        id: `retrieval-interrupted:${retrieval.id}`,
        severity: 'error',
        code: 'retrieval_interrupted',
        message: '应用重启，知识检索在完成证据写入前中断',
        evidence: [retrieval.executionId ?? retrieval.taskId ?? retrieval.projectId],
      });
      this.opts.repos.knowledgeRetrievals.complete(retrieval.id, {
        state: 'failed',
        readEvidenceJson: retrieval.readEvidenceJson,
        skippedRefsJson: retrieval.skippedRefsJson,
        differencesJson: JSON.stringify(differences),
        usedFiles: retrieval.usedFiles,
        usedChars: retrieval.usedChars,
        confidence: retrieval.confidence,
        completedAt: this.now(),
      });
    }

    return { failedRuns: failedRuns.sort(), failedDepositions: failedDepositions.sort() };
  }

  private parseStringArray(value: string): string[] {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      return [];
    }
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

        // Git 由宿主完成：先检查完整工作区范围，再提交草稿分支。
        commitKnowledgeDraft(worktreePath, project.path, `knowledge: initialize ${runId}`);
        const changedPaths = await listChangedPaths(project.path, project.defaultBranch, draftBranch);
        const snapshot = await this.opts.knowledge.audit({ projectId, repoPath: worktreePath, git: this.gitProbe() });

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
          await this.cleanupWorktree({ repoPath: project.path, worktreePath, branchName: draftBranch }).catch(() => undefined);
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
      const worktreePath = this.pendingWorktreePath(record);

      const preflight = await this.opts.knowledge.audit({
        projectId: record.projectId,
        repoPath: worktreePath,
        git: this.gitProbe(),
      });
      const blockers = preflight.findings.filter((finding) => finding.severity === 'error');
      if (blockers.length > 0) {
        const diagnostics = blockers.map((finding) => `草稿校验阻断：${finding.message}`);
        this.opts.repos.knowledgeRuns.finish(runId, 'failed', this.now(), {
          diagnosticsJson: JSON.stringify(diagnostics),
        });
        await this.cleanupWorktree({ repoPath: project.path, worktreePath, branchName: draftBranch }).catch(() => undefined);
        throw new Error(diagnostics.join('; '));
      }

      const mergeRes = await mergeWorktreeBranch({
        repoPath: project.path,
        branchName: draftBranch,
        defaultBranch: project.defaultBranch,
      });
      if (!mergeRes.merged) {
        this.opts.repos.knowledgeRuns.finish(runId, 'failed', this.now(), {
          diagnosticsJson: JSON.stringify([`合并失败：${mergeRes.reason}`]),
        });
        await this.cleanupWorktree({ repoPath: project.path, worktreePath, branchName: draftBranch }).catch(() => undefined);
        throw new Error(`合并失败：${mergeRes.reason}`);
      }

      this.opts.repos.knowledgeRuns.setConfirmation(runId, 'confirmed');
      const endedAt = this.now();
      this.opts.repos.knowledgeRuns.finish(runId, 'succeeded', endedAt);
      try {
        await this.cleanupWorktree({ repoPath: project.path, worktreePath, branchName: draftBranch });
      } catch (err) {
        const diagnostics = this.parseStringArray(record.diagnosticsJson);
        diagnostics.push(`合并已成功，但草稿清理失败：${(err as Error).message}`);
        this.opts.repos.knowledgeRuns.finish(runId, 'succeeded', endedAt, {
          diagnosticsJson: JSON.stringify(diagnostics),
        });
      }

      return this.lightCheck(record.projectId);
    });
  }

  /** 取消运行：清理草稿分支与 worktree，标记取消。 */
  async cancelRun(runId: string): Promise<void> {
    const record = this.opts.repos.knowledgeRuns.get(runId);
    if (!record) throw new Error(`知识运行不存在：${runId}`);
    if (record.state === 'canceled') return;
    if (record.state !== 'awaiting_confirmation') {
      throw new Error(`知识运行状态为 ${record.state}，不能取消`);
    }
    const project = this.opts.repos.projects.get(record.projectId);
    if (project && record.draftBranch) {
      await this.cleanupWorktree({
        repoPath: project.path,
        worktreePath: this.pendingWorktreePath(record),
        branchName: record.draftBranch,
      }).catch(() => undefined);
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

    let worktreePath: string | undefined;
    const auditBranch = `ai-devflow/knowledge/audit-${runId}`;
    try {
      const snapshot = await this.opts.knowledge.audit({ projectId, repoPath: project.path, git: this.gitProbe() });
      const findings = [...snapshot.findings];
      if (mode === 'full') {
        const handle = await createWorktree({
          repoPath: project.path,
          baseDir: this.opts.worktreesBaseDir,
          id: `knowledge-audit-${runId}`,
          branchName: auditBranch,
          baseBranch: project.defaultBranch,
        });
        worktreePath = handle.path;
        const result = await consumeAgentRun(await this.opts.runner.run({
          scope: { kind: 'project', projectId },
          executionId: runId,
          expert: 'project_lead',
          resultKind: 'knowledge_audit',
          prompt: '请只读巡检项目知识，报告可能过期、冲突、重复或缺失的语义问题，不修改文件。',
          cwd: worktreePath,
        }));
        if (result.payload?.kind !== 'knowledge_audit') {
          throw new Error('完整巡检缺少 knowledge_audit 结构化载荷');
        }
        const mutations = workingTreeChangedPaths(worktreePath, project.path);
        if (mutations.length > 0) {
          throw new Error(`完整巡检必须只读，检测到改动：${mutations.join(', ')}`);
        }
        findings.push(...result.payload.findings);
      }
      const findingRecords = findings.map((f, i) => ({
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
    } catch (err) {
      this.opts.repos.knowledgeRuns.finish(runId, 'failed', this.now(), {
        diagnosticsJson: JSON.stringify([(err as Error).message]),
      });
      throw err;
    } finally {
      if (worktreePath) {
        await this.cleanupWorktree({ repoPath: project.path, worktreePath, branchName: auditBranch }).catch(() => undefined);
      }
    }
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

        commitKnowledgeDraft(worktreePath, project.path, `knowledge: repair ${runId}`);
        const snapshot = await this.opts.knowledge.audit({ projectId, repoPath: worktreePath, git: this.gitProbe() });
        const changedPaths = await listChangedPaths(project.path, project.defaultBranch, draftBranch);

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

        this.opts.repos.knowledgeRuns.markAwaitingConfirmation(
          runId,
          draftBranch,
          JSON.stringify(changedPaths),
        );
        const record = this.opts.repos.knowledgeRuns.get(runId)!;
        return toRunView(record, dbFindingsForRun(this.opts.repos, runId));
      } catch (err) {
        if (worktreePath) {
          await this.cleanupWorktree({ repoPath: project.path, worktreePath, branchName: draftBranch }).catch(() => undefined);
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
    if (input.iteration.projectId !== input.projectId) {
      throw new Error(`迭代项目不匹配：${input.iteration.projectId}`);
    }
    const versionSeg = requireCanonicalBranchSegment(input.iteration.version);
    await this.withIterationLock(`create:${input.projectId}:${versionSeg}`, async () => {
      if (this.opts.repos.iterations.listByProject(input.projectId).some((it) => it.version === versionSeg)) {
        throw new Error(`迭代版本号 ${versionSeg} 在该项目下已存在`);
      }
      try {
        // 初始化中记录对普通查询不可见；唯一索引仍负责跨 coordinator/进程占位。
        this.opts.repos.iterations.claim(input.iteration);
      } catch (error) {
        throw new Error(`迭代版本号 ${versionSeg} 在该项目下已存在：${(error as Error).message}`);
      }
      await this.completeClaimedIteration(project, input.iteration, false);
    });
  }

  private async completeClaimedIteration(
    project: { path: string; defaultBranch: string },
    iteration: Iteration,
    preserveClaimOnFailure: boolean,
  ): Promise<void> {
      const versionSeg = requireCanonicalBranchSegment(iteration.version);
      const draftBranch = `ai-devflow/iteration-init/${versionSeg}-${iteration.id}`;
      const deterministicWorktreePath = joinPath(this.opts.worktreesBaseDir, `iter-init-${iteration.id}`);
      let sprint: Awaited<ReturnType<typeof ensureSprintBranch>> | undefined;
      let originalSprintCommit: string | undefined;
      let ownedSprintCommit: string | undefined;
      let deleteSprintOnRollback = false;
      let worktreePath: string | undefined;
      let sprintMutated = false;
      try {
        // 上次若在任意 Git 阶段崩溃，先按确定性名称清理草稿，再从当前 sprint 幂等重建。
        await this.cleanupWorktree({
          repoPath: project.path,
          worktreePath: deterministicWorktreePath,
          branchName: draftBranch,
        });
        sprint = await ensureSprintBranch({
          repoPath: project.path,
          version: versionSeg,
          baseBranch: project.defaultBranch,
        });
        originalSprintCommit = sprint.commit;
        ownedSprintCommit = originalSprintCommit;
        deleteSprintOnRollback = sprint.created;
        const handle = await createWorktree({
          repoPath: project.path,
          baseDir: this.opts.worktreesBaseDir,
          id: `iter-init-${iteration.id}`,
          branchName: draftBranch,
          baseBranch: sprint.branch,
        });
        worktreePath = handle.path;
        await this.opts.knowledge.initializeIteration({
          repoPath: handle.path,
          version: versionSeg,
          iterationId: iteration.id,
          date: dateStr(this.now()),
        });
        const changedPaths = commitKnowledgeDraft(handle.path, project.path, `iter docs: ${versionSeg}`);
        if (changedPaths.length > 0) {
          const mergeRes = await (this.opts.mergeBranchInto ?? mergeBranchInto)({
            repoPath: project.path,
            into: sprint.branch,
            source: draftBranch,
          });
          if (!mergeRes.merged) throw new Error(`迭代文档合并失败：${mergeRes.reason}`);
          if (!mergeRes.commit || !mergeRes.previousCommit) {
            throw new Error('迭代文档合并缺少 CAS commit 证据');
          }
          sprintMutated = true;
          ownedSprintCommit = mergeRes.commit;
          originalSprintCommit = mergeRes.previousCommit;
          deleteSprintOnRollback = sprint.created && mergeRes.previousCommit === sprint.commit;
        }
        this.opts.repos.iterations.activate(iteration.id);
      } catch (err) {
        let rollbackError: unknown;
        try {
          if (sprint && originalSprintCommit && ownedSprintCommit) {
            const rollback = deleteSprintOnRollback
              ? await compareAndSwapBranchRef({
                  repoPath: project.path, branch: sprint.branch, expectedCommit: ownedSprintCommit,
                })
              : sprintMutated
                ? await compareAndSwapBranchRef({
                    repoPath: project.path,
                    branch: sprint.branch,
                    newCommit: originalSprintCommit,
                    expectedCommit: ownedSprintCommit,
                  })
                : { updated: true };
            if (!rollback.updated) throw new Error(rollback.reason);
          }
        } catch (rollback) {
          rollbackError = rollback;
        }
        if (!preserveClaimOnFailure) this.opts.repos.iterations.delete(iteration.id);
        if (rollbackError) {
          throw new Error(`${(err as Error).message}；Git 回滚失败：${(rollbackError as Error).message}`);
        }
        throw err;
      } finally {
        if (worktreePath) {
          await this.cleanupWorktree({ repoPath: project.path, worktreePath, branchName: draftBranch }).catch(() => undefined);
        } else {
          await deleteBranch(project.path, draftBranch, { force: true }).catch(() => undefined);
        }
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
    if (input.stage === 'development') {
      const iteration = this.opts.repos.iterations.get(input.task.iterationId);
      if (iteration) {
        await this.opts.knowledge.initializeTask({
          repoPath: input.cwd,
          version: iteration.version,
          taskId: input.task.id,
          title: input.task.title,
          date: dateStr(this.now()),
        });
        commitKnowledgeDraft(input.cwd, input.project.path, `task docs: ${input.task.id}`);
      }
    }
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
    const manifest = await this.opts.knowledge.planRetrieval({
      id: this.id(),
      projectId: input.projectId,
      taskId: input.taskId,
      expert: input.expert,
      stage: input.stage,
      query: input.prompt,
      repoPath: input.repoPath,
      createdAt: this.now(),
    });
    this.persistRetrieval(manifest);
    return manifest;
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

  /** 校验 Agent 上报的实际读取并完成 retrieval 记录。 */
  completeRetrieval(
    manifest: KnowledgeRetrievalManifest | undefined,
    reads: KnowledgeReadEvidence[] | undefined,
    state: 'completed' | 'failed',
  ): void {
    if (!manifest || manifest.state === 'not_initialized') return;
    const reported = reads ?? [];
    const candidates = new Map(manifest.candidates.map((candidate) => [candidate.id, candidate]));
    const invalid = reported.filter((read) => {
      const candidate = candidates.get(read.knowledgeId);
      return !candidate || candidate.path !== read.path || !Number.isFinite(read.chars) || read.chars < 0;
    });
    const usedFiles = new Set(reported.map((read) => read.knowledgeId)).size;
    const usedChars = reported.reduce((sum, read) => sum + read.chars, 0);
    const budgetExceeded = usedFiles > manifest.budget.maxFiles || usedChars > manifest.budget.maxChars;
    const completedState = invalid.length > 0 || budgetExceeded ? 'failed' : state;
    const confidence = reported.length > 0
      ? reported.reduce((sum, read) => sum + (candidates.get(read.knowledgeId)?.confidence ?? 0), 0) / reported.length
      : 0;
    const differences = [...manifest.differences];
    if (invalid.length > 0 || budgetExceeded) {
      differences.push({
        id: `retrieval-invalid:${manifest.id}`,
        severity: 'error',
        code: invalid.length > 0 ? 'read_outside_manifest' : 'retrieval_budget_exceeded',
        message: invalid.length > 0 ? 'Agent 上报了 manifest 之外的知识读取' : 'Agent 知识读取超出预算',
        evidence: invalid.map((read) => read.path),
      });
    }
    this.opts.repos.knowledgeRetrievals.complete(manifest.id, {
      state: completedState,
      readEvidenceJson: JSON.stringify(reported),
      skippedRefsJson: JSON.stringify(manifest.skipped),
      differencesJson: JSON.stringify(differences),
      usedFiles,
      usedChars,
      confidence,
      completedAt: this.now(),
    });
    if (completedState === 'failed' && state === 'completed') {
      throw new Error(differences.at(-1)?.message ?? '知识检索证据校验失败');
    }
  }

  /** 获取任务知识证据（检索记录 + 评估 + 沉淀，UI 用）。 */
  async getTaskEvidence(taskId: string): Promise<import('@ai-devflow/core').TaskKnowledgeEvidence> {
    const task = this.opts.repos.tasks.get(taskId);
    const project = task ? this.opts.repos.projects.get(task.projectId) : undefined;
    const catalog = project ? await this.opts.knowledge.loadCatalog(project.path) : undefined;
    const retrievals = this.opts.repos.knowledgeRetrievals
      .listByTask(taskId)
      .map((r) => this.recordToManifest(r, catalog?.documents));
    const depositionRow = this.opts.repos.knowledgeDepositions.getLatestByTask(taskId);
    const deposition = depositionRow ? this.rowToDeposition(depositionRow) : undefined;
    return { retrievals, assessment: deposition?.assessment, deposition };
  }

  private recordToManifest(
    r: import('@ai-devflow/persistence').KnowledgeRetrievalRecord,
    documents?: Map<string, import('@ai-devflow/core').KnowledgeDocumentRef>,
  ): KnowledgeRetrievalManifest {
    const candidateRefs = JSON.parse(r.candidateRefsJson) as Array<{ id: string }>;
    return {
      id: r.id,
      projectId: r.projectId,
      taskId: r.taskId,
      executionId: r.executionId,
      expert: r.expertKey,
      stage: r.stage,
      level: r.level,
      state: r.state,
      candidates: candidateRefs.map((ref) => documents?.get(ref.id)).filter((ref): ref is import('@ai-devflow/core').KnowledgeDocumentRef => !!ref),
      reads: JSON.parse(r.readEvidenceJson),
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

  private async depositionTargetBranch(
    task: Task,
    project: { path: string; defaultBranch: string },
  ): Promise<string> {
    const iteration = this.opts.repos.iterations.get(task.iterationId);
    const sprintBranch = iteration?.status === 'active' ? sprintBranchName(iteration.version) : undefined;
    return sprintBranch && await branchExists(project.path, sprintBranch)
      ? sprintBranch
      : project.defaultBranch;
  }

  private depositionGitContainsProgress(
    row: import('@ai-devflow/persistence').KnowledgeDepositionRecordRow,
    projectPath: string,
  ): boolean {
    const progress = parseDepositionProgress(row.progressJson);
    if (!progress) return false;
    if (
      !gitIsAncestor(projectPath, progress.taskCommit, progress.targetBranch) ||
      !gitIsAncestor(projectPath, progress.draftCommit, progress.targetBranch)
    ) {
      return false;
    }
    return true;
  }

  private reconcileIntegratedDeposition(
    row: import('@ai-devflow/persistence').KnowledgeDepositionRecordRow,
    projectPath: string,
  ): boolean {
    const progress = parseDepositionProgress(row.progressJson);
    if (!progress || !this.depositionGitContainsProgress(row, projectPath)) return false;
    const integrationCommit = progress.integrationCommit
      ?? gitOutput(projectPath, ['rev-parse', progress.targetBranch]).trim();
    this.opts.repos.knowledgeDepositions.updateProgress(row.id, {
      relatedKnowledgeIdsJson: row.relatedKnowledgeIdsJson,
      changedPathsJson: row.changedPathsJson,
      progressJson: JSON.stringify({ ...progress, phase: 'integrated', integrationCommit }),
    });
    if (row.state !== 'succeeded' || !row.gatePassed) {
      this.opts.repos.knowledgeDepositions.finish(row.id, {
        state: 'succeeded',
        relatedKnowledgeIdsJson: row.relatedKnowledgeIdsJson,
        changedPathsJson: row.changedPathsJson,
        gatePassed: true,
        diagnosticsJson: row.diagnosticsJson,
        endedAt: row.endedAt ?? this.now(),
      });
    }
    return true;
  }

  /** 知识沉淀门禁：none 持久化为成功沉淀（无路径）；valuable 运行 project_lead 沉淀并校验。 */
  async finalizeTaskKnowledge(input: {
    task: Task;
    project: { id: string; path: string; defaultBranch: string };
    executionId?: string;
    assessment: import('@ai-devflow/core').KnowledgeAssessment | undefined;
    worktreePath: string;
  }): Promise<{ gatePassed: boolean; taskIntegrated?: boolean; depositionId?: string; diagnostics: string[]; awaitingInitialization?: boolean }> {
    const assessment = input.assessment;
    const previous = this.opts.repos.knowledgeDepositions.getLatestByTask(input.task.id);
    if (
      assessment?.verdict === 'valuable' &&
      previous &&
      previous.executionId === input.executionId &&
      previous.assessmentJson === JSON.stringify(assessment) &&
      this.reconcileIntegratedDeposition(previous, input.project.path)
    ) {
      return {
        gatePassed: true,
        taskIntegrated: true,
        depositionId: previous.id,
        diagnostics: this.parseStringArray(previous.diagnosticsJson),
      };
    }
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
      return { gatePassed: true, taskIntegrated: false, depositionId, diagnostics: [] };
    }

    const catalog = await this.opts.knowledge.loadCatalog(input.worktreePath);
    if (!catalog.initialized) {
      const diagnostics = ['知识库未初始化，需要用户确认初始化草稿后恢复沉淀'];
      this.opts.repos.knowledgeDepositions.create({
        ...baseRecord,
        verdict: 'valuable',
        state: 'awaiting_initialization',
        diagnosticsJson: JSON.stringify(diagnostics),
      });
      return { gatePassed: false, depositionId, diagnostics, awaitingInitialization: true };
    }

    this.opts.repos.knowledgeDepositions.create({
      ...baseRecord,
      verdict: 'valuable',
      state: 'running',
    });

    // 调度器在任务门禁与任务分支合并的完整区间持有迭代锁。
    {
      const draftBranch = `ai-devflow/knowledge/${depositionId}`;
      let worktreePath: string | undefined;
      try {
        const iteration = this.opts.repos.iterations.get(input.task.iterationId);
        const targetBranch = await this.depositionTargetBranch(input.task, input.project);
        const taskBranch = `ai-devflow/${input.task.id}`;
        if (!(await branchExists(input.project.path, taskBranch))) {
          throw new Error(`任务分支不存在，无法原子沉淀：${taskBranch}`);
        }
        const handle = await createWorktree({
          repoPath: input.project.path,
          baseDir: this.opts.worktreesBaseDir,
          id: `knowledge-deposition-${depositionId}`,
          branchName: draftBranch,
          baseBranch: taskBranch,
        });
        worktreePath = handle.path;
        if (iteration) {
          await this.opts.knowledge.initializeTask({
            repoPath: worktreePath,
            version: iteration.version,
            taskId: input.task.id,
            title: input.task.title,
            date: dateStr(this.now()),
          });
        }
        const retrievals = this.opts.repos.knowledgeRetrievals.listByTask(input.task.id, 5).map((row) => ({
          id: row.id,
          level: row.level,
          candidates: JSON.parse(row.candidateRefsJson),
          reads: JSON.parse(row.readEvidenceJson),
        }));
        let taskDiff = '';
        try {
          taskDiff = gitOutput(input.project.path, ['diff', '--stat', `${targetBranch}...ai-devflow/${input.task.id}`]).trim();
        } catch {
          taskDiff = '(任务分支差异暂不可用，请以当前文件系统为准)';
        }
        const agentRun = await this.opts.runner.run({
          scope: { kind: 'task', taskId: input.task.id },
          executionId: input.executionId ?? depositionId,
          expert: 'project_lead',
          resultKind: 'knowledge_deposition',
          prompt: [
            '请基于审查候选、任务 diff、检索证据和现有知识更新长期知识、索引与任务文档。',
            `知识评估：${JSON.stringify(assessment)}`,
            `检索证据：${JSON.stringify(retrievals)}`,
            `任务 diff 摘要：\n${taskDiff || '(无提交差异)'}`,
          ].join('\n\n'),
          cwd: worktreePath,
        });
        const agentResult = await consumeAgentRun(agentRun);
        if (agentResult.payload?.kind !== 'knowledge_deposition') {
          throw new Error('知识沉淀缺少 knowledge_deposition 结构化载荷');
        }
        if (JSON.stringify(agentResult.payload.assessment) !== JSON.stringify(assessment)) {
          throw new Error('知识沉淀返回的 assessment 与审查候选不一致');
        }
        commitKnowledgeDraft(worktreePath, input.project.path, `knowledge: deposit ${input.task.id}`);
        // 草稿基于任务分支，二者之间只包含 project_lead 的文档改动；目标分支到草稿则是代码+知识组合树。
        const changedPaths = await listChangedPaths(input.project.path, taskBranch, draftBranch);
        const diagnostics: string[] = [];
        const reportedPaths = new Set(agentResult.payload.changedPaths);
        const missingReportedPaths = agentResult.payload.changedPaths.filter((path) => !changedPaths.includes(path));
        if (missingReportedPaths.length > 0) {
          throw new Error(`沉淀结果声明了不存在的 Git 改动：${missingReportedPaths.join(', ')}`);
        }
        const relatedKnowledgeIds = [...new Set(agentResult.payload.knowledgeIds)].sort();
        if (relatedKnowledgeIds.length === 0) {
          throw new Error('valuable 候选未关联任何知识 ID');
        }
        const snapshot = await this.opts.knowledge.audit({
          projectId: input.project.id,
          repoPath: worktreePath,
          git: this.gitProbe(),
        });
        if (snapshot.findings.some((finding) => finding.severity === 'error')) {
          throw new Error(`沉淀后知识巡检阻断：${snapshot.findings.filter((finding) => finding.severity === 'error').map((finding) => finding.message).join('; ')}`);
        }
        const depositedCatalog = await this.opts.knowledge.loadCatalog(worktreePath);
        const missingKnowledgeIds = relatedKnowledgeIds.filter((id) => !depositedCatalog.documents.has(id));
        if (missingKnowledgeIds.length > 0) {
          throw new Error(`沉淀结果引用不存在的知识 ID：${missingKnowledgeIds.join(', ')}`);
        }
        const mappings = agentResult.payload.candidateKnowledge;
        const mappingsByIndex = new Map<number, string>();
        for (const mapping of mappings) {
          if (mapping.candidateIndex >= assessment.candidates.length) {
            throw new Error(`候选映射索引越界：${mapping.candidateIndex}`);
          }
          if (mappingsByIndex.has(mapping.candidateIndex)) {
            throw new Error(`候选 ${mapping.candidateIndex} 被重复映射`);
          }
          mappingsByIndex.set(mapping.candidateIndex, mapping.knowledgeId);
        }
        const missingCandidateIndexes = assessment.candidates
          .map((_candidate, index) => index)
          .filter((index) => !mappingsByIndex.has(index));
        if (missingCandidateIndexes.length > 0) {
          throw new Error(`valuable 候选缺少显式知识映射：${missingCandidateIndexes.join(', ')}`);
        }
        for (const [candidateIndex, knowledgeId] of mappingsByIndex) {
          if (!relatedKnowledgeIds.includes(knowledgeId)) {
            throw new Error(`候选 ${candidateIndex} 映射的知识 ID 未包含在 knowledgeIds：${knowledgeId}`);
          }
          const document = depositedCatalog.documents.get(knowledgeId);
          if (!document) {
            throw new Error(`候选 ${candidateIndex} 映射的知识 ID 不存在：${knowledgeId}`);
          }
          if (document.id === 'context:root' || document.id.endsWith(':index')) {
            throw new Error(`候选 ${candidateIndex} 不能映射到索引文档：${knowledgeId}`);
          }
          const candidate = assessment.candidates[candidateIndex]!;
          if (document.type !== candidate.type) {
            throw new Error(`候选 ${candidateIndex} 类型 ${candidate.type} 与知识 ${knowledgeId} 类型 ${document.type} 不一致`);
          }
          if (candidate.suggestedTarget && candidate.suggestedTarget !== knowledgeId) {
            throw new Error(`候选 ${candidateIndex} 未映射到建议知识 ID：${candidate.suggestedTarget}`);
          }
          if (!changedPaths.includes(document.path)) {
            throw new Error(`候选 ${candidateIndex} 映射到本次未更新的知识文档：${document.path}`);
          }
        }
        const requiredTaskChangelog = iteration
          ? `docs/iterations/${sanitizePathSegment(iteration.version, 'version')}/tasks/${sanitizePathSegment(input.task.id, 'taskId')}/CHANGELOG.md`
          : undefined;
        if (requiredTaskChangelog && !reportedPaths.has(requiredTaskChangelog)) {
          throw new Error('valuable 沉淀未更新任务 CHANGELOG');
        }
        const taskCommit = gitOutput(input.project.path, ['rev-parse', taskBranch]).trim();
        const draftCommit = gitOutput(input.project.path, ['rev-parse', draftBranch]).trim();
        const validatedProgress: DepositionProgress = {
          phase: 'validated', targetBranch, taskCommit, draftCommit,
        };
        this.opts.repos.knowledgeDepositions.updateProgress(depositionId, {
          relatedKnowledgeIdsJson: JSON.stringify(relatedKnowledgeIds),
          changedPathsJson: JSON.stringify(changedPaths),
          progressJson: JSON.stringify(validatedProgress),
        });
        const mergeRes = targetBranch === input.project.defaultBranch
          ? await mergeWorktreeBranch({
              repoPath: input.project.path,
              branchName: draftBranch,
              defaultBranch: input.project.defaultBranch,
            })
          : await mergeBranchInto({ repoPath: input.project.path, into: targetBranch, source: draftBranch });
        if (!mergeRes.merged) {
          diagnostics.push(`沉淀草稿合并失败：${mergeRes.reason}`);
          this.opts.repos.knowledgeDepositions.finish(depositionId, {
            state: 'failed',
            relatedKnowledgeIdsJson: JSON.stringify(relatedKnowledgeIds),
            changedPathsJson: JSON.stringify(changedPaths),
            gatePassed: false,
            diagnosticsJson: JSON.stringify(diagnostics),
            endedAt: this.now(),
          });
          await this.cleanupWorktree({ repoPath: input.project.path, worktreePath, branchName: draftBranch }).catch(() => undefined);
          return { gatePassed: false, diagnostics };
        }
        const integrationCommit = gitOutput(input.project.path, ['rev-parse', targetBranch]).trim();
        this.opts.repos.knowledgeDepositions.updateProgress(depositionId, {
          relatedKnowledgeIdsJson: JSON.stringify(relatedKnowledgeIds),
          changedPathsJson: JSON.stringify(changedPaths),
          progressJson: JSON.stringify({ ...validatedProgress, phase: 'integrated', integrationCommit }),
        });
        const integratedRecord = this.opts.repos.knowledgeDepositions.get(depositionId);
        if (!integratedRecord || !this.depositionGitContainsProgress(integratedRecord, input.project.path)) {
          throw new Error('沉淀目标分支未同时包含任务提交与知识草稿提交');
        }
        const endedAt = this.now();
        this.opts.repos.knowledgeDepositions.finish(depositionId, {
          state: 'succeeded',
          relatedKnowledgeIdsJson: JSON.stringify(relatedKnowledgeIds),
          changedPathsJson: JSON.stringify(changedPaths),
          gatePassed: true,
          diagnosticsJson: '[]',
          endedAt,
        });
        try {
          await this.cleanupWorktree({ repoPath: input.project.path, worktreePath, branchName: draftBranch });
        } catch (err) {
          diagnostics.push(`沉淀已合并，但草稿清理失败：${(err as Error).message}`);
          this.opts.repos.knowledgeDepositions.finish(depositionId, {
            state: 'succeeded',
            relatedKnowledgeIdsJson: JSON.stringify(relatedKnowledgeIds),
            changedPathsJson: JSON.stringify(changedPaths),
            gatePassed: true,
            diagnosticsJson: JSON.stringify(diagnostics),
            endedAt,
          });
        }
        return { gatePassed: true, taskIntegrated: true, depositionId, diagnostics };
      } catch (err) {
        if (worktreePath) {
          await this.cleanupWorktree({ repoPath: input.project.path, worktreePath, branchName: draftBranch }).catch(() => undefined);
        }
        const current = this.opts.repos.knowledgeDepositions.get(depositionId);
        if (current && this.reconcileIntegratedDeposition(current, input.project.path)) {
          return {
            gatePassed: true,
            taskIntegrated: true,
            depositionId,
            diagnostics: this.parseStringArray(current.diagnosticsJson),
          };
        }
        const diagnostics = [(err as Error).message];
        const relatedKnowledgeIdsJson = current?.relatedKnowledgeIdsJson ?? '[]';
        const changedPathsJson = current?.changedPathsJson ?? '[]';
        this.opts.repos.knowledgeDepositions.finish(depositionId, {
          state: 'failed',
          relatedKnowledgeIdsJson,
          changedPathsJson,
          gatePassed: false,
          diagnosticsJson: JSON.stringify(diagnostics),
          endedAt: this.now(),
        });
        return { gatePassed: false, diagnostics };
      }
    }
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

  private async completeValidatedArchive(input: {
    runId: string;
    iterationId: string;
    project: { path: string; defaultBranch: string };
    sprintBranch: string;
    progress: IterationArchiveProgress;
    verification: IterationChangelogVerification;
  }): Promise<{ ok: true } | { ok: false; reasons: string[]; verification: IterationChangelogVerification }> {
    const reasons: string[] = [];
    const sprintCommit = input.progress.sprintCommit;
    let sprintHead = '';
    try {
      sprintHead = gitOutput(input.project.path, ['rev-parse', input.sprintBranch]).trim();
    } catch {
      // 下面统一返回可诊断失败。
    }
    if (!sprintCommit || sprintHead !== sprintCommit) {
      reasons.push('已验证的迭代聚合与当前 sprint 提交不一致，需要重新聚合');
      return { ok: false, reasons, verification: input.verification };
    }
    if (!input.progress.draftCommit || !gitIsAncestor(input.project.path, input.progress.draftCommit, sprintCommit)) {
      reasons.push('当前 sprint 提交未包含已验证的迭代聚合，需要重新聚合');
      return { ok: false, reasons, verification: input.verification };
    }

    if (!gitIsAncestor(input.project.path, sprintCommit, input.project.defaultBranch)) {
      const mergeRes = await (this.opts.mergeWorktreeBranch ?? mergeWorktreeBranch)({
        repoPath: input.project.path,
        branchName: sprintCommit,
        defaultBranch: input.project.defaultBranch,
      });
      if (!mergeRes.merged) {
        reasons.push(`迭代分支合并失败：${mergeRes.reason}`);
        this.opts.repos.knowledgeRuns.finish(input.runId, 'failed', this.now(), {
          resultJson: JSON.stringify(input.progress),
          diagnosticsJson: JSON.stringify(reasons),
        });
        return { ok: false, reasons, verification: input.verification };
      }
    }
    if (!gitIsAncestor(input.project.path, sprintCommit, input.project.defaultBranch)) {
      reasons.push('迭代分支合并失败：默认分支未包含已验证的 sprint 提交');
      this.opts.repos.knowledgeRuns.finish(input.runId, 'failed', this.now(), {
        resultJson: JSON.stringify(input.progress),
        diagnosticsJson: JSON.stringify(reasons),
      });
      return { ok: false, reasons, verification: input.verification };
    }

    const completed: IterationArchiveProgress = { ...input.progress, phase: 'completed' };
    try {
      const endedAt = this.now();
      this.opts.repos.transaction(() => {
        this.opts.repos.knowledgeRuns.finish(input.runId, 'succeeded', endedAt, {
          resultJson: JSON.stringify(completed),
          diagnosticsJson: '[]',
        });
        this.opts.repos.iterations.archive(input.iterationId, endedAt);
      });
    } catch (err) {
      reasons.push(`归档数据库终态写入失败：${(err as Error).message}`);
      try {
        this.opts.repos.knowledgeRuns.finish(input.runId, 'failed', this.now(), {
          resultJson: JSON.stringify(input.progress),
          diagnosticsJson: JSON.stringify(reasons),
        });
      } catch {
        // 数据库异常时保留原 running/failed 状态与 Git 进度，后续仍可对账恢复。
      }
      return { ok: false, reasons, verification: input.verification };
    }
    return { ok: true };
  }

  /** 严格迭代归档：聚合 CHANGELOG -> 校验 -> 合并 sprint 分支 -> 事务化归档数据库终态。 */
  async archiveIteration(iterationId: string): Promise<{ ok: true } | { ok: false; reasons: string[]; verification?: IterationChangelogVerification }> {
    return this.withIterationLock(iterationId, async () => {
      const iteration = this.opts.repos.iterations.get(iterationId);
      if (!iteration) throw new Error(`迭代不存在：${iterationId}`);
      if (iteration.status === 'archived') return { ok: true };
      const project = this.opts.repos.projects.get(iteration.projectId);
      if (!project) throw new Error(`项目不存在：${iteration.projectId}`);
      const tasks = this.opts.repos.tasks.listByIteration(iterationId);
      const reasons: string[] = [];

      // 1. 所有任务必须已归档
      const unarchived = tasks.filter((t) => t.status !== 'archived');
      if (unarchived.length > 0) {
        reasons.push(`还有 ${unarchived.length} 个任务未归档`);
      }

      if (reasons.length > 0) {
        const runId = this.id();
        const t = this.now();
        this.opts.repos.knowledgeRuns.create({
          id: runId, projectId: project.id, iterationId, kind: 'iteration_changelog',
          state: 'running', confirmationState: 'not_required',
          changedPathsJson: '[]', diagnosticsJson: '[]', resultJson: '{}', startedAt: t,
        });
        this.opts.repos.knowledgeRuns.finish(runId, 'failed', this.now(), {
          resultJson: JSON.stringify({ state: 'invalid' }),
          diagnosticsJson: JSON.stringify(reasons),
        });
        return { ok: false, reasons };
      }

      const sprintBranch = sprintBranchName(iteration.version);
      if (!(await branchExists(project.path, sprintBranch))) {
        return { ok: false, reasons: [`CHANGELOG 聚合或校验异常：迭代分支不存在：${sprintBranch}`] };
      }

      // 先恢复已验证的聚合：避免默认合并或 DB 终态失败后再次要求 Agent 重写相同文件。
      const previousRun = this.opts.repos.knowledgeRuns.getLatestByIteration(iterationId, 'iteration_changelog');
      let previousProgress = previousRun ? parseArchiveProgress(previousRun.resultJson) : undefined;
      if (previousRun && previousProgress?.phase === 'validated') {
        const sprintHead = gitOutput(project.path, ['rev-parse', sprintBranch]).trim();
        const draftBranch = `ai-devflow/knowledge/${previousRun.id}`;
        if (
          previousProgress.draftCommit &&
          previousProgress.sprintBaseCommit &&
          sprintHead === previousProgress.sprintBaseCommit &&
          await branchExists(project.path, draftBranch) &&
          gitOutput(project.path, ['rev-parse', draftBranch]).trim() === previousProgress.draftCommit
        ) {
          const recoveredMerge = await (this.opts.mergeBranchInto ?? mergeBranchInto)({
            repoPath: project.path,
            into: sprintBranch,
            source: draftBranch,
          });
          if (recoveredMerge.merged) {
            await deleteBranch(project.path, draftBranch, { force: true }).catch(() => undefined);
          }
        }
        const recoveredHead = gitOutput(project.path, ['rev-parse', sprintBranch]).trim();
        if (previousProgress.draftCommit && gitIsAncestor(project.path, previousProgress.draftCommit, recoveredHead)) {
          previousProgress = { ...previousProgress, phase: 'awaiting_default_merge', sprintCommit: recoveredHead };
          this.opts.repos.knowledgeRuns.setProgress(
            previousRun.id,
            JSON.stringify(previousProgress),
            JSON.stringify(previousProgress.changedPaths),
          );
        }
      }
      if (
        previousRun &&
        previousProgress?.sprintCommit &&
        (previousProgress.phase === 'awaiting_default_merge' || previousProgress.phase === 'completed') &&
        gitOutput(project.path, ['rev-parse', sprintBranch]).trim() === previousProgress.sprintCommit
      ) {
        const previousVerification = await this.getIterationVerification(iterationId);
        return this.completeValidatedArchive({
          runId: previousRun.id,
          iterationId,
          project,
          sprintBranch,
          progress: previousProgress,
          verification: previousVerification,
        });
      }

      const runId = this.id();
      const t = this.now();
      this.opts.repos.knowledgeRuns.create({
        id: runId, projectId: project.id, iterationId, kind: 'iteration_changelog',
        state: 'running', confirmationState: 'not_required',
        changedPathsJson: '[]', diagnosticsJson: '[]', resultJson: '{}', startedAt: t,
      });
      let verification: IterationChangelogVerification | undefined;
      const draftBranch = `ai-devflow/knowledge/${runId}`;
      let aggregationWorktree: string | undefined;
      let aggregationPayload: Extract<KnowledgeAgentPayload, { kind: 'iteration_changelog' }> | undefined;
      let archiveProgress: IterationArchiveProgress | undefined;
      try {
        const handle = await createWorktree({
          repoPath: project.path,
          baseDir: this.opts.worktreesBaseDir,
          id: `knowledge-changelog-${runId}`,
          branchName: draftBranch,
          baseBranch: sprintBranch,
        });
        aggregationWorktree = handle.path;

        const depositionEvidence = tasks.map((task) => {
          const row = this.opts.repos.knowledgeDepositions.getLatestByTask(task.id);
          return row ? {
            taskId: task.id,
            state: row.state,
            knowledgeIds: JSON.parse(row.relatedKnowledgeIdsJson),
            changedPaths: JSON.parse(row.changedPathsJson),
          } : { taskId: task.id, state: 'missing', knowledgeIds: [], changedPaths: [] };
        });
        const iterationDiff = gitOutput(project.path, [
          'diff', '--stat', `${project.defaultBranch}...${sprintBranch}`,
        ]).trim();
        const agentRun = await this.opts.runner.run({
          scope: { kind: 'iteration', projectId: project.id, iterationId },
          executionId: runId,
          expert: 'project_lead',
          resultKind: 'iteration_changelog',
          prompt: [
            '请读取所有任务 CHANGELOG、沉淀记录和迭代 Git 差异，重建迭代 CHANGELOG 并更新迭代索引。',
            `期望覆盖任务：${JSON.stringify(tasks.map((task) => task.id))}`,
            `沉淀证据：${JSON.stringify(depositionEvidence)}`,
            `迭代差异：\n${iterationDiff || '(无差异)'}`,
          ].join('\n\n'),
          cwd: aggregationWorktree,
        });
        const agentResult = await consumeAgentRun(agentRun);
        if (agentResult.payload?.kind !== 'iteration_changelog') {
          throw new Error('CHANGELOG 聚合缺少 iteration_changelog 结构化载荷');
        }
        aggregationPayload = agentResult.payload;
        const expectedTaskIds = tasks.map((task) => task.id).sort();
        const reportedTaskIds = [...new Set(aggregationPayload.coveredTaskIds)].sort();
        if (JSON.stringify(reportedTaskIds) !== JSON.stringify(expectedTaskIds)) {
          throw new Error(`CHANGELOG 聚合载荷未覆盖全部任务：${reportedTaskIds.join(', ')}`);
        }

        commitKnowledgeDraft(aggregationWorktree, project.path, `knowledge: aggregate iteration ${iteration.version}`);
        const changedPaths = await listChangedPaths(project.path, sprintBranch, draftBranch);
        const missingReportedPaths = aggregationPayload.changedPaths.filter((path) => !changedPaths.includes(path));
        if (missingReportedPaths.length > 0) {
          throw new Error(`CHANGELOG 聚合声明了不存在的 Git 改动：${missingReportedPaths.join(', ')}`);
        }

        // 在包含聚合结果的同一 worktree 上校验路径、覆盖率和 Git 跟踪状态。
        verification = await this.opts.knowledge.verifyIterationChangelog({
          repoPath: aggregationWorktree, version: iteration.version, iterationId,
          expectedTaskIds, git: this.gitProbe(), verifiedAt: this.now(),
        });
        const findingRecords = verification.findings.map((f, i) => ({
          id: `${runId}-f${i}`, runId, severity: f.severity, code: f.code, path: f.path,
          knowledgeId: f.knowledgeId, message: f.message, evidenceJson: JSON.stringify(f.evidence), createdAt: t,
        }));
        this.opts.repos.knowledgeFindings.insertMany(findingRecords);
        if (verification.state !== 'valid') {
          throw new Error('迭代 CHANGELOG 校验未通过');
        }

        const sprintBaseCommit = gitOutput(project.path, ['rev-parse', sprintBranch]).trim();
        const draftCommit = gitOutput(project.path, ['rev-parse', draftBranch]).trim();
        archiveProgress = {
          state: 'valid',
          phase: 'validated',
          aggregation: aggregationPayload,
          coveredTaskIds: verification.coveredTaskIds,
          missingTaskIds: verification.missingTaskIds,
          changedPaths: verification.changedPaths,
          verifiedAt: verification.verifiedAt,
          sprintBaseCommit,
          draftCommit,
        };
        this.opts.repos.knowledgeRuns.setProgress(
          runId,
          JSON.stringify(archiveProgress),
          JSON.stringify(verification.changedPaths),
        );
        const sprintMerge = await (this.opts.mergeBranchInto ?? mergeBranchInto)({
          repoPath: project.path,
          into: sprintBranch,
          source: draftBranch,
        });
        if (!sprintMerge.merged || !sprintMerge.commit) {
          throw new Error(`CHANGELOG 聚合合并失败：${sprintMerge.reason}`);
        }
        const sprintCommit = sprintMerge.commit;
        if (!gitIsAncestor(project.path, draftCommit, sprintCommit)) {
          throw new Error('CHANGELOG 聚合合并结果未包含已验证草稿');
        }
        archiveProgress = { ...archiveProgress, phase: 'awaiting_default_merge', sprintCommit };
        this.opts.repos.knowledgeRuns.setProgress(
          runId,
          JSON.stringify(archiveProgress),
          JSON.stringify(verification.changedPaths),
        );
      } catch (err) {
        reasons.push(`CHANGELOG 聚合或校验异常：${(err as Error).message}`);
      } finally {
        if (aggregationWorktree) {
          await this.cleanupWorktree({
            repoPath: project.path,
            worktreePath: aggregationWorktree,
            branchName: draftBranch,
          }).catch(() => undefined);
        }
      }

      if (reasons.length > 0) {
        this.opts.repos.knowledgeRuns.finish(runId, 'failed', this.now(), {
          resultJson: archiveProgress
            ? JSON.stringify(archiveProgress)
            : JSON.stringify({
                state: 'invalid',
                aggregation: aggregationPayload,
                ...(verification ? { coveredTaskIds: verification.coveredTaskIds, missingTaskIds: verification.missingTaskIds, changedPaths: verification.changedPaths, verifiedAt: verification.verifiedAt } : {}),
              }),
          diagnosticsJson: JSON.stringify(reasons),
        });
        return { ok: false, reasons, verification };
      }

      return this.completeValidatedArchive({
        runId,
        iterationId,
        project,
        sprintBranch,
        progress: archiveProgress!,
        verification: verification!,
      });
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

  private pendingWorktreePath(record: import('@ai-devflow/persistence').KnowledgeRunRecord): string {
    const prefix = record.kind === 'repair' ? 'knowledge-repair-' : 'knowledge-';
    return joinPath(this.opts.worktreesBaseDir, `${prefix}${record.id}`);
  }

  private gitProbe(): import('@ai-devflow/knowledge').KnowledgeGitProbe {
    return {
      isTracked: async (repoPath, relativePath) => {
        try {
          execFileSync('git', ['ls-files', '--error-unmatch', '--', relativePath], { cwd: repoPath, stdio: 'ignore' });
          return true;
        } catch {
          return false;
        }
      },
      isIgnored: async (repoPath, relativePath) => {
        try {
          execFileSync('git', ['check-ignore', '--no-index', '--quiet', '--', relativePath], { cwd: repoPath, stdio: 'ignore' });
          return true;
        } catch {
          return false;
        }
      },
    };
  }
}
