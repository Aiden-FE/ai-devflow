# Embedded Pi-Only Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every Claude Code/Codex/external-Pi execution path with a bundled `@earendil-works/pi-coding-agent@0.80.10`, isolate role profiles and attempts, and route all AI work through an ordered provider list with bounded automatic failover.

**Architecture:** Electron stages and verifies an exact Pi dependency outside ASAR, then injects its absolute entry into a Pi-only runner. `ProviderRouter` resolves hidden workload/model routes and circuit-breaker state; `PiProcessSupervisor` runs one JSONL process per attempt with isolated configuration and session directories. The scheduler and conversational AI services share this runtime, while Renderer sees only sanitized provider CRUD and health summaries.

**Tech Stack:** TypeScript 5.7, Node/Electron child processes, Electron 43, React 18, node:sqlite, Vitest 2, Playwright, pnpm 11, Pi 0.80.10.

## Global Constraints

- Treat `docs/superpowers/specs/2026-07-22-embedded-pi-runtime-design.md` as the authoritative behavior contract.
- Pin `@earendil-works/pi-coding-agent` exactly to `0.80.10`; never use `^`, `~`, PATH lookup, runtime install, or self-update.
- Production source must end with no `AgentType`, `agentType`, `agentRoles`, `roleConfigs`, `ClaudeCodeAdapter`, `CodexAdapter`, or production `AgentRegistry`.
- Renderer and IPC must never expose models, thinking levels, tools, extensions, skills, prompts, credential references, or decrypted secrets.
- `.env` is real-test-only, must remain ignored, and must never be read by application startup, normal tests, build, or packaging.
- API keys must never appear in argv, logs, errors, SQLite plaintext, generated `models.json`, Renderer state, test artifacts, or packaged resources.
- Pi automatic retry must be disabled; `ProviderRouter` owns all model/provider retry and caps one execution at eight attempts.
- Every implementation task follows red-green-refactor, runs the named verification command, and commits only its listed files.
- Do not edit or stage unrelated user files. In particular, inspect `.env.example` but never read or stage `.env`.

---

## Target File Structure

```text
packages/agents/
├── assets/profiles/
│   ├── shared/extensions/{event-bridge,execution-policy,structured-result,checkpoint-context}.ts
│   └── {planner,coder,reviewer,tester}/
│       ├── settings.json
│       ├── SYSTEM.md
│       └── skills/
└── src/
    ├── runner-types.ts          # AgentRunner, AgentRun, PiInvocation
    ├── profiles.ts              # role/workload model and resource registry
    ├── run-plan.ts              # CLI args + clean environment
    ├── runtime-locator.ts       # manifest and Pi entry verification
    ├── json-events.ts           # Pi JSONL → AgentEvent + journal
    ├── attempt-journal.ts       # persisted attempt state
    ├── process-supervisor.ts    # one Pi child per attempt
    ├── provider-router.ts       # route order, failure classification, circuit breaker
    └── pi-runner.ts             # production AgentRunner

packages/pi-runtime-bundle/package.json  # exact Pi production dependency only
apps/desktop/scripts/stage-pi-runtime.mjs
apps/desktop/electron/provider-store.ts
apps/desktop/electron/credentials.ts
apps/desktop/electron/pi-ai.ts
apps/desktop/electron/services.ts
packages/persistence/src/provider-health.ts
packages/persistence/src/execution-attempts.ts
scripts/verify-real-pi-secrets.mjs
```

Keep existing package boundaries: `core` remains browser-safe; `persistence`, `agents`, `scheduler`, and Electron services remain Main-only.

---

### Task 1: Replace Agent configuration types with provider contracts

**Files:**
- Create: `packages/core/src/provider.ts`
- Create: `packages/core/src/__tests__/provider.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `ProviderKind`, `AuthType`, `ProviderConfig`, `ProviderInput`, `ProviderSummary`, `ProviderHealth`, `ProviderHealthSummary`, `ProviderTestResult`, `FailureKind`, `Workload`, `ProviderAuthenticator`, `normalizeProviderInput()`.
- Keeps: legacy Agent contracts unchanged until the atomic scheduler/schema cutover in Task 9.
- Consumes: no new interfaces.

- [ ] **Step 1: Write provider normalization and gate regression tests**

```ts
// packages/core/src/__tests__/provider.test.ts
import { describe, expect, it } from 'vitest';
import { normalizeProviderInput } from '../provider.js';

describe('normalizeProviderInput', () => {
  it('normalizes a compatible provider without retaining a plaintext key', () => {
    const result = normalizeProviderInput({
      id: 'p1', kind: 'openai_compatible', displayName: 'Dev', enabled: true,
      priority: 2, authType: 'api_key', apiKey: 'secret', baseURL: 'https://gateway.example/v1',
      allowInsecureLocal: false, revision: 4,
    });
    expect(result.config).toEqual({
      id: 'p1', kind: 'openai_compatible', displayName: 'Dev', enabled: true,
      priority: 2, authType: 'api_key', credentialRef: 'provider:p1',
      baseURL: 'https://gateway.example/v1', revision: 4,
    });
    expect(result.secret).toBe('secret');
  });

  it('rejects credentials embedded in a URL', () => {
    expect(() => normalizeProviderInput({
      id: 'p1', kind: 'openai_compatible', displayName: 'Dev', enabled: true,
      priority: 0, authType: 'api_key', apiKey: 'secret', baseURL: 'https://u:p@gateway.example/v1', revision: 1,
    })).toThrow(/用户名或密码/);
  });

  it('requires an explicit opt-in for loopback HTTP', () => {
    expect(() => normalizeProviderInput({
      id: 'p1', kind: 'openai_compatible', displayName: 'Local', enabled: true,
      priority: 0, authType: 'api_key', apiKey: 'secret', baseURL: 'http://127.0.0.1:11434/v1', revision: 1,
    })).toThrow(/本地 HTTP/);
    expect(normalizeProviderInput({
      id: 'p1', kind: 'openai_compatible', displayName: 'Local', enabled: true,
      priority: 0, authType: 'api_key', apiKey: 'secret', baseURL: 'http://127.0.0.1:11434/v1',
      allowInsecureLocal: true, revision: 1,
    }).config.baseURL).toBe('http://127.0.0.1:11434/v1');
  });
});
```

- [ ] **Step 2: Run the focused test and confirm red state**

Run: `pnpm --filter @ai-devflow/core exec vitest run src/__tests__/provider.test.ts`

Expected: FAIL because `provider.ts` does not exist.

- [ ] **Step 3: Add the provider contract and normalization implementation**

```ts
// packages/core/src/provider.ts
export type ProviderKind =
  | 'anthropic' | 'openai' | 'google' | 'deepseek' | 'openrouter'
  | 'openai_compatible' | 'anthropic_compatible';
export type AuthType = 'api_key' | 'oauth';
export type Workload =
  | 'planner' | 'coder' | 'reviewer' | 'tester'
  | 'task_chat' | 'requirement_chat' | 'task_proposal' | 'requirement_proposal';
export type FailureKind =
  | 'authentication' | 'rate_limit' | 'transient_provider' | 'model_unavailable'
  | 'runtime' | 'protocol' | 'task_result' | 'interaction';

export interface ProviderConfig {
  id: string; kind: ProviderKind; displayName: string; enabled: boolean;
  priority: number; authType: AuthType; credentialRef: string;
  baseURL?: string; revision: number;
}
export interface ProviderInput extends Omit<ProviderConfig, 'credentialRef'> {
  apiKey?: string;
  allowInsecureLocal?: boolean;
}
export interface ProviderSummary extends Omit<ProviderConfig, 'credentialRef'> {
  hasCredential: boolean;
  health: 'available' | 'untested' | 'cooldown' | 'configuration_error';
}
export interface ProviderHealth {
  providerId: string; routeId: string; state: 'closed' | 'open' | 'half_open';
  consecutiveFailures: number; cooldownUntil?: number; lastFailureKind?: FailureKind; updatedAt: number;
}
export interface ProviderHealthSummary {
  providerId: string;
  status: 'available' | 'untested' | 'cooldown' | 'configuration_error';
  cooldownUntil?: number;
  lastFailureKind?: FailureKind;
}
export interface ProviderTestResult { ok: boolean; providerId: string; status: number; error?: string }
export interface ProviderAuthenticator {
  readonly authType: AuthType;
  normalize(input: ProviderInput): { credentialRef: string; secret?: string };
}

