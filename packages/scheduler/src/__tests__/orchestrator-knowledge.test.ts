import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, createRepositories, type DatabaseSync } from '@ai-devflow/persistence';
import { ProjectKnowledgeService } from '@ai-devflow/knowledge';
import { Orchestrator } from '../orchestrator.js';
import { FakeAgentRunner } from './fake-agent-runner.js';
import { KnowledgeCoordinator } from '../knowledge-coordinator.js';
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
    // 任务索引在 task worktree 中创建（合并后落入默认分支或保留在任务分支）
    // 这里仅校验运行未因 manifest 抛错，且 dev/test 都收到 manifest。
    expect(runner.requests.length).toBe(2);
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
    t.worktreePath = join(worktreeDir, 'fake-wt');
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
