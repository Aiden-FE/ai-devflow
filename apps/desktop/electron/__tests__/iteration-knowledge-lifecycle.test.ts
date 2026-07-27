import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, createRepositories, type DatabaseSync } from '@ai-devflow/persistence';
import { ProjectKnowledgeService } from '@ai-devflow/knowledge';
import type { AgentRunner, AgentRun } from '@ai-devflow/agents';
import type { AgentEvent } from '@ai-devflow/core';
import { KnowledgeCoordinator } from '@ai-devflow/scheduler';
import { Orchestrator } from '@ai-devflow/scheduler';
import { NullNotifier, WebhookSender, TimeoutEngine } from '@ai-devflow/notifications';
import { registerIpc } from '../ipc.js';
import type { Services } from '../services.js';
import { encryptSecret, decryptSecret } from '../credentials.js';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...args: unknown[]) => unknown) => handlers.set(ch, fn), on: () => undefined },
  ipcRenderer: { sendSync: () => 'dark' },
  app: { getPath: () => '/tmp', setName: () => undefined, getVersion: () => '0.0.0' },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
  nativeTheme: { shouldUseDarkColors: false, on: () => undefined },
  Notification: class { show() { /* */ } },
  BrowserWindow: class { static getAllWindows() { return []; } },
  session: { defaultSession: {} }, protocol: {}, shell: {}, dialog: {},
}));

function sh(cwd: string, args: string[]): void { execFileSync('git', args, { cwd, stdio: 'ignore' }); }
function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'iter-life-'));
  sh(repo, ['init', '-q', '-b', 'main']); sh(repo, ['config', 'user.email', 't']); sh(repo, ['config', 'user.name', 't']);
  writeFileSync(join(repo, 'README.md'), 'x'); sh(repo, ['add', '.']); sh(repo, ['commit', '-qm', 'init']);
  return repo;
}
const fakeRunner: AgentRunner = {
  async verifyRuntime() { return { version: 'fake', entry: 'fake' }; },
  async run(): Promise<AgentRun> {
    return { events: (async function* () { yield { type: 'done', summary: 'ok', t: 0 } as AgentEvent; })(), cancel: async () => {}, done: async () => ({ exitCode: 0, ok: true }) };
  },
};
const call = (ns: string, method: string, ...args: unknown[]) => Promise.resolve().then(() => handlers.get(`ai-devflow:${ns}:${method}`)!({}, ...args));

describe('iteration archive lifecycle (strict)', () => {
  let db: DatabaseSync;
  let repo: string;
  let workdir: string;
  let services: Services;

  beforeEach(() => {
    db = openDatabase(':memory:');
    const repos = createRepositories(db);
    repo = makeRepo();
    workdir = mkdtempSync(join(tmpdir(), 'iter-life-wt-'));
    repos.projects.insert({ id: 'p', name: 'P', path: repo, defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
    repos.iterations.insert({ id: 'it', projectId: 'p', name: 'I', version: '1.0', status: 'active', createdAt: 1 });
    repos.requirements.insert({ id: 'req', iterationId: 'it', title: 'R', description: '', priority: 'medium', acceptance: 'a', createdAt: 1, archived: false });
    const coordinator = new KnowledgeCoordinator({ repos, runner: fakeRunner, knowledge: new ProjectKnowledgeService(), worktreesBaseDir: workdir });
    const orchestrator = new Orchestrator(repos, fakeRunner, { worktreesBaseDir: workdir, maxConcurrent: 2, autoRetry: false, knowledgeCoordinator: coordinator });
    const webhooks = new WebhookSender(repos, { maxAttempts: 1, timeoutMs: 1000 });
    const timeoutEngine = new TimeoutEngine(repos, new NullNotifier(), webhooks, { intervalMs: 999_999_999 });
    services = { repos, orchestrator, webhooks, timeoutEngine, knowledge: coordinator, dbPath: ':memory:', worktreesBaseDir: workdir, encryptSecret, decryptSecret, updater: { checkForUpdates: async () => undefined, start: () => undefined, on: () => undefined } as never };
    registerIpc(services, () => undefined, () => undefined);
  });
  afterEach(() => { services.timeoutEngine.stop(); try { db.close(); } catch { /* */ } rmSync(repo, { recursive: true, force: true }); rmSync(workdir, { recursive: true, force: true }); });

  it('blocks archive when tasks are not all archived', async () => {
    const r = await call('iterations', 'archive', 'it') as { ok: false; reasons: string[] };
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/未归档|校验/);
    expect(services.repos.iterations.get('it')!.status).toBe('active');
  });

  it('archives successfully after CHANGELOG is covered and tracked', async () => {
    // 预置已归档任务 + 覆盖的 CHANGELOG（被 git 跟踪）。
    services.repos.tasks.insert({ id: 't1', requirementId: 'req', iterationId: 'it', projectId: 'p', title: 'T', description: '', status: 'archived', role: 'coder', stages: [{ id: 's', name: 's', role: 'coder' }], currentStage: 0, statusChangedAt: 1, createdAt: 1, updatedAt: 1, retryCount: 0 } as never);
    mkdirSync(join(repo, 'docs/iterations/1.0/tasks/t1'), { recursive: true });
    writeFileSync(join(repo, 'docs/iterations/1.0/CHANGELOG.md'), '# Changelog\n\n- t1: done\n');
    writeFileSync(join(repo, 'docs/iterations/1.0/tasks/t1/CHANGELOG.md'), '# t1\n');
    writeFileSync(join(repo, 'docs/iterations/1.0/index.md'), '# Iteration\n');
    sh(repo, ['add', '.']); sh(repo, ['commit', '-qm', 'changelog']);
    // 预置 sprint 分支以便合并。
    sh(repo, ['branch', 'ai-devflow-sprint/1.0', 'main']);
    const r = await call('iterations', 'archive', 'it') as { ok: true } | { ok: false; reasons: string[] };
    expect(r.ok).toBe(true);
    expect(services.repos.iterations.get('it')!.status).toBe('archived');
  });
});