export function normalizeProviderInput(input: ProviderInput): { config: ProviderConfig; secret?: string } {
  if (!input.id.trim() || !input.displayName.trim()) throw new Error('提供商名称不能为空');
  if (input.authType !== 'api_key') throw new Error('当前版本仅支持 API Key');
  const compatible = input.kind === 'openai_compatible' || input.kind === 'anthropic_compatible';
  if (compatible && !input.baseURL) throw new Error('兼容服务必须配置 Base URL');
  if (!compatible && input.baseURL) throw new Error('标准提供商不能覆盖 Base URL');
  let baseURL: string | undefined;
  if (input.baseURL) {
    const url = new URL(input.baseURL);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && input.allowInsecureLocal === true)) {
      throw new Error(local ? '本地 HTTP 必须显式允许' : 'Base URL 必须使用 HTTPS');
    }
    if (url.username || url.password) throw new Error('Base URL 禁止包含用户名或密码');
    if (url.hash || url.search) throw new Error('Base URL 禁止包含 query 或 fragment');
    baseURL = url.toString().replace(/\/$/, '');
  }
  return {
    config: {
      id: input.id.trim(), kind: input.kind, displayName: input.displayName.trim(), enabled: input.enabled,
      priority: input.priority, authType: input.authType, credentialRef: `provider:${input.id.trim()}`,
      baseURL, revision: input.revision,
    },
    secret: input.apiKey?.trim() || undefined,
  };
}
```

Export this module from `packages/core/src/index.ts`. Do not remove or change Agent types in this task; the additive provider contract must leave the current application buildable.

`ProviderAuthenticator` is the reserved OAuth extension seam. Implement and register only an API-key authenticator in this goal; do not expose OAuth through IPC or UI.

- [ ] **Step 4: Run core tests**

Run: `pnpm --filter @ai-devflow/core test`

Expected: PASS with existing Agent tests unchanged.

- [ ] **Step 5: Commit the domain change**

```bash
git add packages/core/src/provider.ts packages/core/src/index.ts packages/core/src/__tests__/provider.test.ts
git commit -m "refactor(core): replace agent selection with provider contracts"
```

---

### Task 2: Add migration backup, schema v9, health, and attempt persistence

**Files:**
- Create: `packages/persistence/src/provider-health.ts`
- Create: `packages/persistence/src/execution-attempts.ts`
- Create: `packages/persistence/src/pi-only-migration-v9.ts`
- Create: `packages/persistence/src/__tests__/pi-migration.test.ts`
- Modify: `packages/persistence/src/db.ts`

**Interfaces:**
- Consumes: `ProviderHealth`, `FailureKind` from Task 1.
- Produces: `backupBeforeMigration()`, inactive `PI_ONLY_MIGRATION_V9`, `ProviderHealthRepo`, and `ExecutionAttemptsRepo`.
- Keeps: `MIGRATIONS` and `createRepositories()` unchanged until Task 9 activates the cutover atomically.

- [ ] **Step 1: Write migration and repository tests**

```ts
// packages/persistence/src/__tests__/pi-migration.test.ts
import { mkdtempSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db.js';
import { applyPiOnlyMigrationV9, backupBeforeMigration } from '../pi-only-migration-v9.js';
import { createExecutionAttemptsRepo } from '../execution-attempts.js';
import { createProviderHealthRepo } from '../provider-health.js';

describe('Pi-only schema migration', () => {
  it('backs up, removes legacy Agent columns, and cleans project settings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aidf-v9-'));
    const path = join(dir, 'app.db');
    const db = openDatabase(path);
    backupBeforeMigration(db, path, join(dir, 'backups'), 8, 123);
    applyPiOnlyMigrationV9(db);
    const taskColumns = db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>;
    const execColumns = db.prepare('PRAGMA table_info(execution_records)').all() as Array<{ name: string }>;
    expect(taskColumns.map((c) => c.name)).not.toContain('agent_type');
    expect(execColumns.map((c) => c.name)).not.toContain('agent_type');
    expect(readdirSync(join(dir, 'backups')).some((n) => n.endsWith('.db'))).toBe(true);
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
```

Import the `DatabaseSync` type from `../db.js`. Add a separate backup-retention case that calls `backupBeforeMigration()` four times with timestamps `100, 200, 300, 400` and asserts only the `200, 300, 400` files remain.

- [ ] **Step 2: Run the migration test and confirm failure**

Run: `pnpm --filter @ai-devflow/persistence exec vitest run src/__tests__/pi-migration.test.ts`

Expected: FAIL because the inactive v9 module and provider health repository are absent.

- [ ] **Step 3: Implement but do not register the v9 migration**

Export this migration from `packages/persistence/src/pi-only-migration-v9.ts`:

```ts
export const PI_ONLY_MIGRATION_V9 = {
  version: 9,
  description: 'pi-only runtime, provider health, and execution attempts',
  sql: `
    ALTER TABLE tasks DROP COLUMN agent_type;
    ALTER TABLE execution_records DROP COLUMN agent_type;
    UPDATE projects
      SET settings_json = json_remove(settings_json, '$.agentRoles', '$.roleConfigs')
      WHERE json_valid(settings_json) = 1;
    DELETE FROM credentials WHERE key = 'global_agent_config';
    CREATE TABLE provider_health (
      provider_id TEXT NOT NULL,
      route_id TEXT NOT NULL,
      state TEXT NOT NULL,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      cooldown_until INTEGER,
      last_failure_kind TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(provider_id, route_id)
    );
    CREATE TABLE execution_attempts (
      id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL REFERENCES execution_records(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      route_id TEXT NOT NULL,
      state TEXT NOT NULL,
      mutations_observed INTEGER NOT NULL DEFAULT 0,
      journal_json TEXT NOT NULL DEFAULT '{}',
      started_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    CREATE INDEX idx_execution_attempts_execution ON execution_attempts(execution_id, ordinal);
  `,
};

export function applyPiOnlyMigrationV9(db: DatabaseSync): void {
  db.exec('BEGIN');
  try {
    db.exec(PI_ONLY_MIGRATION_V9.sql);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
```

`backupBeforeMigration()` queries `sqlite_version()` and rejects values below `3.35.0`, then runs `VACUUM INTO ?` into `<backupDir>/schema-v<old>-<timestamp>.db`. Do not call this function from `openDatabase()` yet. Keep the newest three backup files by parsed timestamp.

- [ ] **Step 4: Implement standalone repositories without changing the aggregate**

Use these public repository shapes:

```ts
export interface ProviderHealthRepo {
  get(providerId: string, routeId: string): ProviderHealth | undefined;
  listByProvider(providerId: string): ProviderHealth[];
  upsert(value: ProviderHealth): void;
  clearProvider(providerId: string): void;
}
export interface ExecutionAttemptRecord {
  id: string; executionId: string; ordinal: number; routeId: string;
  state: 'running' | 'succeeded' | 'failed' | 'canceled';
  mutationsObserved: boolean; journalJson: string; startedAt: number; endedAt?: number;
}
export interface ExecutionAttemptsRepo {
  create(value: ExecutionAttemptRecord): void;
  updateJournal(id: string, journalJson: string, mutationsObserved: boolean): void;
  finish(id: string, state: 'succeeded' | 'failed' | 'canceled', endedAt: number): void;
  listByExecution(executionId: string): ExecutionAttemptRecord[];
}
```

Export `createProviderHealthRepo(db)` and `createExecutionAttemptsRepo(db)` from their files. Do not add them to `createRepositories()` and do not remove Agent columns in this task; Task 9 performs those changes in the same commit that switches the scheduler.

- [ ] **Step 5: Run persistence tests**

Run: `pnpm --filter @ai-devflow/persistence exec vitest run src/__tests__/pi-migration.test.ts`

Expected: PASS for explicit v8-to-v9 migration, backup retention, health, attempt journal, rollback, and repeated `applyPiOnlyMigrationV9()` rejection without corrupting the source database.

- [ ] **Step 6: Commit persistence changes**

```bash
git add packages/persistence/src/provider-health.ts packages/persistence/src/execution-attempts.ts packages/persistence/src/pi-only-migration-v9.ts packages/persistence/src/db.ts packages/persistence/src/__tests__/pi-migration.test.ts
git commit -m "feat(persistence): migrate to pi-only execution records"
```

---

### Task 3: Add encrypted ordered provider storage and legacy credential migration

**Files:**
- Create: `apps/desktop/electron/provider-store.ts`
- Create: `apps/desktop/electron/__tests__/provider-store.test.ts`
- Modify: `apps/desktop/electron/credentials.ts`

**Interfaces:**
- Consumes: provider contracts from Task 1 and `Repositories` from Task 2.
- Produces: `ProviderStore.list()`, `save()`, `remove()`, `reorder()`, `resolveSecret()`, `migrateLegacy()`.

- [ ] **Step 1: Write red tests for encryption, sanitization, reorder, and legacy migration**

```ts
// apps/desktop/electron/__tests__/provider-store.test.ts
import { describe, expect, it } from 'vitest';
import { ProviderStore } from '../provider-store.js';

it('never returns the saved key and preserves order', () => {
  const harness = makeProviderStoreHarness();
  harness.store.save({
    id: 'p1', kind: 'openai', displayName: 'OpenAI', enabled: true,
    priority: 0, authType: 'api_key', apiKey: 'sk-secret', revision: 1,
  });
  expect(harness.store.list()).toEqual([expect.objectContaining({ id: 'p1', hasCredential: true })]);
  expect(JSON.stringify(harness.store.list())).not.toContain('sk-secret');
  expect(harness.store.resolveSecret('p1')).toBe('sk-secret');
});

it('migrates credentials.ai_provider once and discards its model', () => {
  const harness = makeProviderStoreHarness();
  harness.credentials.upsert('ai_provider', harness.encrypt(JSON.stringify({
    provider: 'anthropic', apiKey: 'legacy', baseURL: 'https://api.anthropic.com', model: 'ignored',
  })));
  harness.store.migrateLegacy();
  expect(harness.store.list()).toEqual([expect.objectContaining({ kind: 'anthropic', priority: 0 })]);
  expect(harness.credentials.get('ai_provider')).toBeUndefined();
  harness.store.migrateLegacy();
  expect(harness.store.list()).toHaveLength(1);
});

it('fails closed when secure encryption is unavailable', () => {
  const harness = makeProviderStoreHarness({ encryptThrows: true });
  expect(() => harness.store.save({
    id: 'p1', kind: 'openai', displayName: 'OpenAI', enabled: true,
    priority: 0, authType: 'api_key', apiKey: 'sk-secret', revision: 1,
  })).toThrow(/安全存储不可用/);
  expect(harness.store.list()).toEqual([]);
});
```

Define `makeProviderStoreHarness()` in the same test file with an in-memory credentials map and reversible `enc:` test cipher; it must not use Electron safeStorage in Vitest.

```ts
function makeProviderStoreHarness(opts: { encryptThrows?: boolean } = {}) {
  const values = new Map<string, string>();
  const credentials = {
    get: (key: string) => values.get(key),
    upsert: (key: string, value: string) => { values.set(key, value); },
    delete: (key: string) => { values.delete(key); },
    transaction: <T>(fn: () => T) => fn(),
  };
  const encrypt = (value: string) => {
    if (opts.encryptThrows) throw new Error('安全存储不可用');
    return `enc:${Buffer.from(value).toString('base64')}`;
  };
  const decrypt = (value: string) => Buffer.from(value.slice(4), 'base64').toString();
  const store = new ProviderStore(credentials, { encrypt, decrypt }, () => undefined);
  return { store, credentials, encrypt, decrypt };
}
```

- [ ] **Step 2: Run the test and confirm missing store failure**

Run: `pnpm --filter @ai-devflow/desktop exec vitest run electron/__tests__/provider-store.test.ts`

Expected: FAIL because `provider-store.ts` does not exist.

- [ ] **Step 3: Implement ProviderStore**

```ts
export class ProviderStore {
  constructor(
    private credentials: {
      get(k: string): string | undefined;
      upsert(k: string, v: string): void;
      delete(k: string): void;
      transaction<T>(fn: () => T): T;
    },
    private crypto: { encrypt(v: string): string; decrypt(v: string): string },
    private clearHealth: (providerId: string) => void,
  ) {}

  list(): ProviderSummary[];
  listConfigs(): ProviderConfig[];
  save(input: ProviderInput): ProviderSummary;
  remove(id: string): void;
  reorder(ids: string[]): void;
  resolveSecret(id: string): string | undefined;
  migrateLegacy(): void;
}
```

Store sanitized metadata as encrypted JSON under `providers:v1` and each key under `provider-secret:<id>`. Wrap metadata/key save, remove, reorder, and legacy migration writes in `credentials.transaction()`. On save, increment revision when kind, Base URL, credential, or enabled state changes and call `clearHealth(id)` after commit. `reorder()` must reject missing, duplicate, or foreign IDs and write contiguous priorities `0..n-1`. `migrateLegacy()` writes `provider-migration:v1` only after new records are durable, then deletes `ai_provider` in the same transaction.

Add strict provider helpers in `credentials.ts`: `encryptProviderSecret()` throws when `safeStorage.isEncryptionAvailable()` is false or Linux reports the `basic_text` backend, and otherwise always returns `enc:` data; `decryptProviderSecret()` accepts only `enc:`. Keep any legacy base64 decoder private to `migrateLegacy()`: when secure storage is available it may decode the old value and immediately re-encrypt it, but when unavailable migration preserves the old ciphertext, creates no provider record/marker, and returns a sanitized “请重新输入密钥” status. Never create a new `b64:` provider credential.

- [ ] **Step 4: Run provider-store and desktop credential tests**

Run: `pnpm --filter @ai-devflow/desktop exec vitest run electron/__tests__/provider-store.test.ts`

Expected: PASS; existing IPC and service composition remain unchanged in this additive task.

- [ ] **Step 5: Commit the store**

```bash
git add apps/desktop/electron/provider-store.ts apps/desktop/electron/credentials.ts apps/desktop/electron/__tests__/provider-store.test.ts
git commit -m "feat(desktop): store ordered encrypted providers"
```

---

### Task 4: Implement route resolution and circuit-breaker failover

**Files:**
- Create: `packages/agents/src/provider-router.ts`
- Create: `packages/agents/src/__tests__/provider-router.test.ts`
- Modify: `packages/agents/src/index.ts`

**Interfaces:**
- Consumes: `ProviderConfig`, `ProviderHealth`, `FailureKind`, `Workload`; structural `ProviderHealthStore`; `resolveSecret(providerId)`.
- Produces: `ProviderRoute`, `ProviderExecutionError`, `classifyProviderFailure()`, `ProviderRouter.routesFor()`, `ProviderRouter.execute()`.

- [ ] **Step 1: Write failover state-machine tests**

```ts
import { describe, expect, it } from 'vitest';
import { ProviderExecutionError, ProviderRouter } from '../provider-router.js';

it('tries same-provider fallback before the next provider', async () => {
  const harness = makeRouterHarness(['p1', 'p2']);
  const visited: string[] = [];
  const value = await harness.router.execute('coder', async (route) => {
    visited.push(route.routeId);
    if (visited.length < 3) throw new ProviderExecutionError('model unavailable', 'model_unavailable', 404);
    return 'ok';
  });
  expect(value).toBe('ok');
  expect(visited).toEqual(['p1:coder:primary', 'p1:coder:fallback', 'p2:coder:primary']);
});

it('opens authentication failures until provider revision changes', async () => {
  const harness = makeRouterHarness(['p1', 'p2']);
  await harness.router.execute('tester', async (route) => {
    if (route.providerId === 'p1') throw new ProviderExecutionError('unauthorized', 'authentication', 401);
    return 'ok';
  });
  expect(harness.health.get('p1', 'p1:tester:primary')?.state).toBe('open');
});

it('never exceeds eight operation calls', async () => {
  const harness = makeRouterHarness(['p1', 'p2', 'p3', 'p4', 'p5']);
  let calls = 0;
  await expect(harness.router.execute('planner', async () => {
    calls += 1;
    throw new ProviderExecutionError('offline', 'transient_provider', 503);
  })).rejects.toThrow(/所有已配置 AI 服务/);
  expect(calls).toBeLessThanOrEqual(8);
});
```

Add this complete in-memory harness below the tests:

```ts
function makeRouterHarness(ids: string[]) {
  const providers = ids.map((id, priority) => ({
    id, kind: 'openai' as const, displayName: id, enabled: true, priority,
    authType: 'api_key' as const, credentialRef: `provider:${id}`, revision: 1,
  }));
  const values = new Map<string, ProviderHealth>();
  const key = (providerId: string, routeId: string) => `${providerId}\0${routeId}`;
  const health = {
    get: (providerId: string, routeId: string) => values.get(key(providerId, routeId)),
    listByProvider: (providerId: string) => [...values.values()].filter((v) => v.providerId === providerId),
    upsert: (value: ProviderHealth) => { values.set(key(value.providerId, value.routeId), value); },
    clearProvider: (providerId: string) => {
      for (const [entryKey, value] of values) if (value.providerId === providerId) values.delete(entryKey);
    },
  };
  const router = new ProviderRouter({
    listProviders: () => providers,
    resolveSecret: () => 'secret',
    health,
    now: () => 1_000,
    sleep: async () => undefined,
  });
  return { router, health };
}
```

- [ ] **Step 2: Run router tests and confirm red state**

Run: `pnpm --filter @ai-devflow/agents exec vitest run src/__tests__/provider-router.test.ts`

Expected: FAIL because the router is absent.

- [ ] **Step 3: Implement exact route and error contracts**

```ts
export interface ModelChoice { model: string; thinking: 'low' | 'medium' | 'high' | 'xhigh' }
export interface ProviderRoute {
  providerId: string; providerKind: ProviderKind; providerName: string; routeId: string;
  model: string; thinking: ModelChoice['thinking']; baseURL?: string; secret: string;
}
export class ProviderExecutionError extends Error {
  constructor(message: string, readonly kind: FailureKind, readonly status = 0, readonly retryAfterMs?: number) {
    super(message);
  }
}
export interface ProviderHealthStore {
  get(providerId: string, routeId: string): ProviderHealth | undefined;
  listByProvider(providerId: string): ProviderHealth[];
  upsert(value: ProviderHealth): void;
  clearProvider(providerId: string): void;
}
export class ProviderRouter {
  constructor(deps: {
    listProviders(): ProviderConfig[];
    resolveSecret(providerId: string): string | undefined;
    health: ProviderHealthStore;
    now(): number;
    sleep(ms: number): Promise<void>;
  });
  routesFor(workload: Workload, now?: number): ProviderRoute[];
  execute<T>(
    workload: Workload,
    operation: (route: ProviderRoute, ordinal: number) => Promise<T>,
    options?: { onlyProviderId?: string },
  ): Promise<T>;
}
```

Encode this exact immutable model table in `provider-router.ts`:

| Provider | planner | coder | reviewer | tester |
| --- | --- | --- | --- | --- |
| anthropic | `claude-sonnet-5` high / `claude-sonnet-4-6` high | `claude-sonnet-5` xhigh / `claude-sonnet-4-6` high | `claude-sonnet-5` high / `claude-sonnet-4-6` high | `claude-sonnet-4-6` medium / `claude-sonnet-4-5` medium |
| openai | `gpt-5.6-terra` high / `gpt-5.4` high | `gpt-5.6-sol` xhigh / `gpt-5.6-terra` high | `gpt-5.6-terra` high / `gpt-5.4` high | `gpt-5.6-luna` medium / `gpt-5.4-mini` medium |
| google | `gemini-3.1-pro-preview` high / `gemini-2.5-pro` high | `gemini-3.1-pro-preview` high / `gemini-2.5-pro` high | `gemini-3.1-pro-preview` high / `gemini-2.5-pro` medium | `gemini-3.5-flash` medium / `gemini-2.5-flash` medium |
| deepseek | `deepseek-v4-pro` high / `deepseek-v4-flash` medium | `deepseek-v4-pro` high / `deepseek-v4-flash` high | `deepseek-v4-pro` high / `deepseek-v4-flash` medium | `deepseek-v4-flash` medium / none |
| openrouter | `anthropic/claude-sonnet-5` high / `anthropic/claude-sonnet-4.6` high | `openai/gpt-5.6-sol` xhigh / `anthropic/claude-sonnet-5` high | `anthropic/claude-sonnet-4.6` high / `openai/gpt-5.6-terra` high | `deepseek/deepseek-v4-flash` medium / `google/gemini-3.5-flash` medium |

`openai_compatible` reuses the OpenAI row and `anthropic_compatible` reuses the Anthropic row. Standard routes set `providerName` to the Pi catalog provider name; compatible routes set it to `ai-devflow-<first-12-sha256(providerId)>`. Chat workloads use tester primary/fallback; proposal workloads use planner primary/fallback. `routesFor()` sorts enabled configs by priority, emits primary then fallback, skips missing secrets and open routes, and allows only the earliest half-open route when every route is cooling down. `execute()` retries a transient/runtime/protocol route once, never retries authentication/model-unavailable routes, honors `retryAfterMs`, updates persistent health, and stops after eight operation calls.

Use these deterministic breaker rules: authentication and model-unavailable stay open until provider revision changes; rate-limit cooldown uses `Retry-After` clamped to 1 second–15 minutes or exponential `60s * 2^(failures-1)` capped at 15 minutes; transient/runtime/protocol cooldown uses `5s * 2^(failures-1)` capped at 2 minutes. A successful route resets its row to closed/zero. Keep an in-memory `halfOpenInFlight` set so only one probe per route runs at a time. `classifyProviderFailure()` maps 401/403 or missing key to authentication, 429/quota text to rate-limit, DNS/connect/timeout/5xx to transient, 404 or model-not-found/unsupported text to model-unavailable, malformed/missing JSON events to protocol, and Pi spawn/exit failure to runtime; tool/test/review failures remain task-result and never trigger provider failover.

Keep `ProviderHealthStore` in `packages/agents`; do not import the persistence package. The Task 2 repository satisfies this interface structurally and is injected by Electron in Task 9.

- [ ] **Step 4: Run router tests**

Run: `pnpm --filter @ai-devflow/agents exec vitest run src/__tests__/provider-router.test.ts`

Expected: PASS with route order and maximum-attempt assertions.

- [ ] **Step 5: Commit routing**

```bash
git add packages/agents/src/provider-router.ts packages/agents/src/__tests__/provider-router.test.ts packages/agents/src/index.ts
git commit -m "feat(agents): add provider routing and circuit breaking"
```

---

### Task 5: Stage and verify the exact bundled Pi runtime

**Files:**
- Create: `packages/pi-runtime-bundle/package.json`
- Create: `apps/desktop/scripts/stage-pi-runtime.mjs`
- Create: `packages/agents/src/runtime-locator.ts`
- Create: `packages/agents/src/__tests__/runtime-locator.test.ts`
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/build-electron.mjs`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces: `PiRuntimeManifest`, `BundledPiLocator.verify()`, `BundledPiLocator.command()`.
- Consumes: Electron `resourcesPath` supplied by composition root; no PATH input.

- [ ] **Step 1: Write locator tests against a synthetic manifest**

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { BundledPiLocator } from '../runtime-locator.js';

it('returns an absolute verified entry and never consults PATH', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-runtime-'));
  mkdirSync(join(root, 'package'), { recursive: true });
  writeFileSync(join(root, 'package', 'cli.js'), 'console.log("0.80.10")');
  writeRuntimeManifest(root, 'package/cli.js', '0.80.10');
  const locator = new BundledPiLocator(root, { execFile: fakeVersionExec });
  const command = await locator.command();
  expect(command.entry).toBe(join(root, 'package', 'cli.js'));
  expect(command.version).toBe('0.80.10');
});

it('rejects a checksum mismatch instead of falling back', async () => {
  const root = makeCorruptRuntimeFixture();
  await expect(new BundledPiLocator(root).verify()).rejects.toThrow(/校验失败/);
});
```

Implement `writeRuntimeManifest`, `fakeVersionExec`, and `makeCorruptRuntimeFixture` in the same test file using SHA-256 from `node:crypto`.

```ts
function writeRuntimeManifest(root: string, entry: string, version: string) {
  const absolute = join(root, entry);
  const digest = createHash('sha256').update(readFileSync(absolute)).digest('hex');
  writeFileSync(join(root, 'runtime-manifest.json'), JSON.stringify({
    schemaVersion: 1, piVersion: version, entry, files: { [entry]: digest },
  }));
}
const fakeVersionExec = async () => ({ stdout: '0.80.10\n', stderr: '', exitCode: 0 });
function makeCorruptRuntimeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'pi-runtime-corrupt-'));
  mkdirSync(join(root, 'package'), { recursive: true });
  writeFileSync(join(root, 'package', 'cli.js'), 'changed');
  writeFileSync(join(root, 'runtime-manifest.json'), JSON.stringify({
    schemaVersion: 1, piVersion: '0.80.10', entry: 'package/cli.js',
    files: { 'package/cli.js': '0'.repeat(64) },
  }));
  return root;
}
```

- [ ] **Step 2: Run locator tests and confirm red state**

Run: `pnpm --filter @ai-devflow/agents exec vitest run src/__tests__/runtime-locator.test.ts`

Expected: FAIL because locator and manifest do not exist.

- [ ] **Step 3: Add the dedicated runtime package and staging script**

```json
// packages/pi-runtime-bundle/package.json
{
  "name": "@ai-devflow/pi-runtime-bundle",
  "version": "0.0.0",
  "private": true,
  "dependencies": {
    "@earendil-works/pi-coding-agent": "0.80.10"
  }
}
```

`stage-pi-runtime.mjs` must remove only `apps/desktop/build/pi-runtime`, run `pnpm --filter @ai-devflow/pi-runtime-bundle deploy --prod apps/desktop/build/pi-runtime`, resolve the deployed package's `bin.pi`, hash every staged file in sorted relative-path order, and write:

```json
{
  "schemaVersion": 1,
  "piVersion": "0.80.10",
  "entry": "node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
  "profilesDigest": null,
  "files": { "relative/path": "sha256-hex" }
}
```

At Task 5 the profile directory does not exist yet, so the additive staging step emits `profilesDigest:null`. As soon as `packages/agents/assets/profiles` exists (Task 6 onward), staging must copy it to `profiles/`, compute a digest over all role files, and reject an empty/incomplete role set. Give `BundledPiLocator` an explicit `requireProfiles` option that defaults to `false` for the additive Task 5 locator test; `PiRunner` and every production composition in Task 8 onward construct it with `requireProfiles:true`, requiring a non-null digest and all four roles.

Do not use a shell, network install, or user-global pnpm store mutation during application startup.

- [ ] **Step 4: Wire packaging**

Add `stage:pi`. Make `build` run `stage:pi` before the current Renderer/Electron builds; make `package`, `release`, and `dist` run `build` before electron-builder. Add electron-builder `extraResources` from `build/pi-runtime` to `pi-runtime`. Keep runtime files outside ASAR.

- [ ] **Step 5: Stage and verify**

Run: `pnpm --filter @ai-devflow/desktop stage:pi && pnpm --filter @ai-devflow/agents exec vitest run src/__tests__/runtime-locator.test.ts`

Expected: stage manifest reports `0.80.10`; locator tests PASS. The test also executes the staged entry with Pi's offline `--list-models` command and asserts every standard-provider model/thinking pair from Task 4 exists and supports tools; missing capabilities fail the build rather than changing the table at runtime.

- [ ] **Step 6: Commit runtime packaging**

```bash
git add packages/pi-runtime-bundle packages/agents/src/runtime-locator.ts packages/agents/src/__tests__/runtime-locator.test.ts apps/desktop/scripts/stage-pi-runtime.mjs apps/desktop/package.json apps/desktop/build-electron.mjs pnpm-lock.yaml
git commit -m "build: bundle and verify pi 0.80.10"
```

---

### Task 6: Materialize role profiles and build isolated run plans

**Files:**
- Create: `packages/agents/src/profiles.ts`
- Create: `packages/agents/src/run-plan.ts`
- Create: `packages/agents/src/project-instructions.ts`
- Create: `packages/agents/src/__tests__/run-plan.test.ts`
- Create: `packages/agents/src/__tests__/project-instructions.test.ts`
- Create: `packages/agents/assets/profiles/planner/settings.json`
- Create: `packages/agents/assets/profiles/coder/settings.json`
- Create: `packages/agents/assets/profiles/reviewer/settings.json`
- Create: `packages/agents/assets/profiles/tester/settings.json`
- Create: `packages/agents/assets/profiles/{planner,coder,reviewer,tester}/SYSTEM.md`
- Create: `packages/agents/assets/profiles/planner/skills/requirements-analysis/SKILL.md`
- Create: `packages/agents/assets/profiles/planner/skills/design-writing/SKILL.md`
- Create: `packages/agents/assets/profiles/planner/skills/implementation-planning/SKILL.md`
- Create: `packages/agents/assets/profiles/coder/skills/test-driven-development/SKILL.md`
- Create: `packages/agents/assets/profiles/coder/skills/systematic-debugging/SKILL.md`
- Create: `packages/agents/assets/profiles/coder/skills/verification/SKILL.md`
- Create: `packages/agents/assets/profiles/reviewer/skills/code-review/SKILL.md`
- Create: `packages/agents/assets/profiles/reviewer/skills/security-review/SKILL.md`
- Create: `packages/agents/assets/profiles/reviewer/skills/regression-review/SKILL.md`
- Create: `packages/agents/assets/profiles/tester/skills/test-design/SKILL.md`
- Create: `packages/agents/assets/profiles/tester/skills/failure-analysis/SKILL.md`
- Create: `packages/agents/assets/profiles/tester/skills/acceptance-verification/SKILL.md`

**Interfaces:**
- Consumes: `ProviderRoute`, verified runtime root, `TaskRole`, execution/attempt IDs.
- Produces: `RoleProfileRegistry`, `ProfileMaterializer`, `ProjectInstructionLoader`, `buildPiRunPlan()`.

- [ ] **Step 1: Write isolation and exact-argument tests**

```ts
import { expect, it } from 'vitest';
import { buildPiRunPlan } from '../run-plan.js';

