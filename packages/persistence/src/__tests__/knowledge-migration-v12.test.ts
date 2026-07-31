import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, getCurrentVersion, createRepositories, type DatabaseSync } from '../index.js';

function freshPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'aidf-v12-')), 'app.db');
}

function tableNames(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(
    (t) => t.name,
  );
}

function columnNames(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

describe('schema v12 migration', () => {
  it('migrates a fresh db through v15 with knowledge tables and provider usage analytics', () => {
    const db = openDatabase(freshPath());
    expect(getCurrentVersion(db)).toBe(15);
    expect(tableNames(db)).toEqual(
      expect.arrayContaining([
        'knowledge_runs',
        'knowledge_findings',
        'knowledge_retrievals',
        'knowledge_depositions',
      ]),
    );
    const depositionColumns = db.prepare('PRAGMA table_info(knowledge_depositions)').all() as Array<{ name: string }>;
    expect(depositionColumns.map((column) => column.name)).toContain('progress_json');
    // 知识表绝不允许正文 / 内容 / markdown / prompt 列
    for (const table of tableNames(db).filter((name) => name.startsWith('knowledge_'))) {
      expect(columnNames(db, table)).not.toEqual(
        expect.arrayContaining(['body', 'content', 'markdown', 'prompt']),
      );
    }
  });

  it('upgrades an existing v11 db through v15 preserving rows', () => {
    const path = freshPath();
    const v11 = openDatabase(path, { maxVersion: 11 });
    v11.exec(`
      INSERT INTO projects(id,name,path,default_branch,created_at,updated_at,settings_json)
        VALUES('p','P','/tmp/p','main',1,1,'{}');
    `);
    v11.close();
    const db = openDatabase(path);
    expect(getCurrentVersion(db)).toBe(15);
    expect(db.prepare("SELECT COUNT(*) AS n FROM projects WHERE id='p'").get()).toMatchObject({ n: 1 });
    expect(tableNames(db)).toContain('knowledge_runs');
  });

  it('cascades on deleting a knowledge_run to its findings', () => {
    const db = openDatabase(freshPath());
    const repos = createRepositories(db);
    db.exec(`
      INSERT INTO projects(id,name,path,default_branch,created_at,updated_at,settings_json)
        VALUES('p','P','/tmp/p','main',1,1,'{}');
    `);
    repos.knowledgeRuns.create({
      id: 'run-1',
      projectId: 'p',
      kind: 'full_audit',
      state: 'succeeded',
      confirmationState: 'not_required',
      changedPathsJson: '[]',
      diagnosticsJson: '[]',
      resultJson: '{}',
      startedAt: 10,
      endedAt: 20,
    });
    repos.knowledgeFindings.insertMany([
      {
        id: 'f-1',
        runId: 'run-1',
        severity: 'error',
        code: 'duplicate_id',
        message: 'dup',
        evidenceJson: '[]',
        createdAt: 15,
      },
    ]);
    expect(repos.knowledgeFindings.listByRun('run-1')).toHaveLength(1);
    repos.knowledgeFindings.replaceByRun('run-1', []);
    expect(repos.knowledgeFindings.listByRun('run-1')).toHaveLength(0);
    repos.knowledgeFindings.replaceByRun('run-1', [
      {
        id: 'f-2',
        runId: 'run-1',
        severity: 'warn',
        code: 'updated',
        message: 'latest',
        evidenceJson: '[]',
        createdAt: 16,
      },
    ]);
    expect(repos.knowledgeFindings.listByRun('run-1')).toEqual([
      expect.objectContaining({ id: 'f-2', code: 'updated', message: 'latest' }),
    ]);
    db.prepare('DELETE FROM knowledge_runs WHERE id=?').run('run-1');
    expect(repos.knowledgeFindings.listByRun('run-1')).toHaveLength(0);
  });
});

describe('knowledge repositories', () => {
  function setup() {
    const db = openDatabase(freshPath());
    const repos = createRepositories(db);
    db.exec(`
      INSERT INTO projects(id,name,path,default_branch,created_at,updated_at,settings_json)
        VALUES('p','P','/tmp/p','main',1,1,'{}');
      INSERT INTO iterations(id,project_id,name,version,status,created_at)
        VALUES('i','p','I','1.0','active',1);
      INSERT INTO requirements(id,iteration_id,title,description,acceptance,created_at)
        VALUES('req','i','R','', '', 1);
      INSERT INTO tasks(id,requirement_id,iteration_id,project_id,title,status,role,status_changed_at,created_at,updated_at)
        VALUES('t','req','i','p','T','ready','coder',1,1,1);
      INSERT INTO execution_records(id,task_id,attempt,started_at,status)
        VALUES('e','t',1,1,'running');
    `);
    return { db, repos };
  }

  it('runs lifecycle: create, list, mark, finish', () => {
    const { repos } = setup();
    repos.knowledgeRuns.create({
      id: 'r1',
      projectId: 'p',
      iterationId: 'i',
      kind: 'initialization',
      state: 'running',
      confirmationState: 'not_required',
      changedPathsJson: '[]',
      diagnosticsJson: '[]',
      resultJson: '{}',
      startedAt: 100,
    });
    expect(repos.knowledgeRuns.get('r1')?.state).toBe('running');
    repos.knowledgeRuns.markAwaitingConfirmation('r1', 'ai-devflow/knowledge/r1', '["docs/knowledge/index.md"]');
    expect(repos.knowledgeRuns.get('r1')?.draftBranch).toBe('ai-devflow/knowledge/r1');
    expect(repos.knowledgeRuns.get('r1')?.confirmationState).toBe('pending');
    repos.knowledgeRuns.setConfirmation('r1', 'confirmed');
    repos.knowledgeRuns.finish('r1', 'succeeded', 200, { resultJson: '{"ok":true}' });
    const got = repos.knowledgeRuns.get('r1');
    expect(got?.state).toBe('succeeded');
    expect(got?.endedAt).toBe(200);
    expect(got?.resultJson).toBe('{"ok":true}');
    expect(repos.knowledgeRuns.listByProject('p')).toHaveLength(1);
  });

  it('getLatestByIteration returns the latest iteration_changelog run', () => {
    const { repos } = setup();
    repos.knowledgeRuns.create({
      id: 'r1', projectId: 'p', iterationId: 'i', kind: 'iteration_changelog',
      state: 'succeeded', confirmationState: 'not_required',
      changedPathsJson: '[]', diagnosticsJson: '[]', resultJson: '{}', startedAt: 100, endedAt: 110,
    });
    repos.knowledgeRuns.create({
      id: 'r2', projectId: 'p', iterationId: 'i', kind: 'iteration_changelog',
      state: 'succeeded', confirmationState: 'not_required',
      changedPathsJson: '[]', diagnosticsJson: '[]', resultJson: '{}', startedAt: 200, endedAt: 210,
    });
    expect(repos.knowledgeRuns.getLatestByIteration('i', 'iteration_changelog')?.id).toBe('r2');
  });

  it('findings insertMany rolls back on error (atomicity)', () => {
    const { db, repos } = setup();
    repos.knowledgeRuns.create({
      id: 'r1', projectId: 'p', kind: 'full_audit', state: 'running',
      confirmationState: 'not_required', changedPathsJson: '[]', diagnosticsJson: '[]',
      resultJson: '{}', startedAt: 1,
    });
    expect(() =>
      repos.knowledgeFindings.insertMany([
        { id: 'f1', runId: 'r1', severity: 'error', code: 'c1', message: 'm', evidenceJson: '[]', createdAt: 1 },
        { id: 'f2', runId: 'missing', severity: 'warn', code: 'c2', message: 'm', evidenceJson: '[]', createdAt: 2 },
      ]),
    ).toThrow();
    // 整批回滚：f1 不应残留
    expect(repos.knowledgeFindings.listByRun('r1')).toHaveLength(0);
    void db;
  });

  it('retrievals create, complete, list by task and execution', () => {
    const { repos } = setup();
    repos.knowledgeRetrievals.create({
      id: 'ret1', projectId: 'p', taskId: 't', executionId: 'e',
      expertKey: 'dev', stage: 'development', level: 3, state: 'planned',
      candidateRefsJson: '[]', readEvidenceJson: '[]', skippedRefsJson: '[]', differencesJson: '[]',
      budgetFiles: 5, budgetChars: 1000, usedFiles: 0, usedChars: 0, confidence: 0, createdAt: 10,
    });
    repos.knowledgeRetrievals.complete('ret1', {
      state: 'completed',
      readEvidenceJson: '[]',
      skippedRefsJson: '[]',
      differencesJson: '[]',
      usedFiles: 1,
      usedChars: 50,
      confidence: 0.8,
      completedAt: 20,
    });
    const got = repos.knowledgeRetrievals.get('ret1');
    expect(got?.state).toBe('completed');
    expect(got?.completedAt).toBe(20);
    expect(repos.knowledgeRetrievals.listByTask('t')).toHaveLength(1);
    expect(repos.knowledgeRetrievals.listByExecution('e')).toHaveLength(1);
  });

  it('depositions create, finish, latest, list', () => {
    const { repos } = setup();
    repos.knowledgeDepositions.create({
      id: 'd1', projectId: 'p', taskId: 't', executionId: 'e',
      verdict: 'valuable', state: 'running',
      assessmentJson: '{"verdict":"valuable","candidates":[]}',
      relatedKnowledgeIdsJson: '[]', changedPathsJson: '[]',
      gatePassed: false, diagnosticsJson: '[]', startedAt: 10,
    });
    repos.knowledgeDepositions.finish('d1', {
      state: 'succeeded',
      relatedKnowledgeIdsJson: '["feature:a"]',
      changedPathsJson: '["docs/knowledge/feature/a.md"]',
      gatePassed: true,
      diagnosticsJson: '[]',
      endedAt: 30,
    });
    const got = repos.knowledgeDepositions.get('d1');
    expect(got?.state).toBe('succeeded');
    expect(got?.gatePassed).toBe(true);
    expect(repos.knowledgeDepositions.getLatestByTask('t')?.id).toBe('d1');
    expect(repos.knowledgeDepositions.listByTask('t')).toHaveLength(1);
  });
});
