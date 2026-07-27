import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, createRepositories, type DatabaseSync } from '@ai-devflow/persistence';
import { ProjectKnowledgeService } from '@ai-devflow/knowledge';
import type { AgentRunner, AgentRun, RunnerAgentRunRequest as AgentRunRequest } from '@ai-devflow/agents';
import type { AgentEvent } from '@ai-devflow/core';
import { KnowledgeCoordinator } from '../knowledge-coordinator.js';

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

/** Fake runner：project_lead 在 worktree 写入一份知识文档并提交。 */
class KnowledgeFakeRunner implements AgentRunner {
  requests: AgentRunRequest[] = [];
  constructor(private opts: { outOfScope?: boolean } = {}) {}
  async verifyRuntime(): Promise<{ version: string; entry: string }> {
    return { version: 'fake', entry: 'fake' };
  }
  async run(req: AgentRunRequest): Promise<AgentRun> {
    this.requests.push(req);
    if (req.expert === 'project_lead' && req.resultKind === 'knowledge_initialization') {
      const path = this.opts.outOfScope ? 'packages/core/src/types.ts' : 'docs/knowledge/feature/task-review.md';
      mkdirSync(join(req.cwd, join(path).split('/').slice(0, -1).join('/')), { recursive: true });
      writeFileSync(join(req.cwd, path), '# Task Review\n', 'utf8');
      shGit(req.cwd, ['add', '.']);
      shGit(req.cwd, ['commit', '-q', '-m', 'kb init']);
    }
    if (req.expert === 'project_lead' && req.resultKind === 'knowledge_repair') {
      mkdirSync(join(req.cwd, 'docs/knowledge/context'), { recursive: true });
      writeFileSync(join(req.cwd, 'docs/knowledge/context/runtime.md'), '# Runtime\n', 'utf8');
      shGit(req.cwd, ['add', '.']);
      shGit(req.cwd, ['commit', '-q', '-m', 'kb repair']);
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
            ? { kind: 'knowledge_audit' as const, findings: [] }
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
  let repo: string;
  let wtBase: string;
  let coordinator: KnowledgeCoordinator;
  let runner: KnowledgeFakeRunner;

  beforeEach(() => {
    db = openDatabase(':memory:');
    const repos = createRepositories(db);
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

  it('startInitialization creates a pending run with the knowledge draft branch', async () => {
    const run = await coordinator.startInitialization('p1');
    expect(run.confirmationState).toBe('pending');
    expect(run.draftBranch).toBe(`ai-devflow/knowledge/${run.id}`);
    expect(run.changedPaths).toContain('docs/knowledge/feature/task-review.md');
    // 项目主工作区尚未被修改
    expect(existsSync(join(repo, 'docs/knowledge/index.md'))).toBe(false);
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

  it('cancelRun cleans up the draft branch and marks canceled', async () => {
    const run = await coordinator.startInitialization('p1');
    await coordinator.cancelRun(run.id);
    const record = await coordinator.getRun(run.id);
    expect(record.state).toBe('canceled');
    expect(existsSync(join(repo, 'docs/knowledge/index.md'))).toBe(false);
  });

  it('startAudit(light) performs host-only structural audit', async () => {
    const run = await coordinator.startAudit('p1', 'light');
    expect(run.state).toBe('succeeded');
    expect(run.kind).toBe('light_audit');
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
});
