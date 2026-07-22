// PiRunner 集成测试 harness（设计 §16.2）。用 fake Pi CLI 驱动真实 supervisor/translator/router 链路，
// 无网络、无外部 CLI。注入 spawn 记录每次子进程调用的 args 与初始 message，并把场景注入子进程 env。
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProviderConfig, ProviderHealth } from '@ai-devflow/core';
import { PiRunner } from '../../pi-runner.js';
import { ProjectInstructionLoader } from '../../project-instructions.js';
import type { MaterializeInput } from '../../profiles.js';
import type { SpawnFn } from '../../process-supervisor.js';
import { PiProcessSupervisor } from '../../process-supervisor.js';
import { ProviderRouter, type ProviderHealthStore } from '../../provider-router.js';
import type { AgentRunner } from '../../runner-types.js';
import type { ExecutionAttemptStore } from '../../attempt-journal.js';

const FAKE_PI_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/fake-pi.mjs');

export type FakeScenario =
  | 'success'
  | 'mutate-then-provider-error'
  | 'authentication'
  | 'rate-limit'
  | 'runtime-crash'
  | 'protocol-corruption'
  | 'interaction'
  | 'task-result-failure'
  | 'missing-verification';

export interface PiRunnerHarness {
  runner: AgentRunner;
  cwd: string;
  fakePiEntry: string;
  spawnedCommands: Array<{ args: string[]; initialMessage: string; checkpoint?: unknown }>;
  sleeps: number[];
  attemptIds: string[];
  attemptCollisions: string[];
  materializedProfiles: MaterializeInput[];
}

export function createPiRunnerHarness(input: { scenario: FakeScenario }): PiRunnerHarness {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-runner-cwd-'));
  const sessionsBaseDir = join(mkdtempSync(join(tmpdir(), 'pi-runner-sessions-')), 'sessions');
  const spawnedCommands: Array<{ args: string[]; initialMessage: string; checkpoint?: unknown }> = [];
  const sleeps: number[] = [];
  const attemptIds: string[] = [];
  const attemptCollisions: string[] = [];
  const materializedProfiles: MaterializeInput[] = [];

  const providers: ProviderConfig[] = ['p1', 'p2'].map((id, priority) => ({
    id, kind: 'openai', displayName: id, enabled: true, priority,
    authType: 'api_key', credentialRef: `provider:${id}`, revision: priority + 7,
  }));

  const healthValues = new Map<string, ProviderHealth>();
  const key = (providerId: string, routeId: string) => `${providerId}\0${routeId}`;
  const health: ProviderHealthStore = {
    get: (providerId, routeId) => healthValues.get(key(providerId, routeId)),
    listByProvider: (providerId) => [...healthValues.values()].filter((v) => v.providerId === providerId),
    upsert: (value) => {
      healthValues.set(key(value.providerId, value.routeId), value);
    },
    clearProvider: (providerId) => {
      for (const [k, v] of healthValues) if (v.providerId === providerId) healthValues.delete(k);
    },
  };

  const attempts: ExecutionAttemptStore = {
    create: (value) => {
      if (attemptIds.includes(value.id)) {
        const error = `UNIQUE constraint failed: execution_attempts.id (${value.id})`;
        attemptCollisions.push(error);
        throw new Error(error);
      }
      attemptIds.push(value.id);
    },
    updateJournal: () => undefined,
    finish: () => undefined,
  };

  const router = new ProviderRouter({
    listProviders: () => providers,
    resolveSecret: () => 'fake-secret',
    health,
    now: () => 1_000,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  });

  // 物化器桩：返回一个临时 profile 目录（fake CLI 不读取 profile 内容，run plan 只引用路径）。
  const materializer = {
    materialize: (profile: MaterializeInput) => {
      materializedProfiles.push(profile);
      const profileDir = mkdtempSync(join(tmpdir(), 'pi-runner-profile-'));
      return { profileDir, digest: 'fake-digest' };
    },
  };

  const spawnFn: SpawnFn = (command, args, opts) => {
    const checkpointPath = opts.env.AI_DEVFLOW_CHECKPOINT_PATH;
    spawnedCommands.push({
      args: [...args],
      initialMessage: args[args.length - 1] ?? '',
      checkpoint: checkpointPath ? JSON.parse(readFileSync(checkpointPath, 'utf8')) as unknown : undefined,
    });
    return nodeSpawn(command, args, {
      cwd: opts.cwd,
      env: { ...opts.env, AI_DEVFLOW_FAKE_SCENARIO: input.scenario },
      detached: opts.detached,
      stdio: opts.stdio,
    });
  };

  const supervisor = new PiProcessSupervisor({ spawnFn });

  const runner = new PiRunner({
    locator: { verify: async () => ({ version: '0.80.10', entry: FAKE_PI_ENTRY }) },
    router,
    materializer,
    supervisor,
    sessionsBaseDir,
    projectToolPath: '/usr/bin:/bin',
    instructionLoader: new ProjectInstructionLoader(),
    attempts,
  });

  return { runner, cwd, fakePiEntry: FAKE_PI_ENTRY, spawnedCommands, sleeps, attemptIds, attemptCollisions, materializedProfiles };
}
