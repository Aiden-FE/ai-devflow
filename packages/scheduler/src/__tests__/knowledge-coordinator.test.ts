import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, createRepositories, type DatabaseSync } from '@ai-devflow/persistence';
import { ProjectKnowledgeService } from '@ai-devflow/knowledge';
import type { AgentRunner, AgentRun, RunnerAgentRunRequest as AgentRunRequest } from '@ai-devflow/agents';
import type { AgentEvent } from '@ai-devflow/core';
import { KnowledgeCoordinator } from '../knowledge-coordinator.js';
import { mergeBranchInto } from '../worktree.js';

function shGit(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'kb-coord-'));
  shGit(repo, ['init', '-q', '-b', 'main']);
  shGit(repo, ['config', 'user.email', 't@t']);
  shGit(repo, ['config', 'user.name', 't']);
  writeFileSync(join(repo, 'README.md'), '# repo\n');
  shGit(repo, ['add', '.']);
  shGit(repo, ['commit', '-q', '-m', 'init']);
  return repo;
}

/** Fake runner：project_lead 只写文件；Git 暂存、提交与合并必须由宿主负责。 */
class KnowledgeFakeRunner implements AgentRunner {
  requests: AgentRunRequest[] = [];
  constructor(private opts: {
    outOfScope?: boolean;
    runtimeArtifacts?: string[];
    stageRuntimeArtifacts?: boolean;
    normalizableAdr?: boolean;
    invalidFeatureStatus?: boolean;
    autoRepairFailures?: number;
  } = {}) {}
  private repairAttempts = 0;
  async verifyRuntime(): Promise<{ version: string; entry: string }> {
    return { version: 'fake', entry: 'fake' };
  }
  async run(req: AgentRunRequest): Promise<AgentRun> {
    this.requests.push(req);
    if (req.expert === 'project_lead' && req.resultKind === 'knowledge_initialization') {
      // 运行时（打包的 esbuild/lightningcss 平台二进制等）可能在 worktree 落下 .extramods/ 等产物。
      // 这类产物既非 agent 越界源码改动，也不应进入知识提交门禁。
      for (const artifact of this.opts.runtimeArtifacts ?? []) {
        const abs = join(req.cwd, artifact);
        mkdirSync(join(abs).split('/').slice(0, -1).join('/'), { recursive: true });
        writeFileSync(abs, 'runtime artifact\n', 'utf8');
      }
      if (this.opts.stageRuntimeArtifacts && this.opts.runtimeArtifacts?.length) {
        shGit(req.cwd, ['add', '-f', '--', ...this.opts.runtimeArtifacts]);
      }
      const path = this.opts.outOfScope ? 'packages/core/src/types.ts' : 'docs/knowledge/feature/task-review.md';
      mkdirSync(join(req.cwd, join(path).split('/').slice(0, -1).join('/')), { recursive: true });
      writeFileSync(join(req.cwd, path), this.opts.outOfScope ? '# Task Review\n' : `---
id: feature:task-review
type: feature
status: ${this.opts.invalidFeatureStatus ? 'unknown' : 'active'}
owner: project
updated: 2026-07-28
confidence: 0.9
sources:
  - README.md
related: []
---

# Task Review

Reusable task review guidance.
`, 'utf8');
      if (!this.opts.outOfScope) {
        const indexPath = join(req.cwd, 'docs/knowledge/feature/index.md');
        writeFileSync(indexPath, readFileSync(indexPath, 'utf8').replace('related: []', 'related:\n  - feature:task-review'));
      }
      if (this.opts.normalizableAdr) {
        const adrPath = join(req.cwd, 'docs/knowledge/adr/accepted.md');
        writeFileSync(adrPath, `---
id: adr:accepted
type: adr
status: accepted
owner: project
updated: 2026-07-30
confidence: 0.8
sources:
  - docs/
related: []
---

# Accepted decision

Accepted decision summary.
`);
        writeFileSync(
          join(req.cwd, path),
          readFileSync(join(req.cwd, path), 'utf8').replace('related: []', 'related:\n  - adr:accepted'),
        );
      }
    }
    if (req.expert === 'project_lead' && req.resultKind === 'knowledge_repair') {
      this.repairAttempts += 1;
      if (
        this.opts.invalidFeatureStatus &&
        this.repairAttempts > (this.opts.autoRepairFailures ?? 0)
      ) {
        const featurePath = join(req.cwd, 'docs/knowledge/feature/task-review.md');
        writeFileSync(
          featurePath,
          readFileSync(featurePath, 'utf8').replace('status: unknown', 'status: active'),
        );
      }
      mkdirSync(join(req.cwd, 'docs/knowledge/context'), { recursive: true });
      writeFileSync(join(req.cwd, 'docs/knowledge/context/runtime.md'), `---
id: context:runtime
type: context
status: active
owner: project
updated: 2026-07-30
confidence: 0.8
sources:
  - README.md
related: []
---

# Runtime
`, 'utf8');
    }
    const payload =
      req.resultKind === 'knowledge_initialization'
        ? { kind: 'knowledge_initialization' as const, changedPaths: ['docs/knowledge'], knowledgeIds: [] }
        : req.resultKind === 'knowledge_repair'
          ? {
              kind: 'knowledge_repair' as const,
              changedPaths: ['docs/knowledge'],
              knowledgeIds: [],
              resolvedFindingIds: [],
            }
          : req.resultKind === 'knowledge_audit'
            ? {
                kind: 'knowledge_audit' as const,
                findings: [{
                  id: 'semantic-stale',
                  severity: 'warn' as const,
                  code: 'possibly_stale',
                  message: '运行时知识可能过期',
                  evidence: ['README.md'],
                }],
              }
            : undefined;
    const events: AgentEvent[] = [{ type: 'done', summary: 'ok', result: payload, t: 0 }];
    return {
      events: (async function* () {
        for (const e of events) yield e;
      })(),
      cancel: async () => {},
      done: async () => ({ exitCode: 0, ok: true }),
    };
  }
}