it('builds coder args from an explicit profile and clean environment', () => {
  const plan = buildPiRunPlan(makeRunPlanFixture({ role: 'coder', executionId: 'e1', attemptId: 'a1' }));
  expect(plan.args).toContain('--mode');
  expect(plan.args).toContain('json');
  expect(plan.args).toContain('--no-extensions');
  expect(plan.args).toContain('--no-skills');
  expect(plan.args).toContain('--no-context-files');
  expect(plan.args).toContain('--no-approve');
  expect(valueAfter(plan.args, '--tools')).toBe('read,bash,edit,write,grep,find,ls,ai_devflow_interaction,ai_devflow_report_result');
  expect(plan.env.PI_CODING_AGENT_DIR).toMatch(/coder/);
  expect(plan.env.PI_CODING_AGENT_SESSION_DIR).toMatch(/e1.*a1/);
  expect(plan.env.OPENAI_API_KEY).toBe('route-secret');
  expect(plan.env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(plan.env.DEV_API_KEY).toBeUndefined();
  expect(plan.env.NODE_OPTIONS).toBeUndefined();
});

it('gives concurrent attempts different session directories', () => {
  const one = buildPiRunPlan(makeRunPlanFixture({ role: 'tester', executionId: 'e1', attemptId: 'a1' }));
  const two = buildPiRunPlan(makeRunPlanFixture({ role: 'tester', executionId: 'e1', attemptId: 'a2' }));
  expect(one.env.PI_CODING_AGENT_SESSION_DIR).not.toBe(two.env.PI_CODING_AGENT_SESSION_DIR);
});

it('writes a compatible snapshot that references an environment variable only', () => {
  const fixture = makeRunPlanFixture({ role: 'coder', executionId: 'e1', attemptId: 'a1' });
  fixture.route = {
    ...fixture.route,
    providerKind: 'openai_compatible', providerName: 'ai-devflow-0123456789ab',
    baseURL: 'https://gateway.example/v1',
  };
  const plan = buildPiRunPlan(fixture);
  expect(plan.env.AI_DEVFLOW_ACTIVE_API_KEY).toBe('route-secret');
  expect(plan.modelsJson).toContain('AI_DEVFLOW_ACTIVE_API_KEY');
  expect(plan.modelsJson).not.toContain('route-secret');
  expect(valueAfter(plan.args, '--provider')).toBe('ai-devflow-0123456789ab');
});

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function makeRunPlanFixture(ids: { role: TaskRole; executionId: string; attemptId: string }): PiRunPlanInput {
  return {
    runtimeEntry: '/app/resources/pi-runtime/cli.js',
    profileDir: `/userData/pi-runtime/profiles/digest/${ids.role}`,
    sessionDir: `/userData/pi-runtime/sessions/${ids.executionId}/${ids.attemptId}`,
    isolatedHome: `/userData/pi-runtime/sessions/${ids.executionId}/${ids.attemptId}/home`,
    tempDir: `/userData/pi-runtime/sessions/${ids.executionId}/${ids.attemptId}/tmp`,
    executionId: ids.executionId,
    attemptId: ids.attemptId,
    role: ids.role,
    initialMessage: 'fixture prompt',
    route: {
      providerId: 'p1', providerKind: 'openai', providerName: 'openai', routeId: `p1:${ids.role}:primary`,
      model: 'gpt-5.6-sol', thinking: 'high', secret: 'route-secret',
    },
    projectToolPath: '/usr/local/bin:/usr/bin:/bin',
  };
}
```

- [ ] **Step 2: Run run-plan tests and confirm red state**

Run: `pnpm --filter @ai-devflow/agents exec vitest run src/__tests__/run-plan.test.ts`

Expected: FAIL because profiles and run-plan modules are absent.

- [ ] **Step 3: Add exact role settings and prompts**

Every role `settings.json` must contain:

```json
{
  "defaultProjectTrust": "never",
  "enableInstallTelemetry": false,
  "retry": { "enabled": false, "maxRetries": 0, "provider": { "maxRetries": 0 } },
  "enableSkillCommands": false,
  "packages": [],
  "extensions": [],
  "skills": [],
  "prompts": [],
  "themes": []
}
```

Write each `SYSTEM.md` with: role purpose, allowed write scope, required verification, mandatory use of `ai_devflow_interaction` for blockers, mandatory final `ai_devflow_report_result`, and prohibition on changing credentials/runtime policy. Reviewer prompt must explicitly forbid writes; tester prompt must restrict writes to tests/fixtures unless task text grants broader scope.

Encode this role registry exactly:

| Role | Built-in tools before internal tools | Explicit exclusions | Timeout |
| --- | --- | --- | --- |
| planner | `read,grep,find,ls,write,edit` | `bash` | 20 minutes |
| coder | `read,bash,edit,write,grep,find,ls` | none | 45 minutes |
| reviewer | `read,bash,grep,find,ls` | `edit,write` | 15 minutes |
| tester | `read,bash,grep,find,ls,write,edit` | none | 30 minutes |

Append `ai_devflow_interaction,ai_devflow_report_result` to every role's `--tools` value. Skill paths are exactly the files listed in this task; shared extension paths are exactly the four files created in Task 7. No role may discover another role's resources.

Add `project-instructions.test.ts`: create nested root/package directories containing distinct `AGENTS.md` files plus a `CLAUDE.md`; call `ProjectInstructionLoader.load(repoRoot, packageDir)` and assert root-to-leaf AGENTS ordering, no Claude content, rejection when `cwd` escapes `repoRoot`, an eight-file limit, a 64 KiB per-file limit, and a 256 KiB total limit. The loader returns a delimited string labeled as untrusted project instructions; `buildPiRunPlan()` places it in the initial message before the task request, while role `SYSTEM.md` remains the higher-priority system policy. Pi remains on `--no-context-files`, so this is the only project-instruction path.

- [ ] **Step 4: Implement materialization and run-plan construction**

`ProfileMaterializer.materialize({ role, providerId, providerKind, providerRevision, baseURL })` copies verified read-only assets into a content-addressed directory using a temporary sibling and atomic rename. For compatible providers it writes `models.json` with the generated `providerName`, approved hidden model IDs, Base URL, and `apiKey` set to the literal environment-variable name `AI_DEVFLOW_ACTIVE_API_KEY`; no secret bytes enter the snapshot. `buildPiRunPlan()` emits the exact CLI sequence in spec section 7.5, omits `--exclude-tools` when empty, and constructs `env` from an allowlist instead of spreading `process.env`: isolated `HOME`/`USERPROFILE`, isolated temp variables, sanitized project-toolchain `PATH`, Windows `SystemRoot`/`ComSpec`/`PATHEXT` when present, locale variables, non-secret `AI_DEVFLOW_ROLE/EXECUTION_ID/ATTEMPT_ID/WORKTREE/CHECKPOINT_PATH`, `ELECTRON_RUN_AS_NODE=1`, `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0`, and only the active provider key (`AI_DEVFLOW_ACTIVE_API_KEY` for compatible routes). Other `PI_*`, all provider keys, `DEV_API_*`, `NODE_OPTIONS`, `NODE_PATH`, `NPM_CONFIG_*`, and the user's actual home/temp paths never enter the child unless set to the isolated values.

Define `PiRunPlanInput` with exactly the properties used by `makeRunPlanFixture()` and return `{ command: process.execPath, args: string[], env: Record<string,string>, initialMessage: string, modelsJson?: string }`. `modelsJson` is returned only for test inspection; production writes it through `ProfileMaterializer` and passes only its containing config directory to Pi.

- [ ] **Step 5: Run run-plan and agents tests**

Run: `pnpm --filter @ai-devflow/desktop stage:pi && pnpm --filter @ai-devflow/agents test`

Expected: PASS; staged manifest now has a non-null profiles digest and no test resolves an external CLI.

- [ ] **Step 6: Commit role profiles**

```bash
git add packages/agents/assets packages/agents/src/profiles.ts packages/agents/src/run-plan.ts packages/agents/src/project-instructions.ts packages/agents/src/__tests__/run-plan.test.ts packages/agents/src/__tests__/project-instructions.test.ts
git commit -m "feat(agents): add isolated built-in pi role profiles"
```

---

### Task 7: Add internal Pi extensions, JSON translation, and attempt journals

**Files:**
- Create: `packages/agents/assets/profiles/shared/extensions/event-bridge.ts`
- Create: `packages/agents/assets/profiles/shared/extensions/execution-policy.ts`
- Create: `packages/agents/assets/profiles/shared/extensions/structured-result.ts`
- Create: `packages/agents/assets/profiles/shared/extensions/checkpoint-context.ts`
- Create: `packages/agents/src/json-events.ts`
- Create: `packages/agents/src/attempt-journal.ts`
- Create: `packages/agents/src/__tests__/json-events.test.ts`

**Interfaces:**
- Consumes: Pi 0.80.10 extension API and official JSON event shapes; structural `ExecutionAttemptStore`.
- Produces: `translatePiLine()`, `AttemptJournalWriter`, internal tool schemas.

Define `ExecutionAttemptStore` next to `AttemptJournalWriter` with only `create`, `updateJournal`, and `finish` methods. Do not import `packages/persistence`; its Task 2 repository must satisfy this narrow interface structurally.

- [ ] **Step 1: Write JSONL translation tests**

```ts
import { expect, it } from 'vitest';
import { createPiEventTranslator } from '../json-events.js';

it('tracks a tool from start through completion and emits a file change', () => {
  const translator = createPiEventTranslator({ executionId: 'e1', attemptId: 'a1' });
  translator.push(JSON.stringify({ type: 'tool_execution_start', toolCallId: 'tc1', toolName: 'write', args: { path: 'src/a.ts', content: 'x' } }));
  const events = translator.push(JSON.stringify({ type: 'tool_execution_end', toolCallId: 'tc1', toolName: 'write', result: { content: [] }, isError: false }));
  expect(events).toContainEqual(expect.objectContaining({ type: 'file_change', path: 'src/a.ts', action: 'modify' }));
  expect(translator.journal().toolCalls[0]?.state).toBe('completed');
});

it('marks a started tool uncertain when the stream ends', () => {
  const translator = createPiEventTranslator({ executionId: 'e1', attemptId: 'a1' });
  translator.push(JSON.stringify({ type: 'tool_execution_start', toolCallId: 'tc1', toolName: 'bash', args: { command: 'pnpm test' } }));
  translator.finish();
  expect(translator.journal().toolCalls[0]?.state).toBe('uncertain');
});

it('rejects success without a valid ai_devflow_report_result payload', () => {
  const translator = createPiEventTranslator({ executionId: 'e1', attemptId: 'a1' });
  translator.push(JSON.stringify({ type: 'agent_end', messages: [] }));
  expect(() => translator.finish()).toThrow(/结构化结果/);
});

it('redacts the active route secret before emitting or journaling', () => {
  const translator = createPiEventTranslator({ executionId: 'e1', attemptId: 'a1', secrets: ['route-secret'] });
  const events = translator.push(JSON.stringify({ type: 'message_update', delta: 'never route-secret here' }));
  expect(JSON.stringify(events)).not.toContain('route-secret');
  expect(JSON.stringify(translator.journal())).not.toContain('route-secret');
});
```

- [ ] **Step 2: Run translation tests and confirm red state**

Run: `pnpm --filter @ai-devflow/agents exec vitest run src/__tests__/json-events.test.ts`

Expected: FAIL because translator and journal modules are absent.

- [ ] **Step 3: Implement the two internal tool schemas**

`event-bridge.ts` must register:

```ts
pi.registerTool({
  name: 'ai_devflow_interaction',
  label: 'Request user interaction',
  description: 'Pause for a required clarification or confirmation.',
  parameters: Type.Object({
    kind: Type.Union([Type.Literal('clarification'), Type.Literal('confirmation')]),
    title: Type.String(),
    detail: Type.String(),
  }),
  async execute(_id, input) {
    return { content: [{ type: 'text', text: JSON.stringify({ aiDevflowInteraction: input }) }], details: input };
  },
});
pi.registerTool({
  name: 'ai_devflow_report_result',
  label: 'Report final result',
  description: 'Report the verified final result exactly once.',
  parameters: Type.Object({
    summary: Type.String(),
    verification: Type.Array(Type.String()),
    changedFiles: Type.Array(Type.String()),
    unresolved: Type.Array(Type.String()),
  }),
  async execute(_id, input) {
    return { content: [{ type: 'text', text: JSON.stringify({ aiDevflowResult: input }) }], details: input };
  },
});
```

`execution-policy.ts` canonicalizes every edit/write path with `realpath` of the nearest existing parent and blocks anything outside `AI_DEVFLOW_WORKTREE`, symlink escapes, `.env*`, credential stores, the staged runtime, and profile/session policy files. It blocks recursive deletion and system/global package installation for every role. For reviewer it blocks edit/write tools entirely and accepts bash only when the first command is in the read/verification allowlist (`git diff/status/show/log/grep`, `rg`, `grep`, `find`, `ls`, `pwd`, or a package test command); reject redirection, command substitution, backgrounding, command chaining, `tee`, mutation Git commands, package install/publish, and shell/interpreter escape commands. Record tracked-file hashes before and after reviewer bash and fail the attempt if they change. Return stable block reasons so translator maps policy failures to task-result rather than provider failure.

`structured-result.ts` tracks `ai_devflow_report_result` calls, rejects a second call, validates the exact summary/verification/changedFiles/unresolved schema, and emits a stable extension diagnostic when `agent_end` occurs without one; the Main translator remains the final authority. `checkpoint-context.ts` reads only the path in `AI_DEVFLOW_CHECKPOINT_PATH`, requires it to be inside the attempt session, caps it at 256 KiB, validates `{ completed, incomplete, uncertain, changedFiles, diffSummary, checkpoint }`, and injects that data on `before_agent_start`. `PiRunner` writes this JSON with mode `0600` before spawning; a new attempt never reads a prior Pi private session.

- [ ] **Step 4: Implement bounded JSONL parsing and persistent journal writes**

Parse one line at a time with a maximum 2 MiB line and 8 MiB stderr ring buffer. Before emitting, persisting, or constructing an error, recursively redact the exact active/fallback secrets plus generic secret patterns from every Pi event and diagnostic. Unknown event types produce debug diagnostics. Persist journal JSON after every tool start/end and before process termination. Map interaction tool completion to `PendingInteraction`; map report-result completion to a validated done candidate. An exit code 0 without report-result is `protocol` failure.

- [ ] **Step 5: Run extension typecheck and translation tests**

Run: `pnpm --filter @ai-devflow/desktop stage:pi && pnpm --filter @ai-devflow/agents typecheck && pnpm --filter @ai-devflow/agents exec vitest run src/__tests__/json-events.test.ts`

Expected: PASS; the staged manifest includes all four shared extension files in its checksum map.

- [ ] **Step 6: Commit event bridge**

```bash
git add packages/agents/assets/profiles/shared packages/agents/src/json-events.ts packages/agents/src/attempt-journal.ts packages/agents/src/__tests__/json-events.test.ts
git commit -m "feat(agents): bridge pi json events and attempt journals"
```

---

### Task 8: Implement Pi process supervision and the single production AgentRunner

**Files:**
- Create: `packages/agents/src/process-supervisor.ts`
- Create: `packages/agents/src/pi-runner.ts`
- Create: `packages/agents/src/runner-types.ts`
- Create: `packages/agents/src/__tests__/pi-runner.test.ts`
- Create: `packages/agents/src/__tests__/fixtures/fake-pi.mjs`
- Create: `packages/agents/src/__tests__/helpers/pi-runner-harness.ts`
- Modify: `packages/agents/src/index.ts`

**Interfaces:**
- Consumes: locator, router, run-plan, translator, journal writer.
- Produces: additive `AgentRunner.run(request): Promise<AgentRun>` and `AgentRunner.verifyRuntime()`.
- Keeps: old adapters and registry exported but unused by the new runner until production cutover; Task 12 deletes them after UI removal.

- [ ] **Step 1: Write process and failover tests with fake Pi**

```ts
import { expect, it } from 'vitest';
import { createPiRunnerHarness } from './helpers/pi-runner-harness.js';

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const event of events) values.push(event);
  return values;
}

