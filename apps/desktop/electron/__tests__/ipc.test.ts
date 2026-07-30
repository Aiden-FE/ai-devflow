import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// Mock 'electron'：捕获 ipcMain.handle 注册的处理器，其余为 no-op。
const { openPathMock } = vi.hoisted(() => ({ openPathMock: vi.fn(async () => '') }));
const handlers = new Map<string, (...args: unknown[]) => unknown>();
const syncHandlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...args: unknown[]) => unknown) => handlers.set(ch, fn),
    on: (ch: string, fn: (...args: unknown[]) => unknown) => syncHandlers.set(ch, fn),
  },
  ipcRenderer: { sendSync: () => 'dark' },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: { toString: () => string }) => Buffer.from(b.toString(), 'base64').toString('utf8'),
  },
  app: { getPath: () => '/tmp', isPackaged: false, getVersion: () => '0.0.0', whenReady: () => Promise.resolve(), on: () => {} },
  nativeTheme: { themeSource: 'system', shouldUseDarkColors: false, on: () => {} },
  Notification: class { on() { return this; } show() {} },
  BrowserWindow: class { static fromWebContents() { return null; } },
  session: { defaultSession: { webRequest: { onHeadersReceived() {} } } },
  protocol: { handle() {} },
  shell: { openExternal() {}, openPath: openPathMock },
}));

import { openDatabase, createRepositories, type Repositories } from '@ai-devflow/persistence';
import { KnowledgeCoordinator, Orchestrator } from '@ai-devflow/scheduler';
import { ProjectKnowledgeService } from '@ai-devflow/knowledge';
import { TimeoutEngine, WebhookSender, NullNotifier } from '@ai-devflow/notifications';
import { encryptSecret, decryptSecret } from '../credentials.js';
import { registerIpc, deriveProjectName } from '../ipc.js';
import type { Services } from '../services.js';
import type { Updater } from '../updater.js';
import type { StreamEvent, AiStreamEvent } from '../api.js';
import type { DatabaseSync } from '@ai-devflow/persistence';
import { now, VISIBLE_LANES, type TaskStatus } from '@ai-devflow/core';
import { ProviderStore } from '../provider-store.js';
import { createPiAiService } from '../pi-ai.js';
import type { PiTextExecutor } from '../pi-ai.js';
import { RetentionService } from '../retention.js';

// no-op 更新器（dev 下 createUpdater 也返回 no-op，这里显式构造供测试装配）。
const noopUpdater: Updater = {
  start(onStatus) { onStatus({ state: 'idle', currentVersion: '0.0.0' }); },
  async check() {},
  async installUpdate() { return { ok: false, error: '当前为开发/未打包环境，自动更新不可用。' }; },
  status() { return { state: 'idle', currentVersion: '0.0.0' }; },
};

let db: DatabaseSync;
let repos: Repositories;
let services: Services;
let workdir: string;
let sent: StreamEvent[];
let sentAi: AiStreamEvent[];
let aiRequests: Array<{ workload: string; messages: import('@ai-devflow/core').AiChatMessage[] }>;
let uxConsultationContext: string | undefined;

function initGitRepo(path: string, branch = 'main'): void {
  execFileSync('git', ['init', '-q', '-b', branch, path], { stdio: 'ignore' });
  execFileSync('git', ['-C', path, 'config', 'user.email', 't@t'], { stdio: 'ignore' });
  execFileSync('git', ['-C', path, 'config', 'user.name', 't'], { stdio: 'ignore' });
  writeFileSync(join(path, 'README.md'), 'x');
  execFileSync('git', ['-C', path, 'add', '.'], { stdio: 'ignore' });
  execFileSync('git', ['-C', path, 'commit', '-qm', 'init'], { stdio: 'ignore' });
}

function buildServices() {
  // Pi-only 编排器使用单一 AgentRunner；reviewer 与 dev 均产出含 PASS 结论的 done（供审查解析）。
  const runner: import('@ai-devflow/agents').AgentRunner = {
    async verifyRuntime() {
      return { version: 'fake', entry: 'fake' };
    },
    async run() {
      return {
        events: (async function* () {
          yield { type: 'done', summary: 'ok\nREVIEW_VERDICT: PASS', result: { kind: 'task_review', review: { pass: true, summary: 'REVIEW_VERDICT: PASS' }, knowledgeAssessment: { verdict: 'none', reason: '无沉淀价值', evidence: ['x.ts'] } }, t: 0 } as import('@ai-devflow/core').AgentEvent;
        })(),
        cancel: async () => {},
        done: async () => ({ exitCode: 0, ok: true }),
      };
    },
  };
  const knowledge = new KnowledgeCoordinator({
    repos,
    runner,
    knowledge: new ProjectKnowledgeService(),
    worktreesBaseDir: join(workdir, 'knowledge-worktrees'),
  });
  const orchestrator = new Orchestrator(repos, runner, {
    worktreesBaseDir: workdir, maxConcurrent: 2, autoRetry: false, knowledgeCoordinator: knowledge,
  });
  const webhooks = new WebhookSender(repos, { maxAttempts: 1, timeoutMs: 1000 });
  const timeoutEngine = new TimeoutEngine(repos, new NullNotifier(), webhooks, { intervalMs: 999_999_999 });

  const values = new Map<string, string>();
  const providerStore = new ProviderStore(
    {
      get: (k) => values.get(k),
      upsert: (k, v) => values.set(k, v),
      delete: (k) => values.delete(k),
      transaction: <T>(fn: () => T) => fn(),
    },
    {
      encrypt: (v) => `enc:${Buffer.from(v).toString('base64')}`,
      decrypt: (v) => Buffer.from(v.slice(4), 'base64').toString(),
    },
    () => undefined,
  );
  const fakeExecutor: PiTextExecutor = async (workload, messages, _onDelta, _options, _onToolResult, _onAsk, onConsultUx) => {
    aiRequests.push({ workload, messages });
    if (workload === 'requirement_chat' && uxConsultationContext && onConsultUx) {
      await onConsultUx(uxConsultationContext);
    }
    if (workload === 'requirement_proposal') return '{"title":"T","description":"D","acceptance":"A","priority":"medium"}';
    return 'hello';
  };
  const piAi = createPiAiService(fakeExecutor);

  return { orchestrator, knowledge, webhooks, timeoutEngine, providerStore, piAi } satisfies Partial<Services>;
}

beforeEach(() => {
  db = openDatabase(':memory:');
  repos = createRepositories(db);
  workdir = mkdtempSync(join(tmpdir(), 'aidf-ipc-'));
  sent = [];
  sentAi = [];
  aiRequests = [];
  uxConsultationContext = undefined;
  handlers.clear();
  const built = buildServices();
  services = {
    repos,
    orchestrator: built.orchestrator,
    knowledge: built.knowledge,
    webhooks: built.webhooks,
    timeoutEngine: built.timeoutEngine,
    providerStore: built.providerStore,
    piAi: built.piAi,
    dbPath: ':memory:',
    worktreesBaseDir: workdir,
    encryptSecret,
    decryptSecret,
    updater: noopUpdater,
    retention: new RetentionService(db, repos, { now: () => 1_000_000 }),
  };
  registerIpc(services, (e) => sent.push(e), (e) => sentAi.push(e));
});

