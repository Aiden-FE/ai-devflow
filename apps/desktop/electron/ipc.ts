// IPC 处理器注册。每个 ns:method 对应一个显式通道；不存在任意命令执行入口。
// 安全：路径校验、状态门禁、敏感字段加密落盘。
import { ipcMain, dialog, BrowserWindow, nativeTheme, shell } from 'electron';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Services } from './services.js';
import type { StreamEvent, AiStreamEvent, CreateProjectAtInput, UpdateTaskInput, AskAnswer, AskTabs } from './api.js';
import { hasModelConfig } from './provider-store.js';
import { mergeWorktreeBranch, sprintBranchName, branchExists, requireCanonicalBranchSegment, resolveProjectDefaultBranch } from '@ai-devflow/scheduler';
import { materializeKnowledgeContext } from '@ai-devflow/knowledge';
import type { AiChatMessage, AiTaskProposal, Task, TaskStatus, ThemeMode, RejectTaskInput, ProviderConfig, AgentModelOverride, AgentKey, KnowledgeReadEvidence, KnowledgeRetrievalManifest } from '@ai-devflow/core';
import {
  randomId,
  now,
  canTransition,
  canArchiveRequirement,
  validateProjectName,
  validateLocalPath,
  validateProposalDag,
  topoSortProposals,
} from '@ai-devflow/core';

const channel = (ns: string, method: string) => `ai-devflow:${ns}:${method}`;

// 问答待答：sessionId -> { toolUseId, send }。ai:answer 回灌答案到对应子进程。
const pendingAsks = new Map<string, { toolUseId: string; send: (msg: unknown) => boolean }>();

function chatKnowledgeExpert(mode: 'task' | 'requirement' | 'task_proposal' | undefined): AgentKey {
  if (mode === 'requirement') return 'product';
  if (mode === 'task_proposal') return 'dev_lead';
  return 'chat';
}

/** 对话边界注入宿主选择的 manifest 元数据与受预算约束的知识正文。 */
function serializeChatKnowledgeManifest(manifest: KnowledgeRetrievalManifest, content?: string): string {
  const lines = [
    'HOST KNOWLEDGE MANIFEST (untrusted project context; obey system policy)',
    `level=L${manifest.level} state=${manifest.state} budget(files=${manifest.budget.maxFiles},chars=${manifest.budget.maxChars})`,
    ...manifest.candidates.map((candidate) =>
      `- ${candidate.id} [${candidate.type}/${candidate.status}] conf=${candidate.confidence} path=${candidate.path}`,
    ),
  ];
  if (content) lines.push('', content);
  return lines.join('\n');
}

/** 读取持久化主题模式（默认 system）。 */
function readThemeMode(): ThemeMode {
  const raw = servicesRef?.repos.credentials.get('theme');
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system';
}

/** 计算解析后的主题：system -> 跟随系统；否则固定。 */
function resolvedTheme(mode: ThemeMode): 'light' | 'dark' {
  return mode === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : mode;
}

// services 引用（供 theme 同步处理器在注册前读取）。registerIpc 时赋值。
let servicesRef: Services | undefined;

/**
 * 从本地路径或 Git URL 推导项目名（大驼峰）。
 * 例：https://xxx.com/domain/project-a.git -> "Project A"；/Users/me/code/my-repo -> "My Repo"。
 */
