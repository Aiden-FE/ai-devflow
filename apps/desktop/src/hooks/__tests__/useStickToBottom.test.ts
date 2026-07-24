import { describe, it, expect } from 'vitest';
import { isAtBottom } from '../useStickToBottom.js';

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
