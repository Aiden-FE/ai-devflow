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
    store.saveAgentOverride({ agentKey: 'product', providerId: 'p1', model: 'claude-3-5-sonnet' });
    store.saveAgentOverride({ agentKey: 'dev', providerId: 'p2', model: 'gpt-4o' });
    expect(store.listAgentOverrides()).toHaveLength(2);
    // 同 agentKey 更新
    store.saveAgentOverride({ agentKey: 'product', providerId: 'p3', model: 'm1' });
    const r = store.listAgentOverrides();
    expect(r).toHaveLength(2);
    expect(r.find((o) => o.agentKey === 'product')).toEqual({ agentKey: 'product', providerId: 'p3', model: 'm1' });
  });

  it('removeAgentOverride 删除指定 agentKey', () => {
    const store = makeStore();
    store.saveAgentOverride({ agentKey: 'dev', providerId: 'p2', model: 'gpt-4o' });
    store.removeAgentOverride('dev');
    expect(store.listAgentOverrides()).toEqual([]);
  });
});

describe('ProviderStore.migrateAgentOverridesToExperts', () => {
  /** 直接写入旧键覆盖（绕过类型校验，模拟历史存储数据）。 */
  function seedLegacyOverrides(store: ProviderStore, overrides: Array<{ agentKey: string; providerId: string; model: string }>): void {
    // 复用 saveAgentOverride 的存储路径但注入任意键名：通过 list+upsert 模拟。
    // 这里直接用内部存储：先 save 一条新键占位再读取替换不可行，故用 reflect 访问私有 credentials。
    const creds = (store as unknown as { credentials: { upsert: (k: string, v: string) => void; encrypt?: (v: string) => string } });
    creds.credentials.upsert('agent-overrides:v1', JSON.stringify(overrides));
  }

  it('把旧键迁移到 6 专家键并清理旧键', () => {
    const store = makeStore();
    seedLegacyOverrides(store, [
      { agentKey: 'requirement_refiner', providerId: 'p1', model: 'prod-model' },
      { agentKey: 'task_proposer', providerId: 'p2', model: 'lead-model' },
      { agentKey: 'planner', providerId: 'p3', model: 'dev-model-a' },
      { agentKey: 'reviewer', providerId: 'p4', model: 'test-model' },
      { agentKey: 'chat', providerId: 'p5', model: 'chat-model' },
    ]);
    const result = store.migrateAgentOverridesToExperts();
    const after = store.listAgentOverrides();
    const keys = after.map((o) => o.agentKey).sort();
    expect(keys).toEqual(['chat', 'dev', 'dev_lead', 'product', 'test']);
    // 旧键全部清理
    expect(after.some((o) => ['requirement_refiner', 'task_proposer', 'planner', 'reviewer', 'tester', 'coder'].includes(o.agentKey))).toBe(false);
    expect(result.migrated.sort()).toEqual(['chat', 'dev', 'dev_lead', 'product', 'test']);
    expect(result.conflicts).toEqual([]);
  });

  it('多旧键映射同一新键取首个，其余记 conflict 丢弃', () => {
    const store = makeStore();
    seedLegacyOverrides(store, [
      { agentKey: 'planner', providerId: 'p1', model: 'dev-from-planner' },
      { agentKey: 'coder', providerId: 'p2', model: 'dev-from-coder' },
      { agentKey: 'reviewer', providerId: 'p3', model: 'test-from-reviewer' },
      { agentKey: 'tester', providerId: 'p4', model: 'test-from-tester' },
    ]);
    const result = store.migrateAgentOverridesToExperts();
    const after = store.listAgentOverrides();
    expect(after).toHaveLength(2);
    expect(after.find((o) => o.agentKey === 'dev')!.providerId).toBe('p1');
    expect(after.find((o) => o.agentKey === 'test')!.providerId).toBe('p3');
    expect(result.conflicts.length).toBe(2);
    expect(result.conflicts.some((c) => c.includes('coder->dev'))).toBe(true);
    expect(result.conflicts.some((c) => c.includes('tester->test'))).toBe(true);
  });

  it('幂等：已是新专家键时原样保留，无 conflict', () => {
    const store = makeStore();
    store.saveAgentOverride({ agentKey: 'ux', providerId: 'p1', model: 'ux-model' });
    store.saveAgentOverride({ agentKey: 'dev', providerId: 'p2', model: 'dev-model' });
    const result = store.migrateAgentOverridesToExperts();
    expect(result.migrated.sort()).toEqual(['dev', 'ux']);
    expect(result.conflicts).toEqual([]);
    expect(store.listAgentOverrides().map((o) => o.agentKey).sort()).toEqual(['dev', 'ux']);
  });

  it('空存储返回空结果且不写存储', () => {
    const store = makeStore();
    const result = store.migrateAgentOverridesToExperts();
    expect(result).toEqual({ migrated: [], conflicts: [] });
    expect(store.listAgentOverrides()).toEqual([]);
  });
});

describe('ProviderStore project_lead override round-trip', () => {
  it('saves, lists, and removes a project_lead override', () => {
    const store = makeStore();
    store.saveAgentOverride({ agentKey: 'project_lead', providerId: 'p1', model: 'lead-kb-model' });
    const listed = store.listAgentOverrides();
    expect(listed.find((o) => o.agentKey === 'project_lead')).toEqual({ agentKey: 'project_lead', providerId: 'p1', model: 'lead-kb-model' });
    store.removeAgentOverride('project_lead');
    expect(store.listAgentOverrides().find((o) => o.agentKey === 'project_lead')).toBeUndefined();
  });
});