it('uses the absolute fake Pi entry and emits done only after report_result', async () => {
  const harness = createPiRunnerHarness({ scenario: 'success' });
  const run = await harness.runner.run({
    taskId: 't1', executionId: 'e1', role: 'coder', prompt: 'change fixture', cwd: harness.cwd,
  });
  const events = await collect(run.events);
  expect(events).toContainEqual(expect.objectContaining({ type: 'done' }));
  expect(harness.spawnedCommands[0]?.args[0]).toBe(harness.fakePiEntry);
});

it('passes a mutation checkpoint to the next provider', async () => {
  const harness = createPiRunnerHarness({ scenario: 'mutate-then-provider-error' });
  const run = await harness.runner.run({
    taskId: 't1', executionId: 'e1', role: 'coder', prompt: 'change fixture', cwd: harness.cwd,
  });
  await collect(run.events);
  expect(harness.spawnedCommands).toHaveLength(2);
  expect(harness.spawnedCommands[1]?.initialMessage).toContain('先验证现状');
  expect(harness.spawnedCommands[1]?.initialMessage).toContain('src/fixture.ts');
});
```

- [ ] **Step 2: Run Pi runner tests and confirm red state**

Run: `pnpm --filter @ai-devflow/agents exec vitest run src/__tests__/pi-runner.test.ts`

Expected: FAIL because the runner is absent.

- [ ] **Step 3: Define the final runner protocol**

```ts
export interface AgentRunRequest {
  taskId: string; executionId: string; role: TaskRole; prompt: string; cwd: string;
  resumeFrom?: Checkpoint; userInput?: string;
  interactionResponse?: { kind: InteractionKind; value: string };
}
export interface AgentRun {
  events: AsyncIterable<AgentEvent>;
  cancel(): Promise<void>;
  done(): Promise<{ exitCode: number | null; ok: boolean }>;
  pid?: number;
}
export interface AgentRunner {
  verifyRuntime(): Promise<{ version: string; entry: string }>;
  run(request: AgentRunRequest): Promise<AgentRun>;
}
```

`createPiRunnerHarness()` must return this exact shape:

```ts
interface PiRunnerHarness {
  runner: AgentRunner;
  cwd: string;
  fakePiEntry: string;
  spawnedCommands: Array<{ args: string[]; initialMessage: string }>;
}
function createPiRunnerHarness(input: {
  scenario:
    | 'success' | 'mutate-then-provider-error' | 'authentication' | 'rate-limit'
    | 'runtime-crash' | 'timeout' | 'protocol-corruption' | 'interaction' | 'task-result-failure';
}): PiRunnerHarness;
```

Implement it with two in-memory provider configs, a temporary Git fixture, the fake Pi entry, in-memory health/attempt repositories, and an injected spawn function. The fake CLI must emit a session header, tool start/end events, `ai_devflow_report_result`, and `agent_end`; the mutation scenario exits with a provider-classified error after writing `src/fixture.ts` on its first invocation and succeeds on its second. Add table-driven assertions that authentication immediately selects provider 2, rate-limit honors the injected fake clock, runtime crash and protocol corruption retry once then select provider 2, timeout kills the process tree, interaction stops without failover and produces `awaiting_input`, and task-result failure stops without failover.

`PiProcessSupervisor` spawns `process.execPath` with `ELECTRON_RUN_AS_NODE=1`, `shell:false`, piped stdout/stderr, and the role timeout. On POSIX it uses a detached process group and signals `-pid` with SIGTERM then SIGKILL after 2 seconds; on Windows it invokes `join(process.env.SystemRoot!, 'System32', 'taskkill.exe')` with arguments `['/PID', String(pid), '/T', '/F']` and `shell:false`. It accepts the route secret as redaction input and never exposes raw stderr. `PiRunner` wraps each route in `ProviderRouter.execute()`, creates an attempt record, streams translated/redacted events, and constructs recovery messages from journal + Git diff after a provider failure.

- [ ] **Step 4: Export the additive runner without changing production composition**

Export runner types, Pi runner, router, run-plan, locator, and translator from `packages/agents/src/index.ts`. Keep legacy adapter tests green in this task. Do not modify `apps/desktop/electron/services.ts` yet.

- [ ] **Step 5: Run all agents tests**

Run: `pnpm --filter @ai-devflow/agents test`

Expected: PASS with no real network and no external CLI lookup.

- [ ] **Step 6: Commit the Pi-only runner**

```bash
git add packages/agents/src/process-supervisor.ts packages/agents/src/pi-runner.ts packages/agents/src/runner-types.ts packages/agents/src/index.ts packages/agents/src/__tests__/pi-runner.test.ts packages/agents/src/__tests__/fixtures/fake-pi.mjs packages/agents/src/__tests__/helpers/pi-runner-harness.ts
git commit -m "refactor(agents): replace adapters with bundled pi runner"
```

---

### Task 9: Switch the scheduler to AgentRunner and preserve workflow behavior

**Files:**
- Create: `packages/scheduler/src/__tests__/fake-agent-runner.ts`
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/gates.ts`
- Modify: `packages/core/src/state-machine.ts`
- Modify: `packages/persistence/src/migrations.ts`
- Modify: `packages/persistence/src/db.ts`
- Modify: `packages/persistence/src/repositories.ts`
- Modify: `packages/persistence/src/index.ts`
- Modify: `packages/persistence/src/__tests__/pi-migration.test.ts`
- Modify: `packages/scheduler/src/orchestrator.ts`
- Modify: `packages/scheduler/src/__tests__/orchestrator.test.ts`
- Modify: `packages/scheduler/src/index.ts`
- Modify: `apps/desktop/electron/services.ts`
- Modify: `apps/desktop/electron/main.ts`

