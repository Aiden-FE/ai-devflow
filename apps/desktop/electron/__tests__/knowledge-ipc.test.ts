import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, createRepositories, type DatabaseSync } from '@ai-devflow/persistence';
import { ProjectKnowledgeService } from '@ai-devflow/knowledge';
import type { AgentRunner, AgentRun, RunnerAgentRunRequest as AgentRunRequest } from '@ai-devflow/agents';
import type { AgentEvent, KnowledgeAgentPayload } from '@ai-devflow/core';
import { KnowledgeCoordinator } from '@ai-devflow/scheduler';
import { NullNotifier } from '@ai-devflow/notifications';
import { WebhookSender } from '@ai-devflow/notifications';
import { TimeoutEngine } from '@ai-devflow/notifications';
import { Orchestrator } from '@ai-devflow/scheduler';
import { registerIpc } from '../ipc.js';
import type { Services } from '../services.js';
import { encryptSecret, decryptSecret } from '../credentials.js';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...args: unknown[]) => unknown) => handlers.set(ch, fn),
    on: () => undefined,
  },
  ipcRenderer: { sendSync: () => 'dark' },
  app: { getPath: () => '/tmp', setName: () => undefined, getVersion: () => '0.0.0' },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
  nativeTheme: { shouldUseDarkColors: false, on: () => undefined },
  Notification: class { show() { /* */ } },
  BrowserWindow: class { static getAllWindows() { return []; } },
  session: { defaultSession: {} },
  protocol: {},
  shell: {},
  dialog: {},
}));

function shGit(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'kb-ipc-'));
  shGit(repo, ['init', '-q', '-b', 'main']);
  shGit(repo, ['config', 'user.email', 't@t']);
  shGit(repo, ['config', 'user.name', 't']);
  writeFileSync(join(repo, 'README.md'), '# repo\n');
  shGit(repo, ['add', '.']);
  shGit(repo, ['commit', '-q', '-m', 'init']);
  return repo;
}

function fakeRunner(): AgentRunner {
  return {
    async verifyRuntime() { return { version: 'fake', entry: 'fake' }; },
    async run(req: AgentRunRequest): Promise<AgentRun> {
      if (req.expert === 'project_lead' && req.resultKind === 'knowledge_initialization') {
        writeFileSync(join(req.cwd, 'docs/knowledge/feature/task-review.md'), `---
id: feature:task-review
type: feature
status: active
owner: project
updated: 2026-07-28
confidence: 0.9
sources:
  - README.md
related: []
---

# Task Review

Reusable task review guidance.
`);
        const indexPath = join(req.cwd, 'docs/knowledge/feature/index.md');
        writeFileSync(indexPath, readFileSync(indexPath, 'utf8').replace('related: []', 'related:\n  - feature:task-review'));
      }
      const payload: KnowledgeAgentPayload | undefined =
        req.resultKind === 'knowledge_initialization'
          ? { kind: 'knowledge_initialization', changedPaths: [], knowledgeIds: [] }
          : undefined;
      const events: AgentEvent[] = [{ type: 'done', summary: 'ok', result: payload, t: 0 }];
      return {
        events: (async function* () { for (const e of events) yield e; })(),
        cancel: async () => {},
        done: async () => ({ exitCode: 0, ok: true }),
      };
    },
  };
}

const call = (ns: string, method: string, ...args: unknown[]) =>
  Promise.resolve().then(() => handlers.get(`ai-devflow:${ns}:${method}`)!({}, ...args));

