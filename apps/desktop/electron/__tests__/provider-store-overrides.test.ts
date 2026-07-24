import { describe, expect, it } from 'vitest';
import { ProviderStore } from '../provider-store.js';

function makeStore() {
  const map = new Map<string, string>();
  const sink = {
    get: (k: string) => map.get(k),
    upsert: (k: string, v: string) => { map.set(k, v); },
    delete: (k: string) => { map.delete(k); },
    transaction: <T>(fn: () => T): T => fn(),
  };
  const crypto = { encrypt: (v: string) => v, decrypt: (v: string) => v };
  return new ProviderStore(sink, crypto, () => {});
}

describe('ProviderStore agentOverrides', () => {
  it('空存储返回空数组', () => {
    const store = makeStore();
    expect(store.listAgentOverrides()).toEqual([]);
  });

  it('saveAgentOverride 按 agentKey upsert', () => {
    const store = makeStore();
    store.saveAgentOverride({ agentKey: 'requirement_refiner', providerId: 'p1', model: 'claude-3-5-sonnet' });
    store.saveAgentOverride({ agentKey: 'coder', providerId: 'p2', model: 'gpt-4o' });
    expect(store.listAgentOverrides()).toHaveLength(2);
    // 同 agentKey 更新
    store.saveAgentOverride({ agentKey: 'requirement_refiner', providerId: 'p3', model: 'm1' });
    const r = store.listAgentOverrides();
    expect(r).toHaveLength(2);
    expect(r.find((o) => o.agentKey === 'requirement_refiner')).toEqual({ agentKey: 'requirement_refiner', providerId: 'p3', model: 'm1' });
  });

  it('removeAgentOverride 删除指定 agentKey', () => {
    const store = makeStore();
    store.saveAgentOverride({ agentKey: 'coder', providerId: 'p2', model: 'gpt-4o' });
    store.removeAgentOverride('coder');
    expect(store.listAgentOverrides()).toEqual([]);
  });
});
