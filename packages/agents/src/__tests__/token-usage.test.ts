import { describe, expect, it } from 'vitest';
import { PiTokenUsageAccumulator } from '../token-usage.js';

describe('PiTokenUsageAccumulator', () => {
  it.each([
    ['openai'],
    ['anthropic'],
  ] as const)('deduplicates a canonical no-ID %s assistant message repeated by message_end and agent_end', (provider) => {
    const acc = new PiTokenUsageAccumulator();
    const first = {
      role: 'assistant',
      timestamp: 1_753_824_000_000,
      provider,
      model: 'gpt-5',
      responseId: 'resp-1',
      stopReason: 'toolUse',
      usage: {
        input: 100,
        output: 40,
        cacheRead: 20,
        cacheWrite: 5,
        totalTokens: 165,
        reasoning: 12,
        cacheWrite1h: 3,
      },
    };
    acc.add({ type: 'message_end', message: first });
    acc.add({ type: 'agent_end', messages: [first] });

    expect(acc.snapshot()).toEqual({
      input: 100,
      output: 40,
      cacheRead: 20,
      cacheWrite: 5,
      total: 165,
    });
  });

  it('sums two assistant tool-use turns with distinct timestamps', () => {
    const acc = new PiTokenUsageAccumulator();
    const turn1 = {
      role: 'assistant',
      timestamp: 1_753_824_000_000,
      provider: 'openai',
      model: 'gpt-5',
      responseId: 'resp-1',
      stopReason: 'toolUse',
      usage: { input: 100, output: 40, cacheRead: 20, cacheWrite: 5, totalTokens: 165 },
    };
    const turn2 = {
      role: 'assistant',
      timestamp: 1_753_824_001_000,
      provider: 'openai',
      model: 'gpt-5',
      responseId: 'resp-2',
      stopReason: 'end_turn',
      usage: { input: 30, output: 10, cacheRead: 4, cacheWrite: 1, totalTokens: 45 },
    };
    acc.add({ type: 'message_end', message: turn1 });
    acc.add({ type: 'message_end', message: turn2 });
    acc.add({ type: 'agent_end', messages: [turn1, turn2] });

    expect(acc.snapshot()).toEqual({
      input: 130,
      output: 50,
      cacheRead: 24,
      cacheWrite: 6,
      total: 210,
    });
  });

  it('counts an agent_end fallback message without a preceding message_end', () => {
    const acc = new PiTokenUsageAccumulator();
    acc.add({
      type: 'agent_end',
      messages: [{
        role: 'assistant',
        timestamp: 1_753_824_000_000,
        provider: 'anthropic',
        model: 'claude',
        responseId: 'resp-fallback',
        stopReason: 'end_turn',
        usage: { input: 7, output: 3, cacheRead: 1, cacheWrite: 1 },
      }],
    });

    expect(acc.snapshot()).toEqual({
      input: 7,
      output: 3,
      cacheRead: 1,
      cacheWrite: 1,
      total: 12,
    });
  });

  it('ignores explicit user and tool-result messages', () => {
    const acc = new PiTokenUsageAccumulator();
    acc.add({
      type: 'agent_end',
      messages: [
        { role: 'user', timestamp: 1_753_824_000_000, usage: { input: 999, totalTokens: 999 } },
        {
          role: 'assistant',
          timestamp: 1_753_824_000_000,
          provider: 'openai',
          model: 'gpt-5',
          responseId: 'resp-1',
          stopReason: 'toolUse',
          usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 17 },
        },
        { role: 'tool', timestamp: 1_753_824_000_000, usage: { input: 5 } },
      ],
    });

    expect(acc.snapshot()).toEqual({
      input: 10,
      output: 4,
      cacheRead: 2,
      cacheWrite: 1,
      total: 17,
    });
  });

  it('derives a missing total from the sum of non-null parts', () => {
    const acc = new PiTokenUsageAccumulator();
    acc.add({
      type: 'message_end',
      message: {
        role: 'assistant',
        timestamp: 1_753_824_000_000,
        provider: 'openai',
        model: 'gpt-5',
        responseId: 'resp-1',
        stopReason: 'end_turn',
        usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1 },
      },
    });

    expect(acc.snapshot()).toEqual({
      input: 10,
      output: 4,
      cacheRead: 2,
      cacheWrite: 1,
      total: 17,
    });
  });

  it('rejects negative, fractional, unsafe, and non-number token values', () => {
    const acc = new PiTokenUsageAccumulator();
    acc.add({
      type: 'message_end',
      message: {
        role: 'assistant',
        timestamp: 1_753_824_000_000,
        provider: 'openai',
        model: 'gpt-5',
        responseId: 'resp-1',
        stopReason: 'end_turn',
        usage: {
          input: -1,
          output: 2.5,
          cacheRead: Number.MAX_SAFE_INTEGER + 1,
          cacheWrite: '5',
          totalTokens: NaN,
        },
      },
    });

    expect(acc.snapshot()).toEqual({
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      total: null,
    });
  });

  it('keeps never-observed fields unknown (null, not zero)', () => {
    const acc = new PiTokenUsageAccumulator();
    acc.add({
      type: 'message_end',
      message: {
        role: 'assistant',
        timestamp: 1_753_824_000_000,
        provider: 'openai',
        model: 'gpt-5',
        responseId: 'resp-1',
        stopReason: 'end_turn',
        usage: { input: 10, cacheRead: 2 },
      },
    });

    expect(acc.snapshot()).toEqual({
      input: 10,
      output: null,
      cacheRead: 2,
      cacheWrite: null,
      total: 12,
    });

    const empty = new PiTokenUsageAccumulator();
    empty.add({ type: 'agent_end', messages: [] });
    expect(empty.snapshot()).toEqual({
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      total: null,
    });
  });
});
