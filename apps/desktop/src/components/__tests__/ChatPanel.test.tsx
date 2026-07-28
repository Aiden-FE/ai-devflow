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

  it('助手消息携带 thinking 时渲染可折叠思考过程', () => {
    const messages: ChatPanelMessage[] = [
      { id: 'u1', role: 'user', content: '你好' },
      { id: 'a1', role: 'assistant', content: '答复', thinking: '先分析再回答' },
    ];
    const html = renderToStaticMarkup(
      withLocale(<ChatPanel messages={messages} onSend={() => {}} loading={false} placeholder="p" thinkingLabel="t" sendLabel="发送" />),
    );
    expect(html).toContain('思考过程');
    expect(html).toContain('data-testid="thinking-toggle"');
    // 非流式（已完成）默认折叠：思考内容不渲染。
    expect(html).not.toContain('先分析再回答');
  });

  it('仅末条空助手消息视为流式中（问答卡片后的历史空消息不误显 spinner）', () => {
    const messages: ChatPanelMessage[] = [
      { id: 'a0', role: 'assistant', content: '' },
      { id: 'q1', role: 'assistant', kind: 'question', content: '' },
      { id: 'a1', role: 'assistant', content: '' },
    ];
    const html = renderToStaticMarkup(
      withLocale(<ChatPanel messages={messages} onSend={() => {}} loading placeholder="p" thinkingLabel="思考中" sendLabel="发送" />),
    );
    // 思考占位仅出现一次（末条 a1）；a0 不再是末条，不显示 spinner。
    expect(html.match(/思考中/g)?.length ?? 0).toBe(1);
  });

  it('空状态渲染 emptyAction 快捷操作', () => {
    const html = renderToStaticMarkup(
      withLocale(<ChatPanel messages={[]} onSend={() => {}} loading={false} placeholder="p" thinkingLabel="t" sendLabel="发送" emptyAction={<button data-testid="quick">一键生成</button>} />),
    );
    expect(html).toContain('data-testid="quick"');
  });
});