**Interfaces:**
- Consumes: `AgentRunner` from Task 8.
- Produces: schema v9 activation, PiRunner production composition, and unchanged public task lifecycle with no runtime Agent selection or capability merge.
- Temporary compatibility: Renderer-facing optional Agent fields and old adapter exports remain until Tasks 11–12, but scheduler and persistence neither read nor write them.

- [ ] **Step 1: Rewrite scheduler harness tests around one fake runner**

```ts
export class FakeAgentRunner implements AgentRunner {
  requests: AgentRunRequest[] = [];
  constructor(private script: (request: AgentRunRequest) => AgentEvent[]) {}
  async verifyRuntime() { return { version: 'fake', entry: 'fake' }; }
  async run(request: AgentRunRequest): Promise<AgentRun> {
    this.requests.push(request);
    const events = this.script(request);
    return runFromEvents(events);
  }
}

function runFromEvents(events: AgentEvent[]): AgentRun {
  async function* stream() { for (const event of events) yield event; }
  return {
    events: stream(),
    cancel: async () => undefined,
    done: async () => ({ exitCode: 0, ok: true }),
  };
}
```

Add tests asserting coder and automatic reviewer requests carry `role: 'coder'` and `role: 'reviewer'`, resume carries the checkpoint and user input, and a task starts without Agent assignment.

