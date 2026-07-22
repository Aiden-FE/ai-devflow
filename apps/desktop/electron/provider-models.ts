import type { ProviderConfig, ProviderKind } from '@ai-devflow/core';
import { isCompatibleKind } from '@ai-devflow/agents';

const MODEL_LIST_TIMEOUT_MS = 15_000;

function authHeaders(kind: ProviderKind, secret: string): Record<string, string> {
  if (kind === 'anthropic_compatible') {
    return { 'x-api-key': secret, 'anthropic-version': '2023-06-01' };
  }
  return { Authorization: `Bearer ${secret}` };
}

export async function fetchCompatibleModels(provider: ProviderConfig, secret: string): Promise<string[]> {
  if (!isCompatibleKind(provider.kind) || !provider.baseURL) return [];
  const url = `${provider.baseURL.replace(/\/$/, '')}/models`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MODEL_LIST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { ...authHeaders(provider.kind, secret) },
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    const ids = (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string');
    return [...new Set(ids)].sort();
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
