import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { describe, expect, it } from 'vitest';
import type { ChatPanelMessage } from '../ChatPanel.js';

// ChatPanel 的导入链（NewMessagesButton -> i18n -> lib.tsx）在模块加载期读取 window.api，
// 故先注入 window 再动态导入（与 workspace-reqitem.test.tsx 同构）。
Object.assign(globalThis, { window: { api: {} } });
const { ChatPanel } = await import('../ChatPanel.js');
const { LocaleProvider } = await import('../../i18n/index.js');

// NewMessagesButton 内部使用 useT()，需 LocaleProvider 上下文。
function withLocale(node: React.ReactNode): React.ReactNode {
  return React.createElement(LocaleProvider, null, node);
}

describe('ChatPanel', () => {
  it('空消息时显示 placeholder', () => {
    const html = renderToStaticMarkup(
      withLocale(<ChatPanel messages={[]} onSend={() => {}} loading={false} placeholder="说点什么" thinkingLabel="思考中" sendLabel="发送" />),
    );
    expect(html).toContain('说点什么');
  });

  it('渲染用户/助手气泡（助手空内容用 thinkingLabel 占位）', () => {
    const messages: ChatPanelMessage[] = [
      { id: 'u1', role: 'user', content: '你好' },
      { id: 'a1', role: 'assistant', content: '' },
    ];
    const html = renderToStaticMarkup(
      withLocale(<ChatPanel messages={messages} onSend={() => {}} loading={false} placeholder="p" thinkingLabel="思考中" sendLabel="发送" />),
    );
    expect(html).toContain('你好');
    expect(html).toContain('思考中');
  });

  it('renderMessage 覆盖默认气泡', () => {
    const messages: ChatPanelMessage[] = [{ id: 'q1', role: 'assistant', kind: 'question', content: '问' }];
    const html = renderToStaticMarkup(
      withLocale(
        <ChatPanel
          messages={messages}
          onSend={() => {}}
          loading={false}
          placeholder="p"
          thinkingLabel="t"
          sendLabel="发送"
          renderMessage={() => <div data-testid="custom">自定义卡片</div>}
        />,
      ),
    );
    expect(html).toContain('data-testid="custom"');
    expect(html).toContain('自定义卡片');
  });

  it('渲染错误提示与发送按钮文案', () => {
    const html = renderToStaticMarkup(
      withLocale(<ChatPanel messages={[]} onSend={() => {}} loading={false} placeholder="p" thinkingLabel="t" sendLabel="发送" error="出错了" />),
    );
    expect(html).toContain('出错了');
    expect(html).toContain('发送');
  });
});
