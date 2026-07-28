import React, { useEffect, useRef, useState } from 'react';
import { NewMessagesButton } from './NewMessagesButton.js';
import { Button } from './ui/button.js';
import { Input } from './ui/input.js';
import { useT } from '../i18n/index.js';
import { isAtBottom } from '../hooks/useStickToBottom.js';
import {
  ChevronDown, ChevronRight, CheckCircle2, XCircle, User, Bot, Info, AlertCircle, Loader2,
} from 'lucide-react';

/**
 * 统一聊天界面组件（ChatGPT 风格）。
 * 供任务对话（TaskDetail）、AI 创建需求、AI 创建任务复用。
 * 友好展示 agent/用户消息、工具调用与可展开的调用详情（输入与输出）。
 */

/** 聊天项：统一的 discriminated union，覆盖消息/工具/状态/错误/自定义。 */
export type ChatItem =
  | { type: 'message'; id: string; role: 'user' | 'assistant' | 'system'; text: string; thinking?: string; streaming?: boolean }
  | { type: 'tool'; id: string; toolName?: string; title?: string; input?: string; output?: string; isError?: boolean; running?: boolean }
  | { type: 'error'; id: string; text: string }
  | { type: 'status'; id: string; text: string }
  | { type: 'custom'; id: string; node: React.ReactNode };

/** ChatPanel 消息类型：普通文本消息 + 可扩展的特殊消息（如问答卡片）。 */
export type ChatPanelMessage =
  | { id: string; role: 'user' | 'assistant'; content: string; thinking?: string }
  | { id: string; role: 'assistant'; kind: 'question'; content: string };

export interface ChatThreadProps {
  items: ChatItem[];
  /** 空状态占位文案。 */
  placeholder: string;
  /** 助手空内容（流式中）占位文案。 */
  thinkingLabel: string;
  /** 输入区相关（任一为 undefined 则隐藏对应部分）。 */
  sendLabel?: string;
  inputPlaceholder?: string;
  onSend?: (text: string) => void;
  loading?: boolean;
  /** 底部错误提示（输入区上方）。 */
  error?: string;
  /** 自定义底部插槽（如待沟通的 Composer 按钮），与 onSend 互斥。 */
  footer?: React.ReactNode;
  /** 空状态下的快捷操作（如“一键生成”按钮），渲染在占位文案下方。 */
  emptyAction?: React.ReactNode;
  className?: string;
}

