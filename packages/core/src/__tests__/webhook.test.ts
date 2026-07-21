import { describe, it, expect } from 'vitest';
import {
  buildWebhookPayload,
  canonicalStringify,
  signPayload,
  signBody,
  verifySignature,
  WEBHOOK_SIGNATURE_HEADER,
} from '../webhook.js';

describe('webhook payload & signature', () => {
  it('buildWebhookPayload includes event, task, t', () => {
    const p = buildWebhookPayload('task.stuck', { id: 't1', title: 'T', status: 'in_progress', projectId: 'p1', iterationId: 'i1' }, { minutes: 10 }, 123);
    expect(p.event).toBe('task.stuck');
    expect(p.task.id).toBe('t1');
    expect(p.t).toBe(123);
  });

  it('canonicalStringify sorts keys deterministically', () => {
    const a = canonicalStringify({ b: 1, a: 2, c: { z: 1, a: 2 } });
    const b = canonicalStringify({ c: { a: 2, z: 1 }, a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":{"a":2,"z":1}}');
  });

  it('signPayload produces sha256= hex header', async () => {
    const p = buildWebhookPayload('task.stuck', { id: 't1', title: 'T', status: 'in_progress', projectId: 'p1', iterationId: 'i1' });
    const { body, signature, header } = await signPayload('secret', p);
    expect(header).toBe(WEBHOOK_SIGNATURE_HEADER);
    expect(signature.startsWith('sha256=')).toBe(true);
    expect(signature.length).toBe('sha256='.length + 64); // 32 bytes hex
    expect(body).toBe(canonicalStringify(p));
  });

  it('verifySignature accepts correct signature', async () => {
    const body = '{"a":1}';
    const sig = await signBody('sek', body);
    expect(await verifySignature('sek', body, `sha256=${sig}`)).toBe(true);
    expect(await verifySignature('sek', body, sig)).toBe(true);
  });

  it('verifySignature rejects wrong secret or tampered body', async () => {
    const body = '{"a":1}';
    const sig = await signBody('sek', body);
    expect(await verifySignature('wrong', body, `sha256=${sig}`)).toBe(false);
    expect(await verifySignature('sek', '{"a":2}', `sha256=${sig}`)).toBe(false);
  });

  it('signatures differ across secrets', async () => {
    const p = buildWebhookPayload('e', { id: 't', title: 'x', status: 'backlog', projectId: 'p', iterationId: 'i' });
    const s1 = await signPayload('a', p);
    const s2 = await signPayload('b', p);
    expect(s1.signature).not.toBe(s2.signature);
  });
});
