import { afterEach, describe, expect, it } from 'vitest';
import { getCurrentVersion, openDatabase, runMigrations, type DatabaseSync } from '../index.js';

let db: DatabaseSync | undefined;
afterEach(() => db?.close());

describe('provider usage migration v15', () => {
  it('backfills legacy execution attempts without fabricating model or token data', () => {
    db = openDatabase(':memory:', { maxVersion: 14 });
    db.prepare(`INSERT INTO projects(id,name,path,default_branch,created_at,updated_at,settings_json)
      VALUES('p','Project','/p','main',1,1,'{}')`).run();
    db.prepare(`INSERT INTO iterations(id,project_id,name,version,status,created_at)
      VALUES('i','p','Iteration','v1','active',1)`).run();
    db.prepare(`INSERT INTO requirements(id,iteration_id,title,description,priority,acceptance,created_at,archived)
      VALUES('r','i','Req','','medium','accept',1,0)`).run();
    db.prepare(`INSERT INTO tasks(id,requirement_id,iteration_id,project_id,title,description,status,role,stages_json,current_stage,status_changed_at,created_at,updated_at,retry_count,depends_on_json)
      VALUES('t','r','i','p','Task','','ready','coder','[]',0,1,1,1,0,'[]')`).run();
    db.prepare(`INSERT INTO execution_records(id,task_id,attempt,started_at,ended_at,status)
      VALUES('e1','t',1,100,180,'succeeded')`).run();
    db.prepare(`INSERT INTO execution_attempts(id,execution_id,ordinal,route_id,state,mutations_observed,journal_json,started_at,ended_at)
      VALUES('a1','e1',1,'provider-1:dev','succeeded',0,'{}',110,170)`).run();

    runMigrations(db);

    expect(getCurrentVersion(db)).toBe(15);
    const row = db.prepare(`SELECT * FROM provider_usage WHERE id='legacy:a1'`).get() as Record<string, unknown>;
    expect(row).toMatchObject({
      logical_request_id: 'e1',
      provider_id: 'provider-1',
      provider_name: 'provider-1',
      workload: 'dev',
      source: 'task_agent',
      project_id: 'p',
      task_id: 't',
      execution_id: 'e1',
      status: 'succeeded',
      model: null,
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
      total_tokens: null,
    });

    runMigrations(db);
    expect((db.prepare(`SELECT COUNT(*) AS count FROM provider_usage WHERE id='legacy:a1'`).get() as { count: number }).count).toBe(1);
  });
});
