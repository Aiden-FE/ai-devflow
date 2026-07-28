import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { describe, expect, it } from 'vitest';

// ChatThread 的导入链（useStickToBottom -> i18n -> lib.tsx）在模块加载期读取 window.api。
Object.assign(globalThis, { window: { api: {} } });
const { ChatThread } = await import('../ChatThread.js');
const { LocaleProvider } = await import('../../i18n/index.js');

function withLocale(node: React.ReactNode): React.ReactNode {
  return React.createElement(LocaleProvider, null, node);
}

describe('ChatThread (统一聊天组件)', () => {
  it('空 items 显示 placeholder', () => {
    const html = renderToStaticMarkup(
      withLocale(<ChatThread items={[]} placeholder="说点什么" thinkingLabel="思考中" />),
    );
    expect(html).toContain('说点什么');
  });

  it('渲染用户/助手消息气泡（助手空内容显示思考占位 + spinner）', () => {
    const html = renderToStaticMarkup(
      withLocale(
        <ChatThread
          items={[
            { type: 'message', id: 'u1', role: 'user', text: '你好' },
            { type: 'message', id: 'a1', role: 'assistant', text: '', streaming: true },
          ]}
          placeholder="p"
          thinkingLabel="思考中"
        />,
      ),
    );
    expect(html).toContain('你好');
    expect(html).toContain('思考中');
  });

  it('工具调用卡片：显示工具名 + 标题，可展开入参', () => {
    const html = renderToStaticMarkup(
      withLocale(
        <ChatThread
          items={[
            { type: 'tool', id: 't1', toolName: 'git_diff', title: '查看改动', input: '{"path":"src/a.ts"}' },
          ]}
          placeholder="p"
          thinkingLabel="t"
        />,
      ),
    );
    expect(html).toContain('git_diff');
    expect(html).toContain('查看改动');
  });

  it('工具结果卡片：错误态显示红色边框与输出', () => {
    const html = renderToStaticMarkup(
      withLocale(
        <ChatThread
          items={[
            { type: 'tool', id: 't2', toolName: 'bash', output: 'command failed', isError: true },
          ]}
          placeholder="p"
          thinkingLabel="t"
        />,
      ),
    );
    expect(html).toContain('command failed');
    expect(html).toContain('destructive');
  });

  it('错误与状态居中胶囊渲染', () => {
    const html = renderToStaticMarkup(
      withLocale(
        <ChatThread
          items={[
            { type: 'error', id: 'e1', text: '出错了' },
            { type: 'status', id: 's1', text: '已合并' },
          ]}
          placeholder="p"
          thinkingLabel="t"
        />,
      ),
    );
    expect(html).toContain('出错了');
    expect(html).toContain('已合并');
  });

  it('onSend 输入行：显示发送按钮文案与底部错误', () => {
    const html = renderToStaticMarkup(
      withLocale(
        <ChatThread
          items={[]}
          placeholder="p"
          thinkingLabel="t"
          sendLabel="发送"
          onSend={() => {}}
          error="网络错误"
        />,
      ),
    );
    expect(html).toContain('发送');
    expect(html).toContain('网络错误');
  });

  it('向上滚动分页：默认仅渲染最近一窗口（30）条，更早的历史不进入 DOM，避免卡顿', () => {
    // 60 条用户消息：编号 m0..m59。默认窗口应只渲染 m30..m59。
    const items = Array.from({ length: 60 }, (_, i) => ({ type: 'message' as const, id: `m${i}`, role: 'user' as const, text: `msg-${i}` }));
    const html = renderToStaticMarkup(
      withLocale(<ChatThread items={items} placeholder="p" thinkingLabel="t" />),
    );
    // 最早 30 条不在 DOM 中（分页窗口裁剪）。
    expect(html).not.toContain('msg-0');
    expect(html).not.toContain('msg-29');
    // 最近 30 条已渲染。
    expect(html).toContain('msg-30');
    expect(html).toContain('msg-59');
    // 顶部存在“更多历史”占位。
    expect(html).toContain('…');
  });

  it('消息数不超过窗口大小时全部渲染，无分页占位', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ type: 'message' as const, id: `m${i}`, role: 'user' as const, text: `msg-${i}` }));
    const html = renderToStaticMarkup(
      withLocale(<ChatThread items={items} placeholder="p" thinkingLabel="t" />),
    );
    expect(html).toContain('msg-0');
    expect(html).toContain('msg-9');
    expect(html).not.toContain('…');
  });

  it('思考细节：流式思考阶段默认展开思考内容（带 spinner），正文到达后自动折叠', () => {
    // 思考阶段：streaming 且无正文 -> 思考内容可见。
    const thinkingHtml = renderToStaticMarkup(
      withLocale(
        <ChatThread
          items={[{ type: 'message', id: 'a1', role: 'assistant', text: '', thinking: '正在分析代码结构', streaming: true }]}
          placeholder="p"
          thinkingLabel="思考中"
        />,
      ),
    );
    expect(thinkingHtml).toContain('思考过程');
    expect(thinkingHtml).toContain('data-testid="thinking-body"');
    expect(thinkingHtml).toContain('正在分析代码结构');
    expect(thinkingHtml).toContain('animate-spin');

    // 思考结束（正文到达、streaming=false）-> 思考内容自动折叠，正文可见。
    const doneHtml = renderToStaticMarkup(
      withLocale(
        <ChatThread
          items={[{ type: 'message', id: 'a1', role: 'assistant', text: '最终答复', thinking: '思考细节', streaming: false }]}
          placeholder="p"
          thinkingLabel="思考中"
        />,
      ),
    );
    expect(doneHtml).toContain('最终答复');
    expect(doneHtml).toContain('data-testid="thinking-toggle"');
    expect(doneHtml).not.toContain('data-testid="thinking-body"');
    expect(doneHtml).not.toContain('思考细节');
  });

  it('空状态渲染 emptyAction 快捷操作', () => {
    const html = renderToStaticMarkup(
      withLocale(
        <ChatThread items={[]} placeholder="p" thinkingLabel="t" emptyAction={<button data-testid="quick">一键生成</button>} />,
      ),
    );
    expect(html).toContain('data-testid="quick"');
    expect(html).toContain('一键生成');
  });
});