- [ ] **Step 2: Run scheduler tests and confirm legacy failures**

Run: `pnpm --filter @ai-devflow/scheduler test`

Expected: FAIL on new fake-runner constructor expectations while the orchestrator still requires `AgentRegistry`.

- [ ] **Step 3: Activate schema v9 and switch persistence atomically**

Append `PI_ONLY_MIGRATION_V9` from Task 2 to `MIGRATIONS`, invoke `backupBeforeMigration()` before applying an outstanding v9, and add provider health/attempt repositories to `Repositories`. Remove `TasksRepo.assignAgent()` and remove `agent_type` from task/execution SQL and mappers.

Keep `Task.agentType?` and `ExecutionRecord.agentType?` as deprecated optional compatibility fields for the existing Renderer in this commit, but never populate them. Task 12 deletes the types after Task 11 removes UI references.

- [ ] **Step 4: Replace registry resolution with direct runner calls**

Change the constructor to:

```ts
constructor(
  private repos: Repositories,
  private runner: AgentRunner,
  private opts: OrchestratorOptions,
) {}
```

Delete `resolveAgentType`, `resolveDefaultAgent`, `resolveCapabilities`, global role config reads, and Agent assignment writes. Create execution records without `agentType`, then call `runner.run({ taskId, executionId, role, prompt, cwd, resumeFrom, userInput, interactionResponse })`. Automatic review uses the same runner with `role:'reviewer'`.

- [ ] **Step 5: Switch Electron production composition and startup verification**

Construct `ProviderStore`, persistent health/attempt repos, `ProviderRouter`, `BundledPiLocator`, `ProfileMaterializer`, `PiProcessSupervisor`, and `PiRunner` in `createServices()`. `openDatabase()` performs the backed-up schema migration before returning. Add `initializeServices()` and await it from `main.ts` before scheduler recovery and IPC registration; it runs the legacy credential migration, verifies manifest/checksums/entry/version, and records a sanitized runtime-unavailable status instead of trying PATH or another runtime. Task start must fail recoverably with “应用运行组件损坏” while provider CRUD remains available. Remove `registry` from `Services`; keep old Agent IPC handlers temporarily returning an empty unsupported result until Task 11 deletes the surface.

- [ ] **Step 6: Run migration, scheduler, and desktop composition tests**

Run: `pnpm --filter @ai-devflow/persistence test && pnpm --filter @ai-devflow/scheduler test && pnpm --filter @ai-devflow/desktop exec vitest run electron/__tests__/ipc.test.ts`

Expected: PASS for v1/v6/v8 migrations, start, review, retry, cancel, interaction, resume, worktree, restart recovery, and service creation with an injected runtime locator.

- [ ] **Step 7: Commit the atomic production cutover**

