import { describe, it, expect } from 'vitest';
import {
  isAtBottom,
  nextStickToBottomState,
  nextStickToBottomStateForScrollPosition,
} from '../useStickToBottom.js';

describe('isAtBottom', () => {
  it('距底部小于阈值视为在底部', () => {
    expect(isAtBottom(880, 1000, 100, 120)).toBe(true); // 1000-880-100=20 < 120
  });
  it('距底部大于等于阈值视为不在底部', () => {
    expect(isAtBottom(700, 1000, 100, 120)).toBe(false); // 1000-700-100=200 >= 120
  });
  it('阈值边界：恰好等于阈值视为不在底部', () => {
    expect(isAtBottom(780, 1000, 100, 120)).toBe(false); // 1000-780-100=120
  });
  it('clientHeight 大于 scrollHeight 时视为在底部', () => {
    expect(isAtBottom(0, 100, 200, 120)).toBe(true);
  });
});

describe('nextStickToBottomState', () => {
  it('置底时同一消息内容增长仍要求滚到底部', () => {
    expect(nextStickToBottomState(
      { pinned: true, paused: false },
      { type: 'content' },
    )).toEqual({ pinned: true, paused: false, scroll: true });
  });

  it('用户上滚暂停后内容增长不改变滚动位置', () => {
    expect(nextStickToBottomState(
      { pinned: false, paused: true },
      { type: 'content' },
    )).toEqual({ pinned: false, paused: true, scroll: false });
  });

  it('用户离开底部时暂停，回到底部时恢复置底', () => {
    expect(nextStickToBottomState(
      { pinned: true, paused: false },
      { type: 'user-scroll', atBottom: false },
    )).toEqual({ pinned: false, paused: true, scroll: false });
    expect(nextStickToBottomState(
      { pinned: false, paused: true },
      { type: 'user-scroll', atBottom: true },
    )).toEqual({ pinned: true, paused: false, scroll: false });
  });

  it('即使仍在底部阈值内，用户向上滚动也立即暂停', () => {
    expect(nextStickToBottomState(
      { pinned: true, paused: false },
      { type: 'user-scroll', atBottom: true, direction: 'up' },
    )).toEqual({ pinned: false, paused: true, scroll: false });
  });

  it('uses scroll positions to pause immediately on an upward move near bottom', () => {
    expect(nextStickToBottomStateForScrollPosition(
      { pinned: true, paused: false },
      { previousTop: 900, currentTop: 880, scrollHeight: 1000, clientHeight: 100, threshold: 120 },
    )).toEqual({ pinned: false, paused: true, scroll: false });
  });
});
