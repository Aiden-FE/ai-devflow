import { mkdtempSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { openDatabase, type DatabaseSync } from '../db.js';
import { applyPiOnlyMigrationV9, backupBeforeMigration } from '../pi-only-migration-v9.js';
import { createExecutionAttemptsRepo } from '../execution-attempts.js';
import { createProviderHealthRepo } from '../provider-health.js';

describe('Pi-only schema migration', () => {
  it('backs up, removes legacy Agent columns, and cleans project settings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aidf-v9-'));
    const path = join(dir, 'app.db');
    const db = openDatabase(path);
    // Seed a project settings payload containing the legacy keys to prove json_remove works.
    db.exec(`
      INSERT INTO projects(id,name,path,default_branch,created_at,updated_at,settings_json)
        VALUES('p','P','/tmp/p','main',1,1,'{"agentRoles":{"coder":"pi"},"roleConfigs":{},"maxConcurrent":3}');
    `);
    // Legacy global agent config credential that v9 must delete.
    db.exec(`INSERT INTO credentials(key,value_enc,updated_at) VALUES('global_agent_config','x',1)`);
    backupBeforeMigration(db, path, join(dir, 'backups'), 8, 123);
    applyPiOnlyMigrationV9(db);
    const taskColumns = db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>;
    const execColumns = db.prepare('PRAGMA table_info(execution_records)').all() as Array<{ name: string }>;
    expect(taskColumns.map((c) => c.name)).not.toContain('agent_type');
    expect(execColumns.map((c) => c.name)).not.toContain('agent_type');
    expect(readdirSync(join(dir, 'backups')).some((n) => n.endsWith('.db'))).toBe(true);
    // json_remove strips legacy keys but keeps unrelated fields.
    const settings = (db.prepare("SELECT settings_json AS s FROM projects WHERE id='p'").get() as { s: string }).s;
    const parsed = JSON.parse(settings) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('agentRoles');
    expect(parsed).not.toHaveProperty('roleConfigs');
    expect(parsed.maxConcurrent).toBe(3);
    // credentials.global_agent_config is removed.
    expect(db.prepare("SELECT 1 AS x FROM credentials WHERE key='global_agent_config'").get()).toBeUndefined();
  });

  it('keeps only the newest three backups by timestamp', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aidf-v9-retain-'));
    const path = join(dir, 'app.db');
    const db = openDatabase(path);
    for (const ts of [100, 200, 300, 400]) {
      backupBeforeMigration(db, path, join(dir, 'backups'), 8, ts);
    }
    const files = readdirSync(join(dir, 'backups')).sort();
    expect(files).toHaveLength(3);
    expect(files.some((n) => n.includes('-100.'))).toBe(false);
    expect(files.some((n) => n.includes('-200.'))).toBe(true);
    expect(files.some((n) => n.includes('-400.'))).toBe(true);
  });

  it('round-trips route health and an uncertain tool call journal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aidf-health-'));
    const db = openDatabase(join(dir, 'app.db'));
    applyPiOnlyMigrationV9(db);
    const health = createProviderHealthRepo(db);
    health.upsert({
      providerId: 'p1', routeId: 'p1:gpt', state: 'open', consecutiveFailures: 2,
      cooldownUntil: 123, lastFailureKind: 'rate_limit', updatedAt: 100,
    });
    expect(health.get('p1', 'p1:gpt')?.state).toBe('open');
    expect(health.listByProvider('p1')).toHaveLength(1);
    health.clearProvider('p1');
    expect(health.listByProvider('p1')).toHaveLength(0);

    const attempts = createExecutionAttemptsRepo(db);
    const seededExecutionId = seedExecution(db);
    attempts.create({
      id: 'a1', executionId: seededExecutionId, ordinal: 1, routeId: 'p1:gpt', state: 'running',
      mutationsObserved: false, journalJson: '{}', startedAt: 100,
    });
    attempts.updateJournal('a1', JSON.stringify({ toolCalls: [{ id: 'tc1', state: 'uncertain' }] }), true);
    attempts.finish('a1', 'failed', 123);
    expect(attempts.listByExecution(seededExecutionId)).toEqual([
      expect.objectContaining({ id: 'a1', state: 'failed', mutationsObserved: true, endedAt: 123 }),
    ]);
  });

  it('rolls back and leaves the source readable when v9 is applied twice', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aidf-v9-twice-'));
    const db = openDatabase(join(dir, 'app.db'));
    applyPiOnlyMigrationV9(db);
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
