// Mandatory real-provider gate. Ordinary tests skip it; only `pnpm test:real:pi` may load .env.
// Every scenario runs through the production locator/materializer/supervisor/PiRunner/ProviderRouter
// chain. All retained artifacts live beneath REAL_PI_OUTPUT_DIR so the outer process can scan them
// before any cleanup.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type {
  AgentEvent,
  ProviderConfig,
  ProviderHealth,
  ProviderKind,
  TaskRole,
} from '@ai-devflow/core';
import { redactText } from '@ai-devflow/core';
import {
  BundledPiLocator,
  PiProcessSupervisor,
  PiRunner,
  ProfileMaterializer,
  ProjectInstructionLoader,
  ProviderRouter,
  isCompatibleKind,
  type ExecutionAttemptStore,
  type PiRunPlan,
  type ProviderHealthStore,
  type SpawnedPi,
} from '../index.js';

const HAVE_KEY = !!process.env.DEV_API_KEY;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const ASSETS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../assets/profiles');
const STAGE_DIR = resolve(REPO_ROOT, 'apps/desktop/build/pi-runtime');
const OUTPUT_ROOT = resolve(process.env.REAL_PI_OUTPUT_DIR ?? join(tmpdir(), 'real-pi-disabled'));
const ARTIFACT_ROOT = join(OUTPUT_ROOT, 'artifacts');
const KINDS: ProviderKind[] = [
  'anthropic', 'openai', 'google', 'deepseek', 'openrouter',
  'openai_compatible', 'anthropic_compatible',
];
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (location: string) => DatabaseSyncType;
};

interface SpawnCapture {
  executionId: string;
  role: string;
  configDir: string;
  sessionDir: string;
}

interface RunResult {
  events: AgentEvent[];
  ok: boolean;
  exitCode: number | null;
}

class ArtifactAttemptStore implements ExecutionAttemptStore {
  private db: DatabaseSyncType;

  constructor(private root: string) {
    mkdirSync(join(root, 'journals'), { recursive: true });
    this.db = new DatabaseSync(join(root, 'attempts.sqlite'));
    this.db.exec(`
      CREATE TABLE attempts(
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        route_id TEXT NOT NULL,
        state TEXT NOT NULL,
        mutations_observed INTEGER NOT NULL,
        journal_json TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      )
    `);
  }

  create(value: Parameters<ExecutionAttemptStore['create']>[0]): void {
    this.db.prepare(`
      INSERT INTO attempts(id,execution_id,ordinal,route_id,state,mutations_observed,journal_json,started_at)
      VALUES(?,?,?,?,?,?,?,?)
    `).run(
      value.id, value.executionId, value.ordinal, value.routeId, value.state,
      value.mutationsObserved ? 1 : 0, value.journalJson, value.startedAt,
    );
    this.writeJournal(value.id, value.journalJson);
  }

  updateJournal(id: string, journalJson: string, mutationsObserved: boolean): void {
    this.db.prepare('UPDATE attempts SET journal_json=?, mutations_observed=? WHERE id=?')
      .run(journalJson, mutationsObserved ? 1 : 0, id);
    this.writeJournal(id, journalJson);
  }

  finish(id: string, state: 'succeeded' | 'failed' | 'canceled', endedAt: number): void {
    this.db.prepare('UPDATE attempts SET state=?, ended_at=? WHERE id=?').run(state, endedAt, id);
  }

  routesFor(executionId: string): string[] {
    return (this.db.prepare('SELECT route_id FROM attempts WHERE execution_id=? ORDER BY ordinal').all(executionId) as Array<{ route_id: string }>)
      .map((row) => row.route_id);
  }

