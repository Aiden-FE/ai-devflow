// @vitest-environment happy-dom
import React from 'react';
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import type { KnowledgeHealthSnapshot, KnowledgeRunView, Project } from '@ai-devflow/core';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// ---- Select mock: native <select> so switching is drivable without Radix ----
vi.mock('../components/ui/select.js', () => ({
  Select: ({ value, disabled, onValueChange, children }: any) => (
    <select
      data-testid="knowledge-project-select"
      value={value}
      disabled={disabled}
      onChange={(event) => onValueChange(event.currentTarget.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: ({ children }: any) => <>{children}</>,
  SelectValue: () => null,
  SelectContent: ({ children }: any) => <>{children}</>,
  SelectItem: ({ value, children }: any) => <option value={value}>{children}</option>,
}));

// ---- deferred promise helper ----
type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function snapshot(projectId: string, overrides: Partial<KnowledgeHealthSnapshot> = {}): KnowledgeHealthSnapshot {
  return {
    projectId,
    state: 'healthy',
    checkedAt: 1,
    counts: { context: 1, adr: 0, feature: 0, runbook: 0, product: 0, ux: 0 },
    findings: [],
    ...overrides,
  };
}

function pendingRun(projectId: string): KnowledgeRunView {
  return {
    id: 'run-' + projectId,
    projectId,
    kind: 'initialization',
    state: 'awaiting_confirmation',
    confirmationState: 'pending',
    changedPaths: [],
    findings: [],
    diagnostics: [],
    startedAt: 1,
  };
}

function succeededRun(projectId: string, kind: any): KnowledgeRunView {
  return { id: 'r-' + kind, projectId, kind, state: 'succeeded', confirmationState: 'not_required', changedPaths: [], findings: [], diagnostics: [], startedAt: 1 };
}

const p1: Project = { id: 'p1', name: 'Proj A', path: '/repos/a', defaultBranch: 'main', createdAt: 0, updatedAt: 0, settings: {} };
const p2: Project = { id: 'p2', name: 'Proj B', path: '/repos/b', defaultBranch: 'main', createdAt: 0, updatedAt: 0, settings: {} };
const projects = [p1, p2];

// ---- knowledge API mock (per-test reset via beforeEach) ----
const knowledgeApi = {
  getProjectSnapshot: vi.fn(),
  startInitialization: vi.fn(),
  startAudit: vi.fn(),
  startRepair: vi.fn(),
  confirmRun: vi.fn(),
  cancelRun: vi.fn(),
  getRun: vi.fn(async () => undefined),
  getTaskEvidence: vi.fn(async () => ({ retrievals: [] })),
  getIterationVerification: vi.fn(async () => ({ iterationId: 'i', state: 'pending', coveredTaskIds: [], missingTaskIds: [], changedPaths: [], findings: [] })),
};
// Extend the happy-dom window (do NOT replace it - react-dom's synthetic event
// system needs window.addEventListener etc.).
Object.assign(window, {
  api: { knowledge: knowledgeApi },
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
});
// happy-dom omits window.HTMLIFrameElement; react-dom@18 getActiveElementDeep uses
// `element instanceof win.HTMLIFrameElement` during prepareForCommit when focusable
// elements (buttons) are committed. Define a minimal constructor so instanceof works.
if (!(window as unknown as Record<string, unknown>).HTMLIFrameElement) {
  Object.defineProperty(window, 'HTMLIFrameElement', {
    value: class HTMLIFrameElement {},
    configurable: true,
    writable: true,
  });
}

// i18n: bypass LocaleProvider; t() returns its key so labels are predictable.
vi.mock('../i18n/index.js', () => ({
  useT: () => (key: string) => key,
  LocaleProvider: ({ children }: any) => <>{children}</>,
}));

const { KnowledgePage } = await import('../pages/Knowledge.js') as { KnowledgePage: React.ComponentType<any> };

let root: Root | undefined;
let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = undefined;
});

afterEach(async () => {
  // Flush all pending fire-and-forget refresh chains before unmounting,
  // otherwise a late setSnapshot/setLoading lands on a detached root and
  // corrupts the next test's act boundary ("Should not already be working").
  for (let i = 0; i < 6; i++) {
    await act(async () => { await Promise.resolve(); });
  }
  if (root) {
    await act(async () => { root!.unmount(); });
    root = undefined;
  }
  container.remove();
  vi.clearAllMocks();
});

async function flush() {
  for (let i = 0; i < 4; i++) {
    await act(async () => { await Promise.resolve(); });
  }
}

function render(props: any) {
  act(() => {
    root = createRoot(container);
    root.render(<KnowledgePage {...props} />);
  });
}
function rerender(props: any) {
  act(() => { root!.render(<KnowledgePage {...props} />); });
}
function click(el: Element | null | undefined) {
  act(() => { (el as HTMLElement | null)?.click(); });
}
function changeSelect(value: string) {
  const sel = container.querySelector('[data-testid="knowledge-project-select"]') as HTMLSelectElement | null;
  act(() => {
    if (!sel) return;
    sel.value = value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
function text(): string {
  return container.textContent ?? '';
}
function findButton(substr: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(substr));
}

// ===========================================================================
// Step 1: selector rendering + switching
// ===========================================================================
describe('KnowledgePage project selector', () => {
  beforeEach(() => {
    knowledgeApi.getProjectSnapshot.mockResolvedValue(snapshot('p1'));
  });

  it('renders all project names, active id, active path, and switches via onSwitchProject', async () => {
    const onSwitchProject = vi.fn();
    render({ project: p1, projects, onSwitchProject });
    await flush();

    expect(text()).toContain('Proj A');
    expect(text()).toContain('Proj B');
    expect(text()).toContain('/repos/a');
    const shell = container.querySelector('[data-testid="knowledge-shell"]');
    expect(shell?.getAttribute('data-project-id')).toBe('p1');

    changeSelect('p2');
    expect(onSwitchProject).toHaveBeenCalledWith('p2');
  });

  it('renders the snapshot region with data-snapshot-project-id matching the loaded project', async () => {
    render({ project: p1, projects, onSwitchProject: () => {} });
    await flush();
    const region = container.querySelector('[data-snapshot-project-id]');
    expect(region?.getAttribute('data-snapshot-project-id')).toBe('p1');
  });
});

// ===========================================================================
// Step 2: reset + stale-response rejection
// ===========================================================================
describe('KnowledgePage project reset and stale response rejection', () => {
  it('clears old snapshot, selectedFindings, and error on project change; shows loading', async () => {
    const d1 = deferred<KnowledgeHealthSnapshot>();
    knowledgeApi.getProjectSnapshot.mockReturnValueOnce(d1.promise);
    render({ project: p1, projects, onSwitchProject: () => {} });
    // resolve p1 snapshot with a finding (resolve inside act so state flushes)
    await act(async () => { d1.resolve(snapshot('p1', { findings: [{ id: 'f1', severity: 'warn', code: 'C', message: 'm', evidence: [] }] })); });
    await flush();
    expect(text()).toContain('[warn] C: m');

    // select the finding (use .click() so React's synthetic onChange fires)
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    act(() => { checkbox.click(); });
    await flush();
    expect(text()).toContain('[warn] C: m');

    // inject an error by rejecting an audit (reject inside act)
    const auditErr = deferred<KnowledgeRunView>();
    knowledgeApi.startAudit.mockReturnValueOnce(auditErr.promise);
    click(findButton('knowledge.fullAudit'));
    await act(async () => { auditErr.reject(new Error('audit failed')); });
    await flush();
    expect(text()).toContain('audit failed');

    // switch to p2: the d2 snapshot stays pending -> loading state, old state cleared
    const d2 = deferred<KnowledgeHealthSnapshot>();
    knowledgeApi.getProjectSnapshot.mockReturnValueOnce(d2.promise);
    rerender({ project: p2, projects, onSwitchProject: () => {} });
    await flush();

    // old finding and error must be gone
    expect(text()).not.toContain('[warn] C: m');
    expect(text()).not.toContain('audit failed');
    // shell reflects the new project
    expect(container.querySelector('[data-testid="knowledge-shell"]')?.getAttribute('data-project-id')).toBe('p2');
    // stable loading state is present while p2 snapshot is pending (refresh(true) sets loading=true)
    expect(container.querySelector('[data-testid="knowledge-shell"] .h-40')).not.toBeNull();
  });

  it('rejects a late response from the previous project and keeps only the new project data', async () => {
    const d1 = deferred<KnowledgeHealthSnapshot>();
    knowledgeApi.getProjectSnapshot.mockReturnValueOnce(d1.promise);
    render({ project: p1, projects, onSwitchProject: () => {} });

    const d2 = deferred<KnowledgeHealthSnapshot>();
    knowledgeApi.getProjectSnapshot.mockReturnValueOnce(d2.promise);
    rerender({ project: p2, projects, onSwitchProject: () => {} });
    await flush();

    // resolve the OLD p1 request AFTER p2 started -> must not overwrite
    await act(async () => { d1.resolve(snapshot('p1')); });
    await flush();
    const regionAfterLate = container.querySelector('[data-snapshot-project-id]');
    expect(regionAfterLate).toBeNull(); // still loading, p1 ignored

    // resolve p2 -> only p2 data visible
    await act(async () => { d2.resolve(snapshot('p2')); });
    await flush();
    const region = container.querySelector('[data-snapshot-project-id]');
    expect(region?.getAttribute('data-snapshot-project-id')).toBe('p2');
  });
});

// ===========================================================================
// Step 5: switching guards
// ===========================================================================
describe('KnowledgePage switching guards', () => {
  it('disables the selector while a mutation (audit) is in flight', async () => {
    knowledgeApi.getProjectSnapshot.mockResolvedValue(snapshot('p1'));
    render({ project: p1, projects, onSwitchProject: () => {} });
    await flush();

    const auditD = deferred<KnowledgeRunView>();
    knowledgeApi.startAudit.mockReturnValueOnce(auditD.promise);
    click(findButton('knowledge.fullAudit'));
    await flush();
    const sel = container.querySelector('[data-testid="knowledge-project-select"]') as HTMLSelectElement;
    expect(sel.disabled).toBe(true);

    await act(async () => { auditD.resolve(succeededRun('p1', 'full_audit')); });
    await flush();
    expect(sel.disabled).toBe(false);
  });

  it('keeps the selector disabled while a draft awaits confirmation, re-enabled after confirm', async () => {
    knowledgeApi.getProjectSnapshot.mockResolvedValue(snapshot('p1', { state: 'not_initialized' }));
    render({ project: p1, projects, onSwitchProject: () => {} });
    await flush();

    knowledgeApi.startInitialization.mockResolvedValueOnce(pendingRun('p1'));
    click(findButton('knowledge.initialize'));
    await flush();
    const sel = container.querySelector('[data-testid="knowledge-project-select"]') as HTMLSelectElement;
    expect(sel.disabled).toBe(true);

    knowledgeApi.confirmRun.mockResolvedValueOnce(snapshot('p1') as any);
    click(findButton('common.confirm'));
    await flush();
    expect(sel.disabled).toBe(false);
  });

  it('keeps selector disabled during a pending run until cancel resolves', async () => {
    knowledgeApi.getProjectSnapshot.mockResolvedValue(snapshot('p1', { state: 'not_initialized' }));
    render({ project: p1, projects, onSwitchProject: () => {} });
    await flush();

    knowledgeApi.startInitialization.mockResolvedValueOnce(pendingRun('p1'));
    click(findButton('knowledge.initialize'));
    await flush();
    const sel = container.querySelector('[data-testid="knowledge-project-select"]') as HTMLSelectElement;
    expect(sel.disabled).toBe(true);

    const cancelD = deferred<void>();
    knowledgeApi.cancelRun.mockReturnValueOnce(cancelD.promise);
    click(findButton('common.cancel'));
    await flush();
    expect(sel.disabled).toBe(true);

    await act(async () => { cancelD.resolve(); });
    await flush();
    expect(sel.disabled).toBe(false);
  });

  it('after switching to p2, audit/initialize/repair receive p2 never p1', async () => {
    knowledgeApi.getProjectSnapshot.mockResolvedValue(snapshot('p2', { state: 'not_initialized', findings: [{ id: 'f1', severity: 'warn', code: 'C', message: 'm', evidence: [] }] }));
    render({ project: p2, projects, onSwitchProject: () => {} });
    await flush();

    knowledgeApi.startAudit.mockResolvedValue(succeededRun('p2', 'full_audit'));
    knowledgeApi.startInitialization.mockResolvedValue(pendingRun('p2'));
    knowledgeApi.startRepair.mockResolvedValue(pendingRun('p2'));

    // audit
    click(findButton('knowledge.fullAudit'));
    await flush();

    // initialize
    click(findButton('knowledge.initialize'));
    await flush();

    // select a finding then repair (use .click() so React's synthetic onChange fires)
    const cb = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    act(() => { cb.click(); });
    await flush();
    click(findButton('knowledge.repair'));
    await flush();

    expect(knowledgeApi.startAudit).toHaveBeenCalledWith('p2', 'full');
    expect(knowledgeApi.startInitialization).toHaveBeenCalledWith('p2');
    expect(knowledgeApi.startRepair).toHaveBeenCalledWith('p2', ['f1']);
    expect(knowledgeApi.startAudit).not.toHaveBeenCalledWith('p1', 'full');
    expect(knowledgeApi.startInitialization).not.toHaveBeenCalledWith('p1');
  });
});
