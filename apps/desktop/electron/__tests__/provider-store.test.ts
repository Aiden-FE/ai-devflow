import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories, openDatabase } from '@ai-devflow/persistence';
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
    expect(harness.store.list()).toEqual([expect.objectContaining({ kind: 'anthropic', priority: 0, baseURL: undefined })]);
    expect(harness.store.resolveSecret(harness.store.listConfigs()[0]!.id)).toBe('legacy');
    expect(harness.credentials.get('ai_provider')).toBeUndefined();
    harness.store.migrateLegacy();
    expect(harness.store.list()).toHaveLength(1);
  });

  it('migrates a custom legacy URL as compatible and reindexes it before existing providers', () => {
    const harness = makeProviderStoreHarness();
    harness.store.save({ id: 'a', kind: 'google', displayName: 'A', enabled: true, priority: 0, authType: 'api_key', apiKey: 'a', revision: 1 });
    harness.store.save({ id: 'b', kind: 'deepseek', displayName: 'B', enabled: true, priority: 1, authType: 'api_key', apiKey: 'b', revision: 1 });
    harness.credentials.upsert('ai_provider', harness.encrypt(JSON.stringify({
      provider: 'openai', apiKey: 'legacy', baseURL: 'https://gateway.example/v1', model: 'discarded',
    })));

    expect(harness.store.migrateLegacy()).toBe('migrated');
    const configs = harness.store.listConfigs();
    expect(configs.map((provider) => provider.priority)).toEqual([0, 1, 2]);
    expect(configs.map((provider) => provider.id).slice(1)).toEqual(['a', 'b']);
    expect(configs[0]).toEqual(expect.objectContaining({
      kind: 'openai_compatible',
      baseURL: 'https://gateway.example/v1',
      priority: 0,
    }));
  });

  it('completes legacy re-entry atomically and promotes the replacement provider', () => {
    const harness = makeProviderStoreHarness();
    harness.store.save({ id: 'existing', kind: 'google', displayName: 'Existing', enabled: true, priority: 0, authType: 'api_key', apiKey: 'existing', revision: 1 });
    harness.credentials.upsert('ai_provider', 'enc:undecryptable');

    const replacement = harness.store.completeLegacyReentry({
      id: 'replacement', kind: 'anthropic_compatible', displayName: 'Replacement', enabled: true,
      priority: 99, authType: 'api_key', apiKey: 'new-secret', baseURL: 'https://gateway.example', revision: 1,
    });

    expect(replacement).toEqual(expect.objectContaining({ id: 'replacement', priority: 0, hasCredential: true }));
    expect(harness.store.list().map((provider) => [provider.id, provider.priority])).toEqual([
      ['replacement', 0],
      ['existing', 1],
    ]);
    expect(harness.credentials.get('ai_provider')).toBeUndefined();
    expect(harness.credentials.get('provider-migration:v1')).toBeDefined();
    expect(harness.store.resolveSecret('replacement')).toBe('new-secret');
  });

  it('leaves an undecryptable legacy config in place without a marker', () => {
    const harness = makeProviderStoreHarness();
    harness.credentials.upsert('ai_provider', 'enc:not-valid-base64-json');
    harness.store.migrateLegacy();
    expect(harness.store.list()).toEqual([]);
    // No marker and the old ciphertext is preserved for the user to re-enter the key.
    expect(harness.credentials.get('ai_provider')).toBeDefined();
  });

  it('rolls back metadata, key, marker, and legacy deletion in one real SQLite transaction', () => {
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'aidf-provider-migration-')), 'app.db'));
    const repos = createRepositories(db);
    const encrypt = (value: string) => `enc:${Buffer.from(value).toString('base64')}`;
    const decrypt = (value: string) => Buffer.from(value.slice(4), 'base64').toString();
    repos.credentials.upsert('ai_provider', encrypt(JSON.stringify({
      provider: 'openai', apiKey: 'legacy-key', model: 'discard-me',
    })));
    const store = new ProviderStore(
      {
        get: (key) => repos.credentials.get(key),
        upsert: (key, value) => {
          if (key === 'provider-migration:v1') throw new Error('injected marker failure');
          repos.credentials.upsert(key, value);
        },
        delete: (key) => repos.credentials.delete(key),
        transaction: (fn) => (repos.credentials as typeof repos.credentials & {
          transaction<T>(work: () => T): T;
        }).transaction(fn),
      },
      { encrypt, decrypt },
      () => undefined,
    );

    expect(() => store.migrateLegacy()).toThrow(/injected marker failure/);
    expect(repos.credentials.get('ai_provider')).toBeDefined();
    expect(repos.credentials.get('providers:v1')).toBeUndefined();
    expect(repos.credentials.get('provider-migration:v1')).toBeUndefined();
    expect(store.listConfigs()).toEqual([]);
    db.close();
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

  it('lists provider without models as configuration_error', () => {
    const harness = makeProviderStoreHarness();
    harness.store.save({
      id: 'p1', kind: 'openai', displayName: 'O', enabled: true,
      priority: 0, authType: 'api_key', apiKey: 'k', revision: 1,
      defaultModel: 'm',
    });
    // simulate legacy provider with no models by directly editing config
    const config = harness.store.listConfigs()[0]!;
    delete (config as Partial<typeof config>).defaultModel;
    harness.store.save({ ...config, apiKey: 'k2' });
    expect(harness.store.list()[0]!.health).toBe('configuration_error');
  });

  it('bumps revision and clears health when model config changes', () => {
    const harness = makeProviderStoreHarness();
    harness.store.save({
      id: 'p1', kind: 'openai', displayName: 'O', enabled: true,
      priority: 0, authType: 'api_key', apiKey: 'k', revision: 1,
      defaultModel: 'm1',
    });
    expect(harness.store.list()[0]!.revision).toBe(1);
    harness.store.save({
      id: 'p1', kind: 'openai', displayName: 'O', enabled: true,
      priority: 0, authType: 'api_key', apiKey: 'k', revision: 1,
      defaultModel: 'm2',
    });
    expect(harness.store.list()[0]!.revision).toBe(2);
    expect(harness.cleared).toContain('p1');
  });
});
