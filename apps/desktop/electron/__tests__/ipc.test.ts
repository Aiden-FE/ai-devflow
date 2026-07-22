import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// Mock 'electron'：捕获 ipcMain.handle 注册的处理器，其余为 no-op。
const handlers = new Map<string, (...args: unknown[]) => unknown>();
const syncHandlers = new Map<string, (e: unknown) => unknown>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...args: unknown[]) => unknown) => handlers.set(ch, fn),
    on: (ch: string, fn: (e: unknown) => unknown) => syncHandlers.set(ch, fn),
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
  shell: { openExternal() {} },
}));

import { openDatabase, createRepositories, type Repositories } from '@ai-devflow/persistence';
import { Orchestrator } from '@ai-devflow/scheduler';
import { TimeoutEngine, WebhookSender, NullNotifier } from '@ai-devflow/notifications';
import { encryptSecret, decryptSecret } from '../credentials.js';
import { registerIpc, deriveProjectName } from '../ipc.js';
import type { Services } from '../services.js';
import type { Updater } from '../updater.js';
import type { StreamEvent } from '../api.js';
import type { DatabaseSync } from '@ai-devflow/persistence';
import { now } from '@ai-devflow/core';
import { ProviderStore } from '../provider-store.js';
import { createPiAiService } from '../pi-ai.js';
import type { PiTextExecutor } from '../pi-ai.js';

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

function buildServices() {
  // Pi-only 编排器使用单一 AgentRunner；reviewer 与 dev 均产出含 PASS 结论的 done（供审查解析）。
  const runner: import('@ai-devflow/agents').AgentRunner = {
    async verifyRuntime() {
      return { version: 'fake', entry: 'fake' };
    },
    async run() {
      return {
        events: (async function* () {
          yield { type: 'done', summary: 'ok\nREVIEW_VERDICT: PASS', t: 0 } as import('@ai-devflow/core').AgentEvent;
        })(),
        cancel: async () => {},
        done: async () => ({ exitCode: 0, ok: true }),
      };
    },
  };
  const orchestrator = new Orchestrator(repos, runner, { worktreesBaseDir: workdir, maxConcurrent: 2, autoRetry: false });
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
  const fakeExecutor: PiTextExecutor = async (workload) => {
    if (workload === 'task_proposal') return '{"tasks":[]}';
    if (workload === 'requirement_proposal') return '{"title":"T","description":"D","acceptance":"A","priority":"medium"}';
    return 'hello';
  };
  const piAi = createPiAiService(fakeExecutor);

  return { orchestrator, webhooks, timeoutEngine, providerStore, piAi } satisfies Partial<Services>;
}

beforeEach(() => {
  db = openDatabase(':memory:');
  repos = createRepositories(db);
  workdir = mkdtempSync(join(tmpdir(), 'aidf-ipc-'));
  sent = [];
  handlers.clear();
  const built = buildServices();
  services = {
    repos,
    orchestrator: built.orchestrator,
    webhooks: built.webhooks,
    timeoutEngine: built.timeoutEngine,
    providerStore: built.providerStore,
    piAi: built.piAi,
    dbPath: ':memory:',
    worktreesBaseDir: workdir,
    encryptSecret,
    decryptSecret,
    updater: noopUpdater,
  };
  registerIpc(services, (e) => sent.push(e), () => {});
});

afterEach(() => {
  services.timeoutEngine.stop();
  try { db.close(); } catch { /* */ }
  rmSync(workdir, { recursive: true, force: true });
});

// 用 Promise.resolve().then() 包装，把处理器同步抛错转为 rejected promise（与 Electron 行为一致）。
const call = (ns: string, method: string, ...args: unknown[]) =>
  Promise.resolve().then(() => handlers.get(`ai-devflow:${ns}:${method}`)!({}, ...args));

describe('typed IPC wiring', () => {
  it('projects.create validates and persists', async () => {
    await expect(call('projects', 'create', { name: '', path: '/x', defaultBranch: 'main' })).rejects.toThrow();
    const p = await call('projects', 'create', { name: 'My Proj', path: '/abs/path', defaultBranch: 'main' }) as { id: string };
    expect(repos.projects.get(p.id)).toBeDefined();
    expect((await call('projects', 'list') as unknown[]).length).toBe(1);
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

  it('tasks.updateStatus enforces gate (rejects backlog->archived)', async () => {
    repos.projects.insert({ id: 'p', name: 'P', path: '/x', defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
    repos.iterations.insert({ id: 'i', projectId: 'p', name: 'I', version: 'v1', status: 'active', createdAt: 1 });
    repos.requirements.insert({ id: 'r', iterationId: 'i', title: 'R', description: '', priority: 'medium', acceptance: 'acc', createdAt: 1, archived: false });
    repos.tasks.insert({
      id: 't', requirementId: 'r', iterationId: 'i', projectId: 'p', title: 'T', description: '', status: 'backlog',
      role: 'coder', stages: [], currentStage: 0, statusChangedAt: now(), createdAt: now(), updatedAt: now(), retryCount: 0,
    });
    // 归档必须经 tasks.accept，updateStatus 直接拒绝（看板拖拽不得绕过）。
    await expect(call('tasks', 'updateStatus', 't', 'archived')).rejects.toThrow(/归档|门禁|非法/);
  });

  it('end-to-end: create -> start -> in_review via IPC', async () => {
    const p = await call('projects', 'create', { name: 'P', path: '/abs', defaultBranch: 'main' }) as { id: string };
    const it = await call('iterations', 'create', p.id, 'I1', 'v1') as { id: string };
    const r = await call('requirements', 'create', it.id, 'Req', 'desc', 'high', 'acceptance') as { id: string };
    const t = await call('tasks', 'create', { requirementId: r.id, title: 'Task', description: 'd', role: 'coder' }) as { id: string; status: string };

    // 预置 worktree 路径以跳过真实 git（编排器逻辑仍验证）
    const task = repos.tasks.get(t.id)!;
    task.worktreePath = join(workdir, 'wt');
    repos.tasks.update(task);

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
      routeId: 'auth-broken:coder:primary',
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
    const p = await call('projects', 'create', { name: 'P', path: '/abs', defaultBranch: 'main' }) as { id: string };
    const it = await call('iterations', 'create', p.id, 'I1', 'v1') as { id: string };
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

  it('tasks.listAll returns all tasks', async () => {
    const p = await call('projects', 'create', { name: 'P', path: '/abs', defaultBranch: 'main' }) as { id: string };
    const it = await call('iterations', 'create', p.id, 'I1', 'v1') as { id: string };
    const r = await call('requirements', 'create', it.id, 'Req', 'desc', 'high', 'acceptance') as { id: string };
    await call('tasks', 'create', { requirementId: r.id, title: 'Task', description: 'd', role: 'coder' });
    const all = (await call('tasks', 'listAll')) as unknown[];
    expect(all.length).toBe(1);
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
    await expect(call('tasks', 'updateStatus', 't', 'archived')).rejects.toThrow(/归档/);
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
