import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getAppPath: () => '/tmp/app', isPackaged: false, getVersion: () => '0.0.0' },
  safeStorage: { isEncryptionAvailable: () => false, getSelectedStorageBackend: () => 'basic_text' },
}));

import type { AgentRunner } from '@ai-devflow/agents';
import type { AgentEvent, Task } from '@ai-devflow/core';
import { openDatabase, createRepositories } from '@ai-devflow/persistence';
import { ProjectKnowledgeService } from '@ai-devflow/knowledge';
import { createKnowledgeWorkflow } from '../services.js';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

describe('production knowledge workflow composition', () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it('injects the coordinator so task executions persist retrieval manifests', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'services-kb-repo-'));
    const worktrees = mkdtempSync(join(tmpdir(), 'services-kb-wt-'));
    cleanup.push(repo, worktrees);
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'test@example.invalid']);
    git(repo, ['config', 'user.name', 'Test']);
    writeFileSync(join(repo, 'README.md'), '# Fixture\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-qm', 'init']);

    const db = openDatabase(':memory:');
    const repos = createRepositories(db);
    repos.projects.insert({ id: 'p', name: 'P', path: repo, defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
    repos.iterations.insert({ id: 'it', projectId: 'p', name: 'I', version: '1.0', status: 'active', createdAt: 1 });
    repos.requirements.insert({ id: 'req', iterationId: 'it', title: 'R', description: '', priority: 'medium', acceptance: 'accept', createdAt: 1, archived: false });
    const task: Task = {
      id: 't', requirementId: 'req', iterationId: 'it', projectId: 'p', title: 'Task', description: '',
      status: 'ready', role: 'coder', stages: [], currentStage: 0, statusChangedAt: 1,
      createdAt: 1, updatedAt: 1, retryCount: 0,
    };
    repos.tasks.insert(task);
    const knowledge = new ProjectKnowledgeService();
    await knowledge.initializeKnowledge({ repoPath: repo, date: '2026-07-28' });
    git(repo, ['add', '.']);
    git(repo, ['commit', '-qm', 'knowledge']);

    const runner: AgentRunner = {
      async verifyRuntime() { return { version: 'fake', entry: 'fake' }; },
      async run(request) {
        const event: AgentEvent = request.expert === 'test'
          ? {
              type: 'done', summary: 'REVIEW_VERDICT: PASS', t: 1,
              result: {
                kind: 'task_review', review: { pass: true, summary: 'REVIEW_VERDICT: PASS' },
                knowledgeAssessment: { verdict: 'none', reason: 'no durable knowledge', evidence: ['README.md'] },
              },
            }
          : { type: 'done', summary: 'done', t: 1 };
        return {
          events: (async function* () { yield event; })(),
          cancel: async () => undefined,
          done: async () => ({ exitCode: 0, ok: true }),
        };
      },
    };

    const workflow = createKnowledgeWorkflow({
      repos,
      runner,
      worktreesBaseDir: worktrees,
      hasProvider: () => true,
      autoRetry: false,
    });
    await workflow.orchestrator.start(task.id);

    expect(repos.knowledgeRetrievals.listByTask(task.id)).toHaveLength(2);
    expect(repos.tasks.get(task.id)?.status).toBe('in_review');
    db.close();
  });
});