afterEach(() => {
  services.timeoutEngine.stop();
  try { db.close(); } catch { /* */ }
  rmSync(workdir, { recursive: true, force: true });
});

// 用 Promise.resolve().then() 包装，把处理器同步抛错转为 rejected promise（与 Electron 行为一致）。
const call = (ns: string, method: string, ...args: unknown[]) =>
  Promise.resolve().then(() => handlers.get(`ai-devflow:${ns}:${method}`)!({}, ...args));

// 触发 ipcMain.on 注册的事件处理器（ai:chat 等流式事件）。传入伪 event 对象 + payload。
const sendEvent = (ns: string, method: string, ...args: unknown[]): unknown =>
  syncHandlers.get(`ai-devflow:${ns}:${method}`)!({}, ...args);

describe('typed IPC wiring', () => {
  it('projects.create validates and persists', async () => {
    await expect(call('projects', 'create', { name: '', path: '/x', defaultBranch: 'main' })).rejects.toThrow();
    initGitRepo(workdir, 'main');
    const p = await call('projects', 'create', { name: 'My Proj', path: workdir, defaultBranch: 'main' }) as { id: string };
    expect(repos.projects.get(p.id)).toBeDefined();
    expect((await call('projects', 'list') as unknown[]).length).toBe(1);
  });

  it('projects.create persists the current branch when the requested default is invalid', async () => {
    initGitRepo(workdir, 'master');

    const project = await call('projects', 'create', {
      name: 'Master Repo', path: workdir, defaultBranch: 'main',
    }) as { id: string; defaultBranch: string };

    expect(project.defaultBranch).toBe('master');
    expect(repos.projects.get(project.id)?.defaultBranch).toBe('master');
  });

  it('projects.createAtPath initializes git repo with an initial commit', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'aidf-createAtPath-'));
    try {
      const p = await call('projects', 'createAtPath', { name: 'NewProj', parentDir: parent, gitInit: true, defaultBranch: 'main' }) as { id: string; path: string; defaultBranch: string };
      expect(repos.projects.get(p.id)).toBeDefined();
      expect(p.defaultBranch).toBe('main');
      const rev = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: p.path }).toString().trim();
      expect(rev.length).toBeGreaterThan(0);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('projects.openFolder opens the resolved project path and rejects unknown ids', async () => {
    openPathMock.mockClear();
    const dir = mkdtempSync(join(tmpdir(), 'aidf-open-'));
    repos.projects.insert({ id: 'open-project', name: 'P', path: dir, defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
    const r = (await call('projects', 'openFolder', 'open-project')) as { ok: boolean; error?: string };
    expect(r.ok).toBe(true);
    expect(openPathMock).toHaveBeenCalledWith(dir);
    const bad = (await call('projects', 'openFolder', 'no-such-id')) as { ok: boolean };
    expect(bad.ok).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('tasks.updateStatus cannot bypass dedicated workflow actions', async () => {
    repos.projects.insert({ id: 'p', name: 'P', path: '/x', defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
    repos.iterations.insert({ id: 'i', projectId: 'p', name: 'I', version: 'v1', status: 'active', createdAt: 1 });
    repos.requirements.insert({ id: 'r', iterationId: 'i', title: 'R', description: '', priority: 'medium', acceptance: 'acc', createdAt: 1, archived: false });
    const statuses: TaskStatus[] = ['ready', 'in_review', 'testing', 'archived'];
    for (const status of statuses) {
      repos.tasks.insert({
        id: `t-${status}`, requirementId: 'r', iterationId: 'i', projectId: 'p', title: status, description: '', status,
        role: 'coder', stages: [], currentStage: 0, statusChangedAt: now(), createdAt: now(), updatedAt: now(), retryCount: 0,
      });
    }

    for (const status of statuses) {
      for (const target of VISIBLE_LANES) {
        await expect(call('tasks', 'updateStatus', `t-${status}`, target)).rejects.toThrow(
          '任务状态只能通过启动、验收或驳回操作变更',
        );
        expect(repos.tasks.get(`t-${status}`)?.status).toBe(status);
      }
    }
  });

  it('end-to-end: create -> start -> in_review via IPC', async () => {
    // 在 workdir 初始化真实 git 仓库，使任务分支合并成功。
    execFileSync('git', ['init', '-q', '-b', 'main', workdir], { stdio: 'ignore' });
    execFileSync('git', ['-C', workdir, 'config', 'user.email', 't@t'], { stdio: 'ignore' });
    execFileSync('git', ['-C', workdir, 'config', 'user.name', 't'], { stdio: 'ignore' });
    writeFileSync(join(workdir, 'README.md'), 'x');
    execFileSync('git', ['-C', workdir, 'add', '.'], { stdio: 'ignore' });
    execFileSync('git', ['-C', workdir, 'commit', '-qm', 'init'], { stdio: 'ignore' });
    const p = { id: 'p', name: 'P', path: workdir, defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} };
    repos.projects.insert(p);
    const it = await call('iterations', 'create', p.id, 'I1', 'v1') as { id: string };
    const r = await call('requirements', 'create', it.id, 'Req', 'desc', 'high', 'acceptance') as { id: string };
    const t = await call('tasks', 'create', { requirementId: r.id, title: 'Task', description: 'd', role: 'coder' }) as { id: string; status: string };

    // 预置真实 worktree + 任务分支（使 mergeWorktreeBranch 成功）。
    const task = repos.tasks.get(t.id)!;
    task.worktreePath = join(workdir, 'wt');
    repos.tasks.update(task);
    execFileSync('git', ['-C', workdir, 'worktree', 'add', '-b', `ai-devflow/${task.id}`, task.worktreePath, 'main'], { stdio: 'ignore' });

    expect(t.status).toBe('ready');
    await call('tasks', 'start', t.id);
    expect(repos.tasks.get(t.id)!.status).toBe('in_review');
    // 事件被转发
    expect(sent.some((e) => e.kind === 'task-status')).toBe(true);
  });

  it('webhooks.create encrypts secret and list returns masked', async () => {
    const w = (await call('webhooks', 'create', { name: 'W', url: 'http://x', secret: 'topsecret', events: ['task.timeout'] })) as { id: string; secret: string };
    expect(w.secret).toBe(''); // 不回传明文
    const stored = repos.webhookConfigs.get(w.id)!;
    expect(stored.secret).not.toBe('topsecret');
    expect(stored.secret.startsWith('b64:')).toBe(true);
    expect(decryptSecret(stored.secret)).toBe('topsecret');
    const list = (await call('webhooks', 'list')) as Array<{ secret: string }>;
    expect(list[0]!.secret).toBe('');
  });

  it('settings locale round-trips via credentials store', async () => {
    await call('settings', 'setLocale', 'en');
    expect(await call('settings', 'getLocale')).toBe('en');
    await call('settings', 'setLocale', 'zh');
    expect(await call('settings', 'getLocale')).toBe('zh');
  });

  it('providers CRUD masks secrets and preserves order', async () => {
    const saved = await call('providers', 'save', {
      id: 'p1', kind: 'openai', displayName: 'Primary', enabled: true,
      priority: 0, authType: 'api_key', apiKey: 'sk-secret', revision: 1,
    }) as Record<string, unknown>;
    expect(saved.hasCredential).toBe(true);
    expect(JSON.stringify(saved)).not.toContain('sk-secret');
    expect(saved).not.toHaveProperty('model');
    expect(saved).not.toHaveProperty('credentialRef');
    expect(await call('providers', 'list')).toEqual([saved]);
  });

  it('providers health reports indefinite authentication failure as configuration_error', async () => {
    await call('providers', 'save', {
      id: 'auth-broken', kind: 'openai', displayName: 'Auth broken', enabled: true,
      priority: 0, authType: 'api_key', apiKey: 'test-key', revision: 1,
      defaultModel: 'gpt-4o',
    });
    repos.providerHealth.upsert({
      providerId: 'auth-broken',
      routeId: 'auth-broken:coder',
      state: 'open',
      consecutiveFailures: 1,
      lastFailureKind: 'authentication',
      updatedAt: Date.now(),
    });

    const listed = await call('providers', 'list') as Array<{ id: string; health: string }>;
    expect(listed.find((provider) => provider.id === 'auth-broken')?.health).toBe('configuration_error');
    const health = await call('providers', 'health') as Array<{ providerId: string; status: string }>;
    expect(health.find((provider) => provider.providerId === 'auth-broken')?.status).toBe('configuration_error');
  });

  it('providers list and health report configuration_error for provider without models', async () => {
    await call('providers', 'save', {
      id: 'no-models', kind: 'openai', displayName: 'No Models', enabled: true,
      priority: 0, authType: 'api_key', apiKey: 'k', revision: 1,
    });
    // No defaultModel or workloadModels set, and no health records.
    const listed = await call('providers', 'list') as Array<{ id: string; health: string }>;
    expect(listed.find((p) => p.id === 'no-models')?.health).toBe('configuration_error');
    const health = await call('providers', 'health') as Array<{ providerId: string; status: string }>;
    expect(health.find((p) => p.providerId === 'no-models')?.status).toBe('configuration_error');
  });

  it('providers expose sanitized migration state and complete credential re-entry', async () => {
    services.initializationStatus = { credentialMigration: 'needs_reentry', runtime: 'ready' };
    expect(await call('providers', 'migrationStatus')).toEqual({ state: 'needs_reentry' });
    expect(JSON.stringify(await call('providers', 'migrationStatus'))).not.toContain('credential');

    const saved = await call('providers', 'completeReentry', {
      id: 'replacement', kind: 'openai_compatible', displayName: 'Replacement', enabled: true,
      priority: 0, authType: 'api_key', apiKey: 'replacement-secret', baseURL: 'https://gateway.example/v1', revision: 1,
    }) as Record<string, unknown>;
    expect(saved).toEqual(expect.objectContaining({ id: 'replacement', hasCredential: true }));
    expect(JSON.stringify(saved)).not.toContain('replacement-secret');
    expect(await call('providers', 'migrationStatus')).toEqual({ state: 'ready' });

    services.initializationStatus = { credentialMigration: 'failed', runtime: 'ready' };
    expect(await call('providers', 'migrationStatus')).toEqual({ state: 'failed' });
  });

  it('requirements.archive gates on all subtasks archived', async () => {
    repos.projects.insert({ id: 'p', name: 'P', path: '/x', defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
    repos.iterations.insert({ id: 'i', projectId: 'p', name: 'I', version: 'v1', status: 'active', createdAt: 1 });
    repos.requirements.insert({ id: 'r', iterationId: 'i', title: 'R', description: '', priority: 'medium', acceptance: 'acc', createdAt: 1, archived: false });
    repos.tasks.insert({ id: 't', requirementId: 'r', iterationId: 'i', projectId: 'p', title: 'T', description: '', status: 'backlog', role: 'coder', stages: [], currentStage: 0, statusChangedAt: now(), createdAt: now(), updatedAt: now(), retryCount: 0 });
    // 子任务未归档 -> 拒绝
    await expect(call('requirements', 'archive', 'r')).rejects.toThrow(/子任务/);
    // 无子任务的需求也拒绝
    repos.requirements.insert({ id: 'r2', iterationId: 'i', title: 'R2', description: '', priority: 'medium', acceptance: '', createdAt: 1, archived: false });
    await expect(call('requirements', 'archive', 'r2')).rejects.toThrow(/无子任务/);
    // 子任务归档后 -> 允许
    repos.tasks.updateStatus('t', 'archived', now());
    await call('requirements', 'archive', 'r');
    expect(repos.requirements.get('r')!.archived).toBe(true);
  });

  it('iterations.archive gates on all tasks archived, then archives', async () => {
    services.knowledge = undefined; // 此用例只覆盖无知识协调器的旧项目归档门禁。
    repos.projects.insert({ id: 'p', name: 'P', path: '/non-git', defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
    repos.iterations.insert({ id: 'it', projectId: 'p', name: 'I', version: 'v1', status: 'active', createdAt: 1 });
    repos.requirements.insert({ id: 'r', iterationId: 'it', title: 'R', description: '', priority: 'medium', acceptance: 'acc', createdAt: 1, archived: false });
    repos.tasks.insert({ id: 't', requirementId: 'r', iterationId: 'it', projectId: 'p', title: 'T', description: '', status: 'in_progress', role: 'coder', stages: [], currentStage: 0, statusChangedAt: now(), createdAt: now(), updatedAt: now(), retryCount: 0 });
    // 有未归档任务 -> 返回 {ok:false}
    const blocked = await call('iterations', 'archive', 'it') as { ok: false; reasons: string[] };
    expect(blocked.ok).toBe(false);
    expect(blocked.reasons.join('；')).toMatch(/未归档/);
    expect(repos.iterations.get('it')!.status).toBe('active');
    // 全部归档后 -> 允许（非 git 项目跳过分支合并）
    repos.tasks.updateStatus('t', 'archived', now());
    const res = await call('iterations', 'archive', 'it') as { ok: true; merged: boolean; reason?: string };
    expect(res.ok).toBe(true);
    expect(repos.iterations.get('it')!.status).toBe('archived');
    expect(repos.iterations.get('it')!.archivedAt).toBeGreaterThan(0);
  });

  it('iterations.create rejects duplicate version within a project', async () => {
    repos.projects.insert({ id: 'p', name: 'P', path: '/non-git', defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
    repos.iterations.insert({ id: 'it', projectId: 'p', name: 'I', version: 'v1', status: 'active', createdAt: 1 });
    await expect(call('iterations', 'create', 'p', 'I2', 'v1')).rejects.toThrow(/已存在/);
  });

  it('iterations.create rejects a non-canonical sprint version before inserting', async () => {
    repos.projects.insert({ id: 'p', name: 'P', path: '/non-git', defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });

    await expect(call('iterations', 'create', 'p', 'I', '.v1')).rejects.toThrow(/版本|Git|规范/);

    expect(repos.iterations.listByProject('p')).toHaveLength(0);
  });

  it('iterations.create refuses to run without the knowledge coordinator', async () => {
    execFileSync('git', ['init', '-q', '-b', 'main', workdir], { stdio: 'ignore' });
    execFileSync('git', ['-C', workdir, 'config', 'user.email', 't@t'], { stdio: 'ignore' });
    execFileSync('git', ['-C', workdir, 'config', 'user.name', 't'], { stdio: 'ignore' });
    writeFileSync(join(workdir, 'README.md'), 'x');
    execFileSync('git', ['-C', workdir, 'add', '.'], { stdio: 'ignore' });
    execFileSync('git', ['-C', workdir, 'commit', '-qm', 'init'], { stdio: 'ignore' });
    repos.projects.insert({ id: 'p', name: 'P', path: workdir, defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
    services.knowledge = undefined;

    await expect(call('iterations', 'create', 'p', 'I', 'v-no-coordinator')).rejects.toThrow(/知识协调器|knowledge coordinator/i);

    expect(() => execFileSync('git', [
      'rev-parse', '--verify', 'refs/heads/ai-devflow-sprint/v-no-coordinator',
    ], { cwd: workdir, stdio: 'pipe' })).toThrow();
    expect(repos.iterations.listByProject('p')).toHaveLength(0);
  });

  it('iterations.create commits iteration documents only to the sprint branch', async () => {
    execFileSync('git', ['init', '-q', '-b', 'main', workdir], { stdio: 'ignore' });
    execFileSync('git', ['-C', workdir, 'config', 'user.email', 't@t'], { stdio: 'ignore' });
    execFileSync('git', ['-C', workdir, 'config', 'user.name', 't'], { stdio: 'ignore' });
    writeFileSync(join(workdir, 'README.md'), 'x');
    execFileSync('git', ['-C', workdir, 'add', '.'], { stdio: 'ignore' });
    execFileSync('git', ['-C', workdir, 'commit', '-qm', 'init'], { stdio: 'ignore' });
    repos.projects.insert({ id: 'p', name: 'P', path: workdir, defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
    services.knowledge = new KnowledgeCoordinator({
      repos,
      runner: { async verifyRuntime() { return { version: 'fake', entry: 'fake' }; }, async run() { throw new Error('unused'); } },
      knowledge: new ProjectKnowledgeService(),
      worktreesBaseDir: join(workdir, 'knowledge-worktrees'),
    });

    const iteration = await call('iterations', 'create', 'p', 'I1', 'v1') as { id: string };

    expect(repos.iterations.get(iteration.id)).toBeDefined();
    expect(() => execFileSync('git', ['show', 'main:docs/iterations/v1/index.md'], { cwd: workdir, stdio: 'pipe' })).toThrow();
    expect(execFileSync('git', ['show', 'ai-devflow-sprint/v1:docs/iterations/v1/index.md'], { cwd: workdir, encoding: 'utf8' })).toContain(iteration.id);
  });

  it('iterations.create repairs a stale project default branch before creating the sprint branch', async () => {
    initGitRepo(workdir, 'master');
    repos.projects.insert({
      id: 'p', name: 'P', path: workdir, defaultBranch: 'main',
      createdAt: 1, updatedAt: 1, settings: {},
    });

    const iteration = await call('iterations', 'create', 'p', 'I1', 'v1') as { id: string };

    expect(repos.projects.get('p')?.defaultBranch).toBe('master');
    expect(repos.iterations.get(iteration.id)).toBeDefined();
    expect(execFileSync('git', [
      'show', 'ai-devflow-sprint/v1:docs/iterations/v1/index.md',
    ], { cwd: workdir, encoding: 'utf8' })).toContain(iteration.id);
  });

  it('iterations.create rolls back a newly created sprint branch when the database insert fails', async () => {
    execFileSync('git', ['init', '-q', '-b', 'main', workdir], { stdio: 'ignore' });
    execFileSync('git', ['-C', workdir, 'config', 'user.email', 't@t'], { stdio: 'ignore' });
    execFileSync('git', ['-C', workdir, 'config', 'user.name', 't'], { stdio: 'ignore' });
    writeFileSync(join(workdir, 'README.md'), 'x');
    execFileSync('git', ['-C', workdir, 'add', '.'], { stdio: 'ignore' });
    execFileSync('git', ['-C', workdir, 'commit', '-qm', 'init'], { stdio: 'ignore' });
    repos.projects.insert({ id: 'p', name: 'P', path: workdir, defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
    services.knowledge = new KnowledgeCoordinator({
      repos,
      runner: { async verifyRuntime() { return { version: 'fake', entry: 'fake' }; }, async run() { throw new Error('unused'); } },
      knowledge: new ProjectKnowledgeService(),
      worktreesBaseDir: join(workdir, 'knowledge-worktrees'),
    });
    repos.iterations.claim = () => { throw new Error('injected database failure'); };

    await expect(call('iterations', 'create', 'p', 'I1', 'v1')).rejects.toThrow(/database failure/);

    expect(() => execFileSync('git', ['rev-parse', '--verify', 'refs/heads/ai-devflow-sprint/v1'], { cwd: workdir, stdio: 'pipe' })).toThrow();
    expect(() => execFileSync('git', ['show', 'main:docs/iterations/v1/index.md'], { cwd: workdir, stdio: 'pipe' })).toThrow();
  });

  it('iterations.create restores rather than deletes a pre-existing sprint branch when the database insert fails', async () => {
    execFileSync('git', ['init', '-q', '-b', 'main', workdir], { stdio: 'ignore' });
    execFileSync('git', ['-C', workdir, 'config', 'user.email', 't@t'], { stdio: 'ignore' });
    execFileSync('git', ['-C', workdir, 'config', 'user.name', 't'], { stdio: 'ignore' });
    writeFileSync(join(workdir, 'README.md'), 'x');
    execFileSync('git', ['-C', workdir, 'add', '.'], { stdio: 'ignore' });
    execFileSync('git', ['-C', workdir, 'commit', '-qm', 'init'], { stdio: 'ignore' });
    execFileSync('git', ['-C', workdir, 'branch', 'ai-devflow-sprint/v1', 'main'], { stdio: 'ignore' });
    const originalSprint = execFileSync('git', ['-C', workdir, 'rev-parse', 'ai-devflow-sprint/v1'], { encoding: 'utf8' }).trim();
    repos.projects.insert({ id: 'p', name: 'P', path: workdir, defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
    services.knowledge = new KnowledgeCoordinator({
      repos,
      runner: { async verifyRuntime() { return { version: 'fake', entry: 'fake' }; }, async run() { throw new Error('unused'); } },
      knowledge: new ProjectKnowledgeService(),
      worktreesBaseDir: join(workdir, 'knowledge-worktrees'),
    });
    repos.iterations.claim = () => { throw new Error('injected database failure'); };

    await expect(call('iterations', 'create', 'p', 'I1', 'v1')).rejects.toThrow(/database failure/);

    expect(execFileSync('git', ['-C', workdir, 'rev-parse', 'ai-devflow-sprint/v1'], { encoding: 'utf8' }).trim()).toBe(originalSprint);
    expect(() => execFileSync('git', ['show', 'ai-devflow-sprint/v1:docs/iterations/v1/index.md'], { cwd: workdir, stdio: 'pipe' })).toThrow();
    expect(() => execFileSync('git', ['show', 'main:docs/iterations/v1/index.md'], { cwd: workdir, stdio: 'pipe' })).toThrow();
  });

  it('tasks.update edits only ready tasks', async () => {
    repos.projects.insert({ id: 'p', name: 'P', path: '/x', defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
    repos.iterations.insert({ id: 'i', projectId: 'p', name: 'I', version: 'v1', status: 'active', createdAt: 1 });
    repos.requirements.insert({ id: 'r', iterationId: 'i', title: 'R', description: '', priority: 'medium', acceptance: 'acc', createdAt: 1, archived: false });
    repos.tasks.insert({ id: 't', requirementId: 'r', iterationId: 'i', projectId: 'p', title: 'Old', description: '', status: 'ready', role: 'coder', stages: [], currentStage: 0, statusChangedAt: now(), createdAt: now(), updatedAt: now(), retryCount: 0 });
    const updated = (await call('tasks', 'update', { id: 't', title: 'New', role: 'reviewer' })) as { title: string; role: string };
    expect(updated.title).toBe('New');
    expect(repos.tasks.get('t')!.role).toBe('reviewer');
    // 非可编辑状态拒绝
    repos.tasks.updateStatus('t', 'in_progress', now());
    await expect(call('tasks', 'update', { id: 't', title: 'X' })).rejects.toThrow(/编辑/);
  });

  it('tasks.pause marks awaiting_input with pausedFrom', async () => {
    repos.projects.insert({ id: 'p', name: 'P', path: '/x', defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
    repos.iterations.insert({ id: 'i', projectId: 'p', name: 'I', version: 'v1', status: 'active', createdAt: 1 });
    repos.requirements.insert({ id: 'r', iterationId: 'i', title: 'R', description: '', priority: 'medium', acceptance: 'acc', createdAt: 1, archived: false });
    repos.tasks.insert({ id: 't', requirementId: 'r', iterationId: 'i', projectId: 'p', title: 'T', description: '', status: 'in_progress', role: 'coder', stages: [], currentStage: 0, statusChangedAt: now(), createdAt: now(), updatedAt: now(), retryCount: 0 });
    await call('tasks', 'pause', 't');
    const t = repos.tasks.get('t')!;
    expect(t.status).toBe('awaiting_input');
    expect(t.pausedFrom).toBe('in_progress');
  });

  it('tasks.create persists dependsOn and start blocks on unmet dependency', async () => {
    repos.projects.insert({ id: 'p-deps', name: 'P', path: '/abs', defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
    const it = { id: 'it-deps', projectId: 'p-deps', name: 'I1', version: 'v1', status: 'active' as const, createdAt: 1 };
    repos.iterations.insert(it);
    const r = await call('requirements', 'create', it.id, 'Req', 'desc', 'high', 'acceptance') as { id: string };
    const pred = await call('tasks', 'create', { requirementId: r.id, title: 'Pred', description: '', role: 'coder' }) as { id: string };
    const succ = await call('tasks', 'create', { requirementId: r.id, title: 'Succ', description: '', role: 'coder',  dependsOn: [pred.id] }) as { id: string };
    expect(repos.tasks.get(succ.id)!.dependsOn).toEqual([pred.id]);
    // 新建任务直接为 ready；启动 -> 前置未完成，被依赖门禁拒绝
    expect(repos.tasks.get(succ.id)!.status).toBe('ready');
    await expect(call('tasks', 'start', succ.id)).rejects.toThrow(/前置任务未完成/);
  });

  it('ai.proposeRequirement throws when no provider configured', async () => {
    await expect(call('ai', 'proposeRequirement', [])).rejects.toThrow(/尚未配置/);
  });

  it('ai.chat emits done event with full text after streaming completes', async () => {
    repos.projects.insert({ id: 'chat-project', name: 'P', path: workdir, defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
    await call('providers', 'save', {
      id: 'p1', kind: 'openai', displayName: 'P1', enabled: true,
      priority: 0, authType: 'api_key', apiKey: 'sk-test', revision: 1,
      defaultModel: 'gpt-x', workloadModels: {}, models: [], baseURL: '',
    } as never);
    sendEvent('ai', 'chat', { sessionId: 's1', messages: [{ role: 'user', content: '做一个官网' }], mode: 'requirement', projectId: 'chat-project', projectPath: workdir });
    // fakeExecutor 返回 'hello'；等微任务让 async 处理器完成
    await new Promise((r) => setTimeout(r, 10));
    const types = sentAi.map((e) => e.type);
    expect(types).toContain('done');
    const done = sentAi.find((e) => e.type === 'done') as { fullText: string } | undefined;
    expect(done?.fullText).toBe('hello');
  });

  it('ai.cancel aborts only the active chat and suppresses later stream events', async () => {
    repos.projects.insert({ id: 'cancel-project', name: 'P', path: workdir, defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
    await call('providers', 'save', {
      id: 'p1', kind: 'openai', displayName: 'P1', enabled: true,
      priority: 0, authType: 'api_key', apiKey: 'sk-test', revision: 1,
      defaultModel: 'gpt-x', workloadModels: {}, models: [], baseURL: '',
    } as never);
    let capturedSignal: AbortSignal | undefined;
    let capturedAsk: Parameters<PiTextExecutor>[5];
    let resolveChat = (_value: string) => {};
    const deferredExecutor: PiTextExecutor = async (_workload, _messages, _onDelta, options, _onToolResult, onAsk) => {
      capturedSignal = options?.signal;
      capturedAsk = onAsk;
      return new Promise<string>((resolve) => { resolveChat = resolve; });
    };
    services.piAi = createPiAiService(deferredExecutor);
    registerIpc(services, (e) => sent.push(e), (e) => sentAi.push(e));

    sendEvent('ai', 'chat', {
      sessionId: 'cancel-session',
      messages: [{ role: 'user', content: '拆解任务' }],
      mode: 'task_proposal',
      projectId: 'cancel-project',
      projectPath: workdir,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    sendEvent('ai', 'cancel', { sessionId: 'cancel-session' });
    const lateAnswerSend = vi.fn(() => true);
    capturedAsk?.('late-tool', [], lateAnswerSend);
    sendEvent('ai', 'answer', { sessionId: 'cancel-session', toolUseId: 'late-tool', answers: [] });
    resolveChat('late result');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(capturedSignal?.aborted).toBe(true);
    expect(lateAnswerSend).not.toHaveBeenCalled();
    expect(sentAi.filter((event) => event.sessionId === 'cancel-session')).toEqual([]);
  });

  it('rejects an unregistered project path before starting a creation agent', async () => {
    await call('providers', 'save', {
      id: 'p1', kind: 'openai', displayName: 'P1', enabled: true,
      priority: 0, authType: 'api_key', apiKey: 'sk-test', revision: 1,
      defaultModel: 'gpt-x', workloadModels: {}, models: [], baseURL: '',
    } as never);

    sendEvent('ai', 'chat', {
      sessionId: 'unregistered-project',
      messages: [{ role: 'user', content: '设计登录需求' }],
      mode: 'requirement',
      projectId: 'not-registered',
      projectPath: join(workdir, 'not-registered'),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(aiRequests).toEqual([]);
    expect(sentAi).toContainEqual(expect.objectContaining({
      type: 'error',
      sessionId: 'unregistered-project',
      error: expect.stringMatching(/项目/),
    }));
  });

  it('injects project knowledge content and persists read evidence for requirement and task creation', async () => {
    repos.projects.insert({ id: 'p', name: 'P', path: workdir, defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
    const knowledgeService = new ProjectKnowledgeService();
    await knowledgeService.initializeKnowledge({ repoPath: workdir, date: '2026-07-28' });
    writeFileSync(join(workdir, 'docs/knowledge/context/index.md'), `---
id: context:root
type: context
status: active
owner: project
updated: 2026-07-28
confidence: 0.9
sources: []
related: []
---

# Project Context

PROJECT KNOWLEDGE BODY: existing login uses session cookies.
`);
    await call('providers', 'save', {
      id: 'p1', kind: 'openai', displayName: 'P1', enabled: true,
      priority: 0, authType: 'api_key', apiKey: 'sk-test', revision: 1,
      defaultModel: 'gpt-x', workloadModels: {}, models: [], baseURL: '',
    } as never);

    sendEvent('ai', 'chat', {
      sessionId: 'knowledge-requirement-chat',
      messages: [{ role: 'user', content: '设计登录需求' }],
      mode: 'requirement',
      projectId: 'p',
      projectPath: workdir,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    sendEvent('ai', 'chat', {
      sessionId: 'knowledge-task-chat',
      messages: [{ role: 'user', content: '拆解登录任务' }],
      mode: 'task_proposal',
      projectId: 'p',
      projectPath: workdir,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const retrievals = db.prepare(
      'SELECT expert_key, stage, state, read_evidence_json FROM knowledge_retrievals WHERE project_id=? ORDER BY created_at',
    ).all('p') as Array<{ expert_key: string; stage: string; state: string; read_evidence_json: string }>;
    expect(retrievals).toHaveLength(2);
    expect(retrievals.map(({ expert_key, stage, state }) => ({ expert_key, stage, state }))).toEqual([
      { expert_key: 'product', stage: 'requirement_chat', state: 'completed' },
      { expert_key: 'dev_lead', stage: 'task_proposal', state: 'completed' },
    ]);
    for (const retrieval of retrievals) {
      expect(JSON.parse(retrieval.read_evidence_json)).toContainEqual(expect.objectContaining({
        knowledgeId: 'context:root',
        path: 'docs/knowledge/context/index.md',
        reason: 'host_prompt_context',
      }));
    }
    expect(aiRequests).toHaveLength(2);
    for (const request of aiRequests) {
      expect(request.messages[0]?.content).toContain('HOST KNOWLEDGE MANIFEST');
      expect(request.messages[0]?.content).toContain('PROJECT KNOWLEDGE BODY: existing login uses session cookies.');
    }
  });

  it('marks UX retrieval failed when knowledge materialization fails after planning', async () => {
    repos.projects.insert({ id: 'ux-project', name: 'P', path: workdir, defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
    const knowledgeService = new ProjectKnowledgeService();
    await knowledgeService.initializeKnowledge({ repoPath: workdir, date: '2026-07-28' });
    const coordinator = services.knowledge!;
    services.knowledge = {
      prepareChatContext: async (input: Parameters<KnowledgeCoordinator['prepareChatContext']>[0]) => {
        const manifest = await coordinator.prepareChatContext(input);
        if (input.stage === 'ux_consult') rmSync(workdir, { recursive: true, force: true });
        return manifest;
      },
      completeRetrieval: coordinator.completeRetrieval.bind(coordinator),
    } as unknown as NonNullable<Services['knowledge']>;
    uxConsultationContext = '检查登录交互';
    await call('providers', 'save', {
      id: 'p1', kind: 'openai', displayName: 'P1', enabled: true,
      priority: 0, authType: 'api_key', apiKey: 'sk-test', revision: 1,
      defaultModel: 'gpt-x', workloadModels: {}, models: [], baseURL: '',
    } as never);

    sendEvent('ai', 'chat', {
      sessionId: 'ux-materialization-failure',
      messages: [{ role: 'user', content: '设计登录需求' }],
      mode: 'requirement',
      projectId: 'ux-project',
      projectPath: workdir,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const uxRetrieval = db.prepare(
      "SELECT state FROM knowledge_retrievals WHERE project_id=? AND stage='ux_consult'",
    ).get('ux-project') as { state: string } | undefined;
    expect(uxRetrieval?.state).toBe('failed');
  });

  it('tasks.listAll returns all tasks', async () => {
    repos.projects.insert({ id: 'p-list-all', name: 'P', path: '/abs', defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
    const it = { id: 'it-list-all', projectId: 'p-list-all', name: 'I1', version: 'v1', status: 'active' as const, createdAt: 1 };
    repos.iterations.insert(it);
    const r = await call('requirements', 'create', it.id, 'Req', 'desc', 'high', 'acceptance') as { id: string };
    await call('tasks', 'create', { requirementId: r.id, title: 'Task', description: 'd', role: 'coder' });
    const all = (await call('tasks', 'listAll')) as unknown[];
    expect(all.length).toBe(1);
  });

  it('analytics.query validates filters and returns provider usage aggregates', async () => {
    const usage = repos.providerUsage.start({
      logicalRequestId: 'analytics-request',
      providerId: 'provider-1',
      providerName: 'Provider One',
      routeId: 'provider-1:chat',
      model: 'model-a',
      workload: 'chat',
      source: 'task_chat',
      attemptOrdinal: 1,
      startedAt: 100,
      projectId: 'project-1',
    });
    repos.providerUsage.finish(usage.id, {
      status: 'succeeded',
      endedAt: 150,
      usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 18 },
    });

    const result = await call('analytics', 'query', { startAt: 0, endAt: 1000 }) as import('@ai-devflow/core').UsageAnalytics;
    expect(result.summary).toMatchObject({ providerCalls: 1, logicalRequests: 1, tokens: { total: 18 } });
    await expect(call('analytics', 'query', { startAt: 1000, endAt: 1000 })).rejects.toThrow(/时间/);
    await expect(call('analytics', 'query', { startAt: 0, endAt: 6 * 366 * 24 * 60 * 60 * 1000 })).rejects.toThrow(/五年/);
    await expect(call('analytics', 'query', { startAt: 0.5, endAt: 1000 })).rejects.toThrow(/整数/);
    await expect(call('analytics', 'query', { startAt: 0, endAt: 1000, status: 'mystery' })).rejects.toThrow(/状态/);
  });

  it('analytics.query decorates a configured provider label over an internal stored name', async () => {
    const providerId = '776f5082-9779-4a15-8f3d-ac0b7068da9b';
    services.providerStore?.save({
      id: providerId,
      kind: 'openai',
      displayName: 'Configured Gateway',
      enabled: true,
      priority: 1,
      authType: 'api_key',
      revision: 0,
      apiKey: 'sk-test',
    });
    const usage = repos.providerUsage.start({
      logicalRequestId: 'configured-provider',
      providerId,
      providerName: providerId,
      routeId: `${providerId}:chat`,
      model: 'gpt-5',
      workload: 'chat',
      source: 'task_chat',
      attemptOrdinal: 1,
      startedAt: 100,
      projectId: 'project-1',
    });
    repos.providerUsage.finish(usage.id, {
      status: 'succeeded',
      endedAt: 150,
      usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 18 },
    });

    const result = (await call('analytics', 'query', { startAt: 0, endAt: 10_000_000 })) as import('@ai-devflow/core').UsageAnalytics;
    const provider = result.providers.find((p) => p.key === providerId);
    expect(provider?.label).toBe('Configured Gateway');
    // 稳定 ID 仍是聚合键与过滤值，永不作为可见标签。
    expect(provider?.key).toBe(providerId);
    expect(result.providers.some((p) => p.label === providerId)).toBe(false);
  });

  it('analytics.query resolves unconfigured historical providers and failures with a localized fallback label', async () => {
    const providerId = '776f5082-9779-4a15-8f3d-ac0b7068da9b';
    const usage = repos.providerUsage.start({
      logicalRequestId: 'historical-provider',
      providerId,
      providerName: providerId,
      routeId: `${providerId}:chat`,
      model: 'gpt-5',
      workload: 'chat',
      source: 'task_chat',
      attemptOrdinal: 1,
      startedAt: 100,
      projectId: 'project-1',
    });
    repos.providerUsage.finish(usage.id, {
      status: 'failed',
      endedAt: 200,
      failureKind: 'transient_provider',
      usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
    });
    await call('settings', 'setLocale', 'en');

    const result = (await call('analytics', 'query', { startAt: 0, endAt: 10_000_000 })) as import('@ai-devflow/core').UsageAnalytics;
    const provider = result.providers.find((p) => p.key === providerId);
    expect(provider?.label).toBe('Historical provider · 776f…da9b');
    expect(provider?.key).toBe(providerId);
    expect(result.latestFailures.length).toBeGreaterThan(0);
    const failure = result.latestFailures.find((f) => f.providerId === providerId);
    expect(failure?.providerName).toBe('Historical provider · 776f…da9b');
    expect(failure?.providerId).toBe(providerId);
    // 完整 UUID 永不出现在任何可见标签中。
    expect(result.providers.some((p) => p.label === providerId)).toBe(false);
    expect(result.latestFailures.some((f) => f.providerName === providerId)).toBe(false);
  });

  it('settings retention round-trips and compaction requires explicit confirmation', async () => {
    expect(await call('settings', 'getRetention')).toMatchObject({
      policy: { executionDetailDays: 90, archivedConversationDays: 180, providerRawDays: 365 },
    });
    const policy = { executionDetailDays: 30, archivedConversationDays: 60, providerRawDays: 90 };
    await expect(call('settings', 'setRetention', policy)).resolves.toEqual(policy);
    await expect(call('settings', 'runRetention')).resolves.toMatchObject({ skipped: false, ranAt: 1_000_000 });
    await expect(call('settings', 'compactDatabase', false)).rejects.toThrow(/确认/);
    await expect(call('settings', 'compactDatabase', true)).resolves.toBeUndefined();
  });

  it('notificationRules.create persists rule', async () => {
    const r = (await call('notificationRules', 'create', { id: '', status: 'in_progress', minutes: 5, channels: ['desktop'], enabled: true })) as { id: string };
    expect(repos.notificationRules.list().length).toBe(1);
    expect(r.id).toBeTruthy();
  });

  it('tasks.accept is the only archive path; drag (updateStatus) to archived is rejected', async () => {
    repos.projects.insert({ id: 'p', name: 'P', path: '/x', defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
    repos.iterations.insert({ id: 'i', projectId: 'p', name: 'I', version: 'v1', status: 'active', createdAt: 1 });
    repos.requirements.insert({ id: 'r', iterationId: 'i', title: 'R', description: '', priority: 'medium', acceptance: 'acc', createdAt: 1, archived: false });
    // 待验收任务，无执行产物
    repos.tasks.insert({ id: 't', requirementId: 'r', iterationId: 'i', projectId: 'p', title: 'T', description: '', status: 'in_review', role: 'coder', stages: [], currentStage: 0, statusChangedAt: now(), createdAt: now(), updatedAt: now(), retryCount: 0 });
    await expect(call('tasks', 'accept', 't')).rejects.toThrow(/产物/); // 无执行产物 -> 拒绝
    // 拖拽归档被拒
    await expect(call('tasks', 'updateStatus', 't', 'archived')).rejects.toThrow(/启动、验收或驳回/);
    // 补一条执行记录（产物）
    repos.executions.insert({ id: 'e1', taskId: 't', attempt: 1, startedAt: now(), status: 'succeeded' });
    await call('tasks', 'accept', 't');
    expect(repos.tasks.get('t')!.status).toBe('archived');
    // 非待验收任务验收拒绝
    repos.tasks.insert({ id: 't2', requirementId: 'r', iterationId: 'i', projectId: 'p', title: 'T2', description: '', status: 'ready', role: 'coder', stages: [], currentStage: 0, statusChangedAt: now(), createdAt: now(), updatedAt: now(), retryCount: 0 });
    await expect(call('tasks', 'accept', 't2')).rejects.toThrow(/待验收/);
  });

  it('settings theme round-trips and persists', async () => {
    await call('settings', 'setTheme', 'light');
    expect(await call('settings', 'getTheme')).toBe('light');
    await call('settings', 'setTheme', 'system');
    expect(await call('settings', 'getTheme')).toBe('system');
  });
});

describe('new IPC channels (reject / createBatch / global config / test-connection / install)', () => {
  function seed() {
    repos.projects.insert({ id: 'p', name: 'P', path: '/x', defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
    repos.iterations.insert({ id: 'i', projectId: 'p', name: 'I', version: 'v1', status: 'active', createdAt: 1 });
    repos.requirements.insert({ id: 'r', iterationId: 'i', title: 'R', description: '', priority: 'medium', acceptance: 'acc', createdAt: 1, archived: false });
  }

  it('tasks.reject requires a reason and only applies to in_review', async () => {
    seed();
    repos.tasks.insert({ id: 't', requirementId: 'r', iterationId: 'i', projectId: 'p', title: 'T', description: '', status: 'in_review', role: 'coder', stages: [], currentStage: 0, statusChangedAt: now(), createdAt: now(), updatedAt: now(), retryCount: 0 });
    await expect(call('tasks', 'reject', { taskId: 't', reason: '  ', target: 'ready' })).rejects.toThrow(/退回原因/);
    // ready 任务不可退回
    repos.tasks.insert({ id: 't2', requirementId: 'r', iterationId: 'i', projectId: 'p', title: 'T2', description: '', status: 'ready', role: 'coder', stages: [], currentStage: 0, statusChangedAt: now(), createdAt: now(), updatedAt: now(), retryCount: 0 });
    await expect(call('tasks', 'reject', { taskId: 't2', reason: 'x', target: 'ready' })).rejects.toThrow(/仅待验收/);
  });

  it('tasks.reject to ready only changes status and records the reason', async () => {
    seed();
    repos.tasks.insert({ id: 't', requirementId: 'r', iterationId: 'i', projectId: 'p', title: 'T', description: '', status: 'in_review', role: 'coder', stages: [], currentStage: 0, statusChangedAt: now(), createdAt: now(), updatedAt: now(), retryCount: 0 });
    await call('tasks', 'reject', { taskId: 't', reason: '未覆盖验收标准', target: 'ready' });
    expect(repos.tasks.get('t')!.status).toBe('ready');
    const msgs = repos.taskMessages.listByTask('t').map((m) => m.text ?? '');
    expect(msgs.some((m) => m.includes('验收不通过') && m.includes('未覆盖验收标准'))).toBe(true);
  });

  it('tasks.createBatch maps draftId dependencies to real taskIds atomically', async () => {
    seed();
    const created = (await call('tasks', 'createBatch', {
      requirementId: 'r',
      proposals: [
        { draftId: 't1', title: 'A', description: '', role: 'coder', dependsOn: [] },
        { draftId: 't2', title: 'B', description: '', role: 'coder', dependsOn: ['t1'] },
      ],
    })) as Array<{ id: string; title: string; dependsOn?: string[] }>;
    expect(created.length).toBe(2);
    const a = created.find((c) => c.title === 'A')!;
    const b = created.find((c) => c.title === 'B')!;
    expect(b.dependsOn).toEqual([a.id]); // 草稿引用映射为真实 taskId
  });

  it('tasks.createBatch rejects an invalid DAG (cycle)', async () => {
    seed();
    await expect(call('tasks', 'createBatch', {
      requirementId: 'r',
      proposals: [
        { draftId: 'a', title: 'A', description: '', role: 'coder', dependsOn: ['b'] },
        { draftId: 'b', title: 'B', description: '', role: 'coder', dependsOn: ['a'] },
      ],
    })).rejects.toThrow(/环|依赖/);
    // 原子性：未落库任何任务
    expect(repos.tasks.listByRequirement('r').length).toBe(0);
  });

  it('providers.reorder rejects missing or duplicate ids', async () => {
    const p1 = await call('providers', 'save', { id: 'p1', kind: 'openai', displayName: 'A', enabled: true, priority: 0, authType: 'api_key', apiKey: 'k', revision: 1 });
    await call('providers', 'save', { id: 'p2', kind: 'anthropic', displayName: 'B', enabled: true, priority: 1, authType: 'api_key', apiKey: 'k', revision: 1 });
    await expect(call('providers', 'reorder', [(p1 as { id: string }).id])).rejects.toThrow();
    await expect(call('providers', 'reorder', [(p1 as { id: string }).id, (p1 as { id: string }).id])).rejects.toThrow();
  });

  it('providers.listModels returns empty for standard providers', async () => {
    await call('providers', 'save', {
      id: 'p1', kind: 'openai', displayName: 'O', enabled: true,
      priority: 0, authType: 'api_key', apiKey: 'k', revision: 1,
      defaultModel: 'm',
    });
    const models = await call('providers', 'listModels', 'p1') as unknown[];
    expect(models).toEqual([]);
  });

  it('providers.listModels rejects unknown provider id', async () => {
    await expect(call('providers', 'listModels', 'missing')).rejects.toThrow();
  });

  it('updates.installUpdate returns a visible result (no silent no-op)', async () => {
    const r = (await call('updates', 'installUpdate')) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe('string');
  });
});

describe('deriveProjectName', () => {
  it('derives PascalCase from git URL', () => {
    expect(deriveProjectName('https://xxx.com/domain/project-a.git')).toBe('Project A');
  });
  it('derives PascalCase from local path', () => {
    expect(deriveProjectName('/Users/me/code/my-cool-repo')).toBe('My Cool Repo');
  });
  it('strips trailing slash', () => {
    expect(deriveProjectName('https://github.com/org/foo-bar/')).toBe('Foo Bar');
  });
});

describe('tasks:delete (依赖守卫)', () => {
  function seedDependency(): void {
    repos.projects.insert({ id: 'p', name: 'P', path: '/x', defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
    repos.iterations.insert({ id: 'i', projectId: 'p', name: 'I', version: 'v1', status: 'active', createdAt: 1 });
    repos.requirements.insert({ id: 'r', iterationId: 'i', title: 'R', description: '', priority: 'medium', acceptance: '', createdAt: 1, archived: false });
    const mk = (id: string, title: string, dependsOn: string[]) => repos.tasks.insert({
      id, requirementId: 'r', iterationId: 'i', projectId: 'p',
      title, description: '', status: 'ready', role: 'coder',
      stages: [], currentStage: 0, statusChangedAt: 1, createdAt: 1, updatedAt: 1, retryCount: 0, dependsOn,
    });
    mk('A', '任务A', []);
    mk('B', '任务B', ['A']);
  }

  it('被其它任务 dependsOn 引用时拒绝删除并返回阻塞列表', async () => {
    seedDependency();
    const res = await call('tasks', 'delete', 'A');
    expect(res).toEqual({ ok: false, blockedBy: [{ id: 'B', title: '任务B' }] });
    // 守卫未通过，任务仍在
    expect(repos.tasks.get('A')).toBeDefined();
  });

  it('无依赖引用时硬删除成功', async () => {
    seedDependency();
    const res = await call('tasks', 'delete', 'B');
    expect(res).toEqual({ ok: true });
    expect(repos.tasks.get('B')).toBeUndefined();
    expect(repos.tasks.get('A')).toBeDefined();
  });

  it('删除不存在的任务抛错', async () => {
    await expect(call('tasks', 'delete', 'nope')).rejects.toThrow('任务不存在');
  });
});
