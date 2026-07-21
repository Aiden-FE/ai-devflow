// 装配主进程服务：数据库、Agent 注册表、编排器、超时引擎、Webhook 投递器、通知器。
import { app } from 'electron';
import { join } from 'node:path';
import { openDatabase, createRepositories, type Repositories } from '@ai-devflow/persistence';
import { createDefaultRegistry, type AgentRegistry } from '@ai-devflow/agents';
import { Orchestrator } from '@ai-devflow/scheduler';
import { TimeoutEngine, WebhookSender, type Notifier } from '@ai-devflow/notifications';
import { decryptSecret, encryptSecret } from './credentials.js';

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
}

export function createServices(notifier: Notifier): Services {
  const userData = app.getPath('userData');
  const dbPath = join(userData, 'ai-devflow.db');
  const worktreesBaseDir = join(userData, 'worktrees');
  const db = openDatabase(dbPath);
  const repos = createRepositories(db);
  // Claude Code 在 -p 模式下默认拒绝需授权的工具（Write/Bash 等），导致任务无法改文件、
  // 陷入长思考循环。任务均在独立 worktree 中执行，授权绕过是自治执行的必要前提。
  const registry = createDefaultRegistry({ claudeExtraArgs: ['--permission-mode', 'bypassPermissions'] });
  const orchestrator = new Orchestrator(repos, registry, { worktreesBaseDir, maxConcurrent: 2, autoRetry: true });
  const webhooks = new WebhookSender(repos, { maxAttempts: 3, timeoutMs: 10_000, baseDelayMs: 1000 });
  const timeoutEngine = new TimeoutEngine(repos, notifier, webhooks, { intervalMs: 30_000 });

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
  };
}
