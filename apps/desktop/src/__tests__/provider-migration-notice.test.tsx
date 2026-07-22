import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

describe('ProviderMigrationNotice', () => {
  it('renders an actionable sanitized re-entry notice for both recoverable states', async () => {
    Object.assign(globalThis, { window: { api: {} } });
    const settings = await import('../pages/Settings.js') as Record<string, unknown>;
    const Notice = settings.ProviderMigrationNotice as React.ComponentType<{
      state: 'ready' | 'needs_reentry' | 'failed';
      onReenter(): void;
    }> | undefined;
    expect(Notice).toBeTypeOf('function');
    if (!Notice) return;

    for (const state of ['needs_reentry', 'failed'] as const) {
      const html = renderToStaticMarkup(<Notice state={state} onReenter={() => undefined} />);
      expect(html).toContain(`data-migration-state="${state}"`);
      expect(html).toContain('data-testid="provider-migration-reentry"');
      expect(html).not.toMatch(/api.?key|model|tool|prompt/i);
    }
    expect(renderToStaticMarkup(<Notice state="ready" onReenter={() => undefined} />)).toBe('');
  });
});
