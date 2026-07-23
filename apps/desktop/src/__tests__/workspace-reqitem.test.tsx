import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Requirement, Task } from '@ai-devflow/core';

// lib.tsx 在模块加载期读取 window.api，故先注入 window 再动态导入（静态 import 会被提升到注入之前）。
Object.assign(globalThis, { window: { api: {} } });
const { LocaleProvider } = await import('../i18n/index.js');
const WS = await import('../pages/Workspace.js') as {
  paginate: <T>(items: T[], page: number, pageSize: number) => { items: T[]; totalPages: number };
  ReqItem: React.ComponentType<{ req: Requirement; tasks: Task[]; onCreateTask: () => void; onArchived: () => void }>;
};

function mkReq(id: string): Requirement {
  return { id, iterationId: 'i', title: `需求 ${id}`, description: '', priority: 'medium', acceptance: 'acc', createdAt: 1, archived: false };
}
function mkTask(id: string, requirementId: string): Task {
  return { id, requirementId, iterationId: 'i', projectId: 'p', title: `子任务 ${id}`, description: '', status: 'ready', role: 'coder', stages: [], currentStage: 0, statusChangedAt: 1, createdAt: 1, updatedAt: 1, retryCount: 0 } as Task;
}

describe('paginate', () => {
  it('slices one page and reports total pages', () => {
    const items = Array.from({ length: 25 }, (_, i) => i);
    expect(WS.paginate(items, 0, 10)).toEqual({ items: items.slice(0, 10), totalPages: 3 });
    expect(WS.paginate(items, 2, 10).items).toEqual(items.slice(20, 30));
    expect(WS.paginate(items, 99, 10).items).toEqual(items.slice(20, 30)); // 越界回退末页
  });
  it('handles empty input as one page', () => {
    expect(WS.paginate([], 0, 10)).toEqual({ items: [], totalPages: 1 });
  });
});

describe('ReqItem collapse', () => {
  it('collapses subtasks by default when subtasks exist', () => {
    const html = renderToStaticMarkup(
      <LocaleProvider><WS.ReqItem req={mkReq('r1')} tasks={[mkTask('t1', 'r1'), mkTask('t2', 'r1')]} onCreateTask={() => {}} onArchived={() => {}} /></LocaleProvider>,
    );
    expect(html).toContain('data-testid="req-subtasks-toggle"');
    expect(html).not.toContain('子任务 t1'); // 收起时不渲染子任务标题
  });
  it('renders no toggle when there are no subtasks', () => {
    const html = renderToStaticMarkup(
      <LocaleProvider><WS.ReqItem req={mkReq('r2')} tasks={[]} onCreateTask={() => {}} onArchived={() => {}} /></LocaleProvider>,
    );
    expect(html).not.toContain('req-subtasks-toggle');
  });
});