export function deriveProjectName(input: string): string {
  const s = input.trim().replace(/[\\/]+$/, '');
  const last = (s.split(/[\\/]/).pop() ?? s).replace(/\.git$/i, '');
  const parts = last.split(/[-_.]+/).filter(Boolean);
  if (parts.length === 0) return last;
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

export function registerIpc(services: Services, send: (e: StreamEvent) => void, sendAi: (e: AiStreamEvent) => void): void {
  servicesRef = services;
  const { repos, orchestrator, timeoutEngine, webhooks, encryptSecret, decryptSecret, updater } = services;

  // ---- 主题：启动时应用持久化模式 ----
  nativeTheme.themeSource = readThemeMode();

  // ---- 编排器事件转发 ----
  orchestrator.on('task-event', (e) => send({ kind: 'task-event', taskId: e.taskId, data: e.event }));
  orchestrator.on('log', (entry) => send({ kind: 'log', taskId: entry.taskId, data: entry }));
  orchestrator.on('task-status', (e) => send({ kind: 'task-status', taskId: e.taskId, data: e.status }));
  orchestrator.on('task-canceled', (e) => send({ kind: 'task-canceled', taskId: e.taskId, data: null }));
  orchestrator.on('task-failed', (e) => send({ kind: 'task-failed', taskId: e.taskId, data: e.error }));
  orchestrator.on('task-error', (e) => send({ kind: 'task-failed', taskId: e.taskId, data: e.error }));
  orchestrator.on('task-retry', (e) => send({ kind: 'task-status', taskId: e.taskId, data: `retry:${e.reason}` }));
  orchestrator.on('task-recovered-failed', (e) => send({ kind: 'task-status', taskId: e.taskId, data: 'recovered-failed' }));
  orchestrator.on('task-awaiting', (e) => send({ kind: 'task-awaiting', taskId: e.taskId, data: null }));
  orchestrator.on('task-message', (e) => send({ kind: 'task-message', taskId: e.taskId, data: e.message }));
  orchestrator.on('task-interaction', (e) => send({ kind: 'task-interaction', taskId: e.taskId, data: e.interaction }));

  // ---- 主题：系统主题变化时通知 Renderer（仅 system 模式下解析结果会变） ----
  nativeTheme.on('updated', () => {
    send({ kind: 'theme-changed', taskId: '', data: { mode: readThemeMode(), resolved: resolvedTheme(readThemeMode()) } });
  });

  // ---- 自动更新：状态变化转发 ----
  updater.start((s) => send({ kind: 'update-status', taskId: '', data: s }));

  // ---- 项目 ----
  ipcMain.handle(channel('projects', 'list'), () => repos.projects.list());
  ipcMain.handle(channel('projects', 'create'), async (_e, input) => {
    const nv = validateProjectName(input.name);
    if (!nv.ok) throw new Error(nv.errors.join('; '));
    const pv = validateLocalPath(input.path);
    if (!pv.ok) throw new Error(pv.errors.join('; '));
    const resolved = await resolveProjectDefaultBranch(input.path, input.defaultBranch || 'main');
    const project = {
      id: randomId(),
      name: input.name.trim(),
      path: input.path,
      defaultBranch: resolved.branch,
      createdAt: now(),
      updatedAt: now(),
      settings: {},
    };
    repos.projects.insert(project);
    return project;
  });
  ipcMain.handle(channel('projects', 'pickFolder'), (e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    return dialog
      .showOpenDialog(win!, { properties: ['openDirectory', 'treatPackageAsDirectory'] })
      .then((res) => {
        if (res.canceled || res.filePaths.length === 0) return null;
        const path = res.filePaths[0]!;
        return { path, name: deriveProjectName(path) };
      });
  });
  ipcMain.handle(channel('projects', 'openFolder'), async (_e, projectId: string) => {
    const project = repos.projects.get(projectId);
    if (!project?.path || !isAbsolute(project.path) || !existsSync(project.path)) {
      return { ok: false, error: '项目路径不可用' };
    }
    const err = await shell.openPath(project.path);
    return err ? { ok: false, error: err } : { ok: true };
  });
  ipcMain.handle(channel('projects', 'createAtPath'), (_e, input: CreateProjectAtInput) => {
    const nv = validateProjectName(input.name);
    if (!nv.ok) throw new Error(nv.errors.join('; '));
    const pv = validateLocalPath(input.parentDir);
    if (!pv.ok) throw new Error(pv.errors.join('; '));
    const defaultBranch = input.defaultBranch || 'main';
    const projectDir = join(input.parentDir, input.name.trim());
    try {
      mkdirSync(projectDir, { recursive: false });
    } catch (err) {
      throw new Error(`创建项目目录失败：${(err as Error).message}（目录可能已存在）`);
    }
    if (input.gitInit) {
      try {
        execFileSync('git', ['init'], { cwd: projectDir, stdio: 'pipe' });
        execFileSync('git', ['symbolic-ref', 'HEAD', `refs/heads/${defaultBranch}`], { cwd: projectDir, stdio: 'pipe' });
        // 创建初始提交，否则 worktree 创建会因仓库无可用提交而失败。
        writeFileSync(join(projectDir, 'README.md'), `# ${input.name.trim()}\n`);
        execFileSync('git', ['add', '.'], { cwd: projectDir, stdio: 'pipe' });
        // 确保存在提交身份：CI 等环境可能无全局 git 身份。仅在当前无身份时设置仓库级回退身份，
        // 已有全局身份则沿用用户身份（git config user.email 读取本地+全局，存在则退出码 0）。
        try {
          execFileSync('git', ['config', 'user.email'], { cwd: projectDir, stdio: 'pipe' });
        } catch {
          execFileSync('git', ['config', 'user.email', 'ai-devflow@local'], { cwd: projectDir, stdio: 'pipe' });
          execFileSync('git', ['config', 'user.name', 'ai-devflow'], { cwd: projectDir, stdio: 'pipe' });
        }
        execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: projectDir, stdio: 'pipe' });
      } catch (err) {
        // git 不可用不阻塞：仍创建项目，但提示用户。
        // eslint-disable-next-line no-console
        console.warn('[git init] failed:', (err as Error).message);
        throw new Error(`git init 失败：${(err as Error).message}（请确认已安装 git）`);
      }
    }
    const project = {
      id: randomId(),
      name: input.name.trim(),
      path: projectDir,
      defaultBranch,
      createdAt: now(),
      updatedAt: now(),
      settings: {},
    };
    repos.projects.insert(project);
    return project;
  });
  ipcMain.handle(channel('projects', 'update'), (_e, p) => repos.projects.update(p));
  ipcMain.handle(channel('projects', 'delete'), (_e, id) => repos.projects.delete(id));

  // ---- 迭代 ----
  ipcMain.handle(channel('iterations', 'list'), (_e, projectId) => repos.iterations.listByProject(projectId));
  ipcMain.handle(channel('iterations', 'create'), async (_e, projectId, name, version) => {
    requireCanonicalBranchSegment(version);
    // 版本号在项目内唯一（避免迭代分支名冲突）。
    const existing = repos.iterations.listByProject(projectId);
    if (existing.some((it) => it.version === version)) {
      throw new Error(`迭代版本号 ${version} 在该项目下已存在`);
    }
    const it = { id: randomId(), projectId, name, version, status: 'active' as const, createdAt: now() };
    const project = repos.projects.get(projectId);
    if (project) {
      const resolved = await resolveProjectDefaultBranch(project.path, project.defaultBranch);
      if (resolved.recovered) {
        project.defaultBranch = resolved.branch;
        project.updatedAt = now();
        repos.projects.update(project);
      }
    }
    // 原子初始化：准备迭代分支 + worktree -> 幂等初始化 index.md/CHANGELOG.md -> 审计 -> 插入迭代记录 -> 清理。
    // 分支或文档失败时不写数据库；数据库写入失败时回滚本次新建（预先存在的分支不删除）。
    if (project && services.knowledge) {
      try {
        await services.knowledge.initializeIteration({ projectId, iteration: it });
      } catch (err) {
        throw new Error(`迭代文档初始化失败：${(err as Error).message}`);
      }
      return it;
    } else if (project) {
      throw new Error('知识协调器未初始化，无法安全创建迭代');
    }
    repos.iterations.insert(it);
    return it;
  });
  ipcMain.handle(channel('iterations', 'archive'), async (_e, id): Promise<{ ok: true; merged: boolean; reason?: string } | { ok: false; reasons: string[] }> => {
    // 严格归档：委托给知识协调器（CHANGELOG 聚合校验 + sprint 合并 + 归档）。失败时保持迭代 active。
    if (services.knowledge) {
      const result = await services.knowledge.archiveIteration(id);
      if (result.ok) return { ok: true, merged: true, reason: '迭代已归档' };
      return { ok: false, reasons: result.reasons };
    }
    // 无知识协调器时回退到原有逻辑（保持向后兼容）。
    const it = repos.iterations.get(id);
    if (!it) throw new Error('迭代不存在');
    const project = repos.projects.get(it.projectId);
    if (!project) throw new Error('项目不存在');
    // 门禁：迭代下所有任务必须已归档。
    const tasks = repos.tasks.listByIteration(id);
    const unarchived = tasks.filter((t) => t.status !== 'archived');
    if (unarchived.length > 0) {
      return { ok: false, reasons: [`还有 ${unarchived.length} 个任务未归档：${unarchived.map((t) => t.title).join('、')}`] };
    }
    // 合并迭代分支 -> 主分支（best-effort：非 Git 项目跳过）。
    let mergeResult: { merged: boolean; reason?: string } = { merged: false, reason: '未执行合并（非 Git 项目或无迭代分支）' };
    try {
      if (await branchExists(project.path, sprintBranchName(it.version))) {
        mergeResult = await mergeWorktreeBranch({
          repoPath: project.path,
          branchName: sprintBranchName(it.version),
          defaultBranch: project.defaultBranch,
        });
      } else {
        mergeResult = { merged: true, reason: '迭代分支不存在，跳过合并' };
      }
    } catch (err) {
      mergeResult = { merged: false, reason: (err as Error).message };
    }
    repos.iterations.archive(id, now());
    return { ok: true, merged: mergeResult.merged, reason: mergeResult.reason };
  });

  // ---- 知识库（项目级） ----
  const knowledge = services.knowledge;
  ipcMain.handle(channel('knowledge', 'getProjectSnapshot'), (_e, projectId) =>
    knowledge ? knowledge.lightCheck(projectId) : undefined,
  );
  ipcMain.handle(channel('knowledge', 'startInitialization'), (_e, projectId) =>
    knowledge!.startInitialization(projectId),
  );
  ipcMain.handle(channel('knowledge', 'startAudit'), (_e, projectId, mode) =>
    knowledge!.startAudit(projectId, mode),
  );
  ipcMain.handle(channel('knowledge', 'startRepair'), (_e, projectId, findingIds) =>
    knowledge!.startRepair(projectId, findingIds),
  );
  ipcMain.handle(channel('knowledge', 'getRun'), (_e, runId) => knowledge!.getRun(runId));
  ipcMain.handle(channel('knowledge', 'confirmRun'), (_e, runId) => knowledge!.confirmRun(runId));
  ipcMain.handle(channel('knowledge', 'cancelRun'), (_e, runId) => knowledge!.cancelRun(runId));
  ipcMain.handle(channel('knowledge', 'getTaskEvidence'), (_e, taskId) =>
    knowledge!.getTaskEvidence(taskId),
  );
  ipcMain.handle(channel('knowledge', 'getIterationVerification'), (_e, iterationId) =>
    knowledge!.getIterationVerification(iterationId),
  );

  // ---- 需求 ----
  ipcMain.handle(channel('requirements', 'list'), (_e, iterationId) => repos.requirements.listByIteration(iterationId));
  ipcMain.handle(channel('requirements', 'get'), (_e, id) => repos.requirements.get(id));
  ipcMain.handle(channel('requirements', 'create'), (_e, iterationId, title, description, priority, acceptance) => {
    const r = {
      id: randomId(),
      iterationId,
      title,
      description,
      priority,
      acceptance,
      createdAt: now(),
      archived: false,
    };
    repos.requirements.insert(r);
    return r;
  });
  ipcMain.handle(channel('requirements', 'update'), (_e, r) => repos.requirements.update(r));
  ipcMain.handle(channel('requirements', 'archive'), (_e, id) => {
    const req = repos.requirements.get(id);
    if (!req) throw new Error('需求不存在');
    const tasks = repos.tasks.listByRequirement(id);
    const gate = canArchiveRequirement(tasks);
    if (!gate.ok) throw new Error(gate.reasons.join('; '));
    repos.requirements.archive(id, now());
  });

  // ---- 任务 ----
  ipcMain.handle(channel('tasks', 'listByIteration'), (_e, iterationId) => repos.tasks.listByIteration(iterationId));
  ipcMain.handle(channel('tasks', 'listByProject'), (_e, projectId) => repos.tasks.listByProject(projectId));
  ipcMain.handle(channel('tasks', 'listAll'), () => repos.tasks.list());
  ipcMain.handle(channel('tasks', 'listByRequirement'), (_e, requirementId) => repos.tasks.listByRequirement(requirementId));
  ipcMain.handle(channel('tasks', 'get'), (_e, id) => repos.tasks.get(id));
  // 子任务删除（硬删除 + 依赖守卫）：被同需求下其它任务的 dependsOn 引用时拒绝删除，返回阻塞列表。
  ipcMain.handle(channel('tasks', 'delete'), (_e, id: string): { ok: true } | { ok: false; blockedBy: { id: string; title: string }[] } => {
    const task = repos.tasks.get(id);
    if (!task) throw new Error('任务不存在');
    const siblings = repos.tasks.listByRequirement(task.requirementId);
    const blockers = siblings.filter((t) => t.id !== id && (t.dependsOn ?? []).includes(id));
    if (blockers.length > 0) {
      return { ok: false, blockedBy: blockers.map((b) => ({ id: b.id, title: b.title })) };
    }
    repos.tasks.delete(id);
    return { ok: true };
  });
  ipcMain.handle(channel('tasks', 'create'), (_e, input) => {
    const req = repos.requirements.get(input.requirementId);
    if (!req) throw new Error('需求不存在');
    const iteration = repos.iterations.get(req.iterationId);
    if (!iteration) throw new Error('迭代不存在');
    const t: Task = {
      id: randomId(),
      requirementId: input.requirementId,
      iterationId: req.iterationId,
      projectId: iteration.projectId,
      title: input.title,
      description: input.description,
      status: 'ready',
      // role/stages 保留为兼容字段（编排器忽略，按泳道派发）。
      role: 'coder',
      stages: [{ id: 'impl', name: '实现', role: 'coder' }],
      currentStage: 0,
      statusChangedAt: now(),
      createdAt: now(),
      updatedAt: now(),
      retryCount: 0,
      dependsOn: input.dependsOn,
      typeLabel: input.typeLabel,
    };
    repos.tasks.insert(t);
    return t;
  });
  // 批量创建（AI 提议）：把草稿 draftId 依赖映射为真实 taskId，并在一个事务内原子落库。
  ipcMain.handle(channel('tasks', 'createBatch'), (_e, input: { requirementId: string; proposals: AiTaskProposal[] }) => {
    const req = repos.requirements.get(input.requirementId);
    if (!req) throw new Error('需求不存在');
    const iteration = repos.iterations.get(req.iterationId);
    if (!iteration) throw new Error('迭代不存在');
    const proposals = input.proposals ?? [];
    const validation = validateProposalDag(proposals);
    if (!validation.ok) throw new Error(`任务依赖不合法：${validation.reasons.join('；')}`);
    // 依赖在前排序，确保被依赖任务先拿到真实 ID。
    const ordered = topoSortProposals(proposals);
    // 已有子任务 taskId 集合：跨批依赖允许引用它们（原样保留）。
    const existing = repos.tasks.listByRequirement(input.requirementId);
    const existingIds = new Set(existing.map((t) => t.id));
    const draftToId = new Map<string, string>();
    const created: Task[] = [];
    for (const p of ordered) {
      const id = randomId();
      draftToId.set(p.draftId, id);
      const dependsOn = (p.dependsOn ?? [])
        .map((d) => {
          if (existingIds.has(d)) return d;          // 已有 taskId：原样保留
          return draftToId.get(d);                    // 同批 draftId：映射为真实 taskId
        })
        .filter((x): x is string => !!x);
      created.push({
        id,
        requirementId: input.requirementId,
        iterationId: req.iterationId,
        projectId: iteration.projectId,
        title: p.title,
        description: p.description,
        status: 'ready',
        // role/stages 保留为兼容字段（编排器忽略，按泳道派发）。
        role: 'coder',
        stages: [{ id: 'impl', name: '实现', role: 'coder' }],
        currentStage: 0,
        statusChangedAt: now(),
        createdAt: now(),
        updatedAt: now(),
        retryCount: 0,
        dependsOn,
        typeLabel: p.typeLabel,
      });
    }
    // 事务化批量插入：任一失败整体回滚，避免落库半成品依赖图。
    repos.tasks.insertMany(created);
    return created;
  });
  ipcMain.handle(channel('tasks', 'update'), (_e, input: UpdateTaskInput) => {
    const t = repos.tasks.get(input.id);
    if (!t) throw new Error('任务不存在');
    if (t.status !== 'ready') {
      throw new Error('仅待开发状态的任务可编辑');
    }
    if (input.title !== undefined) t.title = input.title;
    if (input.description !== undefined) t.description = input.description;
    if (input.role !== undefined) t.role = input.role;
    if (input.typeLabel !== undefined) t.typeLabel = input.typeLabel;
    if (input.dependsOn !== undefined) t.dependsOn = input.dependsOn === null ? [] : input.dependsOn;
    t.updatedAt = now();
    repos.tasks.update(t);
    return t;
  });
  ipcMain.handle(channel('tasks', 'updateStatus'), (_e, id, target: TaskStatus) => {
    const t = repos.tasks.get(id);
    if (!t) throw new Error('任务不存在');
    // 归档必须经人工验收入口（tasks.accept），看板拖拽不得绕过。
    if (target === 'archived') {
      throw new Error('归档需经“验收通过并归档”，不支持直接拖拽归档');
    }
    const req = repos.requirements.get(t.requirementId);
    const hasExec = repos.executions.listByTask(id).length > 0;
    const hasCp = !!repos.checkpoints.getLatest(id);
    // 状态迁移门禁的 hasAgentAssigned 仅判定「是否配置过提供商」（任意 provider 存在），
    // 语义不同于编排器的 hasUsableProvider（启用+有凭证+runtime ready，用于禁止开始新 AI 操作）。
    // 此处为状态迁移（非启动 AI），仅需确认曾配置提供商；真正启动 AI 时由 orchestrator.start 再做 hasUsableProvider 校验。
    const gate = canTransition(t, target, {
      hasAcceptance: !!req?.acceptance,
      hasAgentAssigned: services.providerStore ? services.providerStore.list().length > 0 : true,
      hasArtifacts: hasExec || hasCp,
      hasUserAnswer: !!repos.pendingQuestions.get(id)?.answer,
    });
    if (!gate.ok) throw new Error(`状态迁移被门禁拒绝：${gate.reasons.join('; ')}`);
    repos.tasks.updateStatus(id, target, now());
  });
  // 验收通过并归档：唯一进入 archived 的入口。需 in_review + 有执行产物 + 显式人工验收。
  ipcMain.handle(channel('tasks', 'accept'), async (_e, id) => {
    const t = repos.tasks.get(id);
    if (!t) throw new Error('任务不存在');
    if (t.status !== 'in_review') throw new Error('仅待验收任务可验收归档');
    const hasExec = repos.executions.listByTask(id).length > 0;
    // 同 updateStatus：hasAgentAssigned 仅判定「是否配置过提供商」，非 hasUsableProvider（见上）。
    const gate = canTransition(t, 'archived', {
      hasAcceptance: true,
      hasAgentAssigned: services.providerStore ? services.providerStore.list().length > 0 : true,
      hasArtifacts: hasExec,
      accepted: true,
    });
    if (!gate.ok) throw new Error(`验收归档被门禁拒绝：${gate.reasons.join('; ')}`);
    repos.tasks.updateStatus(id, 'archived', now());
    // 归档后清理 worktree
    await orchestrator.cleanupWorktree(id).catch(() => {});
  });
  // 验收不通过退回（专用）：原因必填并写入任务消息/审计；target=ready 仅改状态，
  // target=in_progress（默认）立即携原因启动修复执行。禁止用无原因的通用 updateStatus 代替。
  ipcMain.handle(channel('tasks', 'reject'), (_e, input: RejectTaskInput) => orchestrator.rejectTask(input));
  ipcMain.handle(channel('tasks', 'pause'), (_e, id, note?: string) => {
    // 手动标记待沟通：转 awaiting_input 并创建澄清交互（供用户补充说明后恢复）。
    return orchestrator.pause(id, note);
  });
  ipcMain.handle(channel('tasks', 'start'), (_e, id) => orchestrator.start(id));
  ipcMain.handle(channel('tasks', 'resume'), (_e, id, answer) => orchestrator.resume(id, answer));
  ipcMain.handle(channel('tasks', 'resolveInteraction'), (_e, id, interactionId, response) => orchestrator.resolveInteraction(id, interactionId, response));
  ipcMain.handle(channel('tasks', 'cancel'), (_e, id) => orchestrator.cancel(id));
  ipcMain.handle(channel('tasks', 'retry'), (_e, id) => orchestrator.retry(id));
  ipcMain.handle(channel('tasks', 'logs'), (_e, id) => repos.logs.listByTask(id));
  ipcMain.handle(channel('tasks', 'executions'), (_e, id) => repos.executions.listByTask(id));
  ipcMain.handle(channel('tasks', 'pendingQuestion'), (_e, id) => repos.pendingQuestions.get(id));
  ipcMain.handle(channel('tasks', 'messages'), (_e, id) => repos.taskMessages.listByTask(id));
  ipcMain.handle(channel('tasks', 'interactions'), (_e, id) => repos.pendingInteractions.listByTask(id));

  // ---- 通知规则 ----
  ipcMain.handle(channel('notificationRules', 'list'), () => repos.notificationRules.list());
  ipcMain.handle(channel('notificationRules', 'create'), (_e, rule) => {
    const r = { ...rule, id: rule.id || randomId() };
    repos.notificationRules.insert(r);
    return r;
  });
  ipcMain.handle(channel('notificationRules', 'update'), (_e, r) => repos.notificationRules.update(r));
  ipcMain.handle(channel('notificationRules', 'delete'), (_e, id) => repos.notificationRules.delete(id));

  // ---- Webhook ----
  const mask = (w: { id: string; name: string; url: string; secret: string; events: string[]; enabled: boolean; createdAt: number }) => ({ ...w, secret: '' });
  ipcMain.handle(channel('webhooks', 'list'), () => repos.webhookConfigs.list().map(mask));
  ipcMain.handle(channel('webhooks', 'create'), (_e, input) => {
    const w = {
      id: randomId(),
      name: input.name,
      url: input.url,
      secret: encryptSecret(input.secret || ''),
      events: input.events,
      enabled: true,
      createdAt: now(),
    };
    repos.webhookConfigs.insert(w);
    return mask(w);
  });
  ipcMain.handle(channel('webhooks', 'update'), (_e, w) => {
    const existing = repos.webhookConfigs.get(w.id);
    if (!existing) throw new Error('webhook 不存在');
    const updated = {
      ...w,
      secret: w.secret ? encryptSecret(w.secret) : existing.secret,
      createdAt: existing.createdAt,
    };
    repos.webhookConfigs.update(updated);
    return mask(updated);
  });
  ipcMain.handle(channel('webhooks', 'delete'), (_e, id) => repos.webhookConfigs.delete(id));
  ipcMain.handle(channel('webhooks', 'test'), async (_e, id) => {
    const w = repos.webhookConfigs.get(id);
    if (!w) throw new Error('webhook 不存在');
    const plain = { ...w, secret: decryptSecret(w.secret) };
    const res = await webhooks.test(plain);
    return { ok: res.ok, status: res.status, attempts: res.attempts };
  });
  ipcMain.handle(channel('webhooks', 'deliveries'), (_e, id) => repos.webhookDeliveries.listByWebhook(id));

  // ---- 设置：语言 / AI 服务商 ----
  ipcMain.handle(channel('settings', 'getLocale'), () => {
    const raw = repos.credentials.get('locale');
    return raw === 'en' ? 'en' : 'zh';
  });
  ipcMain.handle(channel('settings', 'setLocale'), (_e, locale) => {
    repos.credentials.upsert('locale', locale);
  });
  ipcMain.handle(channel('settings', 'getProjectSettings'), (_e, projectId) => repos.projects.get(projectId)?.settings ?? {});
  ipcMain.handle(channel('settings', 'updateProjectSettings'), (_e, projectId, settings) => repos.projects.updateSettings(projectId, settings));
  ipcMain.handle(channel('settings', 'getTheme'), () => readThemeMode());
  ipcMain.handle(channel('settings', 'setTheme'), (_e, mode: ThemeMode) => {
    repos.credentials.upsert('theme', mode);
    nativeTheme.themeSource = mode;
    send({ kind: 'theme-changed', taskId: '', data: { mode, resolved: resolvedTheme(mode) } });
  });
  // 同步返回解析后主题，供 preload 在首绘前设置 <html> class（避免亮色启动闪黑）。
  ipcMain.on('ai-devflow:theme:resolved', (e) => {
    e.returnValue = resolvedTheme(readThemeMode());
  });

  // ---- AI 服务商（有序提供商列表，Pi-only；脱敏契约，不暴露模型/密钥/credentialRef） ----
  const providerStore = services.providerStore;
  const healthView = (providerId: string, config?: ProviderConfig): 'available' | 'untested' | 'cooldown' | 'configuration_error' => {
    if (config && !hasModelConfig(config)) return 'configuration_error';
    const hs = repos.providerHealth.listByProvider(providerId);
    if (hs.length === 0) return 'untested';
    const nowMs = Date.now();
    if (hs.some((h) => h.lastFailureKind === 'authentication')) return 'configuration_error';
    if (hs.some((h) => h.state === 'open' && (h.cooldownUntil === undefined || h.cooldownUntil > nowMs))) return 'cooldown';
    return 'available';
  };
  ipcMain.handle(channel('providers', 'list'), () => {
    const configs = new Map((providerStore?.listConfigs() ?? []).map((c) => [c.id, c] as const));
    return (providerStore?.list() ?? []).map((p) => ({ ...p, health: healthView(p.id, configs.get(p.id)) }));
  });
  ipcMain.handle(channel('providers', 'save'), (_e, input) => {
    if (!providerStore) throw new Error('provider store 不可用');
    const summary = providerStore.save(input);
    const config = providerStore.listConfigs().find((c) => c.id === summary.id);
    return { ...summary, health: healthView(summary.id, config) };
  });
  ipcMain.handle(channel('providers', 'remove'), (_e, id: string) => {
    providerStore?.remove(id);
  });
  ipcMain.handle(channel('providers', 'reorder'), (_e, ids: string[]) => {
    providerStore?.reorder(ids);
  });
  ipcMain.handle(channel('providers', 'health'), () =>
    (providerStore?.listConfigs() ?? []).map((p) => ({ providerId: p.id, status: healthView(p.id, p) })),
  );
  const migrationStatus = () => {
    const state = services.initializationStatus?.credentialMigration;
    return { state: state === 'needs_reentry' || state === 'failed' ? state : 'ready' } as const;
  };
  ipcMain.handle(channel('providers', 'migrationStatus'), migrationStatus);
  ipcMain.handle(channel('providers', 'completeReentry'), (_e, input) => {
    if (!providerStore) throw new Error('provider store 不可用');
    if (migrationStatus().state === 'ready') throw new Error('当前没有待完成的旧配置迁移');
    const summary = providerStore.completeLegacyReentry(input);
    services.initializationStatus = {
      credentialMigration: 'migrated',
      runtime: services.initializationStatus?.runtime ?? 'unavailable',
    };
    const config = providerStore.listConfigs().find((c) => c.id === summary.id);
    return { ...summary, health: healthView(summary.id, config) };
  });
  // 测试连接：经 ProviderRouter 解析该提供商的可用路线并做一次最小 Pi 探测。
  ipcMain.handle(channel('providers', 'test'), (_e, id: string) => {
    if (!services.piAi) return { ok: false, providerId: id, status: 0, error: 'provider 未就绪' };
    return services.piAi.testConnection(id);
  });
  // 列出兼容网关可用模型：解析 provider 配置与密钥后调用 fetchCompatibleModels。
  // 标准提供商返回空数组；密钥仅在 Main 进程内使用，不进入 Renderer。
  ipcMain.handle(channel('providers', 'listModels'), async (_e, id: string) => {
    if (!providerStore) throw new Error('provider store 不可用');
    const config = providerStore.listConfigs().find((p) => p.id === id);
    if (!config) throw new Error('提供商不存在');
    const secret = providerStore.resolveSecret(id) ?? '';
    if (!services.piAi) throw new Error('AI 服务未就绪');
    return services.piAi.listModels(config, secret);
  });

  // ---- Agent 模型覆盖（按 agent 钉选 provider+model；无密钥） ----
  ipcMain.handle(channel('agent-overrides', 'list'), () => providerStore?.listAgentOverrides() ?? []);
  ipcMain.handle(channel('agent-overrides', 'save'), (_e, o: AgentModelOverride) => {
    if (!providerStore) throw new Error('provider store 不可用');
    providerStore.saveAgentOverride(o);
    return providerStore.listAgentOverrides();
  });
  ipcMain.handle(channel('agent-overrides', 'remove'), (_e, agentKey: AgentKey) => {
    if (!providerStore) throw new Error('provider store 不可用');
    providerStore.removeAgentOverride(agentKey);
    return providerStore.listAgentOverrides();
  });

  // ---- 自动更新 ----
  ipcMain.handle(channel('updates', 'check'), () => updater.check());
  ipcMain.handle(channel('updates', 'installUpdate'), () => updater.installUpdate());
  ipcMain.handle(channel('updates', 'status'), () => updater.status());

  // ---- AI 沟通：流式对话 + 结构化草稿（任务 / 需求） ----
  ipcMain.on('ai-devflow:ai:chat', async (_e, payload: { sessionId: string; messages: AiChatMessage[]; mode?: 'task' | 'requirement' | 'task_proposal'; context?: string; projectPath?: string }) => {
    if (!services.piAi) {
      sendAi({ type: 'error', sessionId: payload.sessionId, error: '应用运行组件未就绪' });
      return;
    }
    if (!providerStore?.list().length) {
      sendAi({ type: 'error', sessionId: payload.sessionId, error: '尚未配置 AI 服务商，请在“设置 -> AI 服务商”中填写。' });
      return;
    }
    let knowledgeManifest: KnowledgeRetrievalManifest | undefined;
    let knowledgeReads: KnowledgeReadEvidence[] = [];
    try {
      const knowledgeProject = payload.projectPath
        ? repos.projects.list().find((project) => project.path === payload.projectPath)
        : undefined;
      if ((payload.mode === 'requirement' || payload.mode === 'task_proposal') && !knowledgeProject) {
        throw new Error('创建需求或任务时必须选择已注册项目');
      }
      const prompt = [payload.context, ...payload.messages.map((message) => message.content)].filter(Boolean).join('\n\n');
      knowledgeManifest = services.knowledge && knowledgeProject
        ? await services.knowledge.prepareChatContext({
            projectId: knowledgeProject.id,
            expert: chatKnowledgeExpert(payload.mode),
            stage: payload.mode === 'requirement' ? 'requirement_chat' : payload.mode === 'task_proposal' ? 'task_proposal' : 'task_chat',
            prompt,
            repoPath: knowledgeProject.path,
          })
        : undefined;
      const materializedKnowledge = knowledgeManifest && knowledgeProject
        ? await materializeKnowledgeContext(knowledgeProject.path, knowledgeManifest)
        : undefined;
      knowledgeReads = materializedKnowledge?.reads ?? [];
      if (knowledgeManifest && materializedKnowledge?.skipped.length) {
        knowledgeManifest = {
          ...knowledgeManifest,
          skipped: [...knowledgeManifest.skipped, ...materializedKnowledge.skipped],
        };
      }
      const knowledgeContext = knowledgeManifest
        ? serializeChatKnowledgeManifest(knowledgeManifest, materializedKnowledge?.content)
        : undefined;
      const fullText = await services.piAi.chat(payload.messages, (delta) => sendAi({ type: 'delta', sessionId: payload.sessionId, text: delta }), {
        mode: payload.mode,
        context: [knowledgeContext, payload.context].filter(Boolean).join('\n\n') || undefined,
        projectPath: knowledgeProject?.path,
        onToolResult: (toolName, payloadDraft) => {
          if (toolName === 'ai_devflow_propose_requirement' && payloadDraft && typeof payloadDraft === 'object') {
            const d = payloadDraft as { title?: unknown; description?: unknown; acceptance?: unknown; priority?: unknown };
            if (typeof d.title === 'string' && typeof d.description === 'string' && typeof d.acceptance === 'string' && (d.priority === 'low' || d.priority === 'medium' || d.priority === 'high')) {
              sendAi({ type: 'requirement_proposal', sessionId: payload.sessionId, draft: { title: d.title, description: d.description, acceptance: d.acceptance, priority: d.priority } });
            }
          } else if (toolName === 'ai_devflow_propose_task' && payloadDraft && typeof payloadDraft === 'object') {
            // task_proposer 在方案确定后调用工具产出任务草稿：校验 tasks 形态后经 task_proposal 事件回传 UI 填草稿区。
            const t = payloadDraft as { tasks?: unknown };
            const arr = Array.isArray(t.tasks) ? t.tasks : [];
            const tasks = arr
              .map((x, i) => {
                if (!x || typeof x !== 'object') return undefined;
                const o = x as { draftId?: unknown; title?: unknown; description?: unknown; typeLabel?: unknown; dependsOn?: unknown };
                if (typeof o.title !== 'string' || typeof o.description !== 'string') return undefined;
                const typeLabel = o.typeLabel === 'frontend' || o.typeLabel === 'backend' || o.typeLabel === 'fullstack' || o.typeLabel === 'integration' ? o.typeLabel : undefined;
                const draftId = typeof o.draftId === 'string' && o.draftId.trim() ? o.draftId.trim() : `t${i + 1}`;
                const dependsOn = Array.isArray(o.dependsOn) ? o.dependsOn.filter((d): d is string => typeof d === 'string') : [];
                return { draftId, title: o.title, description: o.description, typeLabel, dependsOn };
              })
              .filter((x): x is { draftId: string; title: string; description: string; typeLabel: import('@ai-devflow/core').TaskTypeLabel | undefined; dependsOn: string[] } => !!x);
            if (tasks.length > 0) {
              sendAi({ type: 'task_proposal', sessionId: payload.sessionId, tasks });
            }
          }
        },
        onAsk: (toolUseId, tabs, send) => {
          // 问答工具请求：推 question 事件给 renderer，保存 send 供 ai:answer 回灌。
          sendAi({ type: 'question', sessionId: payload.sessionId, toolUseId, tabs: tabs as AskTabs });
          pendingAsks.set(payload.sessionId, { toolUseId, send });
        },
        onConsultUx: async (requirementContext) => {
          // UX 子咨询：产品专家调用 ai_devflow_consult_ux。主进程启动 UX专家 run，同步返回建议。
          if (!services.piAi) return Promise.resolve('UX 子咨询不可用：AI 服务未就绪');
          let uxManifest: KnowledgeRetrievalManifest | undefined;
          let uxReads: KnowledgeReadEvidence[] = [];
          try {
            uxManifest = services.knowledge && knowledgeProject
              ? await services.knowledge.prepareChatContext({
                  projectId: knowledgeProject.id,
                  expert: 'ux',
                  stage: 'ux_consult',
                  prompt: requirementContext,
                  repoPath: knowledgeProject.path,
                })
              : undefined;
            const uxMaterialized = uxManifest && knowledgeProject
              ? await materializeKnowledgeContext(knowledgeProject.path, uxManifest)
              : undefined;
            uxReads = uxMaterialized?.reads ?? [];
            if (uxManifest && uxMaterialized?.skipped.length) {
              uxManifest = {
                ...uxManifest,
                skipped: [...uxManifest.skipped, ...uxMaterialized.skipped],
              };
            }
            const result = await services.piAi.consultUx([
              uxManifest ? serializeChatKnowledgeManifest(uxManifest, uxMaterialized?.content) : undefined,
              requirementContext,
            ].filter(Boolean).join('\n\n'));
            services.knowledge?.completeRetrieval(uxManifest, uxReads, 'completed');
            return result;
          } catch (error) {
            services.knowledge?.completeRetrieval(uxManifest, uxReads, 'failed');
            throw error;
          }
        },
      });
      services.knowledge?.completeRetrieval(knowledgeManifest, knowledgeReads, 'completed');
      pendingAsks.delete(payload.sessionId);
      sendAi({ type: 'done', sessionId: payload.sessionId, fullText });
    } catch (e) {
      services.knowledge?.completeRetrieval(knowledgeManifest, knowledgeReads, 'failed');
      pendingAsks.delete(payload.sessionId);
      sendAi({ type: 'error', sessionId: payload.sessionId, error: (e as Error).message });
    }
  });
  // 问答工具答案回灌：renderer 提交后经 IPC send 到 main，转成 ask_answer 发回子进程。
  ipcMain.on('ai-devflow:ai:answer', (_e, payload: { sessionId: string; toolUseId: string; answers: AskAnswer }) => {
    const pending = pendingAsks.get(payload.sessionId);
    if (pending && pending.toolUseId === payload.toolUseId) {
      pending.send({ kind: 'ask_answer', toolUseId: payload.toolUseId, answers: payload.answers });
      pendingAsks.delete(payload.sessionId);
    }
  });
  ipcMain.handle(channel('ai', 'proposeRequirement'), async (_e, messages: AiChatMessage[]) => {
    if (!services.piAi) throw new Error('应用运行组件未就绪');
    if (!providerStore?.list().length) throw new Error('尚未配置 AI 服务商，请在“设置 -> AI 服务商”中填写。');
    return services.piAi.proposeRequirement(messages);
  });

  timeoutEngine.start();
}