export function ChatThread({
  items, placeholder, thinkingLabel, sendLabel, inputPlaceholder, onSend, loading, error, footer, emptyAction, className,
}: ChatThreadProps): React.ReactElement {
  const [input, setInput] = useState('');

  // 向上滚动分页：只渲染最近 visibleCount 条，避免一次性渲染全部历史导致卡顿。
  const PAGE_SIZE = 30;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  // items 引用变化但内容未增（如映射重建）时，不重置窗口；仅当长度变化才可能需要调整。
  const prevLenRef = useRef(items.length);
  const mountedRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true); // 是否粘底
  const pausedRef = useRef(false);
  const [paused, setPaused] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const programmaticRef = useRef(false);
  // 预加载更多前的滚动高度，用于追加历史后保持视觉位置（scrollTop += 增量）。
  const preLoadHeightRef = useRef(0);
  const loadingMoreRef = useRef(false);

  // 可见窗口：取末尾 visibleCount 条。
  const start = Math.max(0, items.length - visibleCount);
  const visible = start > 0 ? items.slice(start) : items;
  const hasMore = start > 0;

  const send = () => {
    if (!input.trim() || loading) return;
    onSend?.(input.trim());
    setInput('');
  };

  // 切换会话/重载（items 长度骤减）时重置分页窗口与粘底状态，避免跨会话残留。
  useEffect(() => {
    if (items.length < prevLenRef.current && !loadingMoreRef.current) {
      setVisibleCount(PAGE_SIZE);
      stickToBottomRef.current = true;
      pausedRef.current = false;
      setPaused(false);
      setUnreadCount(0);
      mountedRef.current = false; // 重置挂载标志，使下一轮滚动 effect 重新置底。
    }
  }, [items.length]);

  // 新消息到达或窗口扩大后的滚动管理。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const prevLen = prevLenRef.current;
    const grew = items.length > prevLen;
    prevLenRef.current = items.length;

    // 首次挂载或会话重载后：默认置底（用户打开界面即看到最新消息）。
    if (!mountedRef.current) {
      mountedRef.current = true;
      stickToBottomRef.current = true;
      programmaticRef.current = true;
      el.scrollTop = el.scrollHeight;
      requestAnimationFrame(() => { programmaticRef.current = false; });
      return;
    }

    if (loadingMoreRef.current) {
      // 顶部加载更多：保持用户当前视觉位置（新内容插入在顶部，scrollTop 需补增量）。
      loadingMoreRef.current = false;
      const delta = el.scrollHeight - preLoadHeightRef.current;
      if (delta > 0) {
        programmaticRef.current = true;
        el.scrollTop += delta;
        requestAnimationFrame(() => { programmaticRef.current = false; });
      }
      return;
    }
    // 粘底：新消息到达且用户在底部 -> 滚到底。
    if (grew && stickToBottomRef.current) {
      programmaticRef.current = true;
      el.scrollTop = el.scrollHeight;
      requestAnimationFrame(() => { programmaticRef.current = false; });
    } else if (grew && pausedRef.current) {
      // 用户上滚暂停期间新消息到达 -> 累计未读。
      setUnreadCount((n) => n + 1);
    }
  }, [items, visibleCount]);

  // 用户滚动：检测顶部加载更多 + 底部暂停/恢复。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      if (programmaticRef.current) return;
      const atBottom = isAtBottom(el.scrollTop, el.scrollHeight, el.clientHeight);
      stickToBottomRef.current = atBottom;
      if (!atBottom && !pausedRef.current) {
        pausedRef.current = true;
        setPaused(true);
      } else if (atBottom && pausedRef.current) {
        pausedRef.current = false;
        setPaused(false);
        setUnreadCount(0);
      }
      // 顶部触顶：加载更多历史。
      if (el.scrollTop < 24 && start > 0 && !loadingMoreRef.current) {
        loadingMoreRef.current = true;
        preLoadHeightRef.current = el.scrollHeight;
        setVisibleCount((c) => c + PAGE_SIZE);
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [start]);

  const resume = () => {
    const el = containerRef.current;
    if (el) {
      programmaticRef.current = true;
      el.scrollTop = el.scrollHeight;
      requestAnimationFrame(() => { programmaticRef.current = false; });
    }
    pausedRef.current = false;
    setPaused(false);
    setUnreadCount(0);
  };

  return (
    <div className={`flex flex-col gap-2 flex-1 min-h-0 ${className ?? ''}`}>
      <div ref={containerRef} className="relative flex-1 min-h-0 max-h-[60vh] overflow-y-auto rounded-md border border-border bg-background p-2 text-xs scrollbar-thin">
        <NewMessagesButton count={paused ? unreadCount : 0} onResume={resume} />
        {items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
            <span>{placeholder}</span>
            {emptyAction}
          </div>
        ) : (
          <>
            {hasMore && <div className="py-1 text-center text-muted-foreground/70">…</div>}
            {visible.map((item) => <ChatItemView key={item.id} item={item} thinkingLabel={thinkingLabel} />)}
          </>
        )}
      </div>
      {error && <div className="shrink-0 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}
      {onSend && sendLabel && (
        <div className="flex shrink-0 gap-2">
          <Input className="flex-1" value={input} onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder={inputPlaceholder ?? placeholder} disabled={loading} />
          <Button size="sm" onClick={send} disabled={loading || !input.trim()}>{sendLabel}</Button>
        </div>
      )}
      {footer}
    </div>
  );
}

/** 单个聊天项渲染分发。 */
function ChatItemView({ item, thinkingLabel }: { item: ChatItem; thinkingLabel: string }): React.ReactElement {
  switch (item.type) {
    case 'message':
      return <MessageBubble role={item.role} text={item.text} thinking={item.thinking} streaming={item.streaming} thinkingLabel={thinkingLabel} />;
    case 'tool':
      return <ToolCard {...item} />;
    case 'error':
      return <CenterPill icon={<AlertCircle className="h-3.5 w-3.5 shrink-0" />} tone="error" text={item.text} />;
    case 'status':
      return <CenterPill icon={<Info className="h-3.5 w-3.5 shrink-0" />} tone="status" text={item.text} />;
    case 'custom':
      return <div className="my-1.5">{item.node}</div>;
  }
}

/** 居中胶囊：错误/状态提示。 */
function CenterPill({ icon, tone, text }: { icon: React.ReactNode; tone: 'error' | 'status'; text: string }): React.ReactElement {
  const cls = tone === 'error'
    ? 'border-destructive/40 bg-destructive/10 text-destructive'
    : 'bg-secondary/70 text-muted-foreground';
  return (
    <div className="my-2 flex justify-center">
      <span className={`flex max-w-[92%] min-w-0 items-center gap-1.5 break-words rounded-full border px-2.5 py-1 text-xs ${cls}`}>
        {icon}
        <span className="min-w-0 break-words">{text}</span>
      </span>
    </div>
  );
}

/** 消息气泡：用户/Agent/系统，ChatGPT 风格头像 + 圆角气泡。
 * 思考细节：thinking 存在时渲染可折叠“思考过程”区块——思考阶段（streaming 且无正文）默认展开并带 spinner，
 * 正文到达或流结束后自动折叠，用户可手动展开/收起（手动状态优先于自动状态）。 */
