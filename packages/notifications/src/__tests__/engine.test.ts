import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { openDatabase, createRepositories, type Repositories } from '@ai-devflow/persistence';
import type { DatabaseSync } from '@ai-devflow/persistence';
import { TimeoutEngine, TIMEOUT_EVENT, RecordingNotifier, WebhookSender } from '../index.js';
import { verifySignature, randomId, now } from '@ai-devflow/core';
import type { Task, NotificationRule, WebhookConfig } from '@ai-devflow/core';

let db: DatabaseSync;
let repos: Repositories;
let notifier: RecordingNotifier;
let engine: TimeoutEngine;

beforeEach(() => {
  db = openDatabase(':memory:');
  repos = createRepositories(db);
  notifier = new RecordingNotifier();
  engine = new TimeoutEngine(repos, notifier, new WebhookSender(repos, { maxAttempts: 1, timeoutMs: 2000 }), {
    intervalMs: 1000,
  });
});

afterEach(() => {
  engine.stop();
  try { db.close(); } catch { /* */ }
});

function startCapture(onBody: (body: string, sig: string) => void): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        onBody(body, req.headers['x-aidevflow-signature'] as string);
        res.statusCode = 200;
        res.end('ok');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}/hook` });
    });
  });
}

function seedProject() {
  repos.projects.insert({ id: 'p', name: 'P', path: '/x', defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} });
  repos.iterations.insert({ id: 'i', projectId: 'p', name: 'I', version: 'v1', status: 'active', createdAt: 1 });
  repos.requirements.insert({ id: 'r', iterationId: 'i', title: 'R', description: '', priority: 'medium', acceptance: 'a', createdAt: 1, archived: false });
}

function seedTask(statusChangedAt: number, status: Task['status'] = 'in_progress'): Task {
  const t: Task = {
    id: randomId(), requirementId: 'r', iterationId: 'i', projectId: 'p',
    title: 'Overdue task', description: '', status, role: 'coder',
    stages: [], currentStage: 0, statusChangedAt, createdAt: statusChangedAt, updatedAt: statusChangedAt, retryCount: 0,
  };
  repos.tasks.insert(t);
  return t;
}

describe('timeout engine', () => {
  it('shortened threshold fires desktop notification + local webhook with valid signature', async () => {
    seedProject();
    const captured: Array<{ body: string; sig: string }> = [];
    const { server, url } = await startCapture((body, sig) => captured.push({ body, sig }));
    try {
      // 缩短的测试阈值：minutes = 0；任务 statusChangedAt 在过去 -> 立即逾期。
      const rule: NotificationRule = {
        id: randomId(), status: 'in_progress', minutes: 0, channels: ['desktop', 'webhook'], enabled: true,
      };
      repos.notificationRules.insert(rule);
      const wh: WebhookConfig = {
        id: randomId(), name: 'W', url, secret: 'testsecret', events: [TIMEOUT_EVENT], enabled: true, createdAt: now(),
      };
      repos.webhookConfigs.insert(wh);

      const task = seedTask(now() - 60_000);

      const res = await engine.tick(now());
      expect(res.fired).toBeGreaterThan(0);

      // 桌面通知
      expect(notifier.calls.length).toBe(1);
      expect(notifier.calls[0]!.taskId).toBe(task.id);
      expect(notifier.calls[0]!.deepLink).toBe(`ai-devflow://task/${task.id}`);

      // 本地测试 Webhook 收到且签名有效
      expect(captured.length).toBe(1);
      expect(await verifySignature('testsecret', captured[0]!.body, captured[0]!.sig)).toBe(true);
      const payload = JSON.parse(captured[0]!.body);
      expect(payload.event).toBe(TIMEOUT_EVENT);
      expect(payload.task.id).toBe(task.id);

      // 投递记录
      const delivs = repos.notificationDeliveries.listByTask(task.id);
      expect(delivs.some((d) => d.channel === 'desktop' && d.status === 'sent')).toBe(true);
      expect(delivs.some((d) => d.channel === 'webhook' && d.status === 'sent')).toBe(true);
      expect(repos.webhookDeliveries.listByWebhook(wh.id).length).toBe(1);
    } finally {
      server.close();
    }
  });

  it('dedup: second tick does not refire', async () => {
    seedProject();
    seedTask(now() - 60_000);
    repos.notificationRules.insert({
      id: randomId(), status: 'in_progress', minutes: 0, channels: ['desktop'], enabled: true,
    });
    await engine.tick(now());
    expect(notifier.calls.length).toBe(1);
    await engine.tick(now());
    expect(notifier.calls.length).toBe(1); // 防重复
  });

  it('does not fire for non-overdue task', async () => {
    seedProject();
    seedTask(now()); // 刚进入，未逾期
    repos.notificationRules.insert({
      id: randomId(), status: 'in_progress', minutes: 10, channels: ['desktop'], enabled: true,
    });
    const res = await engine.tick(now());
    expect(res.fired).toBe(0);
    expect(notifier.calls.length).toBe(0);
  });

  it('timing restores after restart: overdue recomputed from statusChangedAt', async () => {
    seedProject();
    // 模拟“重启前”任务：statusChangedAt 在很久以前，minutes=1 -> 已逾期。
    seedTask(now() - 120_000);
    repos.notificationRules.insert({
      id: randomId(), status: 'in_progress', minutes: 1, channels: ['desktop'], enabled: true,
    });
    // 新引擎实例（模拟重启后重建）
    const e2 = new TimeoutEngine(repos, notifier, new WebhookSender(repos), { intervalMs: 1000 });
    const res = await e2.tick(now());
    expect(res.fired).toBe(1);
    expect(notifier.calls.length).toBe(1);
    e2.stop();
  });

  it('webhook channel with no configured webhook records suppressed', async () => {
    seedProject();
    const task = seedTask(now() - 60_000);
    repos.notificationRules.insert({
      id: randomId(), status: 'in_progress', minutes: 0, channels: ['webhook'], enabled: true,
    });
    await engine.tick(now());
    const delivs = repos.notificationDeliveries.listByTask(task.id);
    expect(delivs.some((d) => d.status === 'suppressed')).toBe(true);
  });
});
