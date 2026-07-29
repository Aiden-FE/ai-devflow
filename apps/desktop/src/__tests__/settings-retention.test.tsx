import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

Object.assign(globalThis, { window: { api: {} } });
const { LocaleProvider } = await import('../i18n/index.js');
const { RetentionSettingsView, validateRetentionInputs } = await import('../pages/Settings.js');

const values = {
  executionDetailDays: '90',
  archivedConversationDays: '180',
  providerRawDays: '365',
};

function render(confirmCompact = false): string {
  return renderToStaticMarkup(
    <LocaleProvider>
      <RetentionSettingsView
        values={values}
        loading={false}
        busy={false}
        confirmCompact={confirmCompact}
        onChange={() => undefined}
        onSave={() => undefined}
        onClean={() => undefined}
        onCompactRequest={() => undefined}
        onCompactConfirm={() => undefined}
        onCompactCancel={() => undefined}
      />
    </LocaleProvider>,
  );
}

describe('retention settings', () => {
  it('renders defaults and separate cleanup/compaction commands', () => {
    const html = render();
    expect(html).toContain('数据保留与清理');
    expect(html).toContain('value="90"');
    expect(html).toContain('value="180"');
    expect(html).toContain('value="365"');
    expect(html).toContain('立即清理');
    expect(html).toContain('整理数据库');
  });

  it('rejects values below minimums and requires a compaction confirmation', () => {
    expect(() => validateRetentionInputs({ ...values, executionDetailDays: '6' })).toThrow(/7/);
    expect(() => validateRetentionInputs({ ...values, archivedConversationDays: '29' })).toThrow(/30/);
    expect(render(true)).toContain('data-compact-confirm="true"');
  });
});
