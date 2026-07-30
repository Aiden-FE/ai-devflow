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

/**
 * Content-free message fingerprint: identifies the same assistant message whether it
 * arrives via `message_end` or repeated in `agent_end.messages`, without ever hashing
 * or storing message text. Only stable non-content fields plus the normalized usage
 * numbers participate, so deduplication tolerates Pi omitting `id` on assistant messages.
 */
function messageFingerprint(message: Record<string, unknown>, usage: TokenUsage): string {
  const text = (key: string): string | null =>
    typeof message[key] === 'string' ? message[key] as string : null;
  const timestamp = typeof message.timestamp === 'number' && Number.isSafeInteger(message.timestamp)
    ? message.timestamp
    : null;
  return JSON.stringify([
    timestamp,
    text('provider'),
    text('model'),
    text('responseId'),
    text('stopReason'),
    usage.input,
    usage.output,
    usage.cacheRead,
    usage.cacheWrite,
    usage.total,
  ]);
}

export class PiTokenUsageAccumulator {
  private readonly fingerprints = new Set<string>();
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
      const usage = normalizeUsage(message.usage);
      if (!usage) continue;
      const fingerprint = messageFingerprint(message, usage);
      if (this.fingerprints.has(fingerprint)) continue;
      this.fingerprints.add(fingerprint);
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
