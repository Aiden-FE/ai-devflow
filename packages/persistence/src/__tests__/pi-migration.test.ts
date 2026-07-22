import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRepositories } from '../repositories.js';
import { openDatabase, getCurrentVersion, type DatabaseSync } from '../db.js';
import { applyPiOnlyMigrationV9, backupBeforeMigration } from '../pi-only-migration-v9.js';

function freshPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'aidf-v9-')), 'app.db');
}

describe('Pi-only schema migration (v9, active)', () => {
  it('migrates a fresh db to v9: drops agent columns, creates provider_health & execution_attempts', () => {
    const db = openDatabase(freshPath());
    expect(getCurrentVersion(db)).toBe(9);
    const taskCols = (db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map((c) => c.name);
    const execCols = (db.prepare('PRAGMA table_info(execution_records)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(taskCols).not.toContain('agent_type');
    expect(execCols).not.toContain('agent_type');
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((t) => t.name);
    expect(tables).toContain('provider_health');
    expect(tables).toContain('execution_attempts');
  });

  it('backs up before upgrading a v8 db with data, then drops columns and cleans settings', () => {
    const path = freshPath();
    const v8 = openDatabase(path, { maxVersion: 8 });
    v8.exec(`
      INSERT INTO projects(id,name,path,default_branch,created_at,updated_at,settings_json)
        VALUES('p','P','/tmp/p','main',1,1,'{"agentRoles":{"coder":"pi"},"roleConfigs":{},"maxConcurrent":3}');
      INSERT INTO credentials(key,value_enc,updated_at) VALUES('global_agent_config','x',1);
    `);
    v8.close();

    const db = openDatabase(path);
    expect(getCurrentVersion(db)).toBe(9);
    // 备份已创建
    const backups = readdirSync(join(path, '..', 'backups')).filter((n) => n.endsWith('.db'));
    expect(backups.length).toBeGreaterThanOrEqual(1);
    // 列已删除
    const taskCols = (db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(taskCols).not.toContain('agent_type');
    // settings 清理：移除 agentRoles/roleConfigs，保留 maxConcurrent
    const settings = JSON.parse((db.prepare("SELECT settings_json AS s FROM projects WHERE id='p'").get() as { s: string }).s) as Record<string, unknown>;
    expect(settings).not.toHaveProperty('agentRoles');
    expect(settings).not.toHaveProperty('roleConfigs');
    expect(settings.maxConcurrent).toBe(3);
    // 全局 Agent 配置凭证已删除
    expect(db.prepare("SELECT 1 AS x FROM credentials WHERE key='global_agent_config'").get()).toBeUndefined();
  });

  it('backs up an existing v8 database even when it has zero projects', () => {
    const path = freshPath();
    const v8 = openDatabase(path, { maxVersion: 8 });
    expect((v8.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n).toBe(0);
    v8.close();

    const db = openDatabase(path);
    expect(getCurrentVersion(db)).toBe(9);
    expect(readdirSync(join(path, '..', 'backups')).filter((name) => name.endsWith('.db'))).toHaveLength(1);
  });

  it('keeps only the newest three backups by timestamp', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aidf-v9-retain-'));
    const path = join(dir, 'app.db');
    const db = openDatabase(path);
    const backupDir = join(dir, 'backups');
    for (const ts of [100, 200, 300, 400]) {
      backupBeforeMigration(db, path, backupDir, 8, ts);
    }
    const files = readdirSync(backupDir).filter((f) => f.endsWith('.db')).sort();
    expect(files).toHaveLength(3);
    expect(files.some((n) => n.includes('-100.'))).toBe(false);
    expect(files.some((n) => n.includes('-400.'))).toBe(true);
  });

  it('round-trips route health and an uncertain tool call journal via repositories', () => {
    const db = openDatabase(freshPath());
    const repos = createRepositories(db);
    repos.providerHealth.upsert({
      providerId: 'p1', routeId: 'p1:gpt', state: 'open', consecutiveFailures: 2,
      cooldownUntil: 123, lastFailureKind: 'rate_limit', updatedAt: 100,
    });
    expect(repos.providerHealth.get('p1', 'p1:gpt')?.state).toBe('open');
    repos.providerHealth.clearProvider('p1');
    expect(repos.providerHealth.listByProvider('p1')).toHaveLength(0);

    const execId = seedExecution(db);
    repos.executionAttempts.create({
      id: 'a1', executionId: execId, ordinal: 1, routeId: 'p1:gpt', state: 'running',
      mutationsObserved: false, journalJson: '{}', startedAt: 100,
    });
    repos.executionAttempts.updateJournal('a1', JSON.stringify({ toolCalls: [{ id: 'tc1', state: 'uncertain' }] }), true);
    repos.executionAttempts.finish('a1', 'failed', 123);
    expect(repos.executionAttempts.listByExecution(execId)).toEqual([
      expect.objectContaining({ id: 'a1', state: 'failed', mutationsObserved: true, endedAt: 123 }),
    ]);
  });

  it('rejects re-applying v9 after openDatabase already migrated', () => {
    const db = openDatabase(freshPath());
    expect(getCurrentVersion(db)).toBe(9);
    expect(() => applyPiOnlyMigrationV9(db)).toThrow();
    expect((db.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n).toBe(0);
  });
});

function seedExecution(db: DatabaseSync): string {
  db.exec(`
    INSERT INTO projects(id,name,path,default_branch,created_at,updated_at,settings_json)
      VALUES('p','P','/tmp/p','main',1,1,'{}');
    INSERT INTO iterations(id,project_id,name,version,status,created_at)
      VALUES('i','p','I','1','active',1);
    INSERT INTO requirements(id,iteration_id,title,description,priority,acceptance,created_at)
      VALUES('r','i','R','','medium','',1);
    INSERT INTO tasks(id,requirement_id,iteration_id,project_id,title,description,status,role,stages_json,current_stage,status_changed_at,created_at,updated_at,retry_count)
      VALUES('t','r','i','p','T','','ready','coder','[]',0,1,1,1,0);
    INSERT INTO execution_records(id,task_id,attempt,started_at,status)
      VALUES('e','t',1,1,'running');
  `);
  return 'e';
}
