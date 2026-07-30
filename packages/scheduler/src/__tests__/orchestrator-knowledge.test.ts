import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, createRepositories, type DatabaseSync } from '@ai-devflow/persistence';
import { ProjectKnowledgeService } from '@ai-devflow/knowledge';
import { Orchestrator } from '../orchestrator.js';
import { FakeAgentRunner, type TestEventSpec } from './fake-agent-runner.js';
import { KnowledgeCoordinator } from '../knowledge-coordinator.js';
import type { AgentRunner } from '@ai-devflow/agents';
import type { AgentEvent } from '@ai-devflow/core';
import type { RunnerAgentRunRequest as AgentRunRequest } from '@ai-devflow/agents';

function shGit(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'orch-kb-'));
  shGit(repo, ['init', '-q', '-b', 'main']);
  shGit(repo, ['config', 'user.email', 't@t']);
  shGit(repo, ['config', 'user.name', 't']);
  writeFileSync(join(repo, 'README.md'), '# repo\n');
  shGit(repo, ['add', '.']);
  shGit(repo, ['commit', '-q', '-m', 'init']);
  return repo;
}

function makeTask(over: Partial<import('@ai-devflow/core').Task> = {}): import('@ai-devflow/core').Task {
  const now = Date.now();
  return {
    id: 't1', requirementId: 'req', iterationId: 'it', projectId: 'p',
    title: 'T', description: 'do it', status: 'ready', role: 'coder',
    stages: [], currentStage: 0, statusChangedAt: now, createdAt: now, updatedAt: now, retryCount: 0,
    ...over,
  };
}

