// Webhook Payload 构造与 HMAC-SHA256 签名。
// 使用 Web Crypto（globalThis.crypto），在 Node 22+ 与浏览器均可用，保持 core 零 Node 依赖。

import type { Task } from './types.js';

export const WEBHOOK_SIGNATURE_HEADER = 'X-AiDevflow-Signature';

export interface WebhookEvent {
  event: string;
  task: Pick<Task, 'id' | 'title' | 'status' | 'projectId' | 'iterationId'>;
  t: number;
  detail?: unknown;
}

export function buildWebhookPayload(
  event: string,
  task: WebhookEvent['task'],
  detail?: unknown,
  t: number = 0,
): WebhookEvent {
  return { event, task, t, detail };
}

/** 将对象序列化为稳定 JSON（键排序），保证签名与投递一致。 */
export function canonicalStringify(obj: unknown): string {
  return JSON.stringify(sortKeys(obj));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

function encoders(): { TextEncoder: typeof globalThis.TextEncoder } {
  return { TextEncoder: globalThis.TextEncoder };
}

/** HMAC-SHA256(secret, body) -> hex。 */
export async function signBody(secret: string, body: string): Promise<string> {
  const { TextEncoder } = encoders();
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  const sig = await globalThis.crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return toHex(new Uint8Array(sig));
}

export async function signPayload(
  secret: string,
  payload: WebhookEvent,
): Promise<{ body: string; signature: string; header: string }> {
  const body = canonicalStringify(payload);
  const hex = await signBody(secret, body);
  return { body, signature: `sha256=${hex}`, header: WEBHOOK_SIGNATURE_HEADER };
}

export async function verifySignature(
  secret: string,
  body: string,
  signature: string,
): Promise<boolean> {
  const expected = await signBody(secret, body);
  // signature 形如 "sha256=<hex>" 或裸 hex，兼容两种。
  const incoming = signature.startsWith('sha256=') ? signature.slice('sha256='.length) : signature;
  return constantTimeEqual(expected, incoming.toLowerCase());
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}
