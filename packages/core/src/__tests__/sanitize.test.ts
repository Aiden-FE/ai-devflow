import { describe, it, expect } from 'vitest';
import {
  validateProjectName,
  validateLocalPath,
  validateWebhookUrl,
  validateMinutes,
  validatePrompt,
  redactText,
  redactObject,
  SENSITIVE_FIELDS,
} from '../sanitize.js';

describe('input validation', () => {
  it('validateProjectName rejects empty, long, angle brackets', () => {
    expect(validateProjectName('').ok).toBe(false);
    expect(validateProjectName('   ').ok).toBe(false);
    expect(validateProjectName('a'.repeat(121)).ok).toBe(false);
    expect(validateProjectName('bad <name>').ok).toBe(false);
    expect(validateProjectName('My Project').ok).toBe(true);
  });

  it('validateLocalPath requires absolute path', () => {
    expect(validateLocalPath('relative/path').ok).toBe(false);
    expect(validateLocalPath('').ok).toBe(false);
    expect(validateLocalPath('/abs/path').ok).toBe(true);
  });

  it('validateWebhookUrl only allows http/https', () => {
    expect(validateWebhookUrl('ftp://x').ok).toBe(false);
    expect(validateWebhookUrl('not a url').ok).toBe(false);
    expect(validateWebhookUrl('http://localhost:9000/hook').ok).toBe(true);
    expect(validateWebhookUrl('https://example.com/hook').ok).toBe(true);
  });

  it('validateMinutes requires positive finite', () => {
    expect(validateMinutes(0).ok).toBe(false);
    expect(validateMinutes(-5).ok).toBe(false);
    expect(validateMinutes(NaN).ok).toBe(false);
    expect(validateMinutes(10).ok).toBe(true);
  });

  it('validatePrompt rejects empty and overlong', () => {
    expect(validatePrompt('').ok).toBe(false);
    expect(validatePrompt('x'.repeat(50_001)).ok).toBe(false);
    expect(validatePrompt('do the thing').ok).toBe(true);
  });
});

describe('sensitive field redaction', () => {
  it('redactText masks known secret patterns', () => {
    expect(redactText('key=sk-abcd1234efgh5678ijklmnop')).toBe('key=sk-***');
    expect(redactText('Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456')).toMatch(/Bearer \*\*\*/);
    expect(redactText('aws AKIAIOSFODNN7EXAMPLE')).toBe('aws AKIA***');
  });

  it('redactObject masks sensitive keys entirely', () => {
    const out = redactObject({ name: 'x', secret: 'topsecret', apiKey: 'abc', nested: { token: 't', safe: 1 } });
    expect(out.secret).toBe('***');
    expect(out.apiKey).toBe('***');
    expect(out.nested!.token).toBe('***');
    expect(out.nested!.safe).toBe(1);
    expect(out.name).toBe('x');
  });

  it('redactObject redacts long opaque strings in values', () => {
    const long = 'a'.repeat(40);
    const out = redactObject({ note: `token=${long}` });
    expect(out.note).not.toContain(long);
  });

  it('SENSITIVE_FIELDS includes common names', () => {
    expect(SENSITIVE_FIELDS.has('secret')).toBe(true);
    expect(SENSITIVE_FIELDS.has('authorization')).toBe(true);
    expect(SENSITIVE_FIELDS.has('password')).toBe(true);
  });
});
