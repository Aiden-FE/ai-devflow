import { describe, expect, it } from 'vitest';
import { PiTokenUsageAccumulator } from '../token-usage.js';

describe('PiTokenUsageAccumulator', () => {
  it('deduplicates completed messages repeated by message_end and agent_end', () => {
    const acc = new PiTokenUsageAccumulator();
    const message = {
      id: 'm1',
      role: 'assistant',
      usage: { input: 100, output: 40, cacheRead: 20, cacheWrite: 5, totalTokens: 165 },
    };
    acc.add({ type: 'message_end', message });
    acc.add({ type: 'agent_end', messages: [message] });

    expect(acc.snapshot()).toEqual({
      input: 100,
      output: 40,
      cacheRead: 20,
      cacheWrite: 5,
      total: 165,
    });
  });

  it('normalizes aliases, derives totals, and ignores explicit non-assistant messages', () => {
    const acc = new PiTokenUsageAccumulator();
    acc.add({
      type: 'message_end',
      message: {
        id: 'm1',
        usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1 },
      },
    });
    acc.add({
      type: 'message_end',
      message: { id: 'm2', role: 'user', usage: { input: 999, totalTokens: 999 } },
    });
    expect(acc.snapshot()).toEqual({ input: 10, output: 4, cacheRead: 2, cacheWrite: 1, total: 17 });
  });

  it('keeps absent or invalid token fields unknown', () => {
    const acc = new PiTokenUsageAccumulator();
    acc.add({ type: 'message_end', message: { id: 'm1', usage: { input: -1, output: Number.NaN } } });
    expect(acc.snapshot()).toEqual({ input: null, output: null, cacheRead: null, cacheWrite: null, total: null });

    const empty = new PiTokenUsageAccumulator();
    empty.add({ type: 'agent_end', messages: [] });
    expect(empty.snapshot()).toEqual({ input: null, output: null, cacheRead: null, cacheWrite: null, total: null });
  });
});