```bash
git add packages/core/src/types.ts packages/core/src/gates.ts packages/core/src/state-machine.ts packages/persistence/src/migrations.ts packages/persistence/src/db.ts packages/persistence/src/repositories.ts packages/persistence/src/index.ts packages/persistence/src/__tests__/pi-migration.test.ts packages/scheduler/src/orchestrator.ts packages/scheduler/src/index.ts packages/scheduler/src/__tests__/orchestrator.test.ts packages/scheduler/src/__tests__/fake-agent-runner.ts apps/desktop/electron/services.ts apps/desktop/electron/main.ts
git commit -m "refactor(scheduler): execute all roles through pi runner"
```

---

### Task 10: Route chat and structured proposals through Pi

**Files:**
- Create: `apps/desktop/electron/pi-ai.ts`
- Create: `apps/desktop/electron/pi-ai-prompts.ts`
- Create: `apps/desktop/electron/__tests__/pi-ai.test.ts`
- Rewrite: `apps/desktop/electron/ai.ts`
- Modify: `apps/desktop/electron/services.ts`
- Modify: `apps/desktop/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `ProviderRouter`, `PiProcessSupervisor`, hidden workload routes.
- Produces: existing `chatStream`, `proposeTasks`, `proposeRequirement`, `testConnection` behavior without `AiProviderConfig` input.

- [ ] **Step 1: Write conversational workload tests**

```ts
it('streams task_chat deltas through the shared router', async () => {
  const harness = makePiAiHarness({ text: 'hello' });
  const events: AiStreamEvent[] = [];
  await harness.service.chatStream('s1', [{ role: 'user', content: 'hi' }], (event) => events.push(event), { mode: 'task' });
  expect(harness.workloads).toEqual(['task_chat']);
  expect(events).toContainEqual({ type: 'done', sessionId: 's1', fullText: 'hello' });
});

it('retries an invalid proposal response on the same routed workload', async () => {
  const harness = makePiAiHarness({ texts: ['not-json', '{"tasks":[]}'] });
  await expect(harness.service.proposeTasks([{ role: 'user', content: 'split' }])).resolves.toEqual([]);
  expect(harness.workloads).toEqual(['task_proposal', 'task_proposal']);
});

type PiTextExecutor = (
  workload: Workload,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  onDelta?: (text: string) => void,
) => Promise<string>;

function makePiAiHarness(input: { text?: string; texts?: string[] }) {
  const workloads: Workload[] = [];
  const outputs = [...(input.texts ?? [input.text ?? ''])];
  const executeText: PiTextExecutor = async (workload, _messages, onDelta) => {
    workloads.push(workload);
    const text = outputs.shift() ?? '';
    onDelta?.(text);
    return text;
  };
  return { service: new PiAiService(executeText), workloads };
}
```

- [ ] **Step 2: Run AI tests and confirm red state**

Run: `pnpm --filter @ai-devflow/desktop exec vitest run electron/__tests__/pi-ai.test.ts`

Expected: FAIL because Pi AI service is absent.

- [ ] **Step 3: Implement no-tool Pi workloads**

Implement `PiAiService` with constructor `(executeText: PiTextExecutor)`. Its production executor uses `ProviderRouter` plus `PiProcessSupervisor` with `--no-tools`, `--no-context-files`, an isolated attempt session, and the route's provider/model/thinking. Put the four fixed workload prompts in `pi-ai-prompts.ts`, materialize the selected text as `SYSTEM.md` in a content-addressed read-only Pi config snapshot, and never put it in argv or Renderer state. Stream `message_update` deltas. Reuse the existing Zod proposal schemas and DAG validation, but obtain text from Pi rather than `ai` SDK. `testConnection(providerId)` calls `ProviderRouter.execute(..., { onlyProviderId: providerId })` with a one-token/minimal response request and never falls through to a different provider.

- [ ] **Step 4: Remove the direct AI SDK dependencies**

Delete `@ai-sdk/anthropic`, `@ai-sdk/openai`, and `ai` from `apps/desktop/package.json` after no production import remains. Keep `zod`.

- [ ] **Step 5: Run desktop AI tests**

Run: `pnpm --filter @ai-devflow/desktop exec vitest run electron/__tests__/ai.test.ts electron/__tests__/pi-ai.test.ts`

Expected: PASS; no test constructs `AiProviderConfig` or manually builds provider HTTP URLs.

- [ ] **Step 6: Commit unified AI routing**

```bash
git add apps/desktop/electron/ai.ts apps/desktop/electron/pi-ai.ts apps/desktop/electron/pi-ai-prompts.ts apps/desktop/electron/services.ts apps/desktop/electron/__tests__/ai.test.ts apps/desktop/electron/__tests__/pi-ai.test.ts apps/desktop/package.json pnpm-lock.yaml
git commit -m "refactor(desktop): route conversations through bundled pi"
```

---

### Task 11: Replace Agent settings and IPC with provider management

**Files:**
- Create: `apps/desktop/src/components/ProviderManager.tsx`
- Modify: `apps/desktop/electron/api.ts`
- Modify: `apps/desktop/electron/preload.ts`
- Modify: `apps/desktop/electron/ipc.ts`
- Modify: `apps/desktop/src/pages/Settings.tsx`
- Modify: `apps/desktop/src/pages/Workspace.tsx`
- Modify: `apps/desktop/src/pages/TaskDetail.tsx`
- Modify: `apps/desktop/src/lib.tsx`
- Modify: `apps/desktop/src/i18n/zh.ts`
- Modify: `apps/desktop/src/i18n/en.ts`
- Modify: `apps/desktop/electron/__tests__/ipc.test.ts`
- Modify: `apps/desktop/scripts/run-e2e.mjs`

**Interfaces:**
- Consumes: `ProviderStore`, `ProviderRouter`, sanitized provider types.
- Produces: `providers.list/save/remove/reorder/test/health` IPC only.

- [ ] **Step 1: Replace IPC tests with sanitized provider assertions**

```ts
it('manages providers without returning secrets or internal models', async () => {
  const saved = await call('providers', 'save', {
    id: 'p1', kind: 'openai', displayName: 'Primary', enabled: true,
    priority: 0, authType: 'api_key', apiKey: 'sk-secret', revision: 1,
  }) as Record<string, unknown>;
  expect(saved.hasCredential).toBe(true);
  expect(JSON.stringify(saved)).not.toContain('sk-secret');
  expect(saved).not.toHaveProperty('model');
  expect(saved).not.toHaveProperty('credentialRef');
  expect(await call('providers', 'list')).toEqual([saved]);
});

it('has no Agent detection IPC surface', () => {
  expect(desktopApiShape).not.toHaveProperty('agents');
  expect(desktopApiShape.settings).not.toHaveProperty('getGlobalAgentConfig');
});
```

- [ ] **Step 2: Run IPC tests and confirm red state**

Run: `pnpm --filter @ai-devflow/desktop exec vitest run electron/__tests__/ipc.test.ts`

Expected: FAIL because providers IPC is absent and Agent IPC remains.

- [ ] **Step 3: Implement the final preload/API surface**

```ts
providers: {
  list(): Promise<ProviderSummary[]>;
  save(input: ProviderInput): Promise<ProviderSummary>;
  remove(id: string): Promise<void>;
  reorder(ids: string[]): Promise<void>;
  test(id: string): Promise<ProviderTestResult>;
  health(): Promise<ProviderHealthSummary[]>;
};
```

Delete Agent detect/capability/config endpoints and old `getAiProvider`/`setAiProvider`/`testAiProvider`. Validate all provider inputs in Main. `remove()` must delete the secret and route health. `reorder()` must receive the complete current ID list.

- [ ] **Step 4: Replace UI and task fields**

`ProviderManager` renders ordered cards with name, kind, enabled state, `hasCredential`, health, test/edit/delete controls, and keyboard-accessible move-up/move-down controls in addition to drag ordering. The edit dialog shows Base URL only for compatible kinds and never pre-fills API Key. Remove Agent sections, Agent selectors, Agent badges, execution Agent column, and related translations.

- [ ] **Step 5: Run IPC and E2E tests**

Run: `pnpm --filter @ai-devflow/desktop test && pnpm --filter @ai-devflow/desktop e2e`

Expected: PASS; E2E adds two providers, reorders them, verifies key masking, and confirms no Agent selector text exists.

- [ ] **Step 6: Commit UI/IPC cutover**

```bash
git add apps/desktop/electron/api.ts apps/desktop/electron/preload.ts apps/desktop/electron/ipc.ts apps/desktop/electron/__tests__/ipc.test.ts apps/desktop/src/components/ProviderManager.tsx apps/desktop/src/pages/Settings.tsx apps/desktop/src/pages/Workspace.tsx apps/desktop/src/pages/TaskDetail.tsx apps/desktop/src/lib.tsx apps/desktop/src/i18n/zh.ts apps/desktop/src/i18n/en.ts apps/desktop/scripts/run-e2e.mjs
git commit -m "feat(desktop): expose provider-only AI settings"
```

---

### Task 12: Remove remaining legacy contracts and update authoritative docs

**Files:**
- Remove: `packages/core/src/capability.ts`
- Remove: `packages/core/src/__tests__/capability.test.ts`
- Remove: `packages/agents/src/adapters/claude-code.ts`
- Remove: `packages/agents/src/adapters/codex.ts`
- Remove: `packages/agents/src/adapters/test.ts`
- Remove: `packages/agents/src/registry.ts`
- Remove: `packages/agents/src/detect.ts`
- Remove: `packages/agents/src/resolve-path.ts`
- Remove: `packages/agents/src/types.ts`
- Remove: `packages/agents/src/process-runner.ts`
- Remove: `packages/agents/src/__tests__/adapter.test.ts`
- Remove: `packages/agents/src/__tests__/real-agents.test.ts`
- Remove: `packages/agents/src/__tests__/resolve-path.test.ts`
- Modify: `packages/agents/src/index.ts`
- Modify: `packages/agents/package.json`
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/state-machine.ts`
- Modify: `packages/notifications/src/__tests__/engine.test.ts`
- Modify: `packages/persistence/src/__tests__/persistence.test.ts`
- Modify: `packages/scheduler/src/__tests__/orchestrator.test.ts`
- Modify: `apps/desktop/electron/__tests__/ipc.test.ts`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `apps/desktop/electron/main.ts`
- Modify: `apps/desktop/scripts/run-e2e.mjs`

**Interfaces:**
- Consumes: completed Pi-only production surface.
- Produces: no legacy runtime/type/config references in production.

- [ ] **Step 1: Run the legacy reference audit**

Run:

```bash
rg -n "ClaudeCodeAdapter|CodexAdapter|AgentRegistry|AgentType|agentType|agentRoles|roleConfigs|claude_code|createDefaultRegistry|detectAll|AiProviderConfig|AiProviderKind|AiProbeResult|getAiProvider|setAiProvider|testAiProvider" packages apps README.md docs/architecture.md
```

