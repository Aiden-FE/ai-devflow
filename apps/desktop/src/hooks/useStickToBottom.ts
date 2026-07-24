import { useEffect, useRef, useState } from 'react';

/** 距底部小于阈值视为「在底部」。纯函数，便于单测。 */
export function isAtBottom(scrollTop: number, scrollHeight: number, clientHeight: number, threshold = 120): boolean {
  return scrollHeight - scrollTop - clientHeight < threshold;
}

export interface StickToBottom {
  containerRef: React.RefObject<HTMLDivElement | null>;
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
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [paused, setPaused] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const programmaticRef = useRef(false);

  // 依赖变化：未暂停则滚到底；已暂停则累计未读。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (!paused) {
      programmaticRef.current = true;
      el.scrollTop = el.scrollHeight;
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
      const atBottom = isAtBottom(el.scrollTop, el.scrollHeight, el.clientHeight, threshold);
      if (!atBottom && !paused) {
        setPaused(true);
      } else if (atBottom && paused) {
        setPaused(false);
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
      requestAnimationFrame(() => {
        programmaticRef.current = false;
      });
    }
    setPaused(false);
    setUnreadCount(0);
  };

  return { containerRef, paused, unreadCount, resume };
}
