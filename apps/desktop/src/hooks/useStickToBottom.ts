import { useEffect, useRef, useState } from 'react';

/** 距底部小于阈值视为「在底部」。纯函数，便于单测。 */
export function isAtBottom(scrollTop: number, scrollHeight: number, clientHeight: number, threshold = 120): boolean {
  return scrollHeight - scrollTop - clientHeight < threshold;
}

export interface StickToBottomState {
  pinned: boolean;
  paused: boolean;
}

export type StickToBottomEvent =
  | { type: 'content' }
  | { type: 'user-scroll'; atBottom: boolean; direction?: 'up' | 'down' };

/** 粘底策略的纯状态转换：内容增长只在 pinned 时请求滚动，用户滚动决定暂停/恢复。 */
export function nextStickToBottomState(
  state: StickToBottomState,
  event: StickToBottomEvent,
): StickToBottomState & { scroll: boolean } {
  if (event.type === 'content') return { ...state, scroll: state.pinned };
  if (event.direction === 'up') return { pinned: false, paused: true, scroll: false };
  return event.atBottom
    ? { pinned: true, paused: false, scroll: false }
    : { pinned: false, paused: true, scroll: false };
}

export interface StickToBottomScrollPosition {
  previousTop: number;
  currentTop: number;
  scrollHeight: number;
  clientHeight: number;
  threshold?: number;
}

export function nextStickToBottomStateForScrollPosition(
  state: StickToBottomState,
  position: StickToBottomScrollPosition,
): StickToBottomState & { scroll: boolean } {
  return nextStickToBottomState(state, {
    type: 'user-scroll',
    atBottom: isAtBottom(
      position.currentTop,
      position.scrollHeight,
      position.clientHeight,
      position.threshold,
    ),
    direction: position.currentTop < position.previousTop ? 'up' : 'down',
  });
}

export interface StickToBottom {
  containerRef: React.RefObject<HTMLDivElement>;
  paused: boolean;
  unreadCount: number;
  resume: () => void;
}

/**
 * 粘底滚动：deps 变化时若未暂停则滚到底；用户上滚越过阈值则暂停并累计未读。
 * - 程序触发的滚动设 programmaticRef 标志，避免误判为用户上滚。
 * - 用户手动滚回底部（isAtBottom）时自动恢复。
 */
export function useStickToBottom(deps: unknown[], threshold = 120): StickToBottom {
  const containerRef = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const programmaticRef = useRef(false);
  const lastScrollTopRef = useRef(0);

  // 依赖变化：未暂停则滚到底；已暂停则累计未读。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (!paused) {
      programmaticRef.current = true;
      el.scrollTop = el.scrollHeight;
      lastScrollTopRef.current = el.scrollTop;
      // 下一帧清除标志，避免触发自身 scroll 事件误判。
      requestAnimationFrame(() => {
        programmaticRef.current = false;
      });
    } else {
      setUnreadCount((n) => n + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  // 监听用户滚动：上滚越过阈值 -> 暂停；滚回底部 -> 恢复。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      if (programmaticRef.current) return;
      const next = nextStickToBottomStateForScrollPosition(
        { pinned: !paused, paused },
        {
          previousTop: lastScrollTopRef.current,
          currentTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          threshold,
        },
      );
      lastScrollTopRef.current = el.scrollTop;
      setPaused(next.paused);
      if (!next.paused) {
        setUnreadCount(0);
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [paused, threshold]);

  const resume = () => {
    const el = containerRef.current;
    if (el) {
      programmaticRef.current = true;
      el.scrollTop = el.scrollHeight;
      lastScrollTopRef.current = el.scrollTop;
      requestAnimationFrame(() => {
        programmaticRef.current = false;
      });
    }
    setPaused(false);
    setUnreadCount(0);
  };

  return { containerRef, paused, unreadCount, resume };
}