describe('knowledge IPC', () => {
  let db: DatabaseSync;
  let repo: string;
  let workdir: string;
  let services: Services;

  beforeEach(() => {
    db = openDatabase(':memory:');
    const repos = createRepositories(db);
    repo = makeRepo();
    workdir = mkdtempSync(join(tmpdir(), 'kb-ipc-wt-'));
    repos.projects.insert({
      id: 'p1', name: 'P', path: repo, defaultBranch: 'main',
      createdAt: 1, updatedAt: 1, settings: {},
    });
    const runner = fakeRunner();
    const orchestrator = new Orchestrator(repos, runner, { worktreesBaseDir: workdir, maxConcurrent: 2, autoRetry: false });
    const webhooks = new WebhookSender(repos, { maxAttempts: 1, timeoutMs: 1000 });
    const timeoutEngine = new TimeoutEngine(repos, new NullNotifier(), webhooks, { intervalMs: 999_999_999 });
    const knowledge = new KnowledgeCoordinator({
      repos, runner, knowledge: new ProjectKnowledgeService(), worktreesBaseDir: workdir,
    });
    services = {
      repos,
      orchestrator,
      webhooks,
      timeoutEngine,
      knowledge,
      dbPath: ':memory:',
      worktreesBaseDir: workdir,
      encryptSecret,
      decryptSecret,
      updater: { checkForUpdates: async () => undefined, start: () => undefined, on: () => undefined } as never,
    };
    registerIpc(services, () => undefined, () => undefined);
  });

  afterEach(() => {
    services.timeoutEngine.stop();
    try { db.close(); } catch { /* */ }
    rmSync(repo, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  });

  it('getProjectSnapshot returns not_initialized for a fresh project', async () => {
    const snapshot = await call('knowledge', 'getProjectSnapshot', 'p1') as { state: string };
    expect(snapshot.state).toBe('not_initialized');
  });

  it('startInitialization then confirmRun merges into the default branch', async () => {
    const run = await call('knowledge', 'startInitialization', 'p1') as { id: string; draftBranch: string; confirmationState: string };
    expect(run.confirmationState).toBe('pending');
    expect(run.draftBranch).toBe(`ai-devflow/knowledge/${run.id}`);
    const snapshot = await call('knowledge', 'confirmRun', run.id) as { state: string };
    expect(snapshot.state).not.toBe('not_initialized');
  });

  it('cancelRun cleans up without merging', async () => {
    const run = await call('knowledge', 'startInitialization', 'p1') as { id: string };
    await call('knowledge', 'cancelRun', run.id);
    const view = await call('knowledge', 'getRun', run.id) as { state: string };
    expect(view.state).toBe('canceled');
  });

  it('startAudit(light) returns a succeeded run view', async () => {
    const run = await call('knowledge', 'startAudit', 'p1', 'light') as { state: string; kind: string };
    expect(run.state).toBe('succeeded');
    expect(run.kind).toBe('light_audit');
  });

  it('returns persisted task evidence and iteration verification through IPC', async () => {
    services.repos.iterations.insert({
      id: 'iteration-ipc', projectId: 'p1', name: 'I', version: '1.0', status: 'active', createdAt: 1,
    });
    services.repos.requirements.insert({
      id: 'requirement-ipc', iterationId: 'iteration-ipc', title: 'R', description: '',
      priority: 'medium', acceptance: 'a', createdAt: 1, archived: false,
    });
    services.repos.tasks.insert({
      id: 'task-ipc', requirementId: 'requirement-ipc', iterationId: 'iteration-ipc', projectId: 'p1',
      title: 'Task', description: '', status: 'testing', role: 'coder', stages: [], currentStage: 0,
      statusChangedAt: 1, createdAt: 1, updatedAt: 1, retryCount: 0,
    });
    services.repos.knowledgeRetrievals.create({
      id: 'ret-ipc', projectId: 'p1', taskId: 'task-ipc',
      expertKey: 'test', stage: 'review', level: 2, state: 'completed',
      candidateRefsJson: '[]', readEvidenceJson: '[]', skippedRefsJson: '[]', differencesJson: '[]',
      budgetFiles: 1, budgetChars: 100, usedFiles: 0, usedChars: 0, confidence: 0,
      createdAt: 10, completedAt: 11,
    });
    services.repos.knowledgeRuns.create({
      id: 'changelog-ipc', projectId: 'p1', iterationId: 'iteration-ipc', kind: 'iteration_changelog',
      state: 'running', confirmationState: 'not_required', changedPathsJson: '[]', diagnosticsJson: '[]',
      resultJson: '{}', startedAt: 12,
    });
    services.repos.knowledgeRuns.finish('changelog-ipc', 'succeeded', 13, {
      resultJson: JSON.stringify({
        state: 'valid', coveredTaskIds: ['task-ipc'], missingTaskIds: [],
        changedPaths: ['docs/iterations/1.0/CHANGELOG.md'], verifiedAt: 13,
      }),
    });

    const evidence = await call('knowledge', 'getTaskEvidence', 'task-ipc') as { retrievals: Array<{ id: string }> };
    const verification = await call('knowledge', 'getIterationVerification', 'iteration-ipc') as { state: string; coveredTaskIds: string[] };

    expect(evidence.retrievals.map((item) => item.id)).toEqual(['ret-ipc']);
    expect(verification).toEqual(expect.objectContaining({ state: 'valid', coveredTaskIds: ['task-ipc'] }));
  });

  it('does not let cancelRun overwrite a succeeded run', async () => {
    const run = await call('knowledge', 'startInitialization', 'p1') as { id: string };
    await call('knowledge', 'confirmRun', run.id);

    await expect(call('knowledge', 'cancelRun', run.id)).rejects.toThrow(/不能取消/);
    expect(await call('knowledge', 'getRun', run.id)).toEqual(expect.objectContaining({ state: 'succeeded' }));
  });
});
