// @vitest-environment happy-dom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import type { Project } from '@ai-devflow/core';

// React 18 needs this to treat the happy-dom env as an act environment.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const p1: Project = { id: 'p1', name: 'P1', path: '/p1', defaultBranch: 'main', createdAt: 0, updatedAt: 0, settings: {} };
const p2: Project = { id: 'p2', name: 'P2', path: '/p2', defaultBranch: 'main', createdAt: 0, updatedAt: 0, settings: {} };

// lib.tsx binds `api = window.api` at module-eval time, so window.api must
// exist before App is imported. The project list is mutable so the no-project
// case can swap it.
let currentProjects: Project[] = [p1, p2];

(globalThis as any).window.api = {
  projects: { list: () => Promise.resolve(currentProjects) },
  tasks: { listAll: () => Promise.resolve([]) },
  events: { subscribe: () => () => {} },
  settings: { getLocale: () => Promise.resolve('zh') },
};

// i18n: bypass LocaleProvider; t() returns its key so nav button text is predictable.
vi.mock('../i18n/index.js', () => ({
  useT: () => (key: string) => key,
}));

// Knowledge mock: exposes the shared contract + a switch button.
vi.mock('../pages/Knowledge.js', () => ({
  KnowledgePage: ({ project, onSwitchProject }: {
    project: Project;
    projects: Project[];
    onSwitchProject(id: string): void;
  }) => (
    <div>
      <span data-testid="knowledge-project">{project.id}</span>
      <button onClick={() => onSwitchProject('p2')}>switch knowledge project</button>
    </div>
  ),
}));

// Workspace mock: surfaces the project it currently observes.
vi.mock('../pages/Workspace.js', () => ({
  WorkspacePage: ({ project }: { project?: Project }) => (
    <div data-testid="workspace-mock">
      <span data-testid="workspace-project">{project?.id ?? 'none'}</span>
    </div>
  ),
}));

vi.mock('../pages/Projects.js', () => ({ ProjectsPage: () => <div data-testid="projects-mock" /> }));
vi.mock('../pages/Settings.js', () => ({ SettingsPage: () => <div /> }));
vi.mock('../pages/UsageStats.js', () => ({ UsageStatsPage: () => <div /> }));

function findButton(text: string): HTMLButtonElement {
  const buttons = Array.from(document.body.querySelectorAll('button'));
  return buttons.find((b) => (b.textContent ?? '').includes(text)) as HTMLButtonElement;
}

let root: ReturnType<typeof createRoot> | null = null;

async function renderApp(): Promise<void> {
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root')!);
  await act(async () => {
    root!.render(<App />);
  });
  // Flush the async projects.list() / tasks.listAll() effects.
  await act(async () => { /* flush microtasks */ });
}

const { App } = await import('../App.js');

afterEach(async () => {
  if (root) {
    await act(async () => { root!.unmount(); });
    root = null;
  }
  document.body.innerHTML = '';
  currentProjects = [p1, p2];
});

describe('App knowledge navigation', () => {
  it('selects the first project and opens knowledge when none is selected', async () => {
    currentProjects = [p1, p2];
    await renderApp();

    // Knowledge nav is enabled because projects exist; clicking with no project
    // selected should fall back to projects[0] (p1) and open the knowledge page.
    await act(async () => { findButton('nav.knowledge').click(); });
    await act(async () => { /* flush */ });

    const knowledgeProject = document.querySelector('[data-testid="knowledge-project"]');
    expect(knowledgeProject?.textContent).toBe('p1');
  });

  it('reflects a knowledge-side project switch in the workspace', async () => {
    currentProjects = [p1, p2];
    await renderApp();

    await act(async () => { findButton('nav.knowledge').click(); });
    await act(async () => { /* flush */ });
    await act(async () => { findButton('switch knowledge project').click(); });
    await act(async () => { /* flush */ });
    await act(async () => { findButton('nav.workspace').click(); });
    await act(async () => { /* flush */ });

    const workspaceProject = document.querySelector('[data-testid="workspace-project"]');
    expect(workspaceProject?.textContent).toBe('p2');
  });

  it('disables knowledge navigation when no projects exist', async () => {
    currentProjects = [];
    await renderApp();

    expect(findButton('nav.knowledge').disabled).toBe(true);
  });
});
