// Webhook 投递：构造 Payload、HMAC 签名、POST、失败重试、记录投递历史。
import type { Repositories } from '@ai-devflow/persistence';
import {
  buildWebhookPayload,
  signPayload,
  canonicalStringify,
  WEBHOOK_SIGNATURE_HEADER,
  redactText,
  randomId,
  now,
} from '@ai-devflow/core';
import type { WebhookConfig, WebhookDelivery, Task } from '@ai-devflow/core';

export interface WebhookDeliverResult {
  ok: boolean;
  status: number;
  attempts: number;
  lastError?: string;
}

export class WebhookSender {
  constructor(
    private repos: Repositories,
    private opts: { maxAttempts?: number; timeoutMs?: number; baseDelayMs?: number } = {},
  ) {}

  async deliver(
    config: WebhookConfig,
    event: string,
    task: Pick<Task, 'id' | 'title' | 'status' | 'projectId' | 'iterationId'>,
    detail?: unknown,
  ): Promise<WebhookDeliverResult> {
    const payload = buildWebhookPayload(event, task, detail, now());
    const { body, signature, header } = await signPayload(config.secret, payload);
    const maxAttempts = this.opts.maxAttempts ?? 3;
    const timeoutMs = this.opts.timeoutMs ?? 10_000;
    const baseDelay = this.opts.baseDelayMs ?? 1000;

    let lastError: string | undefined;
    let lastStatus = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const t0 = now();
      let ok = false;
      let status = 0;
      let snippet = '';
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        const res = await fetch(config.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [header]: signature,
            'user-agent': 'ai-devflow/1.0',
          },
          body,
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        status = res.status;
        ok = res.ok;
        snippet = redactText(await res.text().catch(() => '')).slice(0, 500);
      } catch (err) {
        lastError = (err as Error).message;
        status = 0;
        snippet = redactText(lastError).slice(0, 500);
      }
      lastStatus = status;
      const delivery: WebhookDelivery = {
        id: randomId(),
        webhookId: config.id,
        taskId: task.id,
        event,
        payload: body,
        status,
        attempt,
        sentAt: now(),
        durationMs: now() - t0,
        responseSnippet: snippet,
        ok,
      };
      this.repos.webhookDeliveries.insert(delivery);
      if (ok) return { ok: true, status, attempts: attempt };
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, baseDelay * Math.pow(2, attempt - 1)));
      }
    }
    return { ok: false, status: lastStatus, attempts: maxAttempts, lastError };
  }

  /** 测试投递：用配置发送一个 webhook.test 事件，返回结果（不进入重试退避的长等待）。 */
  async test(config: WebhookConfig): Promise<WebhookDeliverResult> {
    return this.deliver(
      config,
      'webhook.test',
      { id: 'test', title: '测试投递', status: 'backlog', projectId: '', iterationId: '' },
      { note: 'manual test' },
    );
  }

  /** 验证给定 body 与签名是否匹配（用于接收方自检或文档）。 */
  static async verify(secret: string, body: string, signature: string): Promise<boolean> {
    const { verifySignature } = await import('@ai-devflow/core');
    return verifySignature(secret, body, signature);
  }
}

export { buildWebhookPayload, signPayload, canonicalStringify, WEBHOOK_SIGNATURE_HEADER };