function MessageBubble({ role, text, thinking, streaming, thinkingLabel }: { role: 'user' | 'assistant' | 'system'; text: string; thinking?: string; streaming?: boolean; thinkingLabel: string }): React.ReactElement {
  const t = useT();
  const time = new Date().toLocaleTimeString();
  const isUser = role === 'user';
  const Icon = isUser ? User : Bot;
  const roleLabel = t(`detail.msg.${role}`);
  const showThinkingSpinner = streaming && !text;
  const hasThinking = !!thinking;
  // 自动展开：思考阶段（流式中且尚无正文）展开思考细节；正文到达/结束后折叠。手动切换优先。
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? (streaming && !text);
  return (
    <div className={`my-1.5 flex items-start gap-2 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${isUser ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'}`}>
        <Icon className="h-3.5 w-3.5" />
      </span>
      <div className={`max-w-[80%] min-w-0 rounded-2xl border border-transparent px-3 py-1.5 ${isUser ? 'rounded-tr-sm bg-primary text-primary-foreground' : 'rounded-tl-sm bg-secondary'}`}>
        <div className={`flex items-center gap-1.5 text-[10px] ${isUser ? 'text-primary-foreground/70' : 'text-muted-foreground'}`}>
          <span className="font-medium">{roleLabel}</span>
          <span className="opacity-60">{time}</span>
        </div>
        {hasThinking && (
          <div className="mt-1">
            <button
              type="button"
              data-testid="thinking-toggle"
              className={`flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground ${isUser ? 'text-primary-foreground/80 hover:text-primary-foreground' : ''}`}
              onClick={() => setManual(!open)}
              aria-expanded={open}
            >
              {showThinkingSpinner
                ? <Loader2 className="h-3 w-3 animate-spin" />
                : open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              <span>{t('chat.thinking.title')}</span>
            </button>
            {open && (
              <div data-testid="thinking-body" className={`mt-1 max-h-48 overflow-auto whitespace-pre-wrap border-l-2 pl-2 text-xs leading-relaxed ${isUser ? 'border-primary-foreground/30 text-primary-foreground/80' : 'border-border text-muted-foreground'}`}>{thinking}</div>
            )}
          </div>
        )}
        <div className="mt-0.5 whitespace-pre-wrap break-words text-sm leading-relaxed">
          {showThinkingSpinner && !hasThinking ? (
            <span className="inline-flex items-center gap-1 text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" />{thinkingLabel}</span>
          ) : text}
        </div>
      </div>
    </div>
  );
}

/** 工具调用/结果卡片：图标 + 工具名 + 摘要，可展开查看入参与输出。 */
function ToolCard({ toolName, title, input, output, isError, running }: { toolName?: string; title?: string; input?: string; output?: string; isError?: boolean; running?: boolean }): React.ReactElement {
  const t = useT();
  const [open, setOpen] = useState(false);
  const hasInput = !!input;
  const hasOutput = !!output;
  const hasDetail = hasInput || hasOutput;
  const StatusIcon = running ? Loader2 : (isError ? XCircle : CheckCircle2);
  const iconCls = running ? 'animate-spin text-muted-foreground' : (isError ? 'text-destructive' : 'text-ok');
  const summary = title ?? output ?? input ?? '';
  return (
    <div className="my-1.5 min-w-0">
      <button
        className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors ${isError ? 'border-destructive/40 bg-destructive/5 hover:bg-destructive/10' : 'border-border bg-secondary/40 hover:bg-secondary/70'}`}
        onClick={() => hasDetail && setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded bg-background/60 ${iconCls}`}>
          <StatusIcon className="h-3 w-3" />
        </span>
        <span className="shrink-0 font-medium text-muted-foreground">{running ? t('detail.msg.toolRunning') : t('detail.msg.toolResult')}</span>
        {toolName && <span className="rounded bg-background/60 px-1.5 py-0.5 font-mono text-[11px]">{toolName}</span>}
        <span className={`min-w-0 flex-1 truncate ${isError ? 'text-destructive/80' : 'text-muted-foreground/80'}`}>{summary}</span>
        {hasDetail && (open ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />)}
      </button>
      {open && hasDetail && (
        <div className="mt-1 space-y-1">
          {hasInput && (
            <div className="overflow-hidden rounded-md border border-border bg-background/50">
              <div className="border-b border-border px-2 py-0.5 text-[10px] font-medium text-muted-foreground">{t('detail.msg.toolInput')}</div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all p-2 font-mono text-[11px]">{input}</pre>
            </div>
          )}
          {hasOutput && (
            <div className={`overflow-hidden rounded-md border ${isError ? 'border-destructive/40' : 'border-border'} bg-background/50`}>
              <div className="border-b border-border px-2 py-0.5 text-[10px] font-medium text-muted-foreground">{t('detail.msg.toolOutput')}</div>
              <pre className={`max-h-48 overflow-auto whitespace-pre-wrap break-all p-2 font-mono text-[11px] ${isError ? 'text-destructive' : ''}`}>{output}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