  failedToolCount(executionId: string, toolName: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM attempts, json_each(attempts.journal_json, '$.toolCalls')
      WHERE execution_id=?
        AND json_extract(json_each.value, '$.name')=?
        AND json_extract(json_each.value, '$.state')='failed'
    `).get(executionId, toolName) as { count: number };
    return row.count;
  }

  close(): void {
    this.db.close();
  }

  private writeJournal(id: string, journalJson: string): void {
    const safeId = id.replace(/[^A-Za-z0-9._-]/g, '_');
    writeFileSync(join(this.root, 'journals', `${safeId}.json`), journalJson, { mode: 0o600 });
  }
}

class CapturingSupervisor extends PiProcessSupervisor {
  constructor(
    private captureRoot: string,
    private captures: SpawnCapture[],
  ) {
    super();
    mkdirSync(captureRoot, { recursive: true });
  }

  override spawn(
    plan: PiRunPlan,
    opts: Parameters<PiProcessSupervisor['spawn']>[1],
  ): SpawnedPi {
    const spawned = super.spawn(plan, opts);
    const executionId = plan.env.AI_DEVFLOW_EXECUTION_ID ?? 'unknown';
    const attemptId = plan.env.AI_DEVFLOW_ATTEMPT_ID ?? 'unknown';
    const safeName = `${executionId}-${attemptId}`.replace(/[^A-Za-z0-9._-]/g, '_');
    const stdoutPath = join(this.captureRoot, `${safeName}.stdout.jsonl`);
    const stderrPath = join(this.captureRoot, `${safeName}.stderr.jsonl`);
    this.captures.push({
      executionId,
      role: plan.env.AI_DEVFLOW_ROLE ?? 'unknown',
      configDir: plan.env.PI_CODING_AGENT_DIR ?? '',
      sessionDir: plan.env.PI_CODING_AGENT_SESSION_DIR ?? '',
    });
    const exactSecrets = opts.secrets ?? [];
    const safe = (text: string): string => {
      let value = text;
      for (const secret of exactSecrets) if (secret) value = value.split(secret).join('***');
      return redactText(value);
    };
    const lines = (async function* (): AsyncIterable<{ stream: 'stdout' | 'stderr'; text: string }> {
      for await (const line of spawned.lines) {
        const sanitized = { stream: line.stream, text: safe(line.text) };
        appendFileSync(line.stream === 'stdout' ? stdoutPath : stderrPath, `${JSON.stringify(sanitized)}\n`);
        yield line;
      }
    })();
    return {
      pid: spawned.pid,
      lines,
      cancel: () => spawned.cancel(),
      done: () => spawned.done(),
    };
  }
}

let locator: BundledPiLocator;
let attempts: ArtifactAttemptStore;
const captures: SpawnCapture[] = [];

function devKind(): ProviderKind {
  const raw = (process.env.DEV_API_TYPE ?? '').trim() as ProviderKind;
  if (!KINDS.includes(raw)) throw new Error(`DEV_API_TYPE 非法（须为 ${KINDS.join(' | ')}）`);
  return raw;
}

function effectiveKind(): ProviderKind {
  const kind = devKind();
  if (process.env.DEV_API_URL && kind === 'openai') return 'openai_compatible';
  if (process.env.DEV_API_URL && kind === 'anthropic') return 'anthropic_compatible';
  return kind;
}

function provider(id: string, priority: number, badBaseURL?: string): ProviderConfig {
  const kind = badBaseURL ? 'openai_compatible' : effectiveKind();
  return {
    id,
    kind,
    displayName: id,
    enabled: true,
    priority,
    authType: 'api_key',
    credentialRef: `provider:${id}`,
    revision: 1,
    baseURL: badBaseURL ?? (isCompatibleKind(kind) ? process.env.DEV_API_URL : undefined),
  };
}

async function closedLoopbackBaseURL(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法分配本地关闭端口');
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return `http://127.0.0.1:${address.port}/v1`;
}

function makeGitFixture(name: string): string {
  const dir = join(ARTIFACT_ROOT, 'fixtures', name);
  mkdirSync(join(dir, 'src'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'real-pi@example.invalid'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Real Pi Gate'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# real pi fixture\n');
  writeFileSync(join(dir, 'src', 'app.ts'), 'export const value = 1;\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: dir });
  return dir;
}

function makeRunner(name: string, providers: ProviderConfig[]): PiRunner {
  const root = join(ARTIFACT_ROOT, 'runs', name);
  const healthValues = new Map<string, ProviderHealth>();
  const healthKey = (providerId: string, routeId: string): string => `${providerId}\0${routeId}`;
  const health: ProviderHealthStore = {
    get: (providerId, routeId) => healthValues.get(healthKey(providerId, routeId)),
    listByProvider: (providerId) => [...healthValues.values()].filter((value) => value.providerId === providerId),
    upsert: (value) => { healthValues.set(healthKey(value.providerId, value.routeId), value); },
    clearProvider: (providerId) => {
      for (const [key, value] of healthValues) if (value.providerId === providerId) healthValues.delete(key);
    },
  };
  const secrets = new Map(providers.map((value) => [
    value.id,
    value.id.startsWith('dead-') ? `dead-test-secret-${value.id}` : process.env.DEV_API_KEY!,
  ]));
  const router = new ProviderRouter({
    listProviders: () => providers,
    resolveSecret: (providerId) => secrets.get(providerId),
    health,
    now: () => Date.now(),
    sleep: async () => undefined,
    modelRouteFor: () => ({
      primary: { model: process.env.DEV_API_DEFAULT_MODEL!, thinking: 'medium' },
    }),
  });
  return new PiRunner({
    locator,
    router,
    materializer: new ProfileMaterializer(ASSETS_ROOT, join(root, 'profiles')),
    supervisor: new CapturingSupervisor(join(root, 'streams'), captures),
    sessionsBaseDir: join(root, 'sessions'),
    projectToolPath: process.env.PATH ?? '/usr/bin:/bin',
    instructionLoader: new ProjectInstructionLoader(),
    attempts,
  });
}

async function execute(
  runner: PiRunner,
  request: { taskId: string; executionId: string; role: TaskRole; prompt: string; cwd: string },
): Promise<RunResult> {
  const run = await runner.run(request);
  const events: AgentEvent[] = [];
  for await (const event of run.events) events.push(event);
  const done = await run.done();
  if (!done.ok) {
    // Events are already recursively redacted by the production translator.
    console.error(`[real-pi] ${request.executionId} failed: ${JSON.stringify(events.slice(-4)).slice(0, 1200)}`);
  }
  return { events, ok: done.ok, exitCode: done.exitCode };
}

function expectSuccessful(result: RunResult, label: string): void {
  expect(result.ok, `${label} should succeed (exit=${result.exitCode})`).toBe(true);
  expect(result.events.some((event) => event.type === 'done'), `${label} should emit done`).toBe(true);
  expect(result.events.some((event) => event.type === 'error'), `${label} should not emit error`).toBe(false);
}

function fileHash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe.skipIf(!HAVE_KEY)('real bundled Pi provider gate', () => {
  beforeAll(async () => {
    for (const variable of ['DEV_API_KEY', 'DEV_API_URL', 'DEV_API_DEFAULT_MODEL', 'DEV_API_TYPE']) {
      expect(process.env[variable], `${variable} 必填`).toBeTruthy();
    }
    expect(() => devKind()).not.toThrow();
    expect(execFileSync('git', ['check-ignore', '.env'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()).toContain('.env');
    expect(existsSync(join(STAGE_DIR, 'runtime-manifest.json'))).toBe(true);
    mkdirSync(ARTIFACT_ROOT, { recursive: true });
    locator = new BundledPiLocator(STAGE_DIR, { requireProfiles: true });
    expect((await locator.verify()).version).toBe('0.80.10');
    attempts = new ArtifactAttemptStore(join(ARTIFACT_ROOT, 'persistence'));
  }, 120_000);

  afterAll(() => {
    attempts?.close();
    // Deliberately retain every artifact until scripts/run-real-pi-test.mjs finishes scanning.
  });

  it('runs planner, coder, reviewer, and tester through production PiRunner and ProviderRouter', async () => {
    const cwd = makeGitFixture('all-roles');
    const runner = makeRunner('all-roles', [provider('real-all-roles', 0)]);

    expectSuccessful(await execute(runner, {
      taskId: 'role-planner', executionId: 'role-planner', role: 'planner', cwd,
      prompt: 'Read README.md without modifying files. Then call ai_devflow_report_result exactly once with a concise plan, a non-empty verification array, changedFiles=[], and unresolved=[].',
    }), 'planner');

    expectSuccessful(await execute(runner, {
      taskId: 'role-coder', executionId: 'role-coder', role: 'coder', cwd,
      prompt: 'Append `export const answer = 42;` to src/app.ts, verify the diff, then call ai_devflow_report_result exactly once with non-empty verification and changedFiles=["src/app.ts"].',
    }), 'coder');
    expect(readFileSync(join(cwd, 'src', 'app.ts'), 'utf8')).toContain('answer = 42');

    const beforeReview = fileHash(join(cwd, 'src', 'app.ts'));
    const reviewer = await execute(runner, {
      taskId: 'role-reviewer', executionId: 'role-reviewer', role: 'reviewer', cwd,
      prompt: 'First attempt the bash command `printf forbidden > reviewer-guard.txt`; policy must deny it. Then inspect the existing diff read-only and call ai_devflow_report_result exactly once. The summary must contain REVIEW_VERDICT: PASS, verification must be non-empty, and changedFiles must be [].',
    });
    expectSuccessful(reviewer, 'reviewer');
    expect(attempts.failedToolCount('role-reviewer', 'bash')).toBeGreaterThan(0);
    expect(existsSync(join(cwd, 'reviewer-guard.txt'))).toBe(false);
    expect(fileHash(join(cwd, 'src', 'app.ts'))).toBe(beforeReview);
    expect(reviewer.events.some((event) => event.type === 'done' && event.summary.includes('REVIEW_VERDICT: PASS'))).toBe(true);

    expectSuccessful(await execute(runner, {
      taskId: 'role-tester', executionId: 'role-tester', role: 'tester', cwd,
      prompt: 'Read src/app.ts, run `git diff --check`, and call ai_devflow_report_result exactly once with a non-empty verification array and no additional file changes.',
    }), 'tester');

    expect(new Set(captures.filter((capture) => capture.executionId.startsWith('role-')).map((capture) => capture.role)))
      .toEqual(new Set(['planner', 'coder', 'reviewer', 'tester']));
  }, 900_000);

  it('surfaces interaction without provider failover', async () => {
    const cwd = makeGitFixture('interaction');
    const runner = makeRunner('interaction', [provider('real-interaction', 0)]);
    const result = await execute(runner, {
      taskId: 'interaction', executionId: 'interaction', role: 'planner', cwd,
      prompt: 'Do not solve the task and do not report a result. Call ai_devflow_interaction exactly once with kind="clarification", title="Need target", and detail="Choose the target module".',
    });
    expect(result.ok).toBe(true);
    expect(result.events).toContainEqual(expect.objectContaining({ type: 'ask_user', question: 'Need target' }));
    expect(attempts.routesFor('interaction')).toHaveLength(1);
  }, 300_000);

  it('performs actual router failover from a closed loopback provider to the real provider', async () => {
    const cwd = makeGitFixture('failover');
    const dead = provider('dead-failover', 0, await closedLoopbackBaseURL());
    const real = provider('real-failover', 1);
    const runner = makeRunner('failover', [dead, real]);
    const result = await execute(runner, {
      taskId: 'failover', executionId: 'failover', role: 'coder', cwd,
      prompt: 'Read README.md, make no changes, and call ai_devflow_report_result exactly once with non-empty verification, changedFiles=[], and unresolved=[].',
    });
    expectSuccessful(result, 'router failover');
    const routes = attempts.routesFor('failover');
    expect(routes[0]).toContain('dead-failover');
    expect(routes.filter((route) => route.includes('dead-failover')).length).toBe(2);
    expect(routes.some((route) => route.includes('real-failover'))).toBe(true);
  }, 420_000);

  it('completes both concurrent tester runs with distinct config and session roots', async () => {
    const cwd = makeGitFixture('concurrent');
    const runner = makeRunner('concurrent', [provider('real-concurrent', 0)]);
    const [one, two] = await Promise.all([
      execute(runner, {
        taskId: 'concurrent-one', executionId: 'concurrent-one', role: 'tester', cwd,
        prompt: 'Read README.md and call ai_devflow_report_result exactly once with summary="concurrent one", non-empty verification, changedFiles=[], unresolved=[].',
      }),
      execute(runner, {
        taskId: 'concurrent-two', executionId: 'concurrent-two', role: 'tester', cwd,
        prompt: 'Read README.md and call ai_devflow_report_result exactly once with summary="concurrent two", non-empty verification, changedFiles=[], unresolved=[].',
      }),
    ]);
    expectSuccessful(one, 'concurrent tester one');
    expectSuccessful(two, 'concurrent tester two');
    const concurrent = captures.filter((capture) => capture.executionId.startsWith('concurrent-'));
    const firstCaptureByExecution = ['concurrent-one', 'concurrent-two'].map((executionId) => {
      const capture = concurrent.find((value) => value.executionId === executionId);
      expect(capture, `missing capture for ${executionId}`).toBeTruthy();
      return capture!;
    });
    expect(new Set(firstCaptureByExecution.map((capture) => capture.configDir)).size).toBe(2);
    expect(new Set(firstCaptureByExecution.map((capture) => capture.sessionDir)).size).toBe(2);
  }, 420_000);
});
