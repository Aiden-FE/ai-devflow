import { describe, expect, it } from 'vitest';
import { normalizeProviderInput } from '../provider.js';

describe('normalizeProviderInput', () => {
  it('normalizes a compatible provider without retaining a plaintext key', () => {
    const result = normalizeProviderInput({
      id: 'p1', kind: 'openai_compatible', displayName: 'Dev', enabled: true,
      priority: 2, authType: 'api_key', apiKey: 'secret', baseURL: 'https://gateway.example/v1',
      allowInsecureLocal: false, revision: 4,
    });
    expect(result.config).toEqual({
      id: 'p1', kind: 'openai_compatible', displayName: 'Dev', enabled: true,
      priority: 2, authType: 'api_key', credentialRef: 'provider:p1',
      baseURL: 'https://gateway.example/v1', revision: 4,
    });
    expect(result.secret).toBe('secret');
  });

  it('rejects credentials embedded in a URL', () => {
    expect(() => normalizeProviderInput({
      id: 'p1', kind: 'openai_compatible', displayName: 'Dev', enabled: true,
      priority: 0, authType: 'api_key', apiKey: 'secret', baseURL: 'https://u:p@gateway.example/v1', revision: 1,
    })).toThrow(/用户名或密码/);
  });

  it('requires an explicit opt-in for loopback HTTP', () => {
    expect(() => normalizeProviderInput({
      id: 'p1', kind: 'openai_compatible', displayName: 'Local', enabled: true,
      priority: 0, authType: 'api_key', apiKey: 'secret', baseURL: 'http://127.0.0.1:11434/v1', revision: 1,
    })).toThrow(/本地 HTTP/);
    expect(normalizeProviderInput({
      id: 'p1', kind: 'openai_compatible', displayName: 'Local', enabled: true,
      priority: 0, authType: 'api_key', apiKey: 'secret', baseURL: 'http://127.0.0.1:11434/v1',
      allowInsecureLocal: true, revision: 1,
    }).config.baseURL).toBe('http://127.0.0.1:11434/v1');
  });

  it('rejects query or fragment in the Base URL', () => {
    expect(() => normalizeProviderInput({
      id: 'p1', kind: 'openai_compatible', displayName: 'Dev', enabled: true,
      priority: 0, authType: 'api_key', apiKey: 'secret', baseURL: 'https://gateway.example/v1?api_key=x', revision: 1,
    })).toThrow(/query 或 fragment/);
    expect(() => normalizeProviderInput({
      id: 'p1', kind: 'openai_compatible', displayName: 'Dev', enabled: true,
      priority: 0, authType: 'api_key', apiKey: 'secret', baseURL: 'https://gateway.example/v1#frag', revision: 1,
    })).toThrow(/query 或 fragment/);
  });

  it('forbids non-API-Key auth in the first version', () => {
    expect(() => normalizeProviderInput({
      id: 'p1', kind: 'openai', displayName: 'O', enabled: true,
      priority: 0, authType: 'oauth', apiKey: 'secret', revision: 1,
    })).toThrow(/API Key/);
  });

  it('requires Base URL for compatible kinds and forbids it for standard kinds', () => {
    expect(() => normalizeProviderInput({
      id: 'p1', kind: 'openai_compatible', displayName: 'Dev', enabled: true,
      priority: 0, authType: 'api_key', apiKey: 'secret', revision: 1,
    })).toThrow(/Base URL/);
    expect(() => normalizeProviderInput({
      id: 'p1', kind: 'openai', displayName: 'O', enabled: true,
      priority: 0, authType: 'api_key', apiKey: 'secret', baseURL: 'https://x.example', revision: 1,
    })).toThrow(/标准提供商/);
  });
});
