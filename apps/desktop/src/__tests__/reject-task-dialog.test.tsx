import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

Object.assign(globalThis, { window: { api: {} } });
const { LocaleProvider } = await import('../i18n/index.js');
const { RejectTaskForm } = await import('../components/RejectTaskDialog.js');

describe('RejectTaskDialog', () => {
  it('locks the rejection target selected by a board drop', () => {
    const html = renderToStaticMarkup(
      <LocaleProvider>
        <RejectTaskForm
          initialTarget="ready"
          lockedTarget="ready"
          busy={false}
          onClose={() => {}}
          onSubmit={() => {}}
        />
      </LocaleProvider>,
    );

    expect(html).toContain('data-testid="reject-target-locked"');
    expect(html).toContain('待开发');
    expect(html).not.toContain('role="combobox"');
  });

  it('shows an IPC failure without replacing the form', () => {
    const html = renderToStaticMarkup(
      <LocaleProvider>
        <RejectTaskForm
          busy={false}
          error="启动修复失败"
          onClose={() => {}}
          onSubmit={() => {}}
        />
      </LocaleProvider>,
    );

    expect(html).toContain('启动修复失败');
    expect(html).toContain('退回原因');
  });
});