describe('knowledge deposition gate', () => {
  let db2: DatabaseSync;
  let repo2: string;
  let wtDir2: string;

  beforeEach(() => {
    db2 = openDatabase(':memory:');
    repo2 = makeRepo();
    wtDir2 = mkdtempSync(join(tmpdir(), 'orch-dep-wt-'));
  });
  afterEach(() => {
    try { db2.close(); } catch { /* */ }
    rmSync(repo2, { recursive: true, force: true });
    rmSync(wtDir2, { recursive: true, force: true });
  });

  function build(
    script: (req: AgentRunRequest) => TestEventSpec[],
    makeCoordinator: (repos: import('@ai-devflow/persistence').Repositories, runner: AgentRunner) => KnowledgeCoordinator | undefined,
    opts: ConstructorParameters<typeof FakeAgentRunner>[1] = {},
    deposition: {
      knowledgeIds?: string[];
      candidateKnowledge?: Array<{ candidateIndex: number; knowledgeId: string }>;
      assessment?: import('@ai-devflow/core').KnowledgeAssessment;
      sourcePath?: string;
    } = {},
  ) {
    const repos = createRepositories(db2);
    repos.projects.insert({ id: 'p', name: 'P', path: repo2, defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
    repos.iterations.insert({ id: 'it', projectId: 'p', name: 'I', version: '1.0', status: 'active', createdAt: 1 });
    repos.requirements.insert({ id: 'req', iterationId: 'it', title: 'R', description: '', priority: 'medium', acceptance: 'acc', createdAt: 1, archived: false });
    const runner = new FakeAgentRunner(script, opts);
    const depositionRequests: AgentRunRequest[] = [];
    const depRunner: AgentRunner = {
      async verifyRuntime() { return { version: '', entry: '' }; },
      async run(req) {
        depositionRequests.push(req);
        if (req.expert === 'project_lead') {
          const { mkdirSync } = await import('node:fs');
          mkdirSync(join(req.cwd, 'docs/knowledge/feature'), { recursive: true });
          writeFileSync(join(req.cwd, 'docs/knowledge/feature/deposited.md'), `---
id: feature:deposited
type: feature
status: active
owner: project
updated: 2026-07-28
confidence: 0.9
sources:
  - ${deposition.sourcePath ?? 'README.md'}
related:
  - feature:index
---

# Deposited
`);
          const indexPath = join(req.cwd, 'docs/knowledge/feature/index.md');
          writeFileSync(indexPath, readFileSync(indexPath, 'utf8').replace('related: []', 'related:\n  - feature:deposited'));
          const taskDocs = join(req.cwd, 'docs/iterations/1.0/tasks/t1');
          mkdirSync(taskDocs, { recursive: true });
          writeFileSync(join(taskDocs, 'CHANGELOG.md'), '# Task t1 Changelog\n\n- Deposited feature:deposited\n');
        }
        const payload = req.resultKind === 'knowledge_deposition'
          ? {
              kind: 'knowledge_deposition' as const,
              changedPaths: [
                'docs/knowledge/feature/deposited.md',
                'docs/knowledge/feature/index.md',
                'docs/iterations/1.0/tasks/t1/CHANGELOG.md',
              ],
              knowledgeIds: deposition.knowledgeIds ?? ['feature:deposited'],
              candidateKnowledge: deposition.candidateKnowledge ?? [{ candidateIndex: 0, knowledgeId: 'feature:deposited' }],
              assessment: deposition.assessment ?? { verdict: 'valuable' as const, candidates: [{ type: 'feature' as const, summary: 's', evidence: ['x.ts'], reuseScenario: 'r' }] },
            }
          : undefined;
        const events: AgentEvent[] = [{ type: 'done', summary: 'ok', result: payload, t: 0 }];
        return { events: (async function* () { for (const e of events) yield e; })(), cancel: async () => {}, done: async () => ({ exitCode: 0, ok: true }) };
      },
    };
    const coordinator = makeCoordinator(repos, depRunner);
    const orch = new Orchestrator(repos, runner, { worktreesBaseDir: wtDir2, maxConcurrent: 2, autoRetry: false, knowledgeCoordinator: coordinator });
    return { orch, repos, runner, coordinator, depositionRequests };
  }

  it('passes a none assessment with evidence without running project_lead', async () => {
    const { orch, repos } = build(() => [{ type: 'done', summary: 'dev ok', t: 0 }], (r) => new KnowledgeCoordinator({
      repos: r, runner: { async verifyRuntime() { return { version: '', entry: '' }; }, async run() { throw new Error('unused'); } },
      knowledge: new ProjectKnowledgeService(), worktreesBaseDir: wtDir2,
    }));
    const t = makeTask({ iterationId: 'it', requirementId: 'req' });
    t.worktreePath = undefined;
    repos.tasks.insert(t);
    await orch.start(t.id);
    expect(repos.tasks.get(t.id)!.status).toBe('in_review');
    // none 沉淀记录成功（无 project_lead 运行）。
    const dep = repos.knowledgeDepositions.getLatestByTask(t.id);
    expect(dep?.verdict).toBe('none');
    expect(dep?.state).toBe('succeeded');
  });

  it('holds the iteration lock through knowledge finalization, task merge, and in_review transition', async () => {
    let coordinator!: KnowledgeCoordinator;
    let lockActive = false;
    let finalizedWhileLocked = false;
    let statusWhenLockReleased: import('@ai-devflow/core').TaskStatus | undefined;
    const { orch, repos } = build(
      () => [{ type: 'done', summary: 'dev ok', t: 0 }],
      (r) => {
        coordinator = new KnowledgeCoordinator({
          repos: r,
          runner: { async verifyRuntime() { return { version: '', entry: '' }; }, async run() { throw new Error('unused'); } },
          knowledge: new ProjectKnowledgeService(),
          worktreesBaseDir: wtDir2,
        });
        const lockAware = coordinator as KnowledgeCoordinator & {
          withIterationLock<T>(iterationId: string, action: () => Promise<T>): Promise<T>;
        };
        lockAware.withIterationLock = async (_iterationId, action) => {
          lockActive = true;
          try {
            const result = await action();
            statusWhenLockReleased = r.tasks.get('t1')?.status;
            return result;
          } finally {
            lockActive = false;
          }
        };
        coordinator.finalizeTaskKnowledge = async () => {
          finalizedWhileLocked = lockActive;
          return { gatePassed: true, diagnostics: [] };
        };
        return coordinator;
      },
    );
    repos.tasks.insert(makeTask());

    await orch.start('t1');

    expect(finalizedWhileLocked).toBe(true);
    expect(statusWhenLockReleased).toBe('in_review');
    expect(repos.tasks.get('t1')?.status).toBe('in_review');
  });

  it('syncs a stale task branch to the latest sprint before knowledge finalization', async () => {
    let sawLatestSprint = false;
    const { orch, repos } = build(
      () => [{ type: 'done', summary: 'dev ok', t: 0 }],
      (r) => {
        const coordinator = new KnowledgeCoordinator({
          repos: r,
          runner: { async verifyRuntime() { return { version: '', entry: '' }; }, async run() { throw new Error('unused'); } },
          knowledge: new ProjectKnowledgeService(),
          worktreesBaseDir: wtDir2,
        });
        coordinator.finalizeTaskKnowledge = async () => {
          try {
            execFileSync('git', ['show', 'ai-devflow/t1:sprint-only.md'], { cwd: repo2, stdio: 'ignore' });
            sawLatestSprint = true;
          } catch {
            sawLatestSprint = false;
          }
          return { gatePassed: true, diagnostics: [] };
        };
        return coordinator;
      },
    );
    shGit(repo2, ['branch', 'ai-devflow-sprint/1.0', 'main']);
    const taskWorktree = join(wtDir2, 'precreated-task');
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'ai-devflow/t1', taskWorktree, 'ai-devflow-sprint/1.0'], { cwd: repo2 });
    shGit(repo2, ['switch', '-q', 'ai-devflow-sprint/1.0']);
    writeFileSync(join(repo2, 'sprint-only.md'), '# latest sprint\n');
    shGit(repo2, ['add', 'sprint-only.md']);
    shGit(repo2, ['commit', '-q', '-m', 'advance sprint']);
    shGit(repo2, ['switch', '-q', 'main']);
    repos.tasks.insert(makeTask({ worktreePath: taskWorktree }));

    await orch.start('t1');

    expect(sawLatestSprint).toBe(true);
    expect(repos.tasks.get('t1')?.status).toBe('in_review');
  });

  it('host-commits reviewed agent changes before syncing and merging the task branch', async () => {
    const { orch, repos } = build(
      (request) => {
        writeFileSync(join(request.cwd, 'implemented.ts'), 'export const implemented = true;\n');
        return [{ type: 'done', summary: 'dev ok', t: 0 }];
      },
      (r) => new KnowledgeCoordinator({
        repos: r,
        runner: { async verifyRuntime() { return { version: '', entry: '' }; }, async run() { throw new Error('unused'); } },
        knowledge: new ProjectKnowledgeService(),
        worktreesBaseDir: wtDir2,
      }),
    );
    repos.tasks.insert(makeTask());

    await orch.start('t1');

    expect(repos.tasks.get('t1')?.status).toBe('in_review');
    expect(execFileSync('git', ['show', 'ai-devflow-sprint/1.0:implemented.ts'], { cwd: repo2, encoding: 'utf8' }))
      .toContain('implemented = true');
  });

  it('atomically integrates reviewed source and valuable knowledge while preserving doc-only deposition paths', async () => {
    const assessment = {
      verdict: 'valuable' as const,
      candidates: [{ type: 'feature' as const, summary: 'new source behavior', evidence: ['src/new-file.ts'], reuseScenario: 'reuse it' }],
    };
    const { orch, repos } = build(
      (request) => {
        mkdirSync(join(request.cwd, 'src'), { recursive: true });
        writeFileSync(join(request.cwd, 'src/new-file.ts'), 'export const added = true;\n');
        return [{ type: 'done', summary: 'dev ok', t: 0 }];
      },
      (r, depRunner) => new KnowledgeCoordinator({
        repos: r, runner: depRunner, knowledge: new ProjectKnowledgeService(), worktreesBaseDir: wtDir2,
      }),
      {
        testExpertEvents: () => [{
          type: 'done', summary: 'ok\nREVIEW_VERDICT: PASS',
          result: {
            kind: 'task_review',
            review: { pass: true, summary: 'REVIEW_VERDICT: PASS' },
            knowledgeAssessment: assessment,
          },
          t: 0,
        }],
      },
      { assessment, sourcePath: 'src/new-file.ts' },
    );
    const knowledge = new ProjectKnowledgeService();
    await knowledge.initializeKnowledge({ repoPath: repo2, date: '2026-07-28' });
    shGit(repo2, ['add', '.']);
    shGit(repo2, ['commit', '-q', '-m', 'knowledge']);
    repos.tasks.insert(makeTask());

    await orch.start('t1');

    expect(repos.tasks.get('t1')?.status).toBe('in_review');
    expect(execFileSync('git', ['show', 'ai-devflow-sprint/1.0:src/new-file.ts'], { cwd: repo2, encoding: 'utf8' }))
      .toContain('added = true');
    expect(execFileSync('git', ['show', 'ai-devflow-sprint/1.0:docs/knowledge/feature/deposited.md'], { cwd: repo2, encoding: 'utf8' }))
      .toContain('src/new-file.ts');
    const deposition = repos.knowledgeDepositions.getLatestByTask('t1');
    expect(JSON.parse(deposition!.changedPathsJson)).not.toContain('src/new-file.ts');
  });

  it('skips a second task-branch merge when knowledge finalization already integrated the task', async () => {
    const { orch, repos } = build(
      () => [{ type: 'done', summary: 'dev ok', t: 0 }],
      (r) => {
        const coordinator = new KnowledgeCoordinator({
          repos: r,
          runner: { async verifyRuntime() { return { version: '', entry: '' }; }, async run() { throw new Error('unused'); } },
          knowledge: new ProjectKnowledgeService(),
          worktreesBaseDir: wtDir2,
        });
        coordinator.finalizeTaskKnowledge = async (input) => {
          execFileSync('git', ['worktree', 'remove', '--force', input.worktreePath], { cwd: repo2, stdio: 'ignore' });
          execFileSync('git', ['branch', '-D', 'ai-devflow/t1'], { cwd: repo2, stdio: 'ignore' });
          return { gatePassed: true, taskIntegrated: true, diagnostics: [] };
        };
        return coordinator;
      },
    );
    repos.tasks.insert(makeTask());

    await orch.start('t1');

    expect(repos.tasks.get('t1')?.status).toBe('in_review');
  });

  it('reuses a succeeded deposition for the same execution without running project_lead again', async () => {
    const assessment = {
      verdict: 'valuable' as const,
      candidates: [{ type: 'feature' as const, summary: 's', evidence: ['x.ts'], reuseScenario: 'r' }],
    };
    const { orch, repos, coordinator, depositionRequests } = build(
      () => [{ type: 'done', summary: 'dev ok', t: 0 }],
      (r, depRunner) => new KnowledgeCoordinator({
        repos: r, runner: depRunner, knowledge: new ProjectKnowledgeService(), worktreesBaseDir: wtDir2,
      }),
      {
        testExpertEvents: () => [{
          type: 'done', summary: 'ok\nREVIEW_VERDICT: PASS',
          result: {
            kind: 'task_review',
            review: { pass: true, summary: 'REVIEW_VERDICT: PASS' },
            knowledgeAssessment: assessment,
          },
          t: 0,
        }],
      },
      { assessment },
    );
    const knowledge = new ProjectKnowledgeService();
    await knowledge.initializeKnowledge({ repoPath: repo2, date: '2026-07-28' });
    shGit(repo2, ['add', '.']);
    shGit(repo2, ['commit', '-q', '-m', 'knowledge']);
    repos.tasks.insert(makeTask());
    await orch.start('t1');
    const task = repos.tasks.get('t1')!;
    const executionId = repos.executions.getLatest('t1')!.id;

    const repeated = await coordinator!.finalizeTaskKnowledge({
      task,
      project: { id: 'p', path: repo2, defaultBranch: 'main' },
      executionId,
      assessment,
      worktreePath: task.worktreePath!,
    });

    expect(repeated).toMatchObject({ gatePassed: true, taskIntegrated: true });
    expect(depositionRequests.filter((request) => request.resultKind === 'knowledge_deposition')).toHaveLength(1);
  });

  it('reconciles Git integration when the first deposition success write fails', async () => {
    const assessment = {
      verdict: 'valuable' as const,
      candidates: [{ type: 'feature' as const, summary: 's', evidence: ['x.ts'], reuseScenario: 'r' }],
    };
    const { orch, repos, depositionRequests } = build(
      () => [{ type: 'done', summary: 'dev ok', t: 0 }],
      (r, depRunner) => new KnowledgeCoordinator({
        repos: r, runner: depRunner, knowledge: new ProjectKnowledgeService(), worktreesBaseDir: wtDir2,
      }),
      {
        testExpertEvents: () => [{
          type: 'done', summary: 'ok\nREVIEW_VERDICT: PASS',
          result: {
            kind: 'task_review',
            review: { pass: true, summary: 'REVIEW_VERDICT: PASS' },
            knowledgeAssessment: assessment,
          },
          t: 0,
        }],
      },
      { assessment },
    );
    const knowledge = new ProjectKnowledgeService();
    await knowledge.initializeKnowledge({ repoPath: repo2, date: '2026-07-28' });
    shGit(repo2, ['add', '.']);
    shGit(repo2, ['commit', '-q', '-m', 'knowledge']);
    repos.tasks.insert(makeTask());
    const realFinish = repos.knowledgeDepositions.finish.bind(repos.knowledgeDepositions);
    let failedOnce = false;
    repos.knowledgeDepositions.finish = (id, value) => {
      if (!failedOnce && value.state === 'succeeded') {
        failedOnce = true;
        throw new Error('injected finish failure after Git integration');
      }
      realFinish(id, value);
    };

    await orch.start('t1');

    expect(failedOnce).toBe(true);
    expect(repos.tasks.get('t1')?.status).toBe('in_review');
    expect(repos.knowledgeDepositions.getLatestByTask('t1')).toMatchObject({ state: 'succeeded', gatePassed: true });
    expect(depositionRequests.filter((request) => request.resultKind === 'knowledge_deposition')).toHaveLength(1);
  });

  it('fails the gate if the target ref loses the knowledge draft before integration is recorded', async () => {
    const assessment = {
      verdict: 'valuable' as const,
      candidates: [{ type: 'feature' as const, summary: 's', evidence: ['x.ts'], reuseScenario: 'r' }],
    };
    const { orch, repos } = build(
      () => [{ type: 'done', summary: 'dev ok', t: 0 }],
      (r, depRunner) => new KnowledgeCoordinator({
        repos: r, runner: depRunner, knowledge: new ProjectKnowledgeService(), worktreesBaseDir: wtDir2,
      }),
      {
        testExpertEvents: () => [{
          type: 'done', summary: 'ok\nREVIEW_VERDICT: PASS',
          result: {
            kind: 'task_review',
            review: { pass: true, summary: 'REVIEW_VERDICT: PASS' },
            knowledgeAssessment: assessment,
          },
          t: 0,
        }],
      },
      { assessment },
    );
    const knowledge = new ProjectKnowledgeService();
    await knowledge.initializeKnowledge({ repoPath: repo2, date: '2026-07-28' });
    shGit(repo2, ['add', '.']);
    shGit(repo2, ['commit', '-q', '-m', 'knowledge']);
    repos.tasks.insert(makeTask());
    const realUpdateProgress = repos.knowledgeDepositions.updateProgress.bind(repos.knowledgeDepositions);
    repos.knowledgeDepositions.updateProgress = (id, value) => {
      const progress = JSON.parse(value.progressJson) as { phase?: string; targetBranch?: string; taskCommit?: string };
      if (progress.phase === 'integrated' && progress.targetBranch && progress.taskCommit) {
        const currentTarget = execFileSync('git', ['rev-parse', progress.targetBranch], { cwd: repo2, encoding: 'utf8' }).trim();
        shGit(repo2, ['update-ref', `refs/heads/${progress.targetBranch}`, progress.taskCommit, currentTarget]);
      }
      realUpdateProgress(id, value);
    };

    await orch.start('t1');

    expect(repos.tasks.get('t1')?.status).toBe('testing');
    expect(repos.knowledgeDepositions.getLatestByTask('t1')).toMatchObject({ state: 'failed', gatePassed: false });
  });

  it('does not reuse a succeeded deposition after its target branch loses the integrated commit', async () => {
    const assessment = {
      verdict: 'valuable' as const,
      candidates: [{ type: 'feature' as const, summary: 's', evidence: ['x.ts'], reuseScenario: 'r' }],
    };
    const { orch, repos, coordinator, depositionRequests } = build(
      () => [{ type: 'done', summary: 'dev ok', t: 0 }],
      (r, depRunner) => new KnowledgeCoordinator({
        repos: r, runner: depRunner, knowledge: new ProjectKnowledgeService(), worktreesBaseDir: wtDir2,
      }),
      {
        testExpertEvents: () => [{
          type: 'done', summary: 'ok\nREVIEW_VERDICT: PASS',
          result: {
            kind: 'task_review',
            review: { pass: true, summary: 'REVIEW_VERDICT: PASS' },
            knowledgeAssessment: assessment,
          },
          t: 0,
        }],
      },
      { assessment },
    );
    const knowledge = new ProjectKnowledgeService();
    await knowledge.initializeKnowledge({ repoPath: repo2, date: '2026-07-28' });
    shGit(repo2, ['add', '.']);
    shGit(repo2, ['commit', '-q', '-m', 'knowledge']);
    repos.tasks.insert(makeTask());
    await orch.start('t1');
    const task = repos.tasks.get('t1')!;
    const executionId = repos.executions.getLatest('t1')!.id;
    const mainCommit = execFileSync('git', ['rev-parse', 'main'], { cwd: repo2, encoding: 'utf8' }).trim();
    const sprintCommit = execFileSync('git', ['rev-parse', 'ai-devflow-sprint/1.0'], { cwd: repo2, encoding: 'utf8' }).trim();
    shGit(repo2, ['update-ref', 'refs/heads/ai-devflow-sprint/1.0', mainCommit, sprintCommit]);

    const repeated = await coordinator!.finalizeTaskKnowledge({
      task,
      project: { id: 'p', path: repo2, defaultBranch: 'main' },
      executionId,
      assessment,
      worktreePath: task.worktreePath!,
    });

    expect(repeated.gatePassed).toBe(true);
    expect(depositionRequests.filter((request) => request.resultKind === 'knowledge_deposition')).toHaveLength(2);
    expect(execFileSync('git', [
      'show', 'ai-devflow-sprint/1.0:docs/knowledge/feature/deposited.md',
    ], { cwd: repo2, encoding: 'utf8' })).toContain('feature:deposited');
  });

  it('keeps valuable work in testing until project_lead deposition validates', async () => {
    const { orch, repos } = build(() => [{ type: 'done', summary: 'dev ok', t: 0 }], (r, depRunner) => new KnowledgeCoordinator({
      repos: r, runner: depRunner, knowledge: new ProjectKnowledgeService(), worktreesBaseDir: wtDir2,
    }), {
      testExpertEvents: () => [
        { type: 'log', level: 'info', text: 'reviewing', t: 0 },
        { type: 'done', summary: 'ok\nREVIEW_VERDICT: PASS', result: { kind: 'task_review', review: { pass: true, summary: 'REVIEW_VERDICT: PASS' }, knowledgeAssessment: { verdict: 'valuable', candidates: [{ type: 'feature', summary: 's', evidence: ['x.ts'], reuseScenario: 'r' }] } }, t: 0 },
      ],
    });
    const t = makeTask({ iterationId: 'it', requirementId: 'req' });
    t.worktreePath = undefined;
    repos.tasks.insert(t);
    const knowledge = new ProjectKnowledgeService();
    await knowledge.initializeKnowledge({ repoPath: repo2, date: '2026-07-28' });
    shGit(repo2, ['add', '.']);
    shGit(repo2, ['commit', '-q', '-m', 'knowledge']);
    await orch.start(t.id);
    expect(repos.tasks.get(t.id)!.status).toBe('in_review');
    const dep = repos.knowledgeDepositions.getLatestByTask(t.id);
    expect(dep?.verdict).toBe('valuable');
    expect(dep?.state).toBe('succeeded');
    expect(JSON.parse(dep!.relatedKnowledgeIdsJson)).toEqual(['feature:deposited']);
  });

  it('keeps a merged valuable deposition succeeded when cleanup fails', async () => {
    const { orch, repos } = build(() => [{ type: 'done', summary: 'dev ok', t: 0 }], (r, depRunner) => new KnowledgeCoordinator({
      repos: r,
      runner: depRunner,
      knowledge: new ProjectKnowledgeService(),
      worktreesBaseDir: wtDir2,
      removeWorktree: async () => { throw new Error('injected cleanup failure'); },
    }), {
      testExpertEvents: () => [{
        type: 'done',
        summary: 'ok\nREVIEW_VERDICT: PASS',
        result: {
          kind: 'task_review',
          review: { pass: true, summary: 'REVIEW_VERDICT: PASS' },
          knowledgeAssessment: { verdict: 'valuable', candidates: [{ type: 'feature', summary: 's', evidence: ['x.ts'], reuseScenario: 'r' }] },
        },
        t: 0,
      }],
    });
    const knowledge = new ProjectKnowledgeService();
    await knowledge.initializeKnowledge({ repoPath: repo2, date: '2026-07-28' });
    shGit(repo2, ['add', '.']);
    shGit(repo2, ['commit', '-q', '-m', 'knowledge']);
    repos.tasks.insert(makeTask());

    await orch.start('t1');

    expect(repos.tasks.get('t1')?.status).toBe('in_review');
    const deposition = repos.knowledgeDepositions.getLatestByTask('t1');
    expect(deposition?.state).toBe('succeeded');
    expect(JSON.parse(deposition!.diagnosticsJson).join(' ')).toMatch(/cleanup|清理/);
  });

  it('keeps valuable work in testing when deposition reports no covered knowledge ids', async () => {
    const { orch, repos } = build(
      () => [{ type: 'done', summary: 'dev ok', t: 0 }],
      (r, depRunner) => new KnowledgeCoordinator({
        repos: r, runner: depRunner, knowledge: new ProjectKnowledgeService(), worktreesBaseDir: wtDir2,
      }),
      {
        testExpertEvents: () => [{
          type: 'done',
          summary: 'ok\nREVIEW_VERDICT: PASS',
          result: {
            kind: 'task_review',
            review: { pass: true, summary: 'REVIEW_VERDICT: PASS' },
            knowledgeAssessment: { verdict: 'valuable', candidates: [{ type: 'feature', summary: 's', evidence: ['x.ts'], reuseScenario: 'r' }] },
          },
          t: 0,
        }],
      },
      { knowledgeIds: [] },
    );
    const knowledge = new ProjectKnowledgeService();
    await knowledge.initializeKnowledge({ repoPath: repo2, date: '2026-07-28' });
    shGit(repo2, ['add', '.']);
    shGit(repo2, ['commit', '-q', '-m', 'knowledge']);
    repos.tasks.insert(makeTask());

    await orch.start('t1');

    expect(repos.tasks.get('t1')?.status).toBe('testing');
    const row = repos.knowledgeDepositions.getLatestByTask('t1');
    expect(row?.state).toBe('failed');
    expect(JSON.parse(row!.diagnosticsJson).join(' ')).toMatch(/候选|知识 ID/);
  });

  it('rejects deposition when related documents do not cover every valuable candidate type', async () => {
    const assessment = {
      verdict: 'valuable' as const,
      candidates: [
        { type: 'feature' as const, summary: 'feature', evidence: ['f.ts'], reuseScenario: 'reuse feature' },
        { type: 'adr' as const, summary: 'decision', evidence: ['a.ts'], reuseScenario: 'reuse decision' },
      ],
    };
    const { orch, repos } = build(
      () => [{ type: 'done', summary: 'dev ok', t: 0 }],
      (r, depRunner) => new KnowledgeCoordinator({
        repos: r, runner: depRunner, knowledge: new ProjectKnowledgeService(), worktreesBaseDir: wtDir2,
      }),
      {
        testExpertEvents: () => [{
          type: 'done', summary: 'ok\nREVIEW_VERDICT: PASS',
          result: {
            kind: 'task_review',
            review: { pass: true, summary: 'REVIEW_VERDICT: PASS' },
            knowledgeAssessment: assessment,
          },
          t: 0,
        }],
      },
      { knowledgeIds: ['feature:deposited'], assessment },
    );
    const knowledge = new ProjectKnowledgeService();
    await knowledge.initializeKnowledge({ repoPath: repo2, date: '2026-07-28' });
    shGit(repo2, ['add', '.']);
    shGit(repo2, ['commit', '-q', '-m', 'knowledge']);
    repos.tasks.insert(makeTask());

    await orch.start('t1');

    expect(repos.tasks.get('t1')?.status).toBe('testing');
    const row = repos.knowledgeDepositions.getLatestByTask('t1');
    expect(row?.state).toBe('failed');
    expect(JSON.parse(row!.diagnosticsJson).join(' ')).toMatch(/adr|ADR|候选/);
  });

  it('accepts explicit per-candidate mappings when multiple candidates update the same knowledge document', async () => {
    const assessment = {
      verdict: 'valuable' as const,
      candidates: [
        { type: 'feature' as const, summary: 'first', evidence: ['a.ts'], reuseScenario: 'reuse first' },
        { type: 'feature' as const, summary: 'second', evidence: ['b.ts'], reuseScenario: 'reuse second' },
      ],
    };
    const { orch, repos } = build(
      () => [{ type: 'done', summary: 'dev ok', t: 0 }],
      (r, depRunner) => new KnowledgeCoordinator({
        repos: r, runner: depRunner, knowledge: new ProjectKnowledgeService(), worktreesBaseDir: wtDir2,
      }),
      {
        testExpertEvents: () => [{
          type: 'done', summary: 'ok\nREVIEW_VERDICT: PASS',
          result: {
            kind: 'task_review',
            review: { pass: true, summary: 'REVIEW_VERDICT: PASS' },
            knowledgeAssessment: assessment,
          },
          t: 0,
        }],
      },
      {
        knowledgeIds: ['feature:deposited'],
        candidateKnowledge: [
          { candidateIndex: 0, knowledgeId: 'feature:deposited' },
          { candidateIndex: 1, knowledgeId: 'feature:deposited' },
        ],
        assessment,
      },
    );
    const knowledge = new ProjectKnowledgeService();
    await knowledge.initializeKnowledge({ repoPath: repo2, date: '2026-07-28' });
    shGit(repo2, ['add', '.']);
    shGit(repo2, ['commit', '-q', '-m', 'knowledge']);
    repos.tasks.insert(makeTask());

    await orch.start('t1');

    expect(repos.tasks.get('t1')?.status).toBe('in_review');
    expect(repos.knowledgeDepositions.getLatestByTask('t1')?.state).toBe('succeeded');
  });

  it('pauses valuable work for explicit initialization when the knowledge root is absent', async () => {
    const { orch, repos } = build(() => [{ type: 'done', summary: 'dev ok', t: 0 }], (r, depRunner) => new KnowledgeCoordinator({
      repos: r, runner: depRunner, knowledge: new ProjectKnowledgeService(), worktreesBaseDir: wtDir2,
    }), {
      testExpertEvents: () => [{
        type: 'done',
        summary: 'ok\nREVIEW_VERDICT: PASS',
        result: {
          kind: 'task_review',
          review: { pass: true, summary: 'REVIEW_VERDICT: PASS' },
          knowledgeAssessment: { verdict: 'valuable', candidates: [{ type: 'feature', summary: 's', evidence: ['x.ts'], reuseScenario: 'r' }] },
        },
        t: 0,
      }],
    });
    repos.tasks.insert(makeTask());

    await orch.start('t1');

    expect(repos.tasks.get('t1')?.status).toBe('awaiting_input');
    expect(repos.tasks.get('t1')?.pausedFrom).toBe('testing');
    const deposition = repos.knowledgeDepositions.getLatestByTask('t1');
    expect(deposition?.state).toBe('awaiting_initialization');
    expect(deposition?.gatePassed).toBe(false);
  });

  it('does not enter in_review when the review payload is missing (assessment undefined)', async () => {
    const { orch, repos } = build(() => [{ type: 'done', summary: 'dev ok', t: 0 }], (r) => new KnowledgeCoordinator({
      repos: r, runner: { async verifyRuntime() { return { version: '', entry: '' }; }, async run() { throw new Error('unused'); } },
      knowledge: new ProjectKnowledgeService(), worktreesBaseDir: wtDir2,
    }), {
      testExpertEvents: () => [
        { type: 'log', level: 'info', text: 'reviewing', t: 0 },
        { type: 'done', summary: 'ok\nREVIEW_VERDICT: PASS', t: 0 },
      ],
    });
    const t = makeTask({ iterationId: 'it', requirementId: 'req' });
    t.worktreePath = undefined;
    repos.tasks.insert(t);
    await orch.start(t.id);
    // 载荷缺失属确定性契约失败：不伪造审查结论、不返工、不进待沟通，直接退回待开发供显式重试。
    expect(repos.tasks.get(t.id)!.status).toBe('ready');
    const msgs = repos.taskMessages.listByTask(t.id).map((m) => m.text ?? '');
    expect(msgs.some((m) => m.includes('task_review 结构化载荷'))).toBe(true);
  });

  it('does not enter in_review when task branch merge fails', async () => {
    // 项目路径指向一个非 git 目录 -> mergeWorktreeBranch 失败。
    const repos = createRepositories(db2);
    const nongit = mkdtempSync(join(tmpdir(), 'nongit-'));
    repos.projects.insert({ id: 'p', name: 'P', path: nongit, defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
    repos.iterations.insert({ id: 'it', projectId: 'p', name: 'I', version: '1.0', status: 'active', createdAt: 1 });
    repos.requirements.insert({ id: 'req', iterationId: 'it', title: 'R', description: '', priority: 'medium', acceptance: 'acc', createdAt: 1, archived: false });
    const coordinator = new KnowledgeCoordinator({
      repos, runner: { async verifyRuntime() { return { version: '', entry: '' }; }, async run() { throw new Error('unused'); } },
      knowledge: new ProjectKnowledgeService(), worktreesBaseDir: wtDir2,
    });
    const runner = new FakeAgentRunner(() => [{ type: 'done', summary: 'dev ok', t: 0 }]);
    const orch = new Orchestrator(repos, runner, { worktreesBaseDir: wtDir2, maxConcurrent: 2, autoRetry: false, knowledgeCoordinator: coordinator });
    const t = makeTask({ iterationId: 'it', requirementId: 'req' });
    t.worktreePath = undefined;
    repos.tasks.insert(t);
    await orch.start(t.id).catch(() => undefined);
    expect(repos.tasks.get(t.id)!.status).not.toBe('in_review');
    rmSync(nongit, { recursive: true, force: true });
  });
});

describe('orchestrator knowledge retrieval integration', () => {
  let db: DatabaseSync;
  let repo: string;
  let worktreeDir: string;

  beforeEach(() => {
    db = openDatabase(':memory:');
    const repos = createRepositories(db);
    repo = makeRepo();
    worktreeDir = mkdtempSync(join(tmpdir(), 'orch-kb-wt-'));
    repos.projects.insert({ id: 'p', name: 'P', path: repo, defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
    repos.iterations.insert({ id: 'it', projectId: 'p', name: 'I', version: '1.0', status: 'active', createdAt: 1 });
    repos.requirements.insert({ id: 'req', iterationId: 'it', title: 'R', description: '', priority: 'medium' as const, acceptance: '', createdAt: 1, archived: false });
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
    rmSync(repo, { recursive: true, force: true });
    rmSync(worktreeDir, { recursive: true, force: true });
  });

  function setup(runner: FakeAgentRunner, coordinator?: KnowledgeCoordinator) {
    const repos = createRepositories(db);
    const orch = new Orchestrator(repos, runner, {
      worktreesBaseDir: worktreeDir,
      maxConcurrent: 2,
      autoRetry: false,
      knowledgeCoordinator: coordinator,
    });
    return { orch, repos };
  }

  it('injects L3 manifests for dev and test and creates the task index', async () => {
    // 先初始化知识库
    const knowledge = new ProjectKnowledgeService();
    await knowledge.initializeKnowledge({ repoPath: repo, date: '2026-07-27' });
    shGit(repo, ['add', '.']);
    shGit(repo, ['commit', '-q', '-m', 'kb init']);
    const coordinator = new KnowledgeCoordinator({
      repos: createRepositories(db), runner: { async verifyRuntime() { return { version: '', entry: '' }; }, async run() { throw new Error('unused'); } },
      knowledge, worktreesBaseDir: worktreeDir,
    });

    const runner = new FakeAgentRunner(() => [{ type: 'done', summary: 'dev ok', t: 0 }]);
    const { orch, repos } = setup(runner, coordinator);
    const t = makeTask({ worktreePath: join(worktreeDir, 'fake-wt') });
    // fake-wt 不是 git 仓库 -> createWorktree 会失败；直接用一个真实 worktree 路径
    t.worktreePath = undefined;
    repos.tasks.insert(t);

    await orch.start(t.id);

    expect(runner.requests.map((r: AgentRunRequest) => [r.expert, r.knowledgeManifest?.level])).toEqual([
      ['dev', 3],
      ['test', 3],
    ]);
    expect(
      execFileSync(
        'git',
        ['show', 'ai-devflow-sprint/1.0:docs/iterations/1.0/tasks/t1/index.md'],
        { cwd: repo, encoding: 'utf8' },
      ),
    ).toContain('# T');
  });

  it('completes persisted retrievals with validated agent read evidence', async () => {
    const knowledge = new ProjectKnowledgeService();
    await knowledge.initializeKnowledge({ repoPath: repo, date: '2026-07-27' });
    shGit(repo, ['add', '.']);
    shGit(repo, ['commit', '-q', '-m', 'kb init']);
    const coordinator = new KnowledgeCoordinator({
      repos: createRepositories(db),
      runner: { async verifyRuntime() { return { version: '', entry: '' }; }, async run() { throw new Error('unused'); } },
      knowledge,
      worktreesBaseDir: worktreeDir,
    });
    const read = {
      knowledgeId: 'context:root',
      path: 'docs/knowledge/index.md',
      reason: 'project context',
      chars: 120,
    };
    const runner = new FakeAgentRunner(
      () => [{ type: 'done', summary: 'dev ok', knowledgeReads: [read], t: 0 }],
      {
        testExpertEvents: () => [{
          type: 'done',
          summary: 'ok\nREVIEW_VERDICT: PASS',
          knowledgeReads: [read],
          result: {
            kind: 'task_review',
            review: { pass: true, summary: 'REVIEW_VERDICT: PASS' },
            knowledgeAssessment: { verdict: 'none', reason: 'no durable change', evidence: ['README.md'] },
          },
          t: 0,
        }],
      },
    );
    const { orch, repos } = setup(runner, coordinator);
    repos.tasks.insert(makeTask());

    await orch.start('t1');

    const retrievals = repos.knowledgeRetrievals.listByTask('t1');
    expect(retrievals).toHaveLength(2);
    expect(retrievals.every((item) => item.state === 'completed')).toBe(true);
    expect(retrievals.every((item) => JSON.parse(item.readEvidenceJson).length === 1)).toBe(true);
    const evidence = await coordinator.getTaskEvidence('t1');
    expect(evidence.retrievals.every((item) => item.reads[0]?.knowledgeId === 'context:root')).toBe(true);
  });

  it('produces a not_initialized manifest when the knowledge root is absent', async () => {
    const knowledge = new ProjectKnowledgeService();
    const coordinator = new KnowledgeCoordinator({
      repos: createRepositories(db), runner: { async verifyRuntime() { return { version: '', entry: '' }; }, async run() { throw new Error('unused'); } },
      knowledge, worktreesBaseDir: worktreeDir,
    });
    const runner = new FakeAgentRunner(() => [{ type: 'done', summary: 'dev ok', t: 0 }]);
    const { repos } = setup(runner, coordinator);
    const t = makeTask();
    t.worktreePath = undefined;
    repos.tasks.insert(t);

    await orch_start(repos, runner, coordinator, t.id, worktreeDir);
    // 未初始化时 manifest 状态为 not_initialized，level=1
    const devReq = (globalThis as { __lastRequests?: AgentRunRequest[] }).__lastRequests;
    expect(devReq).toBeDefined();
    const dev = devReq!.find((r) => r.expert === 'dev');
    expect(dev?.knowledgeManifest?.state).toBe('not_initialized');
  });
});

// 辅助：用一个共享 runner 引用启动（捕获 requests）。
async function orch_start(
  repos: import('@ai-devflow/persistence').Repositories,
  runner: FakeAgentRunner,
  coordinator: KnowledgeCoordinator,
  taskId: string,
  worktreeDir: string,
): Promise<void> {
  const orch = new Orchestrator(repos, runner, {
    worktreesBaseDir: worktreeDir,
    maxConcurrent: 2,
    autoRetry: false,
    knowledgeCoordinator: coordinator,
  });
  try {
    await orch.start(taskId);
  } finally {
    (globalThis as { __lastRequests?: AgentRunRequest[] }).__lastRequests = runner.requests;
  }
}
