// 装配主进程服务：数据库、内置 Pi 运行时（Provider 存储 + 路由 + Runner）、编排器、超时引擎、
// Webhook 投递器、通知器、自动更新。Pi-only：不再有 Agent 注册表/适配器。
import { app } from 'electron';
import { join } from 'node:path';
import { openDatabase, createRepositories, type Repositories } from '@ai-devflow/persistence';
import type { ProviderSummary } from '@ai-devflow/core';
import { PiProcessSupervisor, buildControlledPath, type AgentRunner } from '@ai-devflow/agents';
import { Orchestrator, KnowledgeCoordinator, type KnowledgeCoordinatorOptions } from '@ai-devflow/scheduler';
import { ProjectKnowledgeService } from '@ai-devflow/knowledge';
import { TimeoutEngine, WebhookSender, type Notifier } from '@ai-devflow/notifications';
import { decryptSecret, encryptSecret } from './credentials.js';
import { createUpdater, type Updater } from './updater.js';
import { createPiRuntime, assetsRootFor, type PiRuntimeServices } from './pi-runtime.js';
import type { ProviderStore } from './provider-store.js';
import { createPiAiService, createProductionTextExecutor, type PiAiService } from './pi-ai.js';
import { RetentionService } from './retention.js';

export interface Services {
  repos: Repositories;
  runner?: AgentRunner;
  providerStore?: ProviderStore;
  piRuntime?: PiRuntimeServices;
  piAi?: PiAiService;
  knowledge?: KnowledgeCoordinator;
  orchestrator: Orchestrator;
  timeoutEngine: TimeoutEngine;
  webhooks: WebhookSender;
  dbPath: string;
  worktreesBaseDir: string;
  encryptSecret: (s: string) => string;
  decryptSecret: (s: string) => string;
  updater: Updater;
  initializationStatus?: ServiceInitializationStatus;
  retention?: RetentionService;
}

export interface ServiceInitializationStatus {
  credentialMigration: 'not_needed' | 'migrated' | 'needs_reentry' | 'failed';
  runtime: 'ready' | 'unavailable';
}

export interface KnowledgeWorkflowOptions {
  repos: Repositories;
  runner: AgentRunner;
  worktreesBaseDir: string;
  maxConcurrent?: number;
  autoRetry?: boolean;
  hasProvider?: () => boolean;
}

/** 生产与测试共用的知识工作流组合根，保证 Orchestrator 始终使用同一个 coordinator。 */
export function createKnowledgeWorkflow(options: KnowledgeWorkflowOptions): {
  knowledge: KnowledgeCoordinator;
  orchestrator: Orchestrator;
} {
  const knowledge = new KnowledgeCoordinator({
    repos: options.repos,
    runner: options.runner,
    knowledge: new ProjectKnowledgeService(),
    worktreesBaseDir: options.worktreesBaseDir,
  } as KnowledgeCoordinatorOptions);
  const orchestrator = new Orchestrator(options.repos, options.runner, {
    worktreesBaseDir: options.worktreesBaseDir,
    maxConcurrent: options.maxConcurrent ?? 2,
    autoRetry: options.autoRetry ?? true,
    hasProvider: options.hasProvider,
    knowledgeCoordinator: knowledge,
  });
  return { knowledge, orchestrator };
}

export function hasUsableProvider(
  providers: ReadonlyArray<Pick<ProviderSummary, 'enabled' | 'hasCredential'>>,
  runtime: ServiceInitializationStatus['runtime'] | undefined,
): boolean {
  return runtime === 'ready' && providers.some((provider) => provider.enabled && provider.hasCredential);
}

interface InitializableServices {
  repos?: Pick<Repositories, 'providerUsage'>;
  retention?: Pick<RetentionService, 'runIfDue'>;
  knowledge?: Pick<KnowledgeCoordinator, 'recoverInterrupted'>;
  piRuntime?: {
    cleanupOrphans?(): Promise<void>;
    providerStore: {
      migrateLegacy(): 'not_needed' | 'migrated' | 'needs_reentry';
    };
    locator: {
      verify(): Promise<{ version: string; entry: string }>;
    };
  };
}

/**
 * Complete all startup-only Pi initialization before IPC registration or scheduler recovery.
 * Errors are deliberately collapsed to stable high-level states so credential/runtime details
 * can never escape through logs or Renderer-visible service state.
 */
export async function initializeServices(
  services: InitializableServices,
): Promise<ServiceInitializationStatus> {
  try {
    services.repos?.providerUsage.recoverInterrupted(Date.now());
  } catch {
    // Usage recovery is best effort; startup continues with existing analytics rows.
  }
  void services.retention?.runIfDue().catch(() => undefined);

  let credentialMigration: ServiceInitializationStatus['credentialMigration'] = 'not_needed';
  try {
    credentialMigration = services.piRuntime?.providerStore.migrateLegacy() ?? 'not_needed';
  } catch {
    credentialMigration = 'failed';
  }

  try {
    await services.piRuntime?.cleanupOrphans?.();
  } catch {
    // Cleanup is best-effort and deliberately silent; runtime verification still proceeds.
  }

  try {
    await services.knowledge?.recoverInterrupted();
  } catch {
    // Recovery is best-effort; individual records retain diagnostics and app startup continues.
  }

  let runtime: ServiceInitializationStatus['runtime'] = 'unavailable';
  try {
    await services.piRuntime?.locator.verify();
    runtime = services.piRuntime ? 'ready' : 'unavailable';
  } catch {
    runtime = 'unavailable';
  }
  return { credentialMigration, runtime };
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
      projectToolPath: buildControlledPath(),
      assetsRoot: assetsRootFor(),
      usage: {
        start: (input) => {
          const providerName = piRuntime.providerStore.listConfigs()
            .find((provider) => provider.id === input.providerId)?.displayName ?? input.providerName;
          return repos.providerUsage.start({ ...input, providerName }).id;
        },
        finish: (id, input) => repos.providerUsage.finish(id, input),
      },
    }),
  );
  let services: Services | undefined;
  const workflow = createKnowledgeWorkflow({
    repos,
    runner: piRuntime.runner,
    worktreesBaseDir,
    maxConcurrent: 2,
    autoRetry: true,
    hasProvider: () => hasUsableProvider(
      piRuntime.providerStore.list(),
      services?.initializationStatus?.runtime,
    ),
  });
  const { orchestrator, knowledge } = workflow;
  const webhooks = new WebhookSender(repos, { maxAttempts: 3, timeoutMs: 10_000, baseDelayMs: 1000 });
  const timeoutEngine = new TimeoutEngine(repos, notifier, webhooks, { intervalMs: 30_000 });
  const updater = createUpdater();
  const retention = new RetentionService(db, repos);

  services = {
    repos,
    runner: piRuntime.runner,
    providerStore: piRuntime.providerStore,
    piRuntime,
    piAi,
    knowledge,
    orchestrator,
    timeoutEngine,
    webhooks,
    dbPath,
    worktreesBaseDir,
    encryptSecret,
    decryptSecret,
    updater,
    retention,
  };
  // 专家化重构（§6.2）：启动一次性迁移旧 AgentModelOverride 键到 6 专家键。
  const overrideMigration = piRuntime.providerStore.migrateAgentOverridesToExperts();
  if (overrideMigration.conflicts.length > 0) {
    console.warn('[provider-store] Agent override 迁移冲突：', overrideMigration.conflicts);
  }
  return services;
}
