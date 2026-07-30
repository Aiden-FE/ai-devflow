import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TaskStatus } from '@ai-devflow/core';

Object.assign(globalThis, { window: { api: {} } });
const { LocaleProvider } = await import('../i18n/index.js');
const TaskDetailModule = await import('../pages/TaskDetail.js') as {
  InterruptibleTaskActions?: React.ComponentType<{
    status: TaskStatus;
    busy: boolean;
    onCancel(): void;
    onPause(): void;
  }>;
};

describe('TaskDetail interrupt actions', () => {
  it('keeps cancel and pause enabled while the launch request is still pending', () => {
    expect(TaskDetailModule.InterruptibleTaskActions).toBeTypeOf('function');
    if (!TaskDetailModule.InterruptibleTaskActions) return;

    const html = renderToStaticMarkup(
      <LocaleProvider>
        <TaskDetailModule.InterruptibleTaskActions
          status="in_progress"
          busy={false}
          onCancel={() => undefined}
          onPause={() => undefined}
        />
      </LocaleProvider>,
    );

    expect(html).toContain('取消');
    expect(html).toContain('标记待沟通');
    expect(html).not.toMatch(/<button[^>]*\sdisabled(?:=|>)/);
  });
});
