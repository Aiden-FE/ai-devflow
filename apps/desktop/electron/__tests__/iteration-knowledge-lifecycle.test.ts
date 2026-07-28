import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, createRepositories, type DatabaseSync } from '@ai-devflow/persistence';
import { ProjectKnowledgeService } from '@ai-devflow/knowledge';
import type { AgentRunner, AgentRun, RunnerAgentRunRequest as AgentRunRequest } from '@ai-devflow/agents';
import type { AgentEvent } from '@ai-devflow/core';
import { KnowledgeCoordinator, mergeBranchInto, mergeWorktreeBranch } from '@ai-devflow/scheduler';
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
class ArchiveRunner implements AgentRunner {
  requests: AgentRunRequest[] = [];
  failAggregation = false;

  async verifyRuntime() { return { version: 'fake', entry: 'fake' }; }

  async run(request: AgentRunRequest): Promise<AgentRun> {
    this.requests.push(request);
    let result: import('@ai-devflow/core').KnowledgeAgentPayload | undefined;
    if (request.resultKind === 'iteration_changelog' && !this.failAggregation) {
      mkdirSync(join(request.cwd, 'docs/iterations/1.0'), { recursive: true });
      writeFileSync(join(request.cwd, 'docs/iterations/1.0/CHANGELOG.md'), '# Changelog\n\n- t1: done\n');
      writeFileSync(join(request.cwd, 'docs/iterations/1.0/index.md'), '# Iteration\n\n- t1\n');
      result = {
        kind: 'iteration_changelog',
        changedPaths: [
          'docs/iterations/1.0/CHANGELOG.md',
          'docs/iterations/1.0/index.md',
        ],
        coveredTaskIds: ['t1'],
      } as never;
    }
    return {
      events: (async function* () {
        yield { type: 'done', summary: 'ok', result, t: 0 } as AgentEvent;
      })(),
      cancel: async () => {},
      done: async () => ({ exitCode: 0, ok: true }),
    };
  }
}
const call = (ns: string, method: string, ...args: unknown[]) => Promise.resolve().then(() => handlers.get(`ai-devflow:${ns}:${method}`)!({}, ...args));

