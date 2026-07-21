import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { openDatabase, createRepositories, type Repositories } from '@ai-devflow/persistence';
import type { DatabaseSync } from '@ai-devflow/persistence';
import { WebhookSender, signPayload, WEBHOOK_SIGNATURE_HEADER } from '../webhook.js';
import { verifySignature, randomId } from '@ai-devflow/core';
import type { WebhookConfig } from '@ai-devflow/core';

let db: DatabaseSync;
let repos: Repositories;

function fresh() {
  db = openDatabase(':memory:');
  repos = createRepositories(db);
}

afterEach(() => {
  try { db.close(); } catch { /* */ }
});

function startServer(handler: (req: IncomingMessage, body: string, res: ServerResponse) => void): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => handler(req, body, res));
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}/hook` });
    });
  });
}

function cfg(url: string, secret = 'sek', events = ['task.timeout']): WebhookConfig {
  return { id: randomId(), name: 'W', url, secret, events, enabled: true, createdAt: Date.now() };
}

describe('webhook sender', () => {
  it('delivers signed payload to local server and records ok delivery', async () => {
    fresh();
    let received = { body: '', sig: '', ct: '' };
    const { server, url } = await startServer((req, body, res) => {
      received = { body, sig: req.headers[WEBHOOK_SIGNATURE_HEADER.toLowerCase()] as string, ct: req.headers['content-type'] as string };
      res.statusCode = 200;
      res.end('ok');
    });
    try {
      const sender = new WebhookSender(repos, { maxAttempts: 1, timeoutMs: 2000 });
      const c = cfg(url, 'mysecret');
      repos.webhookConfigs.insert(c);
      const res = await sender.deliver(c, 'task.timeout', { id: 't1', title: 'T', status: 'in_progress', projectId: 'p', iterationId: 'i' });
      expect(res.ok).toBe(true);
      expect(res.status).toBe(200);
      // 签名验证
      expect(await verifySignature('mysecret', received.body, received.sig)).toBe(true);
      expect(received.ct).toBe('application/json');
      // 投递历史
      const deliveries = repos.webhookDeliveries.listByWebhook(c.id);
      expect(deliveries.length).toBe(1);
      expect(deliveries[0]!.ok).toBe(true);
      expect(deliveries[0]!.status).toBe(200);
    } finally {
      server.close();
    }
  });

  it('retries on 5xx and records each attempt', async () => {
    fresh();
    let hits = 0;
    const { server, url } = await startServer((_req, _body, res) => {
      hits++;
      res.statusCode = 500;
      res.end('err');
    });
    try {
      const sender = new WebhookSender(repos, { maxAttempts: 2, timeoutMs: 2000, baseDelayMs: 10 });
      const c = cfg(url);
      repos.webhookConfigs.insert(c);
      const res = await sender.deliver(c, 'task.timeout', { id: 't1', title: 'T', status: 'in_progress', projectId: 'p', iterationId: 'i' });
      expect(res.ok).toBe(false);
      expect(res.attempts).toBe(2);
      expect(hits).toBe(2);
      expect(repos.webhookDeliveries.listByWebhook(c.id).length).toBe(2);
    } finally {
      server.close();
    }
  });

  it('records failed delivery on network error (bad host)', async () => {
    fresh();
    const sender = new WebhookSender(repos, { maxAttempts: 1, timeoutMs: 1000 });
    const c = cfg('http://127.0.0.1:1/nope'); // 端口 1 通常无服务
    repos.webhookConfigs.insert(c);
    const res = await sender.deliver(c, 'task.timeout', { id: 't1', title: 'T', status: 'in_progress', projectId: 'p', iterationId: 'i' });
    expect(res.ok).toBe(false);
    const deliveries = repos.webhookDeliveries.listByWebhook(c.id);
    expect(deliveries.length).toBe(1);
    expect(deliveries[0]!.ok).toBe(false);
    expect(deliveries[0]!.status).toBe(0);
  });

  it('test() sends a webhook.test event', async () => {
    fresh();
    let event = '';
    const { server, url } = await startServer((_req, body, res) => {
      event = JSON.parse(body).event;
      res.statusCode = 200;
      res.end('ok');
    });
    try {
      const sender = new WebhookSender(repos, { maxAttempts: 1, timeoutMs: 2000 });
      const c = cfg(url);
      repos.webhookConfigs.insert(c);
      const res = await sender.test(c);
      expect(res.ok).toBe(true);
      expect(event).toBe('webhook.test');
    } finally {
      server.close();
    }
  });

  it('signPayload produces header matching sender', async () => {
    const { body, signature } = await signPayload('s', { event: 'e', task: { id: 't', title: 'T', status: 'backlog', projectId: 'p', iterationId: 'i' }, t: 1 });
    expect(signature.startsWith('sha256=')).toBe(true);
    expect(await verifySignature('s', body, signature)).toBe(true);
  });
});
