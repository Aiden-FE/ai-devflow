import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Task, TaskStatus } from '@ai-devflow/core';

Object.assign(globalThis, { window: { api: {} } });
const { LocaleProvider } = await import('../i18n/index.js');
const Workspace = await import('../pages/Workspace.js') as unknown as {
  TaskCard: React.ComponentType<{
    task: Task;
    selected: boolean;
    onSelect: (id: string) => void;
    onDragState: (id?: string) => void;
  }>;
  dropActionFor: (tasks: Task[], taskId: string, target: TaskStatus) => unknown;
};

function task(status: TaskStatus): Task {
  return {
    id: `task-${status}`,
    requirementId: 'r',
    iterationId: 'i',
    projectId: 'p',
    title: status,
    description: '',
    status,
    role: 'coder',
    stages: [],
    currentStage: 0,
    statusChangedAt: 1,
    createdAt: 1,
    updatedAt: 1,
    retryCount: 0,
  };
}

function renderCard(status: TaskStatus): string {
  return renderToStaticMarkup(
    <LocaleProvider>
      <Workspace.TaskCard task={task(status)} selected={false} onSelect={() => {}} onDragState={() => {}} />
    </LocaleProvider>,
  );
}

describe('workspace drag policy', () => {
  it('renders only ready and in-review cards as draggable', () => {
    expect(renderCard('ready')).toContain('draggable="true"');
    expect(renderCard('in_review')).toContain('draggable="true"');
    for (const status of ['backlog', 'in_progress', 'testing', 'awaiting_input', 'archived'] as TaskStatus[]) {
      expect(renderCard(status)).not.toContain('draggable="true"');
    }
  });

  it('returns actions only for allowed source-target pairs', () => {
    const tasks = [task('ready'), task('in_review'), task('testing')];
    expect(Workspace.dropActionFor(tasks, 'task-ready', 'in_progress')).toEqual({ kind: 'start' });
    expect(Workspace.dropActionFor(tasks, 'task-in_review', 'archived')).toEqual({ kind: 'accept' });
    expect(Workspace.dropActionFor(tasks, 'task-in_review', 'ready')).toEqual({ kind: 'reject', target: 'ready' });
    expect(Workspace.dropActionFor(tasks, 'task-in_review', 'in_progress')).toEqual({ kind: 'reject', target: 'in_progress' });
    expect(Workspace.dropActionFor(tasks, 'task-testing', 'ready')).toBeUndefined();
    expect(Workspace.dropActionFor(tasks, 'missing', 'ready')).toBeUndefined();
  });
});
