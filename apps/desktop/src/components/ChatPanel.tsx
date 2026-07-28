import React from 'react';
import { ChatThread, type ChatItem, type ChatPanelMessage } from './ChatThread.js';

/** ChatPanel 消息类型：普通文本消息 + 可扩展的特殊消息（如问答卡片）。 */
export type { ChatPanelMessage } from './ChatThread.js';

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
  /** 空状态快捷操作（如“一键生成”按钮）。 */
  emptyAction?: React.ReactNode;
}

/**
 * 统一聊天面板：消息列表（含粘底滚动 + 新消息悬浮按钮）+ 输入行 + 可选的特殊消息渲染槽。
 * 供 AiRefineRequirement / AiCreateTask 复用；问答卡片经 renderMessage 注入。
 *
 * 实现为 ChatThread（统一 ChatGPT 风格组件）的适配层：把 ChatPanelMessage 映射为 ChatItem，
 * 保持既有 props 契约不变，让 AiRefineRequirement / AiCreateTask 无需改动即可获得统一的聊天 UX。
 */
export function ChatPanel({ messages, onSend, loading, placeholder, thinkingLabel, sendLabel, error, renderMessage, emptyAction }: ChatPanelProps): React.ReactElement {
  const items: ChatItem[] = messages.map((m, i) => {
    if ('kind' in m && m.kind === 'question') {
      const custom = renderMessage?.(m, i);
      if (custom !== undefined && custom !== null) return { type: 'custom', id: m.id, node: custom };
    }
    // 助手空内容（流式未产生任何 delta 或刚插入占位）显示思考占位；仅末条助手消息视为流式中，
    // 避免问答卡片后的历史空消息误显 spinner。
    const streaming = m.role === 'assistant' && !m.content && i === messages.length - 1;
    return { type: 'message', id: m.id, role: m.role, text: m.content, thinking: 'thinking' in m ? m.thinking : undefined, streaming };
  });
  return (
    <ChatThread
      items={items}
      placeholder={placeholder}
      thinkingLabel={thinkingLabel}
      sendLabel={sendLabel}
      inputPlaceholder={placeholder}
      onSend={onSend}
      loading={loading}
      error={error}
      emptyAction={emptyAction}
    />
  );
}
