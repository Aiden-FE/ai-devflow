import { describe, expect, it } from 'vitest';
import { EXPERT_PROFILES, validateExpertProfiles } from '../profiles.js';

describe('EXPERT_PROFILES', () => {
  it('含 5 个执行专家（不含 chat）', () => {
    const keys = Object.keys(EXPERT_PROFILES);
    expect(keys.sort()).toEqual(['dev', 'dev_lead', 'product', 'test', 'ux']);
  });

  it('测试专家含 write/edit 工具用于用例验证', () => {
    expect(EXPERT_PROFILES.test.tools).toContain('write');
    expect(EXPERT_PROFILES.test.tools).toContain('edit');
  });

  it('研发负责人无 bash/edit/write', () => {
    const t = EXPERT_PROFILES.dev_lead.tools;
    expect(t).not.toContain('bash');
    expect(t).not.toContain('edit');
    expect(t).not.toContain('write');
  });

  it('研发专家含 bash/edit/write', () => {
    const t = EXPERT_PROFILES.dev.tools;
    expect(t).toContain('bash');
    expect(t).toContain('edit');
    expect(t).toContain('write');
  });

  it('validateExpertProfiles 不抛', () => {
    expect(() => validateExpertProfiles()).not.toThrow();
  });
});
