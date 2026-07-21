// IPC 处理器注册。每个 ns:method 对应一个显式通道；不存在任意命令执行入口。
// 安全：路径校验、状态门禁、敏感字段加密落盘。
import { ipcMain, dialog, BrowserWindow, nativeTheme } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Services } from './services.js';
import type { StreamEvent, AiStreamEvent, CreateProjectAtInput, UpdateTaskInput } from './api.js';
import type { AiChatMessage, AiTaskProposal, Task, TaskStatus, ThemeMode, RejectTaskInput } from '@ai-devflow/core';
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
import { chatStream, proposeTasks, proposeRequirement, testConnection } from './ai.js';

const channel = (ns: string, method: string) => `ai-devflow:${ns}:${method}`;

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
  const { repos, orchestrator, timeoutEngine, webhooks, registry, encryptSecret, decryptSecret, updater } = services;

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
  ipcMain.handle(channel('projects', 'create'), (_e, input) => {
    const nv = validateProjectName(input.name);
    if (!nv.ok) throw new Error(nv.errors.join('; '));
    const pv = validateLocalPath(input.path);
    if (!pv.ok) throw new Error(pv.errors.join('; '));
    const project = {
      id: randomId(),
      name: input.name.trim(),
      path: input.path,
      defaultBranch: input.defaultBranch || 'main',
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
  ipcMain.handle(channel('iterations', 'create'), (_e, projectId, name, version) => {
    const it = { id: randomId(), projectId, name, version, status: 'active' as const, createdAt: now() };
    repos.iterations.insert(it);
    return it;
  });
  ipcMain.handle(channel('iterations', 'archive'), (_e, id) => repos.iterations.archive(id));

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
      agentType: input.agentType,
      role: input.role,
      stages: [{ id: 'impl', name: '实现', role: input.role }],
      currentStage: 0,
      statusChangedAt: now(),
      createdAt: now(),
      updatedAt: now(),
      retryCount: 0,
      dependsOn: input.dependsOn,
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
    const draftToId = new Map<string, string>();
    const created: Task[] = [];
    for (const p of ordered) {
      const id = randomId();
      draftToId.set(p.draftId, id);
      const dependsOn = (p.dependsOn ?? [])
        .map((d) => draftToId.get(d))
        .filter((x): x is string => !!x);
      created.push({
        id,
        requirementId: input.requirementId,
        iterationId: req.iterationId,
        projectId: iteration.projectId,
        title: p.title,
        description: p.description,
        status: 'ready',
        role: p.role,
        stages: [{ id: 'impl', name: '实现', role: p.role }],
        currentStage: 0,
        statusChangedAt: now(),
        createdAt: now(),
        updatedAt: now(),
        retryCount: 0,
        dependsOn,
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
    if (input.agentType !== undefined) t.agentType = input.agentType || undefined;
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

  // ---- Agent ----
  ipcMain.handle(channel('agents', 'detectAll'), async () => {
    const types = ['claude_code', 'codex', 'pi'] as const;
    return Promise.all(types.map((t) => registry.require(t).detect()));
  });
  ipcMain.handle(channel('agents', 'detect'), (_e, type) => registry.require(type).detect());
  ipcMain.handle(channel('agents', 'capabilities'), () => {
    const out: Record<string, unknown> = {};
    for (const a of registry.list()) out[a.id] = a.capabilities();
    return out;
  });

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
  ipcMain.handle(channel('settings', 'getAiProvider'), () => {
    const raw = repos.credentials.get('ai_provider');
    if (!raw) return undefined;
    try {
      const cfg = JSON.parse(decryptSecret(raw)) as { provider: 'anthropic' | 'openai'; apiKey: string; baseURL?: string; model: string };
      // 密钥不回传明文（与 webhook secret 一致）；Renderer 用 apiKey 留空表示不修改。
      return { provider: cfg.provider, apiKey: '', baseURL: cfg.baseURL, model: cfg.model };
    } catch {
      return undefined;
    }
  });
  ipcMain.handle(channel('settings', 'setAiProvider'), (_e, cfg) => {
    if (!cfg) {
      repos.credentials.delete('ai_provider');
      return;
    }
    // apiKey 为空表示沿用既有密钥。
    let apiKey = cfg.apiKey;
    if (!apiKey) {
      const raw = repos.credentials.get('ai_provider');
      if (raw) {
        try { apiKey = (JSON.parse(decryptSecret(raw)) as { apiKey: string }).apiKey ?? ''; } catch { /* ignore */ }
      }
    }
    repos.credentials.upsert('ai_provider', encryptSecret(JSON.stringify({ ...cfg, apiKey })));
  });
  // 测试连接：用最小请求探测最终地址，返回 HTTP 状态与脱敏后的服务端摘要（绝不记录 API Key）。
  ipcMain.handle(channel('settings', 'testAiProvider'), async (_e, cfg) => {
    // apiKey 为空时沿用已存密钥（与 setAiProvider 一致），便于保存后直接测试。
    let apiKey = cfg?.apiKey;
    if (!apiKey) {
      const raw = repos.credentials.get('ai_provider');
      if (raw) {
        try { apiKey = (JSON.parse(decryptSecret(raw)) as { apiKey: string }).apiKey ?? ''; } catch { /* ignore */ }
      }
    }
    return testConnection({ ...(cfg ?? {}), apiKey: apiKey ?? '' });
  });
  // 全局 Agent 能力默认配置（明文 JSON，非密钥）：项目可按角色/字段覆盖（item 12）。
  ipcMain.handle(channel('settings', 'getGlobalAgentConfig'), () => {
    const raw = repos.credentials.get('global_agent_config');
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { return {}; }
  });
  ipcMain.handle(channel('settings', 'setGlobalAgentConfig'), (_e, config) => {
    repos.credentials.upsert('global_agent_config', JSON.stringify(config ?? {}));
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

  // ---- 自动更新 ----
  ipcMain.handle(channel('updates', 'check'), () => updater.check());
  ipcMain.handle(channel('updates', 'installUpdate'), () => updater.installUpdate());
  ipcMain.handle(channel('updates', 'status'), () => updater.status());

  // ---- AI 沟通：流式对话 + 结构化草稿（任务 / 需求） ----
  ipcMain.on('ai-devflow:ai:chat', async (_e, payload: { sessionId: string; messages: AiChatMessage[]; mode?: 'task' | 'requirement'; context?: string }) => {
    const raw = repos.credentials.get('ai_provider');
    if (!raw) {
      sendAi({ type: 'error', sessionId: payload.sessionId, error: '尚未配置 AI 服务商，请在“设置 -> AI 服务商”中填写。' });
      return;
    }
    let cfg;
    try {
      cfg = JSON.parse(decryptSecret(raw));
    } catch {
      sendAi({ type: 'error', sessionId: payload.sessionId, error: 'AI 服务商配置损坏，请重新填写。' });
      return;
    }
    await chatStream(cfg, payload.sessionId, payload.messages, sendAi, { mode: payload.mode, context: payload.context });
  });
  ipcMain.handle(channel('ai', 'propose'), async (_e, messages: AiChatMessage[], context?: string) => {
    const raw = repos.credentials.get('ai_provider');
    if (!raw) throw new Error('尚未配置 AI 服务商，请在“设置 -> AI 服务商”中填写。');
    const cfg = JSON.parse(decryptSecret(raw));
    return proposeTasks(cfg, messages, context);
  });
  ipcMain.handle(channel('ai', 'proposeRequirement'), async (_e, messages: AiChatMessage[]) => {
    const raw = repos.credentials.get('ai_provider');
    if (!raw) throw new Error('尚未配置 AI 服务商，请在“设置 -> AI 服务商”中填写。');
    const cfg = JSON.parse(decryptSecret(raw));
    return proposeRequirement(cfg, messages);
  });

  timeoutEngine.start();
}
