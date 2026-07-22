import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
    getAppPath: () => '/tmp/app',
    isPackaged: false,
    getVersion: () => '0.0.0',
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    getSelectedStorageBackend: () => 'basic_text',
  },
}));

import { initializeServices } from '../services.js';

describe('initializeServices', () => {
  const calls: string[] = [];

  beforeEach(() => calls.splice(0));

  it('awaits credential migration before runtime verification', async () => {
    const status = await initializeServices({
      piRuntime: {
        providerStore: {
          migrateLegacy() {
            calls.push('migration');
            return 'migrated';
          },
        },
        locator: {
          async verify() {
            calls.push('runtime');
            return { version: '0.80.10', entry: '/verified/pi' };
          },
        },
      },
    });

    expect(calls).toEqual(['migration', 'runtime']);
    expect(status).toEqual({ credentialMigration: 'migrated', runtime: 'ready' });
  });

  it('returns a sanitized migration failure status without leaking the thrown message', async () => {
    const status = await initializeServices({
      piRuntime: {
        providerStore: {
          migrateLegacy() {
            throw new Error('secret-provider-key should never escape');
          },
        },
        locator: {
          async verify() {
            return { version: '0.80.10', entry: '/verified/pi' };
          },
        },
      },
    });

    expect(status.credentialMigration).toBe('failed');
    expect(JSON.stringify(status)).not.toContain('secret-provider-key');
    expect(status.runtime).toBe('ready');
  });
});
