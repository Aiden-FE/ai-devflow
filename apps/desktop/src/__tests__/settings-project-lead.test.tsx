import { describe, expect, it } from 'vitest';
import type { AgentKey } from '@ai-devflow/core';

// Settings 模块加载期经 lib.tsx 读取 window.api；注入桩。
Object.assign(globalThis, { window: { api: { providers: { list: async () => [] }, agentOverrides: { list: async () => [] }, settings: { getLocale: async () => 'zh' } } } });

import { zh } from '../i18n/zh.js';
import { en } from '../i18n/en.js';

const Settings = await import('../pages/Settings.js') as { AGENT_KEYS?: AgentKey[] };

describe('Settings project lead', () => {
  it('includes project_lead in the single AGENT_KEYS constant (7 keys)', () => {
    const keys = Settings.AGENT_KEYS ?? [];
    expect(keys).toContain('project_lead');
    expect(keys).toHaveLength(7);
  });

  it('exposes project lead agent and workload labels in both locales', () => {
    expect(zh['settings.agentModels.agent.project_lead']).toBe('项目负责人');
    expect(zh['settings.agentModels.workload.project_lead']).toBe('knowledge_maintenance');
    expect(en['settings.agentModels.agent.project_lead']).toBe('Project lead');
    expect(en['nav.knowledge']).toBe('Knowledge');
  });
});