Expected: matches remain in legacy code, fixtures, and documentation before this task.

- [ ] **Step 2: Delete production legacy code and repair fixtures**

Remove the listed adapters, detection/registry/path/process-runner code, obsolete Agent types, old single-provider `AiProvider*` types, their dedicated tests, capability merge files, the obsolete `verify:real` package script, and all legacy imports. Keep the old encrypted-record shape private inside `ProviderStore.migrateLegacy()` only. `PiProcessSupervisor` from Task 8 is the sole child-process implementation. Task fixtures omit `agentType`; execution fixtures omit `agentType`; scheduler and desktop tests inject `FakeAgentRunner`. Update state-machine copy from “已分配 Agent” to “已配置可用 AI 服务”.

- [ ] **Step 3: Rewrite README and architecture**

Document bundled Pi 0.80.10, role profiles, provider-only setup, failover, `.env` real-test command, migration v9, and packaging. Remove all instructions to install/login/detect Claude Code, Codex, or external Pi and all instructions for adding custom Agent adapters.

- [ ] **Step 4: Run the final legacy audit**

Run:

```bash
rg -n "ClaudeCodeAdapter|CodexAdapter|AgentRegistry|AgentType|agentType|agentRoles|roleConfigs|claude_code|createDefaultRegistry|detectAll|AiProviderConfig|AiProviderKind|AiProbeResult|getAiProvider|setAiProvider|testAiProvider" packages apps README.md docs/architecture.md
```

Expected: exit code 1 with no matches. References inside the approved spec/plan and Git history are excluded from this production audit.

- [ ] **Step 5: Run workspace verification**

Run: `pnpm verify`

Expected: exit code 0 for typecheck, lint, unit tests, and script tests.

- [ ] **Step 6: Commit legacy removal and docs**

```bash
git add -A -- packages/core/src/capability.ts packages/core/src/__tests__/capability.test.ts packages/core/src/types.ts packages/core/src/index.ts packages/core/src/state-machine.ts packages/agents/src/adapters packages/agents/src/registry.ts packages/agents/src/detect.ts packages/agents/src/resolve-path.ts packages/agents/src/types.ts packages/agents/src/process-runner.ts packages/agents/src/__tests__/adapter.test.ts packages/agents/src/__tests__/real-agents.test.ts packages/agents/src/__tests__/resolve-path.test.ts packages/agents/src/index.ts packages/agents/package.json packages/notifications/src/__tests__/engine.test.ts packages/persistence/src/__tests__/persistence.test.ts packages/scheduler/src/__tests__/orchestrator.test.ts apps/desktop/electron/__tests__/ipc.test.ts apps/desktop/electron/main.ts apps/desktop/scripts/run-e2e.mjs README.md docs/architecture.md
git commit -m "refactor: remove claude code and codex support"
```

---

### Task 13: Add the mandatory `.env` real Pi verification

**Files:**
- Modify: `.env.example`
- Create: `packages/agents/src/__tests__/real-pi.test.ts`
- Create: `scripts/run-real-pi-test.mjs`
- Create: `scripts/verify-real-pi-secrets.mjs`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: staged Pi runtime, PiRunner, provider route override for tests only.
- Produces: `pnpm test:real:pi` completion gate.

- [ ] **Step 1: Normalize the public environment contract without reading `.env`**

```dotenv
# .env.example
# Real Pi integration tests only. Copy to .env; never commit real values.
DEV_API_KEY=
DEV_API_URL=
DEV_API_DEFAULT_MODEL=
DEV_API_TYPE=openai_compatible
```

Keep `.env` and `.env.*` ignored and `!.env.example` allowed. Run `git check-ignore -v .env` and require a matching ignore rule before any real test.

- [ ] **Step 2: Write real-test preflight and role cases**

The test must validate all four variables without printing values, construct a test-only provider route using `DEV_API_DEFAULT_MODEL`, create a disposable Git repository under `mkdtempSync`, and run planner/coder/reviewer/tester cases through the verified bundled entry. Add a first route whose Base URL is a local closed port, then assert failover reaches the real route. Run two tester attempts concurrently and assert distinct config/session paths.

The reviewer case attempts to call `write`; success means the policy blocks the write and the fixture hash is unchanged. Every role must complete via `ai_devflow_report_result`.

- [ ] **Step 3: Add the secret scanner**

`scripts/verify-real-pi-secrets.mjs` reads `DEV_API_KEY` from the process environment, rejects an empty value, then scans only the real-test output directory, redacted stdout/stderr captures, journal JSON, SQLite fixture, temporary config/session trees, and staged manifest for exact key bytes. It prints file names and pass/fail only; it never prints the key or matching content. Packaged resources are checked separately in Task 14 after a package exists.

`scripts/run-real-pi-test.mjs` first verifies `.env` is ignored and the four variables are non-empty without printing values. It spawns `./node_modules/vitest/vitest.mjs run packages/agents/src/__tests__/real-pi.test.ts --no-file-parallelism` with piped output. For every raw chunk it checks for the exact `DEV_API_KEY` in memory, replaces that exact value before applying the same generic secret-pattern vocabulary as production, then echoes and saves only the redacted form. It always calls the artifact scanner in `finally`, even when Vitest fails. It exits nonzero if raw output contained the key or if the test/scan fails, and never writes raw output, the child environment, or response bodies.

- [ ] **Step 4: Add the root command**

```json
"test:real:pi": "pnpm --filter @ai-devflow/desktop stage:pi && node --env-file=.env scripts/run-real-pi-test.mjs"
```

- [ ] **Step 5: Run the mandatory real test**

Run: `pnpm test:real:pi`

Expected: exit code 0; four roles complete, failover succeeds, concurrent sessions differ, reviewer write is blocked, and secret scan reports no leak. If the provider/network/credential/model fails, stop and report the real failure; do not skip and do not use external Pi.

- [ ] **Step 6: Commit the real-test harness, never `.env`**

```bash
git add .env.example .gitignore package.json packages/agents/src/__tests__/real-pi.test.ts scripts/run-real-pi-test.mjs scripts/verify-real-pi-secrets.mjs
git diff --cached --name-only | rg '^\.env$' && exit 1 || true
git commit -m "test: add real bundled pi provider verification"
```

---

### Task 14: Verify packaged runtime isolation and complete the migration

**Files:**
- Create: `apps/desktop/scripts/verify-packaged-pi.mjs`
- Modify: `apps/desktop/scripts/run-e2e.mjs`
- Modify: `.github/workflows/release.yml`
- Modify: `apps/desktop/package.json`

**Interfaces:**
- Consumes: complete Pi-only app.
- Produces: package smoke gates on macOS x64/arm64, Windows x64, Linux x64.

- [ ] **Step 1: Add packaged isolation E2E**

Add a `--packaged <release-root>` mode to `run-e2e.mjs`. In that mode, resolve exactly one unpacked application matching `process.platform` and `process.arch` and launch its platform executable, then run an isolation scenario that starts a loopback OpenAI-compatible fake-provider HTTP server, stores its fake key through the real provider IPC, creates a fake executable named `pi` at the front of PATH that exits 97, and creates hostile user/project Pi settings and extensions that write marker files. Execute a task whose deterministic fake-provider response calls `ai_devflow_report_result`. Assert the task succeeds through the real bundled Pi process, exit 97 is never observed, and no hostile marker is created. Assert `runtime-manifest.json` reports `0.80.10`, every checksum verifies, and the fake server received only the configured fake key. Bind the server to `127.0.0.1` on an OS-assigned port and close it in `finally`.

- [ ] **Step 2: Add package inspection script**

`verify-packaged-pi.mjs <release-root>` must locate every unpacked application directory containing `resources/app.asar` (and fail if none exist), then verify each one: runtime manifest exists outside ASAR; entry and dependency files exist; no `.env` file exists; no `DEV_API_KEY` bytes occur; and no legacy adapter source or command string exists. For the directory matching the host architecture, resolve its Electron executable and spawn it with `[absolutePiEntry, '--version']`, `ELECTRON_RUN_AS_NODE=1`, and `shell:false`; require exact version `0.80.10`. Non-host architecture directories still require full manifest/checksum inspection but are not executed.

- [ ] **Step 3: Run local package smoke**

Run:

```bash
pnpm --filter @ai-devflow/desktop package
node apps/desktop/scripts/verify-packaged-pi.mjs apps/desktop/release
node apps/desktop/scripts/run-e2e.mjs --packaged apps/desktop/release
```

Expected: package, inspection, and packaged isolation E2E exit 0; inspection prints every validated unpacked directory and E2E prints the one matching the host architecture.

- [ ] **Step 4: Add CI matrix gates**

Add a `pi-runtime-smoke` job after `prepare` with exactly four entries: `macos-13/x64`, `macos-14/arm64`, `windows-latest/x64`, and `ubuntu-latest/x64`. Each entry checks out the prepared tag, installs frozen dependencies, runs desktop build, runs `electron-builder --dir` for only its matrix architecture, then package inspection and `run-e2e.mjs --packaged`. On Linux install/start `gnome-keyring` inside `dbus-run-session` so `safeStorage` does not select `basic_text`, and wrap the E2E with `xvfb-run -a`. Make the existing release `build` job depend on this smoke job; keep its signing/notarization and artifact upload behavior unchanged. Upload only redacted inspection logs, never user data, `.env`, provider responses, or sessions.

- [ ] **Step 5: Run final full verification**

Run in order:

```bash
pnpm verify
pnpm --filter @ai-devflow/desktop build
pnpm --filter @ai-devflow/desktop e2e
pnpm --filter @ai-devflow/desktop package
node apps/desktop/scripts/verify-packaged-pi.mjs apps/desktop/release
node apps/desktop/scripts/run-e2e.mjs --packaged apps/desktop/release
pnpm test:real:pi
git diff --check
git status --short
```

Expected: every command exits 0; `git status --short` contains no implementation changes and may contain only user-owned files that were already untracked before execution. Confirm `.env` is absent from `git ls-files` and present in `git check-ignore -v .env`.

- [ ] **Step 6: Commit package gates**

```bash
git add apps/desktop/scripts/run-e2e.mjs apps/desktop/scripts/verify-packaged-pi.mjs apps/desktop/package.json .github/workflows/release.yml
git commit -m "test: gate releases on bundled pi isolation"
```

---

## Completion Evidence

Before marking the goal complete, attach or summarize these fresh outputs without secrets:

1. `pnpm verify` with all package counts and zero failures.
2. Desktop build and E2E exit codes.
3. `pnpm test:real:pi` showing four role cases, failover, concurrency, and secret scan passed.
4. Packaged runtime inspection showing Pi `0.80.10` and checksum success.
5. Schema migration tests from v1, v6, and v8 plus backup/rollback evidence.
6. The production legacy audit returning no matches.
7. `git status --short` proving `.env` was never staged and no unrelated user file changed.
