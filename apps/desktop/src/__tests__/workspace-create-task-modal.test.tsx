import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Requirement } from '@ai-devflow/core';

// lib.tsx 在模块加载期读取 window.api，故先注入 window 再动态导入（与 workspace-reqitem.test.tsx 同构）。
Object.assign(globalThis, { window: { api: {} } });
const { LocaleProvider } = await import('../i18n/index.js');
const WS = await import('../pages/Workspace.js') as {
  AiCreateTask: React.ComponentType<{ requirementId: string; requirement?: Requirement; projectPath?: string; onDirtyChange?: (dirty: boolean) => void; onCreated: (taskId: string) => void }>;
  AskCard: React.ComponentType<{ state: { toolUseId: string; tabs: unknown[]; submitted: boolean }; onSubmit: () => void }>;
};

const REQ: Requirement = { id: 'r1', iterationId: 'i', title: '示例需求', description: '示例描述', priority: 'medium', acceptance: '示例验收', createdAt: 1, archived: false };

describe('CreateTaskModal（AI 创建任务弹窗）', () => {
  it('需求已加载时渲染“一键生成任务”快捷按钮（Issue 3）', () => {
    const html = renderToStaticMarkup(
      <LocaleProvider>
        <WS.AiCreateTask requirementId="r1" requirement={REQ} onCreated={() => {}} />
      </LocaleProvider>,
    );
    expect(html).toContain('data-testid="quick-generate"');
    expect(html).toContain('一键生成任务');
    expect(html).toContain('跳过沟通直接生成任务草稿');
  });

  it('需求未加载时不渲染一键生成按钮', () => {
    const html = renderToStaticMarkup(
      <LocaleProvider>
        <WS.AiCreateTask requirementId="r1" onCreated={() => {}} />
      </LocaleProvider>,
    );
    expect(html).not.toContain('data-testid="quick-generate"');
  });
});

describe('AskCard 提交后状态（Issue 1）', () => {
  it('提交后展示 spinner + 继续处理提示，而非静态“已提交”', () => {
    const html = renderToStaticMarkup(
      <LocaleProvider>
        <WS.AskCard state={{ toolUseId: 'tu1', tabs: [], submitted: true }} onSubmit={() => {}} />
      </LocaleProvider>,
    );
    expect(html).toContain('animate-spin');
    expect(html).toContain('AI 正在继续处理');
  });
});