describe('iteration archive lifecycle (strict)', () => {
  let db: DatabaseSync;
  let repo: string;
  let workdir: string;
  let services: Services;
  let runner: ArchiveRunner;
  let coordinator: KnowledgeCoordinator;

  beforeEach(() => {
    db = openDatabase(':memory:');
    const repos = createRepositories(db);
    repo = makeRepo();
    workdir = mkdtempSync(join(tmpdir(), 'iter-life-wt-'));
    repos.projects.insert({ id: 'p', name: 'P', path: repo, defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
    repos.iterations.insert({ id: 'it', projectId: 'p', name: 'I', version: '1.0', status: 'active', createdAt: 1 });
    repos.requirements.insert({ id: 'req', iterationId: 'it', title: 'R', description: '', priority: 'medium', acceptance: 'a', createdAt: 1, archived: false });
    runner = new ArchiveRunner();
    coordinator = new KnowledgeCoordinator({ repos, runner, knowledge: new ProjectKnowledgeService(), worktreesBaseDir: workdir });
    const orchestrator = new Orchestrator(repos, runner, { worktreesBaseDir: workdir, maxConcurrent: 2, autoRetry: false, knowledgeCoordinator: coordinator });
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

  it('serializes archive with task finalization on the same iteration lock', async () => {
    services.repos.tasks.insert({ id: 't1', requirementId: 'req', iterationId: 'it', projectId: 'p', title: 'T', description: '', status: 'archived', role: 'coder', stages: [], currentStage: 0, statusChangedAt: 1, createdAt: 1, updatedAt: 1, retryCount: 0 } as never);
    sh(repo, ['switch', '-qc', 'ai-devflow-sprint/1.0']);
    mkdirSync(join(repo, 'docs/iterations/1.0/tasks/t1'), { recursive: true });
    writeFileSync(join(repo, 'docs/iterations/1.0/tasks/t1/CHANGELOG.md'), '# t1\n');
    sh(repo, ['add', '.']); sh(repo, ['commit', '-qm', 'task changelog']);
    sh(repo, ['switch', '-q', 'main']);

    let release!: () => void;
    let entered!: () => void;
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    const acquired = new Promise<void>((resolve) => { entered = resolve; });
    const held = coordinator.withIterationLock('it', async () => {
      entered();
      await blocker;
    });
    await acquired;

    const archiving = call('iterations', 'archive', 'it');
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(runner.requests).toHaveLength(0);
    } finally {
      release();
      await held;
    }
    const result = await archiving as { ok: true } | { ok: false; reasons: string[] };
    expect(result.ok).toBe(true);
  });

  it('aggregates on the sprint branch before validating and archiving', async () => {
    // 任务级文档只存在于 sprint 分支；迭代级 CHANGELOG 必须由 project_lead 聚合生成。
    services.repos.tasks.insert({ id: 't1', requirementId: 'req', iterationId: 'it', projectId: 'p', title: 'T', description: '', status: 'archived', role: 'coder', stages: [{ id: 's', name: 's', role: 'coder' }], currentStage: 0, statusChangedAt: 1, createdAt: 1, updatedAt: 1, retryCount: 0 } as never);
    sh(repo, ['switch', '-qc', 'ai-devflow-sprint/1.0']);
    mkdirSync(join(repo, 'docs/iterations/1.0/tasks/t1'), { recursive: true });
    writeFileSync(join(repo, 'docs/iterations/1.0/tasks/t1/CHANGELOG.md'), '# t1\n');
    sh(repo, ['add', '.']); sh(repo, ['commit', '-qm', 'task changelog']);
    sh(repo, ['switch', '-q', 'main']);

    const r = await call('iterations', 'archive', 'it') as { ok: true } | { ok: false; reasons: string[] };
    expect(r.ok).toBe(true);
    expect(runner.requests.map((request) => request.resultKind)).toEqual(['iteration_changelog']);
    expect(execFileSync('git', ['show', 'main:docs/iterations/1.0/CHANGELOG.md'], { cwd: repo, encoding: 'utf8' })).toContain('t1');
    expect(services.repos.iterations.get('it')!.status).toBe('archived');
  });

  it('keeps the iteration active when changelog aggregation fails', async () => {
    services.repos.tasks.insert({ id: 't1', requirementId: 'req', iterationId: 'it', projectId: 'p', title: 'T', description: '', status: 'archived', role: 'coder', stages: [], currentStage: 0, statusChangedAt: 1, createdAt: 1, updatedAt: 1, retryCount: 0 } as never);
    sh(repo, ['switch', '-qc', 'ai-devflow-sprint/1.0']);
    mkdirSync(join(repo, 'docs/iterations/1.0/tasks/t1'), { recursive: true });
    writeFileSync(join(repo, 'docs/iterations/1.0/tasks/t1/CHANGELOG.md'), '# t1\n');
    sh(repo, ['add', '.']); sh(repo, ['commit', '-qm', 'task changelog']);
    sh(repo, ['switch', '-q', 'main']);
    runner.failAggregation = true;

    const result = await call('iterations', 'archive', 'it') as { ok: false; reasons: string[] };

    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/iteration_changelog|聚合/);
    expect(services.repos.iterations.get('it')?.status).toBe('active');
  });

  it('keeps the iteration active when the sprint branch cannot merge into the default branch', async () => {
    services.repos.tasks.insert({ id: 't1', requirementId: 'req', iterationId: 'it', projectId: 'p', title: 'T', description: '', status: 'archived', role: 'coder', stages: [], currentStage: 0, statusChangedAt: 1, createdAt: 1, updatedAt: 1, retryCount: 0 } as never);
    sh(repo, ['switch', '-qc', 'ai-devflow-sprint/1.0']);
    mkdirSync(join(repo, 'docs/iterations/1.0/tasks/t1'), { recursive: true });
    writeFileSync(join(repo, 'docs/iterations/1.0/tasks/t1/CHANGELOG.md'), '# t1\n');
    sh(repo, ['add', '.']); sh(repo, ['commit', '-qm', 'task changelog']);
    sh(repo, ['switch', '-qc', 'user-work']);

    const result = await call('iterations', 'archive', 'it') as { ok: false; reasons: string[] };

    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/合并失败|当前在/);
    expect(services.repos.iterations.get('it')?.status).toBe('active');
  });

  it('reuses a validated sprint aggregation when retrying a failed default merge', async () => {
    services.repos.tasks.insert({ id: 't1', requirementId: 'req', iterationId: 'it', projectId: 'p', title: 'T', description: '', status: 'archived', role: 'coder', stages: [], currentStage: 0, statusChangedAt: 1, createdAt: 1, updatedAt: 1, retryCount: 0 } as never);
    sh(repo, ['switch', '-qc', 'ai-devflow-sprint/1.0']);
    mkdirSync(join(repo, 'docs/iterations/1.0/tasks/t1'), { recursive: true });
    writeFileSync(join(repo, 'docs/iterations/1.0/tasks/t1/CHANGELOG.md'), '# t1\n');
    sh(repo, ['add', '.']); sh(repo, ['commit', '-qm', 'task changelog']);
    sh(repo, ['switch', '-qc', 'user-work']);

    const first = await call('iterations', 'archive', 'it') as { ok: false; reasons: string[] };
    expect(first.ok).toBe(false);
    expect(runner.requests).toHaveLength(1);

    sh(repo, ['switch', '-q', 'main']);
    const retried = await call('iterations', 'archive', 'it') as { ok: true } | { ok: false; reasons: string[] };

    expect(retried.ok).toBe(true);
    expect(runner.requests).toHaveLength(1);
    expect(services.repos.iterations.get('it')?.status).toBe('archived');
  });

  it('does not archive an externally moved sprint ref after merging the validated draft', async () => {
    services.repos.tasks.insert({ id: 't1', requirementId: 'req', iterationId: 'it', projectId: 'p', title: 'T', description: '', status: 'archived', role: 'coder', stages: [], currentStage: 0, statusChangedAt: 1, createdAt: 1, updatedAt: 1, retryCount: 0 } as never);
    sh(repo, ['switch', '-qc', 'ai-devflow-sprint/1.0']);
    mkdirSync(join(repo, 'docs/iterations/1.0/tasks/t1'), { recursive: true });
    writeFileSync(join(repo, 'docs/iterations/1.0/tasks/t1/CHANGELOG.md'), '# t1\n');
    sh(repo, ['add', '.']); sh(repo, ['commit', '-qm', 'task changelog']);
    sh(repo, ['switch', '-q', 'main']);
    let externalCommit: string | undefined;
    const raceCoordinator = new KnowledgeCoordinator({
      repos: services.repos,
      runner,
      knowledge: new ProjectKnowledgeService(),
      worktreesBaseDir: workdir,
      mergeBranchInto: async (input) => {
        const result = await mergeBranchInto(input);
        if (result.merged && result.commit && result.previousCommit) {
          const tree = execFileSync('git', ['rev-parse', `${result.previousCommit}^{tree}`], { cwd: repo, encoding: 'utf8' }).trim();
          externalCommit = execFileSync('git', [
            'commit-tree', tree, '-p', result.previousCommit, '-m', 'external sprint replacement',
          ], { cwd: repo, encoding: 'utf8' }).trim();
          sh(repo, ['update-ref', `refs/heads/${input.into}`, externalCommit, result.commit]);
        }
        return result;
      },
    });

    const result = await raceCoordinator.archiveIteration('it');

    expect(externalCommit).toBeTruthy();
    expect(result.ok).toBe(false);
    expect(services.repos.iterations.get('it')?.status).toBe('active');
    expect(() => execFileSync('git', [
      'show', 'main:docs/iterations/1.0/CHANGELOG.md',
    ], { cwd: repo, stdio: 'pipe' })).toThrow();
  });

  it('merges the recorded sprint commit when the sprint ref moves before the default merge', async () => {
    services.repos.tasks.insert({ id: 't1', requirementId: 'req', iterationId: 'it', projectId: 'p', title: 'T', description: '', status: 'archived', role: 'coder', stages: [], currentStage: 0, statusChangedAt: 1, createdAt: 1, updatedAt: 1, retryCount: 0 } as never);
    sh(repo, ['switch', '-qc', 'ai-devflow-sprint/1.0']);
    mkdirSync(join(repo, 'docs/iterations/1.0/tasks/t1'), { recursive: true });
    writeFileSync(join(repo, 'docs/iterations/1.0/tasks/t1/CHANGELOG.md'), '# t1\n');
    sh(repo, ['add', '.']); sh(repo, ['commit', '-qm', 'task changelog']);
    sh(repo, ['switch', '-q', 'main']);
    let externalCommit: string | undefined;
    const raceCoordinator = new KnowledgeCoordinator({
      repos: services.repos,
      runner,
      knowledge: new ProjectKnowledgeService(),
      worktreesBaseDir: workdir,
      mergeWorktreeBranch: async (input: Parameters<typeof mergeWorktreeBranch>[0]) => {
        const sprintBranch = 'ai-devflow-sprint/1.0';
        const sprintHead = execFileSync('git', ['rev-parse', sprintBranch], { cwd: repo, encoding: 'utf8' }).trim();
        const previous = execFileSync('git', ['rev-parse', `${sprintHead}^`], { cwd: repo, encoding: 'utf8' }).trim();
        const tree = execFileSync('git', ['rev-parse', `${previous}^{tree}`], { cwd: repo, encoding: 'utf8' }).trim();
        externalCommit = execFileSync('git', [
          'commit-tree', tree, '-p', previous, '-m', 'external sprint replacement before default merge',
        ], { cwd: repo, encoding: 'utf8' }).trim();
        sh(repo, ['update-ref', `refs/heads/${sprintBranch}`, externalCommit, sprintHead]);
        return mergeWorktreeBranch(input);
      },
    });

    const result = await raceCoordinator.archiveIteration('it');

    expect(externalCommit).toBeTruthy();
    expect(result.ok).toBe(true);
    expect(services.repos.iterations.get('it')?.status).toBe('archived');
    expect(execFileSync('git', [
      'show', 'main:docs/iterations/1.0/CHANGELOG.md',
    ], { cwd: repo, encoding: 'utf8' })).toContain('t1');
  });

  it('rolls back run success when iteration archival fails and recovers from the merged Git state', async () => {
    services.repos.tasks.insert({ id: 't1', requirementId: 'req', iterationId: 'it', projectId: 'p', title: 'T', description: '', status: 'archived', role: 'coder', stages: [], currentStage: 0, statusChangedAt: 1, createdAt: 1, updatedAt: 1, retryCount: 0 } as never);
    sh(repo, ['switch', '-qc', 'ai-devflow-sprint/1.0']);
    mkdirSync(join(repo, 'docs/iterations/1.0/tasks/t1'), { recursive: true });
    writeFileSync(join(repo, 'docs/iterations/1.0/tasks/t1/CHANGELOG.md'), '# t1\n');
    sh(repo, ['add', '.']); sh(repo, ['commit', '-qm', 'task changelog']);
    sh(repo, ['switch', '-q', 'main']);
    const archive = services.repos.iterations.archive;
    services.repos.iterations.archive = () => { throw new Error('injected archive failure'); };

    const first = await call('iterations', 'archive', 'it') as { ok: true } | { ok: false; reasons: string[] };

    expect(first.ok).toBe(false);
    expect(services.repos.iterations.get('it')?.status).toBe('active');
    expect(services.repos.knowledgeRuns.getLatestByIteration('it', 'iteration_changelog')?.state).not.toBe('succeeded');
    expect(execFileSync('git', ['show', 'main:docs/iterations/1.0/CHANGELOG.md'], { cwd: repo, encoding: 'utf8' })).toContain('t1');

    services.repos.iterations.archive = archive;
    const retried = await call('iterations', 'archive', 'it') as { ok: true } | { ok: false; reasons: string[] };

    expect(retried.ok).toBe(true);
    expect(runner.requests).toHaveLength(1);
    expect(services.repos.iterations.get('it')?.status).toBe('archived');
    expect(services.repos.knowledgeRuns.getLatestByIteration('it', 'iteration_changelog')?.state).toBe('succeeded');
  });

  it('preserves a validated aggregation branch across restart recovery and resumes without rerunning the agent', async () => {
    services.repos.tasks.insert({ id: 't1', requirementId: 'req', iterationId: 'it', projectId: 'p', title: 'T', description: '', status: 'archived', role: 'coder', stages: [], currentStage: 0, statusChangedAt: 1, createdAt: 1, updatedAt: 1, retryCount: 0 } as never);
    sh(repo, ['switch', '-qc', 'ai-devflow-sprint/1.0']);
    mkdirSync(join(repo, 'docs/iterations/1.0/tasks/t1'), { recursive: true });
    writeFileSync(join(repo, 'docs/iterations/1.0/tasks/t1/CHANGELOG.md'), '# t1\n');
    sh(repo, ['add', '.']); sh(repo, ['commit', '-qm', 'task changelog']);
    sh(repo, ['switch', '-q', 'main']);
    const sprintBaseCommit = execFileSync('git', ['rev-parse', 'ai-devflow-sprint/1.0'], { cwd: repo, encoding: 'utf8' }).trim();
    const runId = 'recovery-run';
    const draftBranch = `ai-devflow/knowledge/${runId}`;
    const draftWorktree = join(workdir, `knowledge-changelog-${runId}`);
    execFileSync('git', ['worktree', 'add', '-q', '-b', draftBranch, draftWorktree, 'ai-devflow-sprint/1.0'], { cwd: repo });
    writeFileSync(join(draftWorktree, 'docs/iterations/1.0/CHANGELOG.md'), '# Changelog\n\n- t1: done\n');
    writeFileSync(join(draftWorktree, 'docs/iterations/1.0/index.md'), '# Iteration\n\n- t1\n');
    sh(draftWorktree, ['add', '.']); sh(draftWorktree, ['commit', '-qm', 'validated aggregation']);
    const draftCommit = execFileSync('git', ['rev-parse', draftBranch], { cwd: repo, encoding: 'utf8' }).trim();
    services.repos.knowledgeRuns.create({
      id: runId,
      projectId: 'p',
      iterationId: 'it',
      kind: 'iteration_changelog',
      state: 'running',
      confirmationState: 'not_required',
      changedPathsJson: JSON.stringify(['docs/iterations/1.0/CHANGELOG.md', 'docs/iterations/1.0/index.md']),
      diagnosticsJson: '[]',
      resultJson: JSON.stringify({
        state: 'valid',
        phase: 'validated',
        aggregation: { kind: 'iteration_changelog', changedPaths: ['docs/iterations/1.0/CHANGELOG.md', 'docs/iterations/1.0/index.md'], coveredTaskIds: ['t1'] },
        coveredTaskIds: ['t1'],
        missingTaskIds: [],
        changedPaths: ['docs/iterations/1.0/CHANGELOG.md', 'docs/iterations/1.0/index.md'],
        verifiedAt: 2,
        sprintBaseCommit,
        draftCommit,
      }),
      startedAt: 1,
    });

    await coordinator.recoverInterrupted();
    expect(execFileSync('git', ['rev-parse', '--verify', `refs/heads/${draftBranch}`], { cwd: repo, encoding: 'utf8' }).trim()).toBe(draftCommit);

    const resumed = await call('iterations', 'archive', 'it') as { ok: true } | { ok: false; reasons: string[] };

    expect(resumed.ok).toBe(true);
    expect(runner.requests).toHaveLength(0);
    expect(services.repos.iterations.get('it')?.status).toBe('archived');
    expect(execFileSync('git', ['show', 'main:docs/iterations/1.0/CHANGELOG.md'], { cwd: repo, encoding: 'utf8' })).toContain('t1');
  });

  it('recovers a validated aggregation already contained by a non-fast-forward sprint merge', async () => {
    services.repos.tasks.insert({ id: 't1', requirementId: 'req', iterationId: 'it', projectId: 'p', title: 'T', description: '', status: 'archived', role: 'coder', stages: [], currentStage: 0, statusChangedAt: 1, createdAt: 1, updatedAt: 1, retryCount: 0 } as never);
    sh(repo, ['switch', '-qc', 'ai-devflow-sprint/1.0']);
    mkdirSync(join(repo, 'docs/iterations/1.0/tasks/t1'), { recursive: true });
    writeFileSync(join(repo, 'docs/iterations/1.0/tasks/t1/CHANGELOG.md'), '# t1\n');
    sh(repo, ['add', '.']); sh(repo, ['commit', '-qm', 'task changelog']);
    sh(repo, ['switch', '-q', 'main']);
    const sprintBaseCommit = execFileSync('git', ['rev-parse', 'ai-devflow-sprint/1.0'], { cwd: repo, encoding: 'utf8' }).trim();
    const runId = 'non-ff-recovery-run';
    const draftBranch = `ai-devflow/knowledge/${runId}`;
    const draftWorktree = join(workdir, `knowledge-changelog-${runId}`);
    execFileSync('git', ['worktree', 'add', '-q', '-b', draftBranch, draftWorktree, 'ai-devflow-sprint/1.0'], { cwd: repo });
    writeFileSync(join(draftWorktree, 'docs/iterations/1.0/CHANGELOG.md'), '# Changelog\n\n- t1: done\n');
    writeFileSync(join(draftWorktree, 'docs/iterations/1.0/index.md'), '# Iteration\n\n- t1\n');
    sh(draftWorktree, ['add', '.']); sh(draftWorktree, ['commit', '-qm', 'validated aggregation']);
    const draftCommit = execFileSync('git', ['rev-parse', draftBranch], { cwd: repo, encoding: 'utf8' }).trim();
    const baseTree = execFileSync('git', ['rev-parse', `${sprintBaseCommit}^{tree}`], { cwd: repo, encoding: 'utf8' }).trim();
    const concurrentSprintCommit = execFileSync('git', [
      'commit-tree', baseTree, '-p', sprintBaseCommit, '-m', 'concurrent sprint advance',
    ], { cwd: repo, encoding: 'utf8' }).trim();
    sh(repo, ['update-ref', 'refs/heads/ai-devflow-sprint/1.0', concurrentSprintCommit, sprintBaseCommit]);
    const sprintMerge = await mergeBranchInto({ repoPath: repo, into: 'ai-devflow-sprint/1.0', source: draftBranch });
    expect(sprintMerge.merged).toBe(true);
    expect(sprintMerge.commit).not.toBe(draftCommit);
    services.repos.knowledgeRuns.create({
      id: runId,
      projectId: 'p',
      iterationId: 'it',
      kind: 'iteration_changelog',
      state: 'running',
      confirmationState: 'not_required',
      changedPathsJson: JSON.stringify(['docs/iterations/1.0/CHANGELOG.md', 'docs/iterations/1.0/index.md']),
      diagnosticsJson: '[]',
      resultJson: JSON.stringify({
        state: 'valid',
        phase: 'validated',
        aggregation: { kind: 'iteration_changelog', changedPaths: ['docs/iterations/1.0/CHANGELOG.md', 'docs/iterations/1.0/index.md'], coveredTaskIds: ['t1'] },
        coveredTaskIds: ['t1'],
        missingTaskIds: [],
        changedPaths: ['docs/iterations/1.0/CHANGELOG.md', 'docs/iterations/1.0/index.md'],
        verifiedAt: 2,
        sprintBaseCommit,
        draftCommit,
      }),
      startedAt: 1,
    });

    await coordinator.recoverInterrupted();
    const resumed = await coordinator.archiveIteration('it');

    expect(resumed.ok).toBe(true);
    expect(runner.requests).toHaveLength(0);
    expect(services.repos.iterations.get('it')?.status).toBe('archived');
    expect(execFileSync('git', ['show', 'main:docs/iterations/1.0/CHANGELOG.md'], { cwd: repo, encoding: 'utf8' })).toContain('t1');
  });
});
