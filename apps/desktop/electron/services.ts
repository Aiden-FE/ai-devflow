// 装配主进程服务：数据库、内置 Pi 运行时（Provider 存储 + 路由 + Runner）、编排器、超时引擎、
// Webhook 投递器、通知器、自动更新。Pi-only：不再有 Agent 注册表/适配器。
import { app } from 'electron';
import { join } from 'node:path';
import { openDatabase, createRepositories, type Repositories } from '@ai-devflow/persistence';
import { PiProcessSupervisor, type AgentRunner } from '@ai-devflow/agents';
import { Orchestrator } from '@ai-devflow/scheduler';
import { TimeoutEngine, WebhookSender, type Notifier } from '@ai-devflow/notifications';
import { decryptSecret, encryptSecret } from './credentials.js';
import { createUpdater, type Updater } from './updater.js';
import { createPiRuntime, type PiRuntimeServices } from './pi-runtime.js';
import type { ProviderStore } from './provider-store.js';
import { createPiAiService, createProductionTextExecutor, type PiAiService } from './pi-ai.js';

export interface Services {
  repos: Repositories;
  runner?: AgentRunner;
  providerStore?: ProviderStore;
  piRuntime?: PiRuntimeServices;
  piAi?: PiAiService;
  orchestrator: Orchestrator;
  timeoutEngine: TimeoutEngine;
  webhooks: WebhookSender;
  dbPath: string;
  worktreesBaseDir: string;
  encryptSecret: (s: string) => string;
  decryptSecret: (s: string) => string;
  updater: Updater;
}

export function createServices(notifier: Notifier): Services {
  const userData = app.getPath('userData');
  const dbPath = join(userData, 'ai-devflow.db');
  const worktreesBaseDir = join(userData, 'worktrees');
  const db = openDatabase(dbPath);
  const repos = createRepositories(db);
  const piRuntime = createPiRuntime(repos, userData);
  const piAi = createPiAiService(
    createProductionTextExecutor({
      locator: piRuntime.locator,
      router: piRuntime.router,
      supervisor: new PiProcessSupervisor(),
      sessionsBaseDir: join(userData, 'pi-runtime', 'sessions'),
      projectToolPath: process.env.PATH ?? '/usr/bin:/bin',
    }),
  );
  const orchestrator = new Orchestrator(repos, piRuntime.runner, {
    worktreesBaseDir,
    maxConcurrent: 2,
    autoRetry: true,
    hasProvider: () => piRuntime.providerStore.list().length > 0,
  });
  const webhooks = new WebhookSender(repos, { maxAttempts: 3, timeoutMs: 10_000, baseDelayMs: 1000 });
  const timeoutEngine = new TimeoutEngine(repos, notifier, webhooks, { intervalMs: 30_000 });
  const updater = createUpdater();

  return {
    repos,
    runner: piRuntime.runner,
    providerStore: piRuntime.providerStore,
    piRuntime,
    piAi,
    orchestrator,
    timeoutEngine,
    webhooks,
    dbPath,
    worktreesBaseDir,
    encryptSecret,
    decryptSecret,
    updater,
  };
}
