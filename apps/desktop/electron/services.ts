// 装配主进程服务：数据库、Agent 注册表、编排器、超时引擎、Webhook 投递器、通知器、自动更新。
import { app } from 'electron';
import { join } from 'node:path';
import { openDatabase, createRepositories, type Repositories } from '@ai-devflow/persistence';
import { createDefaultRegistry, type AgentRegistry } from '@ai-devflow/agents';
import { Orchestrator } from '@ai-devflow/scheduler';
import { TimeoutEngine, WebhookSender, type Notifier } from '@ai-devflow/notifications';
import { decryptSecret, encryptSecret } from './credentials.js';
import { createUpdater, type Updater } from './updater.js';

export interface Services {
  repos: Repositories;
  registry: AgentRegistry;
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
  // 不再无条件绕过权限：权限模式由各角色能力配置决定（requireApproval ? manual : acceptEdits），
  // 真实权限请求转为 approval_request 由用户处理。详见 adapters/claude-code.ts。
  const registry = createDefaultRegistry();
  const orchestrator = new Orchestrator(repos, registry, { worktreesBaseDir, maxConcurrent: 2, autoRetry: true });
  const webhooks = new WebhookSender(repos, { maxAttempts: 3, timeoutMs: 10_000, baseDelayMs: 1000 });
  const timeoutEngine = new TimeoutEngine(repos, notifier, webhooks, { intervalMs: 30_000 });
  const updater = createUpdater();

  return {
    repos,
    registry,
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
