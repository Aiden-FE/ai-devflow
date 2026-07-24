import React from 'react';
import { useStickToBottom } from '../hooks/useStickToBottom.js';
import { NewMessagesButton } from './NewMessagesButton.js';
import { Button } from './ui/button.js';
import { Input } from './ui/input.js';

/** ChatPanel 消息类型：普通文本消息 + 可扩展的特殊消息（如问答卡片）。 */
export type ChatPanelMessage =
  | { id: string; role: 'user' | 'assistant'; content: string }
  | { id: string; role: 'assistant'; kind: 'question'; content: string };

export interface ChatPanelProps {
  messages: ChatPanelMessage[];
  onSend: (text: string) => void;
  loading: boolean;
  placeholder: string;
  thinkingLabel: string;
  sendLabel: string;
  error?: string;
  /** 自定义消息渲染（如问答卡片）；返回 null 则用默认气泡。 */
  renderMessage?: (msg: ChatPanelMessage, index: number) => React.ReactNode | null;
}

/**
 * 统一聊天面板：消息列表（含粘底滚动 + 新消息悬浮按钮）+ 输入行 + 可选的特殊消息渲染槽。
 * 供 AiRefineRequirement / AiCreateTask 复用；问答卡片经 renderMessage 注入。
 */
export function ChatPanel({ messages, onSend, loading, placeholder, thinkingLabel, sendLabel, error, renderMessage }: ChatPanelProps): React.ReactElement {
  const [input, setInput] = React.useState('');
  const stick = useStickToBottom([messages]);

  const send = () => {
    if (!input.trim() || loading) return;
    onSend(input.trim());
    setInput('');
  };

  return (
    <div className="flex flex-col gap-2">
      <div ref={stick.containerRef} className="relative flex-1 min-h-[280px] max-h-[60vh] overflow-y-auto rounded-md border border-border bg-background p-2 text-xs scrollbar-thin">
        <NewMessagesButton count={stick.paused ? stick.unreadCount : 0} onResume={stick.resume} />
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">{placeholder}</div>
        ) : messages.map((m, i) => {
          const custom = renderMessage?.(m, i);
          if (custom !== undefined && custom !== null) return <div key={m.id} className="mb-2">{custom}</div>;
          return (
            <div key={m.id} className={`mb-2 ${m.role === 'user' ? 'text-right' : ''}`}>
              <span className={`inline-block max-w-[85%] whitespace-pre-wrap break-words rounded-md px-2 py-1 ${m.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-secondary'}`}>
                {m.content || thinkingLabel}
              </span>
            </div>
          );
        })}
      </div>
      {error && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}
      <div className="flex gap-2">
        <Input className="flex-1" value={input} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder={placeholder} disabled={loading} />
        <Button size="sm" onClick={send} disabled={loading || !input.trim()}>{sendLabel}</Button>
      </div>
    </div>
  );
}
