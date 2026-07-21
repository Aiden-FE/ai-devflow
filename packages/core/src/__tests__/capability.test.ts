import { describe, it, expect } from 'vitest';
import { mergeRoleConfig, resolveRoleConfig, resolveRoleConfigForRole, stripInheritedFields } from '../capability.js';
import type { RoleAgentConfig } from '../types.js';

describe('mergeRoleConfig（项目显式值 > 全局值）', () => {
  it('inherits global when project field is undefined', () => {
    const global: RoleAgentConfig = { tools: ['Bash', 'Read'], requireApproval: true };
    const merged = mergeRoleConfig(global, {});
    expect(merged.tools).toEqual(['Bash', 'Read']);
    expect(merged.requireApproval).toBe(true);
  });

  it('project explicit value overrides global', () => {
    const global: RoleAgentConfig = { tools: ['Bash', 'Read'] };
    const project: RoleAgentConfig = { tools: ['Edit'] };
    expect(mergeRoleConfig(global, project).tools).toEqual(['Edit']);
  });

  it('treats [] as an explicit override (not "unset")', () => {
    // 空数组 = 显式禁用全部工具，必须覆盖全局的非空值
    const global: RoleAgentConfig = { tools: ['Bash'], skills: ['x'] };
    const project: RoleAgentConfig = { tools: [] };
    const merged = mergeRoleConfig(global, project);
    expect(merged.tools).toEqual([]);
    expect(merged.skills).toEqual(['x']); // 未覆盖的字段仍继承
  });

  it('field-by-field merge (some overridden, some inherited)', () => {
    const global: RoleAgentConfig = { agentType: 'codex', tools: ['Bash'], plugins: ['p1'] };
    const project: RoleAgentConfig = { tools: ['Edit'] };
    const merged = mergeRoleConfig(global, project);
    expect(merged.agentType).toBe('codex'); // 继承
    expect(merged.tools).toEqual(['Edit']); // 覆盖
    expect(merged.plugins).toEqual(['p1']); // 继承
  });
});

describe('resolveRoleConfig（标注来源）', () => {
  it('marks overridden vs inherited fields', () => {
    const global: RoleAgentConfig = { tools: ['Bash'], requireApproval: true };
    const project: RoleAgentConfig = { tools: [] };
    const { overridden } = resolveRoleConfig(global, project);
    expect(overridden.tools).toBe(true); // 项目覆盖
    expect(overridden.requireApproval).toBe(false); // 继承全局
    expect(overridden.plugins).toBe(false); // 均未配置
  });
});

describe('resolveRoleConfigForRole', () => {
  it('resolves per role from global + project maps', () => {
    const global = { reviewer: { tools: ['Read'] } as RoleAgentConfig };
    const project = { reviewer: { requireApproval: true } as RoleAgentConfig };
    const { config } = resolveRoleConfigForRole('reviewer', global, project);
    expect(config.tools).toEqual(['Read']);
    expect(config.requireApproval).toBe(true);
  });
});

describe('stripInheritedFields（保存时不固化继承值）', () => {
  it('drops fields identical to global, keeps real overrides', () => {
    const global: RoleAgentConfig = { tools: ['Bash'], requireApproval: true };
    // 表单把继承的 tools 原样带回（与全局相同），requireApproval 改为 false（真实覆盖）
    const project: RoleAgentConfig = { tools: ['Bash'], requireApproval: false };
    const stripped = stripInheritedFields(global, project);
    expect(stripped.tools).toBeUndefined(); // 与全局一致 -> 不写入
    expect(stripped.requireApproval).toBe(false); // 真实覆盖 -> 保留
  });

  it('keeps [] override even though global is unset', () => {
    const stripped = stripInheritedFields({}, { tools: [] });
    expect(stripped.tools).toEqual([]);
  });
});
