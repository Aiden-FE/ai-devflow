import { describe, expect, it, vi } from 'vitest';
import type { ProviderConfig } from '@ai-devflow/core';
import { fetchCompatibleModels } from '../provider-models.js';

const baseConfig: ProviderConfig = {
  id: 'p1', kind: 'openai_compatible', displayName: 'G', enabled: true,
  priority: 0, authType: 'api_key', credentialRef: 'provider:p1', revision: 1,
  baseURL: 'https://gateway.example/v1', defaultModel: 'm',
};

describe('fetchCompatibleModels', () => {
  it('returns empty for non-compatible kinds', async () => {
    const result = await fetchCompatibleModels({ ...baseConfig, kind: 'openai' } as ProviderConfig, 'secret');
    expect(result).toEqual([]);
  });

  it('parses OpenAI-compatible /v1/models response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'b' }, { id: 'a' }] }),
    });
    const result = await fetchCompatibleModels(baseConfig, 'sk-test');
    expect(result).toEqual(['a', 'b']);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://gateway.example/v1/models',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer sk-test' }) }),
    );
  });

  it('parses Anthropic-compatible /v1/models response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'claude-x' }] }),
    });
    const result = await fetchCompatibleModels({ ...baseConfig, kind: 'anthropic_compatible' } as ProviderConfig, 'sk-test');
    expect(result).toEqual(['claude-x']);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://gateway.example/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-api-key': 'sk-test',
          'anthropic-version': '2023-06-01',
        }),
      }),
    );
  });

  it('returns empty on fetch error', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network'));
    const result = await fetchCompatibleModels(baseConfig, 'sk-test');
    expect(result).toEqual([]);
  });
});
