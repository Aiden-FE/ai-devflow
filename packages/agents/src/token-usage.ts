import type { TokenUsage } from '@ai-devflow/core';

type UsageKey = 'input' | 'output' | 'cacheRead' | 'cacheWrite';

const ALIASES: Record<UsageKey, readonly string[]> = {
  input: ['input', 'inputTokens', 'input_tokens'],
  output: ['output', 'outputTokens', 'output_tokens'],
  cacheRead: ['cacheRead', 'cacheReadTokens', 'cache_read', 'cache_read_tokens'],
  cacheWrite: ['cacheWrite', 'cacheWriteTokens', 'cache_write', 'cache_write_tokens'],
};

function tokenValue(record: Record<string, unknown>, aliases: readonly string[]): number | null {
  for (const alias of aliases) {
    const value = record[alias];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  }
  return null;
}

function normalizeUsage(value: unknown): TokenUsage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const input = tokenValue(record, ALIASES.input);
  const output = tokenValue(record, ALIASES.output);
  const cacheRead = tokenValue(record, ALIASES.cacheRead);
  const cacheWrite = tokenValue(record, ALIASES.cacheWrite);
  const explicitTotal = tokenValue(record, ['total', 'totalTokens', 'total_tokens']);
  const parts = [input, output, cacheRead, cacheWrite];
  const total = explicitTotal ?? (parts.some((part) => part !== null)
    ? parts.reduce<number>((sum, part) => sum + (part ?? 0), 0)
    : null);
  if ([...parts, total].every((part) => part === null)) return undefined;
  return { input, output, cacheRead, cacheWrite, total };
}

function messagesFromEvent(event: Record<string, unknown>): unknown[] {
  if (event.type === 'message_end') return [event.message];
  if (event.type === 'agent_end' && Array.isArray(event.messages)) return event.messages;
  return [];
}

export class PiTokenUsageAccumulator {
  private readonly messageIds = new Set<string>();
  private readonly sums: Record<keyof TokenUsage, number> = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  };
  private readonly known = new Set<keyof TokenUsage>();

  add(event: unknown): void {
    if (typeof event !== 'object' || event === null) return;
    for (const value of messagesFromEvent(event as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue;
      const message = value as Record<string, unknown>;
      if (message.role !== undefined && message.role !== 'assistant') continue;
      const id = typeof message.id === 'string' && message.id.length > 0 ? message.id : undefined;
      if (!id || this.messageIds.has(id)) continue;
      const usage = normalizeUsage(message.usage);
      if (!usage) continue;
      this.messageIds.add(id);
      for (const key of Object.keys(this.sums) as Array<keyof TokenUsage>) {
        const token = usage[key];
        if (token !== null) {
          this.sums[key] += token;
          this.known.add(key);
        }
      }
    }
  }

  snapshot(): TokenUsage {
    return {
      input: this.known.has('input') ? this.sums.input : null,
      output: this.known.has('output') ? this.sums.output : null,
      cacheRead: this.known.has('cacheRead') ? this.sums.cacheRead : null,
      cacheWrite: this.known.has('cacheWrite') ? this.sums.cacheWrite : null,
      total: this.known.has('total') ? this.sums.total : null,
    };
  }
}
