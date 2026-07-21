import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { normalizeAnthropicBaseURL, sanitizeUrl, testConnection, buildTestRequest } from '../ai.js';
import type { AiProviderConfig } from '@ai-devflow/core';

describe('normalizeAnthropicBaseURL', () => {
  it('appends /v1 to a host root', () => {
    expect(normalizeAnthropicBaseURL('https://api.example.com')).toBe('https://api.example.com/v1');
    expect(normalizeAnthropicBaseURL('https://api.example.com/')).toBe('https://api.example.com/v1');
  });
  it('keeps a /v1 prefix unchanged', () => {
    expect(normalizeAnthropicBaseURL('https://api.example.com/v1')).toBe('https://api.example.com/v1');
  });
  it('strips a trailing /messages so /v1/messages is not duplicated', () => {
    expect(normalizeAnthropicBaseURL('https://api.example.com/v1/messages')).toBe('https://api.example.com/v1');
  });
  it('returns undefined for empty input', () => {
    expect(normalizeAnthropicBaseURL(undefined)).toBeUndefined();
    expect(normalizeAnthropicBaseURL('  ')).toBeUndefined();
  });
});

describe('sanitizeUrl', () => {
  it('strips embedded credentials', () => {
    expect(sanitizeUrl('https://user:pass@api.example.com/v1')).toBe('https://api.example.com/v1');
  });
  it('keeps a clean url intact', () => {
    expect(sanitizeUrl('https://api.example.com/v1/messages')).toBe('https://api.example.com/v1/messages');
  });
});

describe('buildTestRequest', () => {
  it('puts the API key in headers (never the URL) for anthropic and targets /v1/messages', () => {
    const cfg: AiProviderConfig = { provider: 'anthropic', apiKey: 'sk-secret', model: 'claude-x', baseURL: 'https://h' };
    const { url, headers } = buildTestRequest(cfg);
    expect(url).toBe('https://h/v1/messages');
    expect(url).not.toContain('sk-secret');
    expect(headers['x-api-key']).toBe('sk-secret');
    expect(headers['authorization']).toBe('Bearer sk-secret');
    expect(headers['anthropic-version']).toBeTruthy();
  });
  it('targets /chat/completions for openai and passes baseURL through', () => {
    const cfg: AiProviderConfig = { provider: 'openai', apiKey: 'sk-o', model: 'gpt-x', baseURL: 'https://o/v1' };
    const { url, headers } = buildTestRequest(cfg);
    expect(url).toBe('https://o/v1/chat/completions');
    expect(headers['authorization']).toBe('Bearer sk-o');
  });
});

describe('testConnection (local mock HTTP server)', () => {
  let server: Server;
  let base: string;
  let lastReq: { method?: string; url?: string; headers: Record<string, string | string[] | undefined> } = { headers: {} };

  beforeAll(async () => {
    server = createServer((req, res) => {
      lastReq = { method: req.method, url: req.url, headers: req.headers };
      // 仅当命中 Anthropic messages 路径才视为成功，其余 404（模拟配置错误）。
      if (req.url === '/v1/messages') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'pong' }] }));
      } else {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Not Found: ${req.url}` } }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('succeeds against the normalized /v1/messages path and sends anthropic auth headers', async () => {
    const r = await testConnection({ provider: 'anthropic', apiKey: 'sk-test', model: 'claude-x', baseURL: base });
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(lastReq.url).toBe('/v1/messages');
    expect(lastReq.headers['x-api-key']).toBe('sk-test');
    expect(lastReq.headers['authorization']).toBe('Bearer sk-test');
    // 结果 URL 脱敏且不含密钥
    expect(r.url).not.toContain('sk-test');
  });

  it('normalizes a full /v1/messages baseURL without duplication', async () => {
    const r = await testConnection({ provider: 'anthropic', apiKey: 'sk-test', model: 'claude-x', baseURL: `${base}/v1/messages` });
    expect(r.ok).toBe(true);
    expect(lastReq.url).toBe('/v1/messages'); // 不是 /v1/messages/v1/messages
  });

  it('reports a 404 with sanitized url + server summary on a wrong path', async () => {
    const r = await testConnection({ provider: 'anthropic', apiKey: 'sk-test', model: 'claude-x', baseURL: `${base}/gateway` });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
    expect(r.url).toContain('/gateway/v1/messages');
    expect(r.serverSummary).toContain('Not Found');
    expect(r.error).toMatch(/404/);
  });

  it('fails fast without an API key (no request sent)', async () => {
    const r = await testConnection({ provider: 'anthropic', apiKey: '', model: 'claude-x', baseURL: base });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/API Key/);
  });
});