describe('KnowledgeCoordinator', () => {
  let db: DatabaseSync;
  let repos: ReturnType<typeof createRepositories>;
  let repo: string;
  let wtBase: string;
  let coordinator: KnowledgeCoordinator;
  let runner: KnowledgeFakeRunner;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repos = createRepositories(db);
    repo = makeRepo();
    wtBase = mkdtempSync(join(tmpdir(), 'kb-coord-wt-'));
    repos.projects.insert({
      id: 'p1', name: 'P', path: repo, defaultBranch: 'main',
      createdAt: 1, updatedAt: 1, settings: {},
    });
    runner = new KnowledgeFakeRunner();
    coordinator = new KnowledgeCoordinator({
      repos,
      runner,
      knowledge: new ProjectKnowledgeService(),
      worktreesBaseDir: wtBase,
    });
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
    rmSync(repo, { recursive: true, force: true });
    rmSync(wtBase, { recursive: true, force: true });
  });

  it('lightCheck reports not_initialized on a fresh project', async () => {
    const snapshot = await coordinator.lightCheck('p1');
    expect(snapshot.state).toBe('not_initialized');
  });

  it('initializes iteration docs when the project ignores the node_modules directory', async () => {
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
    shGit(repo, ['add', '.gitignore']);
    shGit(repo, ['commit', '-q', '-m', 'ignore dependencies']);
    mkdirSync(join(repo, 'node_modules'));

    await expect(coordinator.initializeIteration({
      projectId: 'p1',
      iteration: { id: 'it-node-modules', projectId: 'p1', name: 'I', version: 'v-node-modules', status: 'active', createdAt: 1 },
    })).resolves.toBeUndefined();

    expect(repos.iterations.get('it-node-modules')).toEqual(expect.objectContaining({ status: 'active' }));
    expect(execFileSync('git', [
      'show', 'ai-devflow-sprint/v-node-modules:docs/iterations/v-node-modules/index.md',
    ], { cwd: repo, encoding: 'utf8' })).toContain('it-node-modules');
  });

  it('ignores runtime .extramods artifacts when committing knowledge drafts', async () => {
    // 运行时（打包的 esbuild/lightningcss 平台二进制等）在 worktree 里落下未忽略的 .extramods/，
    // 这类产物不是 agent 越界源码改动，知识门禁必须豁免，否则任务会被确定性卡死且无法靠重启解开。
    const runtimeRunner = new KnowledgeFakeRunner({
      runtimeArtifacts: [
        '.extramods/esbuild-0.21.3.tgz',
        '.extramods/esbuild-0.21.3/bin/esbuild',
        '.extramods/lightningcss-darwin-x64/lightningcss.darwin-x64.node',
      ],
    });
    const guardedCoordinator = new KnowledgeCoordinator({
      repos,
      runner: runtimeRunner,
      knowledge: new ProjectKnowledgeService(),
      worktreesBaseDir: wtBase,
    });

    const run = await guardedCoordinator.startInitialization('p1');

    expect(run.confirmationState).toBe('pending');
    expect(run.changedPaths).toContain('docs/knowledge/feature/task-review.md');
    // .extramods 运行时产物不得进入知识草稿提交。
    expect(run.changedPaths.some((p) => p.startsWith('.extramods/'))).toBe(false);
  });

  it('rejects staged runtime artifacts instead of including them in a knowledge commit', async () => {
    const guardedCoordinator = new KnowledgeCoordinator({
      repos,
      runner: new KnowledgeFakeRunner({
        runtimeArtifacts: ['.extramods/esbuild/bin/esbuild'],
        stageRuntimeArtifacts: true,
      }),
      knowledge: new ProjectKnowledgeService(),
      worktreesBaseDir: wtBase,
    });

    await expect(guardedCoordinator.startInitialization('p1')).rejects.toThrow(
      /越界改动被拒绝：\.extramods\/esbuild\/bin\/esbuild/,
    );
  });

  it('rejects tracked runtime artifact modifications in knowledge worktrees', async () => {
    mkdirSync(join(repo, '.extramods'), { recursive: true });
    writeFileSync(join(repo, '.extramods', 'tracked.txt'), 'baseline\n');
    shGit(repo, ['add', '.extramods/tracked.txt']);
    shGit(repo, ['commit', '-q', '-m', 'track runtime fixture']);
    const guardedCoordinator = new KnowledgeCoordinator({
      repos,
      runner: new KnowledgeFakeRunner({ runtimeArtifacts: ['.extramods/tracked.txt'] }),
      knowledge: new ProjectKnowledgeService(),
      worktreesBaseDir: wtBase,
    });

    await expect(guardedCoordinator.startInitialization('p1')).rejects.toThrow(
      /越界改动被拒绝：\.extramods\/tracked\.txt/,
    );
  });

  it('prepares a retried task without treating existing implementation changes as knowledge changes', async () => {
    repos.iterations.insert({
      id: 'it-retry', projectId: 'p1', name: 'Retry', version: 'v-retry', status: 'active', createdAt: 1,
    });
    repos.requirements.insert({
      id: 'req-retry', iterationId: 'it-retry', title: 'Retry requirement', description: '',
      priority: 'medium', acceptance: '', createdAt: 1, archived: false,
    });
    const task = {
      id: 'task-retry', requirementId: 'req-retry', iterationId: 'it-retry', projectId: 'p1',
      title: 'Resume implementation', description: '', status: 'in_progress' as const, role: 'coder' as const,
      stages: [], currentStage: 0, statusChangedAt: 1, createdAt: 1, updatedAt: 1, retryCount: 1,
    };
    repos.tasks.insert(task);
    repos.executions.insert({
      id: 'exec-retry', taskId: task.id, attempt: 2, startedAt: 1, status: 'running',
    });
    writeFileSync(join(repo, 'README.md'), '# staged implementation change\n');
    shGit(repo, ['add', 'README.md']);
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'feature.ts'), 'export const feature = true;\n');
    mkdirSync(join(repo, '.toolchain'), { recursive: true });
    writeFileSync(join(repo, '.toolchain', 'node'), 'runtime cache\n');

    await expect(coordinator.prepareTaskExecution({
      task,
      project: { id: 'p1', path: repo, defaultBranch: 'main' },
      executionId: 'exec-retry',
      expert: 'dev',
      stage: 'development',
      cwd: repo,
    })).resolves.toBeDefined();

    const committedPaths = execFileSync(
      'git', ['show', '--pretty=', '--name-only', 'HEAD'], { cwd: repo, encoding: 'utf8' },
    ).trim().split('\n').filter(Boolean);
    expect(committedPaths).toEqual(['docs/iterations/v-retry/tasks/task-retry/index.md']);
    const status = execFileSync('git', ['status', '--short'], { cwd: repo, encoding: 'utf8' });
    expect(status).toContain('M  README.md');
    expect(status).toContain('?? .toolchain/');
    expect(status).toContain('?? src/');
  });

  it('rejects a node_modules link that no longer targets the project dependencies', async () => {
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
    shGit(repo, ['add', '.gitignore']);
    shGit(repo, ['commit', '-q', '-m', 'ignore dependencies']);
    mkdirSync(join(repo, 'node_modules'));
    const unmanagedDependencies = join(wtBase, 'unmanaged-node-modules');
    mkdirSync(unmanagedDependencies);
    const replacingKnowledge = new ProjectKnowledgeService();
    const initializeIteration = replacingKnowledge.initializeIteration.bind(replacingKnowledge);
    replacingKnowledge.initializeIteration = async (input) => {
      const changes = await initializeIteration(input);
      rmSync(join(input.repoPath, 'node_modules'), { force: true });
      symlinkSync(unmanagedDependencies, join(input.repoPath, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
      return changes;
    };
    const guardedCoordinator = new KnowledgeCoordinator({
      repos,
      runner,
      knowledge: replacingKnowledge,
      worktreesBaseDir: wtBase,
    });

    await expect(guardedCoordinator.initializeIteration({
      projectId: 'p1',
      iteration: { id: 'it-unmanaged-link', projectId: 'p1', name: 'I', version: 'v-unmanaged-link', status: 'active', createdAt: 1 },
    })).rejects.toThrow(/越界改动被拒绝：node_modules/);
  });

  it('rejects the managed node_modules link when it has been force-staged', async () => {
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
    shGit(repo, ['add', '.gitignore']);
    shGit(repo, ['commit', '-q', '-m', 'ignore dependencies']);
    mkdirSync(join(repo, 'node_modules'));
    const stagingKnowledge = new ProjectKnowledgeService();
    const initializeIteration = stagingKnowledge.initializeIteration.bind(stagingKnowledge);
    stagingKnowledge.initializeIteration = async (input) => {
      const changes = await initializeIteration(input);
      shGit(input.repoPath, ['add', '-f', 'node_modules']);
      return changes;
    };
    const guardedCoordinator = new KnowledgeCoordinator({
      repos,
      runner,
      knowledge: stagingKnowledge,
      worktreesBaseDir: wtBase,
    });

    await expect(guardedCoordinator.initializeIteration({
      projectId: 'p1',
      iteration: { id: 'it-staged-link', projectId: 'p1', name: 'I', version: 'v-staged-link', status: 'active', createdAt: 1 },
    })).rejects.toThrow(/越界改动被拒绝：node_modules/);
  });

  it('serializes concurrent creation of the same project version before touching Git twice', async () => {
    let releaseInitialization!: () => void;
    const initializationGate = new Promise<void>((resolve) => { releaseInitialization = resolve; });
    let firstInitializationStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { firstInitializationStarted = resolve; });
    let initializationCalls = 0;
    const realKnowledge = new ProjectKnowledgeService();
    const delayedKnowledge = new ProjectKnowledgeService();
    delayedKnowledge.initializeIteration = async (input) => {
      initializationCalls += 1;
      firstInitializationStarted();
      await initializationGate;
      return realKnowledge.initializeIteration(input);
    };
    let generatedId = 0;
    const concurrentCoordinator = new KnowledgeCoordinator({
      repos,
      runner,
      knowledge: delayedKnowledge,
      worktreesBaseDir: wtBase,
      id: () => `generated-${++generatedId}`,
    });
    const first = concurrentCoordinator.initializeIteration({
      projectId: 'p1',
      iteration: { id: 'it-1', projectId: 'p1', name: 'I1', version: 'v1', status: 'active', createdAt: 1 },
    });
    await firstStarted;
    const second = concurrentCoordinator.initializeIteration({
      projectId: 'p1',
      iteration: { id: 'it-2', projectId: 'p1', name: 'I2', version: 'v1', status: 'active', createdAt: 2 },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseInitialization();

    const results = await Promise.allSettled([first, second]);

    expect(initializationCalls).toBe(1);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejection = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(String(rejection?.reason)).toMatch(/v1.*已存在/);
    expect(repos.iterations.listByProject('p1')).toHaveLength(1);
  });

  it('claims an iteration version in the database before another coordinator can mutate its sprint branch', async () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'kb-coord-db-'));
    const dbPath = join(dbDir, 'shared.db');
    const db1 = openDatabase(dbPath);
    const db2 = openDatabase(dbPath);
    const repos1 = createRepositories(db1);
    const repos2 = createRepositories(db2);
    repos1.projects.insert({
      id: 'shared', name: 'Shared', path: repo, defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {},
    });
    let releaseInitialization!: () => void;
    const initializationGate = new Promise<void>((resolve) => { releaseInitialization = resolve; });
    let firstInitializationStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { firstInitializationStarted = resolve; });
    const delayedKnowledge = new ProjectKnowledgeService();
    const realInitialize = delayedKnowledge.initializeIteration.bind(delayedKnowledge);
    delayedKnowledge.initializeIteration = async (input) => {
      firstInitializationStarted();
      await initializationGate;
      return realInitialize(input);
    };
    const firstCoordinator = new KnowledgeCoordinator({
      repos: repos1, runner, knowledge: delayedKnowledge, worktreesBaseDir: wtBase, id: () => 'first-draft',
    });
    const secondCoordinator = new KnowledgeCoordinator({
      repos: repos2, runner, knowledge: new ProjectKnowledgeService(), worktreesBaseDir: wtBase, id: () => 'second-draft',
    });

    try {
      const first = firstCoordinator.initializeIteration({
        projectId: 'shared',
        iteration: { id: 'it-first', projectId: 'shared', name: 'First', version: 'v-shared', status: 'active', createdAt: 1 },
      });
      await firstStarted;
      const second = secondCoordinator.initializeIteration({
        projectId: 'shared',
        iteration: { id: 'it-second', projectId: 'shared', name: 'Second', version: 'v-shared', status: 'active', createdAt: 2 },
      });
      await expect(second).rejects.toThrow(/v-shared|unique|已存在/i);
      releaseInitialization();
      await first;

      expect(repos1.iterations.listByProject('shared').map((iteration) => iteration.id)).toEqual(['it-first']);
      expect(execFileSync('git', [
        'show', 'ai-devflow-sprint/v-shared:docs/iterations/v-shared/index.md',
      ], { cwd: repo, encoding: 'utf8' })).toContain('it-first');
    } finally {
      releaseInitialization();
      db2.close();
      db1.close();
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  it.each(['claimed', 'branch_created', 'docs_merged'] as const)(
    'recovers an initializing iteration after a %s crash point',
    async (crashPoint) => {
      db.prepare(
        `INSERT INTO iterations(id,project_id,name,version,status,created_at)
         VALUES(?,?,?,?,?,?)`,
      ).run('it-crash', 'p1', 'Crash', 'v-crash', 'initializing', 1);
      const sprintBranch = 'ai-devflow-sprint/v-crash';
      if (crashPoint !== 'claimed') {
        shGit(repo, ['branch', sprintBranch, 'main']);
      }
      if (crashPoint === 'docs_merged') {
        const crashWorktree = join(wtBase, 'crash-docs');
        execFileSync('git', ['worktree', 'add', '-q', '-b', 'crash-docs', crashWorktree, sprintBranch], { cwd: repo });
        mkdirSync(join(crashWorktree, 'docs/iterations/v-crash'), { recursive: true });
        writeFileSync(join(crashWorktree, 'docs/iterations/v-crash/index.md'), '# Iteration it-crash\n');
        writeFileSync(join(crashWorktree, 'docs/iterations/v-crash/CHANGELOG.md'), '# Changelog\n');
        shGit(crashWorktree, ['add', '.']);
        shGit(crashWorktree, ['commit', '-q', '-m', 'crash docs']);
        const docsCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: crashWorktree, encoding: 'utf8' }).trim();
        const previous = execFileSync('git', ['rev-parse', sprintBranch], { cwd: repo, encoding: 'utf8' }).trim();
        shGit(repo, ['update-ref', `refs/heads/${sprintBranch}`, docsCommit, previous]);
        execFileSync('git', ['worktree', 'remove', '--force', crashWorktree], { cwd: repo, stdio: 'ignore' });
        shGit(repo, ['branch', '-D', 'crash-docs']);
      }

      expect(repos.iterations.listByProject('p1')).toHaveLength(0);

      await coordinator.recoverInterrupted();

      expect(repos.iterations.listByProject('p1')).toEqual([
        expect.objectContaining({ id: 'it-crash', version: 'v-crash', status: 'active' }),
      ]);
      expect(execFileSync('git', [
        'show', `${sprintBranch}:docs/iterations/v-crash/index.md`,
      ], { cwd: repo, encoding: 'utf8' })).toContain('it-crash');
    },
  );

  it('does not roll back an external sprint advance after its own merge CAS succeeds', async () => {
    let externalCommit: string | undefined;
    const guardedCoordinator = new KnowledgeCoordinator({
      repos,
      runner,
      knowledge: new ProjectKnowledgeService(),
      worktreesBaseDir: wtBase,
      mergeBranchInto: async (input) => {
        const result = await mergeBranchInto(input);
        if (result.merged && result.commit) {
          const tree = execFileSync('git', ['rev-parse', `${result.commit}^{tree}`], { cwd: repo, encoding: 'utf8' }).trim();
          externalCommit = execFileSync('git', [
            'commit-tree', tree, '-p', result.commit, '-m', 'external sprint advance',
          ], { cwd: repo, encoding: 'utf8' }).trim();
          shGit(repo, ['update-ref', `refs/heads/${input.into}`, externalCommit, result.commit]);
        }
        return result;
      },
    });
    repos.iterations.activate = () => { throw new Error('injected activate failure'); };

    await expect(guardedCoordinator.initializeIteration({
      projectId: 'p1',
      iteration: { id: 'it-cas-failure', projectId: 'p1', name: 'I', version: 'v-cas-failure', status: 'active', createdAt: 1 },
    })).rejects.toThrow(/activate failure/);

    expect(externalCommit).toBeTruthy();
    expect(execFileSync('git', [
      'rev-parse', 'ai-devflow-sprint/v-cas-failure',
    ], { cwd: repo, encoding: 'utf8' }).trim()).toBe(externalCommit);
  });

  it('rejects a version that would be rewritten to a colliding sprint branch segment', async () => {
    await expect(coordinator.initializeIteration({
      projectId: 'p1',
      iteration: { id: 'it-dot', projectId: 'p1', name: 'Dot', version: '.v1', status: 'active', createdAt: 1 },
    })).rejects.toThrow(/version|版本|规范/);

    expect(repos.iterations.listByProject('p1')).toHaveLength(0);
    expect(() => execFileSync('git', ['rev-parse', '--verify', 'refs/heads/ai-devflow-sprint/v1'], {
      cwd: repo,
      stdio: 'pipe',
    })).toThrow();
  });

  it('removes a newly created sprint branch when initialization fails before the draft merge', async () => {
    const failingKnowledge = new ProjectKnowledgeService();
    failingKnowledge.initializeIteration = async () => {
      throw new Error('injected initialization failure');
    };
    const failingCoordinator = new KnowledgeCoordinator({
      repos, runner, knowledge: failingKnowledge, worktreesBaseDir: wtBase,
    });

    await expect(failingCoordinator.initializeIteration({
      projectId: 'p1',
      iteration: { id: 'it-pre-merge-fail', projectId: 'p1', name: 'I', version: 'v-pre-merge-fail', status: 'active', createdAt: 1 },
    })).rejects.toThrow(/initialization failure/);

    expect(repos.iterations.listByProject('p1')).toHaveLength(0);
    expect(() => execFileSync('git', [
      'rev-parse', '--verify', 'refs/heads/ai-devflow-sprint/v-pre-merge-fail',
    ], { cwd: repo, stdio: 'pipe' })).toThrow();
  });

  it('startInitialization creates a pending run with the knowledge draft branch', async () => {
    const run = await coordinator.startInitialization('p1');
    expect(run.confirmationState).toBe('pending');
    expect(run.draftBranch).toBe(`ai-devflow/knowledge/${run.id}`);
    expect(run.changedPaths).toContain('docs/knowledge/feature/task-review.md');
    // 项目主工作区尚未被修改
    expect(existsSync(join(repo, 'docs/knowledge/index.md'))).toBe(false);
  });

  it('normalizes known metadata defects before exposing an initialization draft', async () => {
    const normalizingCoordinator = new KnowledgeCoordinator({
      repos,
      runner: new KnowledgeFakeRunner({ normalizableAdr: true }),
      knowledge: new ProjectKnowledgeService(),
      worktreesBaseDir: wtBase,
    });

    const run = await normalizingCoordinator.startInitialization('p1');
    const retained = await normalizingCoordinator.getRun(run.id);

    expect(retained.state).toBe('awaiting_confirmation');
    expect(retained.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
    expect(retained.diff).toContain('status: active');
    expect(retained.diff).toContain('  - docs');
    expect(retained.diff).not.toContain('status: accepted');
    expect(retained.diff).not.toContain('  - docs/');
  });

  it('automatically asks the agent to repair deterministic initialization findings', async () => {
    const repairingRunner = new KnowledgeFakeRunner({ invalidFeatureStatus: true });
    const repairingCoordinator = new KnowledgeCoordinator({
      repos,
      runner: repairingRunner,
      knowledge: new ProjectKnowledgeService(),
      worktreesBaseDir: wtBase,
    });

    const run = await repairingCoordinator.startInitialization('p1');

    expect(run.state).toBe('awaiting_confirmation');
    expect(run.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
    expect(repairingRunner.requests.map((request) => request.resultKind)).toEqual([
      'knowledge_initialization',
      'knowledge_repair',
    ]);
    expect(repairingRunner.requests[1]?.prompt).toMatch(/invalid knowledge metadata/);
    expect(repairingRunner.requests[1]?.prompt).toMatch(/docs\/knowledge\/feature\/task-review\.md/);
  });

  it('retains the draft and retries agent repair during confirmation instead of discarding initialization work', async () => {
    const repairingRunner = new KnowledgeFakeRunner({
      invalidFeatureStatus: true,
      autoRepairFailures: 1,
    });
    const repairingCoordinator = new KnowledgeCoordinator({
      repos,
      runner: repairingRunner,
      knowledge: new ProjectKnowledgeService(),
      worktreesBaseDir: wtBase,
    });

    const run = await repairingCoordinator.startInitialization('p1');
    expect(run.state).toBe('awaiting_confirmation');
    expect(run.findings.some((finding) => finding.severity === 'error')).toBe(true);
    expect(existsSync(join(wtBase, `knowledge-${run.id}`))).toBe(true);

    await expect(repairingCoordinator.confirmRun(run.id)).resolves.toBeDefined();

    expect((await repairingCoordinator.getRun(run.id)).state).toBe('succeeded');
    expect(readFileSync(join(repo, 'docs/knowledge/feature/task-review.md'), 'utf8')).toContain('status: active');
    expect(repairingRunner.requests.map((request) => request.resultKind)).toEqual([
      'knowledge_initialization',
      'knowledge_repair',
      'knowledge_repair',
    ]);
  });

  it('confirmRun merges the draft into the default branch', async () => {
    const run = await coordinator.startInitialization('p1');
    const snapshot = await coordinator.confirmRun(run.id);
    expect(existsSync(join(repo, 'docs/knowledge/index.md'))).toBe(true);
    expect(existsSync(join(repo, 'docs/knowledge/feature/task-review.md'))).toBe(true);
    expect(snapshot.state).not.toBe('not_initialized');
    const record = await coordinator.getRun(run.id);
    expect(record.state).toBe('succeeded');
  });

  it('normalizes and commits known metadata defects in an existing pending draft before merge', async () => {
    const run = await coordinator.startInitialization('p1');
    const worktreePath = join(wtBase, `knowledge-${run.id}`);
    writeFileSync(join(worktreePath, 'docs/knowledge/adr/accepted.md'), `---
id: adr:accepted
type: adr
status: accepted
owner: project
updated: 2026-07-30
confidence: 0.8
sources:
  - docs/
related: []
---

# Accepted decision

Accepted decision summary.
`);
    shGit(worktreePath, ['add', 'docs/knowledge/adr/accepted.md']);
    shGit(worktreePath, ['commit', '-q', '-m', 'inject invalid metadata']);

    await expect(coordinator.confirmRun(run.id)).resolves.toBeDefined();

    const merged = readFileSync(join(repo, 'docs/knowledge/adr/accepted.md'), 'utf8');
    expect(merged).toContain('status: active');
    expect(merged).toContain('  - docs');
    expect(merged).not.toContain('status: accepted');
    expect(merged).not.toContain('  - docs/');
  });

  it('keeps a confirmed run succeeded when post-merge cleanup fails', async () => {
    const cleanupFailure = new KnowledgeCoordinator({
      repos: createRepositories(db),
      runner,
      knowledge: new ProjectKnowledgeService(),
      worktreesBaseDir: wtBase,
      removeWorktree: async () => { throw new Error('injected cleanup failure'); },
    });
    const run = await cleanupFailure.startInitialization('p1');

    await cleanupFailure.confirmRun(run.id);

    expect(existsSync(join(repo, 'docs/knowledge/index.md'))).toBe(true);
    const record = await cleanupFailure.getRun(run.id);
    expect(record.state).toBe('succeeded');
    expect(record.confirmationState).toBe('confirmed');
    expect(record.diagnostics.join(' ')).toMatch(/cleanup|清理/);
  });

  it('keeps a draft active and cancelable when confirmation validation is blocked', async () => {
    const updates: Array<{ id: string; state: string }> = [];
    coordinator.on('run-update', (view) => updates.push(view));
    const run = await coordinator.startInitialization('p1');
    const worktreePath = join(wtBase, `knowledge-${run.id}`);
    const featurePath = join(worktreePath, 'docs/knowledge/feature/task-review.md');
    writeFileSync(featurePath, readFileSync(featurePath, 'utf8').replace('status: active', 'status: unknown'));
    shGit(worktreePath, ['add', 'docs/knowledge/feature/task-review.md']);
    shGit(worktreePath, ['commit', '-q', '-m', 'inject invalid metadata']);

    await expect(coordinator.confirmRun(run.id)).rejects.toThrow(/invalid knowledge metadata|阻断/);

    expect(existsSync(join(repo, 'docs/knowledge/index.md'))).toBe(false);
    const retained = await coordinator.getRun(run.id);
    expect(retained.state).toBe('awaiting_confirmation');
    expect(retained.diff).toContain('docs/knowledge/index.md');
    expect((await coordinator.getActiveRun('p1'))?.id).toBe(run.id);
    expect(updates.at(-1)).toEqual(expect.objectContaining({ id: run.id, state: 'awaiting_confirmation' }));

    await expect(coordinator.cancelRun(run.id)).resolves.toBeUndefined();
    expect((await coordinator.getRun(run.id)).state).toBe('canceled');
  });

  it('cancelRun cleans up the draft branch and marks canceled', async () => {
    const run = await coordinator.startInitialization('p1');
    await coordinator.cancelRun(run.id);
    const record = await coordinator.getRun(run.id);
    expect(record.state).toBe('canceled');
    expect(existsSync(join(repo, 'docs/knowledge/index.md'))).toBe(false);
  });

  it('getActiveRun recovers the complete pending draft view', async () => {
    await expect(coordinator.getActiveRun('p1')).resolves.toBeUndefined();
    const run = await coordinator.startInitialization('p1');
    const active = await coordinator.getActiveRun('p1');
    expect(active?.id).toBe(run.id);
    expect(active?.state).toBe('awaiting_confirmation');
    expect(active?.confirmationState).toBe('pending');
    expect(active?.diff).toContain('docs/knowledge');
    await coordinator.cancelRun(run.id);
    await expect(coordinator.getActiveRun('p1')).resolves.toBeUndefined();
  });

  it('returns the existing pending initialization instead of starting another run', async () => {
    const first = await coordinator.startInitialization('p1');
    const second = await coordinator.startInitialization('p1');

    expect(second.id).toBe(first.id);
    expect(second.diff).toContain('docs/knowledge');
    expect(repos.knowledgeRuns.listByProject('p1')).toHaveLength(1);
    expect(runner.requests).toHaveLength(1);
    // 其他知识操作仍受到保护。
    await expect(coordinator.startAudit('p1', 'light')).rejects.toThrow(/已有进行中的知识运行/);
    await coordinator.cancelRun(first.id);
    // 取消后可重新启动。
    const restarted = await coordinator.startInitialization('p1');
    expect(restarted.id).not.toBe(first.id);
  });

  it('keeps a missing pending draft cancelable after confirm reports recovery guidance', async () => {
    const run = await coordinator.startInitialization('p1');
    rmSync(join(wtBase, `knowledge-${run.id}`), { recursive: true, force: true });

    await expect(coordinator.confirmRun(run.id)).rejects.toThrow(/草稿.*缺失|取消.*重新初始化/);
    expect((await coordinator.getRun(run.id)).state).toBe('awaiting_confirmation');

    await expect(coordinator.cancelRun(run.id)).resolves.toBeUndefined();
    expect((await coordinator.getRun(run.id)).state).toBe('canceled');
  });

  it('keeps a corrupt pending worktree cancelable after confirm reports recovery guidance', async () => {
    const run = await coordinator.startInitialization('p1');
    const worktreePath = join(wtBase, `knowledge-${run.id}`);
    writeFileSync(join(worktreePath, '.git'), 'gitdir: /missing/knowledge-worktree\n');

    await expect(coordinator.confirmRun(run.id)).rejects.toThrow(/草稿.*缺失|取消.*重新初始化/);
    expect((await coordinator.getRun(run.id)).state).toBe('awaiting_confirmation');

    await expect(coordinator.cancelRun(run.id)).resolves.toBeUndefined();
    expect((await coordinator.getRun(run.id)).state).toBe('canceled');
  });

  it('serializes confirm and cancel so a terminal state cannot be overwritten', async () => {
    const blockingKnowledge = new ProjectKnowledgeService();
    const audit = blockingKnowledge.audit.bind(blockingKnowledge);
    let auditCalls = 0;
    let signalEntered!: () => void;
    let releaseAudit!: () => void;
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    const release = new Promise<void>((resolve) => { releaseAudit = resolve; });
    blockingKnowledge.audit = async (input) => {
      auditCalls += 1;
      if (auditCalls === 2) {
        signalEntered();
        await release;
      }
      return audit(input);
    };
    const racingCoordinator = new KnowledgeCoordinator({
      repos,
      runner,
      knowledge: blockingKnowledge,
      worktreesBaseDir: wtBase,
    });
    const run = await racingCoordinator.startInitialization('p1');

    const confirmPromise = racingCoordinator.confirmRun(run.id);
    await entered;
    const cancelPromise = racingCoordinator.cancelRun(run.id);
    releaseAudit();

    await expect(confirmPromise).resolves.toEqual(expect.objectContaining({ projectId: 'p1' }));
    await expect(cancelPromise).rejects.toThrow(/不能取消/);
    expect((await racingCoordinator.getRun(run.id)).state).toBe('succeeded');
  });

  it('startAudit(light) performs host-only structural audit', async () => {
    const run = await coordinator.startAudit('p1', 'light');
    expect(run.state).toBe('succeeded');
    expect(run.kind).toBe('light_audit');
    expect(runner.requests).toHaveLength(0);
  });

  it('startAudit(full) runs project_lead and persists semantic findings', async () => {
    const run = await coordinator.startAudit('p1', 'full');

    expect(runner.requests.map((request) => request.resultKind)).toEqual(['knowledge_audit']);
    expect(run.kind).toBe('full_audit');
    expect(run.findings.map((finding) => finding.code)).toContain('possibly_stale');
  });

  it('startRepair rejects unknown finding ids', async () => {
    await expect(coordinator.startRepair('p1', ['bogus-finding'])).rejects.toThrow(/未知|无可修复/);
  });

  it('startRepair fixes selected findings in a fresh draft', async () => {
    // 先做一次巡检产生 finding 记录
    const audit = await coordinator.startAudit('p1', 'light');
    const findingId = audit.findings[0]?.id;
    expect(findingId).toBeTruthy();
    const repair = await coordinator.startRepair('p1', [findingId!]);
    expect(repair.confirmationState).toBe('pending');
    expect(repair.draftBranch).toBe(`ai-devflow/knowledge/${repair.id}`);
  });

  it('rejects out-of-scope agent changes during initialization', async () => {
    const oosRunner = new KnowledgeFakeRunner({ outOfScope: true });
    const db2 = openDatabase(':memory:');
    const repos2 = createRepositories(db2);
    repos2.projects.insert({
      id: 'p1', name: 'P', path: repo, defaultBranch: 'main',
      createdAt: 1, updatedAt: 1, settings: {},
    });
    const oosCoord = new KnowledgeCoordinator({
      repos: repos2, runner: oosRunner, knowledge: new ProjectKnowledgeService(),
      worktreesBaseDir: wtBase,
    });
    await expect(oosCoord.startInitialization('p1')).rejects.toThrow(/越界/);
    try { db2.close(); } catch { /* */ }
  });

  it('getRun returns a diff for pending confirmation runs', async () => {
    const run = await coordinator.startInitialization('p1');
    const view = await coordinator.getRun(run.id);
    expect(view.diff).toBeTruthy();
    expect(view.diff).toContain('Task Review');
  });

  it('persists project-scope chat retrievals before the agent request', async () => {
    const manifest = await coordinator.prepareChatContext({
      projectId: 'p1',
      expert: 'product',
      stage: 'requirement_chat',
      prompt: '设计登录需求',
      repoPath: repo,
    });

    const row = createRepositories(db).knowledgeRetrievals.get(manifest.id);
    expect(row).toEqual(expect.objectContaining({
      projectId: 'p1',
      expertKey: 'product',
      stage: 'requirement_chat',
      state: 'not_initialized',
    }));
  });

  it('recovers interrupted knowledge writes without duplicating awaiting initialization', async () => {
    const localRepos = createRepositories(db);
    localRepos.iterations.insert({ id: 'it', projectId: 'p1', name: 'I', version: '1.0', status: 'active', createdAt: 1 });
    localRepos.requirements.insert({ id: 'req', iterationId: 'it', title: 'R', description: '', priority: 'medium', acceptance: 'a', createdAt: 1, archived: false });
    for (const taskId of ['running-task', 'awaiting-task']) {
      localRepos.tasks.insert({
        id: taskId, requirementId: 'req', iterationId: 'it', projectId: 'p1', title: taskId,
        description: '', status: 'testing', role: 'coder', stages: [], currentStage: 0,
        statusChangedAt: 1, createdAt: 1, updatedAt: 1, retryCount: 0,
      });
    }
    localRepos.knowledgeRuns.create({
      id: 'interrupted-run', projectId: 'p1', kind: 'full_audit', state: 'running',
      confirmationState: 'not_required', changedPathsJson: '[]', diagnosticsJson: '["before restart"]',
      resultJson: '{}', startedAt: 1,
    });
    const assessmentJson = JSON.stringify({ verdict: 'valuable', candidates: [{ type: 'feature', summary: 's', evidence: ['e'], reuseScenario: 'r' }] });
    localRepos.knowledgeDepositions.create({
      id: 'interrupted-deposition', projectId: 'p1', taskId: 'running-task', verdict: 'valuable', state: 'running',
      assessmentJson, relatedKnowledgeIdsJson: '[]', changedPathsJson: '[]', gatePassed: false,
      diagnosticsJson: '["before restart"]', startedAt: 1,
    });
    localRepos.knowledgeDepositions.create({
      id: 'awaiting-deposition', projectId: 'p1', taskId: 'awaiting-task', verdict: 'valuable', state: 'awaiting_initialization',
      assessmentJson, relatedKnowledgeIdsJson: '[]', changedPathsJson: '[]', gatePassed: false,
      diagnosticsJson: '["needs init"]', startedAt: 2,
    });
    localRepos.knowledgeRetrievals.create({
      id: 'interrupted-retrieval', projectId: 'p1', taskId: 'running-task',
      expertKey: 'test', stage: 'review', level: 2, state: 'planned',
      candidateRefsJson: '[]', readEvidenceJson: '[]', skippedRefsJson: '[]', differencesJson: '[]',
      budgetFiles: 1, budgetChars: 100, usedFiles: 0, usedChars: 0, confidence: 0, createdAt: 3,
    });

    const recovered = await coordinator.recoverInterrupted();

    expect(recovered).toEqual({ failedRuns: ['interrupted-run'], failedDepositions: ['interrupted-deposition'] });
    expect(localRepos.knowledgeRuns.get('interrupted-run')).toEqual(expect.objectContaining({ state: 'failed' }));
    expect(JSON.parse(localRepos.knowledgeRuns.get('interrupted-run')!.diagnosticsJson)).toEqual(['before restart', '应用重启，知识运行已中断']);
    expect(localRepos.knowledgeDepositions.get('interrupted-deposition')).toEqual(expect.objectContaining({ state: 'failed' }));
    expect(localRepos.knowledgeDepositions.get('awaiting-deposition')).toEqual(expect.objectContaining({
      state: 'awaiting_initialization',
      diagnosticsJson: '["needs init"]',
    }));
    expect(localRepos.knowledgeRetrievals.get('interrupted-retrieval')).toEqual(expect.objectContaining({
      state: 'failed',
      completedAt: expect.any(Number),
    }));
    expect(JSON.parse(localRepos.knowledgeRetrievals.get('interrupted-retrieval')!.differencesJson)).toContainEqual(
      expect.objectContaining({ code: 'retrieval_interrupted' }),
    );
  });

  it('reconciles a running deposition whose validated draft is already in the target branch', async () => {
    repos.iterations.insert({ id: 'it-reconcile', projectId: 'p1', name: 'I', version: 'v-reconcile', status: 'active', createdAt: 1 });
    repos.requirements.insert({ id: 'req-reconcile', iterationId: 'it-reconcile', title: 'R', description: '', priority: 'medium', acceptance: '', createdAt: 1, archived: false });
    repos.tasks.insert({
      id: 'task-reconcile', requirementId: 'req-reconcile', iterationId: 'it-reconcile', projectId: 'p1', title: 'T', description: '',
      status: 'testing', role: 'coder', stages: [], currentStage: 0, statusChangedAt: 1, createdAt: 1, updatedAt: 1, retryCount: 0,
    });
    const taskBranch = 'ai-devflow/task-reconcile';
    const draftBranch = 'ai-devflow/knowledge/reconcile-deposition';
    const targetBranch = 'ai-devflow-sprint/v-reconcile';
    const worktreePath = join(wtBase, 'knowledge-deposition-reconcile-deposition');
    shGit(repo, ['branch', taskBranch, 'main']);
    execFileSync('git', ['worktree', 'add', '-q', '-b', draftBranch, worktreePath, taskBranch], { cwd: repo });
    mkdirSync(join(worktreePath, 'docs/knowledge/feature'), { recursive: true });
    writeFileSync(join(worktreePath, 'docs/knowledge/feature/recovered.md'), '# recovered\n');
    shGit(worktreePath, ['add', '.']);
    shGit(worktreePath, ['commit', '-q', '-m', 'knowledge']);
    const taskCommit = execFileSync('git', ['rev-parse', taskBranch], { cwd: repo, encoding: 'utf8' }).trim();
    const draftCommit = execFileSync('git', ['rev-parse', draftBranch], { cwd: repo, encoding: 'utf8' }).trim();
    shGit(repo, ['branch', targetBranch, draftCommit]);
    repos.knowledgeDepositions.create({
      id: 'reconcile-deposition', projectId: 'p1', taskId: 'task-reconcile', verdict: 'valuable', state: 'running',
      assessmentJson: JSON.stringify({ verdict: 'valuable', candidates: [{ type: 'feature', summary: 's', evidence: ['x'], reuseScenario: 'r' }] }),
      relatedKnowledgeIdsJson: '["feature:recovered"]', changedPathsJson: '["docs/knowledge/feature/recovered.md"]',
      gatePassed: false, diagnosticsJson: '[]', startedAt: 1,
      progressJson: JSON.stringify({ phase: 'validated', targetBranch, taskCommit, draftCommit }),
    });

    const recovered = await coordinator.recoverInterrupted();

    expect(recovered.failedDepositions).toEqual([]);
    expect(repos.knowledgeDepositions.get('reconcile-deposition')).toMatchObject({ state: 'succeeded', gatePassed: true });
  });

  it('retries cleanup of terminal knowledge run and deposition worktrees on startup', async () => {
    repos.iterations.insert({ id: 'it', projectId: 'p1', name: 'I', version: 'v1', status: 'active', createdAt: 1 });
    repos.requirements.insert({ id: 'req', iterationId: 'it', title: 'R', description: '', priority: 'medium', acceptance: '', createdAt: 1, archived: false });
    repos.tasks.insert({
      id: 'task', requirementId: 'req', iterationId: 'it', projectId: 'p1', title: 'T', description: '',
      status: 'testing', role: 'coder', stages: [], currentStage: 0, statusChangedAt: 1, createdAt: 1, updatedAt: 1, retryCount: 0,
    });
    const runId = 'terminal-run';
    const depositionId = 'terminal-deposition';
    const runBranch = `ai-devflow/knowledge/${runId}`;
    const depositionBranch = `ai-devflow/knowledge/${depositionId}`;
    const runWorktree = join(wtBase, `knowledge-${runId}`);
    const depositionWorktree = join(wtBase, `knowledge-deposition-${depositionId}`);
    execFileSync('git', ['worktree', 'add', '-q', '-b', runBranch, runWorktree, 'main'], { cwd: repo });
    execFileSync('git', ['worktree', 'add', '-q', '-b', depositionBranch, depositionWorktree, 'main'], { cwd: repo });
    repos.knowledgeRuns.create({
      id: runId, projectId: 'p1', kind: 'initialization', state: 'succeeded', confirmationState: 'confirmed',
      changedPathsJson: '[]', diagnosticsJson: '["cleanup failed"]', resultJson: '{}', startedAt: 1, endedAt: 2,
    });
    repos.knowledgeDepositions.create({
      id: depositionId, projectId: 'p1', taskId: 'task', verdict: 'valuable', state: 'succeeded',
      assessmentJson: JSON.stringify({ verdict: 'valuable', candidates: [{ type: 'feature', summary: 's', evidence: ['x'], reuseScenario: 'r' }] }),
      relatedKnowledgeIdsJson: '["feature:x"]', changedPathsJson: '["docs/knowledge/feature/x.md"]',
      gatePassed: true, diagnosticsJson: '["cleanup failed"]', startedAt: 1, endedAt: 2,
    });

    const recovered = await coordinator.recoverInterrupted();

    expect(recovered).toEqual({ failedRuns: [], failedDepositions: [] });
    expect(existsSync(runWorktree)).toBe(false);
    expect(existsSync(depositionWorktree)).toBe(false);
    expect(() => execFileSync('git', ['rev-parse', '--verify', `refs/heads/${runBranch}`], { cwd: repo, stdio: 'pipe' })).toThrow();
    expect(() => execFileSync('git', ['rev-parse', '--verify', `refs/heads/${depositionBranch}`], { cwd: repo, stdio: 'pipe' })).toThrow();
    expect(repos.knowledgeRuns.get(runId)?.state).toBe('succeeded');
    expect(repos.knowledgeDepositions.get(depositionId)?.state).toBe('succeeded');
  });

  it('retries cleanup for every deposition attempt, not only the latest task record', async () => {
    repos.iterations.insert({ id: 'it-all', projectId: 'p1', name: 'I', version: 'v-all', status: 'active', createdAt: 1 });
    repos.requirements.insert({ id: 'req-all', iterationId: 'it-all', title: 'R', description: '', priority: 'medium', acceptance: '', createdAt: 1, archived: false });
    repos.tasks.insert({
      id: 'task-all', requirementId: 'req-all', iterationId: 'it-all', projectId: 'p1', title: 'T', description: '',
      status: 'testing', role: 'coder', stages: [], currentStage: 0, statusChangedAt: 1, createdAt: 1, updatedAt: 1, retryCount: 0,
    });
    const attempts = ['old-deposition', 'latest-deposition'];
    for (const [index, depositionId] of attempts.entries()) {
      const branch = `ai-devflow/knowledge/${depositionId}`;
      const worktree = join(wtBase, `knowledge-deposition-${depositionId}`);
      execFileSync('git', ['worktree', 'add', '-q', '-b', branch, worktree, 'main'], { cwd: repo });
      repos.knowledgeDepositions.create({
        id: depositionId, projectId: 'p1', taskId: 'task-all', verdict: 'valuable', state: 'failed',
        assessmentJson: JSON.stringify({ verdict: 'valuable', candidates: [{ type: 'feature', summary: 's', evidence: ['x'], reuseScenario: 'r' }] }),
        relatedKnowledgeIdsJson: '[]', changedPathsJson: '[]', gatePassed: false,
        diagnosticsJson: '["cleanup failed"]', startedAt: index + 1, endedAt: index + 2,
      });
    }

    await coordinator.recoverInterrupted();

    for (const depositionId of attempts) {
      expect(existsSync(join(wtBase, `knowledge-deposition-${depositionId}`))).toBe(false);
      expect(() => execFileSync('git', [
        'rev-parse', '--verify', `refs/heads/ai-devflow/knowledge/${depositionId}`,
      ], { cwd: repo, stdio: 'pipe' })).toThrow();
    }
  });
});
