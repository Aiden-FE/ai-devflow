import { describe, expect, it } from 'vitest';
import { ProviderStore } from '../provider-store.js';

function makeProviderStoreHarness(opts: { encryptThrows?: boolean } = {}) {
  const values = new Map<string, string>();
  const credentials = {
    get: (key: string) => values.get(key),
    upsert: (key: string, value: string) => {
      values.set(key, value);
    },
    delete: (key: string) => {
      values.delete(key);
    },
    transaction: <T>(fn: () => T) => fn(),
  };
  const cleared: string[] = [];
  const encrypt = (value: string) => {
    if (opts.encryptThrows) throw new Error('安全存储不可用');
    return `enc:${Buffer.from(value).toString('base64')}`;
  };
  const decrypt = (value: string) => Buffer.from(value.slice(4), 'base64').toString();
  const store = new ProviderStore(credentials, { encrypt, decrypt }, (id) => cleared.push(id));
  return { store, credentials, encrypt, decrypt, cleared };
}

describe('ProviderStore', () => {
  it('never returns the saved key and preserves order', () => {
    const harness = makeProviderStoreHarness();
    harness.store.save({
      id: 'p1', kind: 'openai', displayName: 'OpenAI', enabled: true,
      priority: 0, authType: 'api_key', apiKey: 'sk-secret', revision: 1,
    });
    expect(harness.store.list()).toEqual([expect.objectContaining({ id: 'p1', hasCredential: true })]);
    expect(JSON.stringify(harness.store.list())).not.toContain('sk-secret');
    expect(JSON.stringify(harness.store.listConfigs())).not.toContain('sk-secret');
    expect(harness.store.resolveSecret('p1')).toBe('sk-secret');
  });

  it('migrates credentials.ai_provider once and discards its model', () => {
    const harness = makeProviderStoreHarness();
    harness.credentials.upsert('ai_provider', harness.encrypt(JSON.stringify({
      provider: 'anthropic', apiKey: 'legacy', baseURL: 'https://api.anthropic.com', model: 'ignored',
    })));
    harness.store.migrateLegacy();
    expect(harness.store.list()).toEqual([expect.objectContaining({ kind: 'anthropic', priority: 0 })]);
    expect(harness.store.resolveSecret(harness.store.listConfigs()[0]!.id)).toBe('legacy');
    expect(harness.credentials.get('ai_provider')).toBeUndefined();
    harness.store.migrateLegacy();
    expect(harness.store.list()).toHaveLength(1);
  });

  it('leaves an undecryptable legacy config in place without a marker', () => {
    const harness = makeProviderStoreHarness();
    harness.credentials.upsert('ai_provider', 'enc:not-valid-base64-json');
    harness.store.migrateLegacy();
    expect(harness.store.list()).toEqual([]);
    // No marker and the old ciphertext is preserved for the user to re-enter the key.
    expect(harness.credentials.get('ai_provider')).toBeDefined();
  });

  it('fails closed when secure encryption is unavailable', () => {
    const harness = makeProviderStoreHarness({ encryptThrows: true });
    expect(() => harness.store.save({
      id: 'p1', kind: 'openai', displayName: 'OpenAI', enabled: true,
      priority: 0, authType: 'api_key', apiKey: 'sk-secret', revision: 1,
    })).toThrow(/安全存储不可用/);
    expect(harness.store.list()).toEqual([]);
  });

  it('reorders by a complete id permutation and rejects bad input', () => {
    const harness = makeProviderStoreHarness();
    harness.store.save({ id: 'a', kind: 'openai', displayName: 'A', enabled: true, priority: 0, authType: 'api_key', apiKey: 'k', revision: 1 });
    harness.store.save({ id: 'b', kind: 'openai', displayName: 'B', enabled: true, priority: 1, authType: 'api_key', apiKey: 'k', revision: 1 });
    harness.store.reorder(['b', 'a']);
    expect(harness.store.list().map((s) => s.id)).toEqual(['b', 'a']);
    expect(() => harness.store.reorder(['a'])).toThrow();
    expect(() => harness.store.reorder(['a', 'a'])).toThrow();
    expect(() => harness.store.reorder(['a', 'x'])).toThrow();
  });

  it('increments revision only on kind/baseURL/enabled/secret change and clears health', () => {
    const harness = makeProviderStoreHarness();
    harness.store.save({ id: 'p1', kind: 'openai', displayName: 'O', enabled: true, priority: 0, authType: 'api_key', apiKey: 'k1', revision: 1 });
    expect(harness.store.list()[0]!.revision).toBe(1);
    // displayName-only change does not bump revision.
    harness.store.save({ id: 'p1', kind: 'openai', displayName: 'O2', enabled: true, priority: 0, authType: 'api_key', revision: 1 });
    expect(harness.store.list()[0]!.revision).toBe(1);
    expect(harness.store.list()[0]!.displayName).toBe('O2');
    expect(harness.cleared).not.toContain('p1');
    // New secret bumps revision and clears health.
    harness.store.save({ id: 'p1', kind: 'openai', displayName: 'O2', enabled: true, priority: 0, authType: 'api_key', apiKey: 'k2', revision: 1 });
    expect(harness.store.list()[0]!.revision).toBe(2);
    expect(harness.cleared).toContain('p1');
  });

  it('removes a provider with its secret', () => {
    const harness = makeProviderStoreHarness();
    harness.store.save({ id: 'a', kind: 'openai', displayName: 'A', enabled: true, priority: 0, authType: 'api_key', apiKey: 'k', revision: 1 });
    harness.store.remove('a');
    expect(harness.store.list()).toEqual([]);
    expect(harness.store.resolveSecret('a')).toBeUndefined();
    expect(harness.cleared).toContain('a');
  });
});
