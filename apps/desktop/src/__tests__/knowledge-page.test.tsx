import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '@ai-devflow/core';

const knowledgeApi = {
  getProjectSnapshot: vi.fn(async () => ({ projectId: 'p', state: 'not_initialized', checkedAt: 1, counts: { context: 0, adr: 0, feature: 0, runbook: 0, product: 0, ux: 0 }, findings: [] })),
  startInitialization: vi.fn(async () => ({ id: 'r', projectId: 'p', kind: 'initialization', state: 'awaiting_confirmation', confirmationState: 'pending', changedPaths: [], findings: [], diagnostics: [], startedAt: 1 })),
  startAudit: vi.fn(async () => ({ id: 'r', projectId: 'p', kind: 'light_audit', state: 'succeeded', confirmationState: 'not_required', changedPaths: [], findings: [], diagnostics: [], startedAt: 1 })),
  startRepair: vi.fn(async () => ({ id: 'r', projectId: 'p', kind: 'repair', state: 'awaiting_confirmation', confirmationState: 'pending', changedPaths: [], findings: [], diagnostics: [], startedAt: 1 })),
  getRun: vi.fn(async () => undefined),
  confirmRun: vi.fn(async () => ({ projectId: 'p', state: 'healthy', checkedAt: 1, counts: { context: 1, adr: 0, feature: 0, runbook: 0, product: 0, ux: 0 }, findings: [] })),
  cancelRun: vi.fn(async () => undefined),
  getTaskEvidence: vi.fn(async () => ({ retrievals: [] })),
  getIterationVerification: vi.fn(async () => ({ iterationId: 'i', state: 'pending', coveredTaskIds: [], missingTaskIds: [], changedPaths: [], findings: [] })),
};
Object.assign(globalThis, { window: { api: { knowledge: knowledgeApi } } });

const { LocaleProvider } = await import('../i18n/index.js');
const KP = (await import('../pages/Knowledge.js')) as { KnowledgePage: React.ComponentType<{ project: Project }> };

const project: Project = { id: 'p', name: 'P', path: '/x', defaultBranch: 'main', createdAt: 1, updatedAt: 1, settings: {} };

describe('KnowledgePage', () => {
  it('renders the initialize knowledge base button (enabled when not_initialized)', () => {
    // SSR 不执行 effect，故 snapshot 未填充；按钮始终静态渲染。
    const html = renderToStaticMarkup(
      <LocaleProvider>
        <KP.KnowledgePage project={project} />
      </LocaleProvider>,
    );
    expect(html).toContain('初始化知识库');
    expect(html).toContain('完整巡检');
    expect(html).toContain('修复');
  });
});
