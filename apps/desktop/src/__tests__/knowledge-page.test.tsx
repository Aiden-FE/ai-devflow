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

function pendingRun(projectId: string, overrides: Partial<KnowledgeRunView> = {}): KnowledgeRunView {
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
    ...overrides,
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
  getActiveRun: vi.fn(async (): Promise<KnowledgeRunView | undefined> => undefined),
  startInitialization: vi.fn(),
  startAudit: vi.fn(),
  startRepair: vi.fn(),
  confirmRun: vi.fn(),
  cancelRun: vi.fn(),
  getRun: vi.fn(async () => undefined),
  getTaskEvidence: vi.fn(async () => ({ retrievals: [] })),
  getIterationVerification: vi.fn(async () => ({ iterationId: 'i', state: 'pending', coveredTaskIds: [], missingTaskIds: [], changedPaths: [], findings: [] })),
};
// events.subscribe: 默认返回空订阅；个别用例可覆写以模拟运行事件。
const eventsApi = { subscribe: vi.fn((_handler: (e: any) => void) => () => {}) };
// Extend the happy-dom window (do NOT replace it - react-dom's synthetic event
// system needs window.addEventListener etc.).
Object.assign(window, {
  api: { knowledge: knowledgeApi, events: eventsApi },
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
function runningRun(projectId: string): KnowledgeRunView {
  return { id: 'running-' + projectId, projectId, kind: 'initialization', state: 'running', confirmationState: 'not_required', changedPaths: [], findings: [], diagnostics: [], startedAt: 1 };
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
// Step 6: in-progress run recovery (切页重进后恢复运行态 + 进度指示 + 事件订阅)
// ===========================================================================
describe('KnowledgePage in-progress recovery', () => {
  it('renders a readable, expandable review instead of a raw diff dump', async () => {
    knowledgeApi.getProjectSnapshot.mockResolvedValue(snapshot('p1', { state: 'not_initialized' }));
    knowledgeApi.getActiveRun.mockResolvedValueOnce(pendingRun('p1', {
      draftBranch: 'knowledge/draft-run-p1',
      changedPaths: ['knowledges/context/project.md', 'knowledges/runbook/setup.md'],
      diff: `diff --git a/knowledges/context/project.md b/knowledges/context/project.md
--- a/knowledges/context/project.md
+++ b/knowledges/context/project.md
@@ -1,2 +1,2 @@
 # Project
-Old summary
+Current summary
diff --git a/knowledges/runbook/setup.md b/knowledges/runbook/setup.md
new file mode 100644
--- /dev/null
+++ b/knowledges/runbook/setup.md
@@ -0,0 +1,2 @@
+# Setup
+Run pnpm install`,
    }));
    render({ project: p1, projects, onSwitchProject: () => {} });
    await flush();

    const review = container.querySelector('[data-testid="knowledge-draft-review"]');
    const files = container.querySelectorAll('[data-testid="knowledge-draft-file"]');
    expect(review).toBeTruthy();
    expect(files).toHaveLength(2);
    expect(text()).toContain('knowledge.draft.summary');
    expect(text()).toContain('knowledges/context/project.md');
    expect(text()).toContain('knowledges/runbook/setup.md');
    expect(text()).toContain('Current summary');
    expect(text()).not.toContain('Run pnpm install');
    expect(text()).not.toContain('diff --git');

    click(files[1].querySelector('button'));
    expect(text()).toContain('Run pnpm install');
    expect(container.querySelectorAll('[data-testid="knowledge-diff-line"]').length).toBeGreaterThan(0);
  });

  it('lists changed paths when no diff content is available', async () => {
    knowledgeApi.getProjectSnapshot.mockResolvedValue(snapshot('p1', { state: 'not_initialized' }));
    knowledgeApi.getActiveRun.mockResolvedValueOnce(pendingRun('p1', {
      changedPaths: ['knowledges/context/project.md'],
    }));
    render({ project: p1, projects, onSwitchProject: () => {} });
    await flush();

    expect(container.querySelector('[data-testid="knowledge-draft-review"]')).toBeTruthy();
    expect(text()).toContain('knowledges/context/project.md');
    expect(text()).toContain('knowledge.draft.diffUnavailable');
  });

  it('confirms the pending run recovered on page entry', async () => {
    knowledgeApi.getProjectSnapshot.mockResolvedValue(snapshot('p1', { state: 'not_initialized' }));
    knowledgeApi.getActiveRun.mockResolvedValueOnce(pendingRun('p1'));
    knowledgeApi.confirmRun.mockResolvedValueOnce(snapshot('p1'));
    render({ project: p1, projects, onSwitchProject: () => {} });
    await flush();

    click(findButton('common.confirm'));
    await flush();

    expect(knowledgeApi.confirmRun).toHaveBeenCalledWith('run-p1');
  });

  it('keeps the draft visible and presents deduplicated validation issues when confirmation is blocked', async () => {
    knowledgeApi.getProjectSnapshot.mockResolvedValue(snapshot('p1', { state: 'not_initialized' }));
    knowledgeApi.getActiveRun.mockResolvedValueOnce(pendingRun('p1', {
      changedPaths: ['docs/knowledge/context/project.md'],
      diff: `diff --git a/docs/knowledge/context/project.md b/docs/knowledge/context/project.md
--- a/docs/knowledge/context/project.md
+++ b/docs/knowledge/context/project.md
@@ -1 +1 @@
-old
+new`,
    }));
    knowledgeApi.confirmRun.mockRejectedValueOnce(new Error(
      "Error invoking remote method 'ai-devflow:knowledge:confirmRun': Error: "
      + '草稿校验阻断：引用目标不存在：adr:001; '
      + '草稿校验阻断：来源路径非法：entrypoints/popup/; '
      + '草稿校验阻断：引用目标不存在：adr:001',
    ));
    render({ project: p1, projects, onSwitchProject: () => {} });
    await flush();

    click(findButton('common.confirm'));
    await flush();

    expect(container.querySelector('[data-testid="knowledge-draft-review"]')).toBeTruthy();
    const validation = container.querySelector('[data-testid="knowledge-draft-validation"]');
    expect(validation).toBeTruthy();
    expect(validation?.querySelectorAll('li')).toHaveLength(2);
    expect(validation?.textContent).toContain('引用目标不存在：adr:001');
    expect(validation?.textContent).toContain('来源路径非法：entrypoints/popup/');
    expect(validation?.textContent).not.toContain('Error invoking remote method');
    expect(findButton('common.cancel')?.disabled).toBe(false);
  });

  it('restores draft validation issues from a recovered pending run', async () => {
    knowledgeApi.getProjectSnapshot.mockResolvedValue(snapshot('p1', { state: 'not_initialized' }));
    knowledgeApi.getActiveRun.mockResolvedValueOnce(pendingRun('p1', {
      changedPaths: ['docs/knowledge/index.md'],
      findings: [
        { id: 'f1', severity: 'error', code: 'invalid_reference', message: '引用目标不存在：adr:001', evidence: [] },
        { id: 'f2', severity: 'error', code: 'invalid_reference', message: '引用目标不存在：adr:001', evidence: [] },
        { id: 'f3', severity: 'warn', code: 'stale', message: '可能过期', evidence: [] },
      ],
    }));
    render({ project: p1, projects, onSwitchProject: () => {} });
    await flush();

    const validation = container.querySelector('[data-testid="knowledge-draft-validation"]');
    expect(validation).toBeTruthy();
    expect(validation?.querySelectorAll('li')).toHaveLength(1);
    expect(validation?.textContent).toContain('引用目标不存在：adr:001');
    expect(validation?.textContent).not.toContain('可能过期');
  });

  it('cancels the pending run recovered on page entry', async () => {
    knowledgeApi.getProjectSnapshot.mockResolvedValue(snapshot('p1', { state: 'not_initialized' }));
    knowledgeApi.getActiveRun.mockResolvedValueOnce(pendingRun('p1'));
    knowledgeApi.cancelRun.mockResolvedValueOnce(undefined);
    render({ project: p1, projects, onSwitchProject: () => {} });
    await flush();

    click(findButton('common.cancel'));
    await flush();

    expect(knowledgeApi.cancelRun).toHaveBeenCalledWith('run-p1');
  });

  it('disables new knowledge operations while a draft awaits confirmation', async () => {
    knowledgeApi.getProjectSnapshot.mockResolvedValue(snapshot('p1', {
      state: 'not_initialized',
      findings: [{ id: 'f1', severity: 'warn', code: 'C', message: 'm', evidence: [] }],
    }));
    knowledgeApi.getActiveRun.mockResolvedValueOnce(pendingRun('p1'));
    render({ project: p1, projects, onSwitchProject: () => {} });
    await flush();

    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    act(() => { checkbox.click(); });
    await flush();

    expect(findButton('knowledge.initialize')?.disabled).toBe(true);
    expect(findButton('knowledge.fullAudit')?.disabled).toBe(true);
    expect(findButton('knowledge.repair')?.disabled).toBe(true);
    expect(findButton('common.confirm')?.disabled).toBe(false);
    expect(findButton('common.cancel')?.disabled).toBe(false);
  });

  it('recovers a running run from getActiveRun and shows a progress panel with buttons disabled', async () => {
    knowledgeApi.getProjectSnapshot.mockResolvedValue(snapshot('p1', { state: 'not_initialized' }));
    knowledgeApi.getActiveRun.mockResolvedValueOnce(runningRun('p1'));
    render({ project: p1, projects, onSwitchProject: () => {} });
    await flush();

    const progress = container.querySelector('[data-testid="knowledge-run-progress"]');
    expect(progress?.getAttribute('data-run-id')).toBe('running-p1');
    expect(progress?.getAttribute('data-run-state')).toBe('running');
    // 运行中时初始化/巡检/修复按钮均禁用。
    expect(findButton('knowledge.initialize')?.disabled).toBe(true);
    expect(findButton('knowledge.fullAudit')?.disabled).toBe(true);
  });

  it('disables the selector while a run is actively running, re-enabled once it terminates via event', async () => {
    knowledgeApi.getProjectSnapshot.mockResolvedValue(snapshot('p1'));
    let emit: ((ev: any) => void) | undefined;
    eventsApi.subscribe.mockImplementationOnce((cb: any) => { emit = cb; return () => {}; });
    render({ project: p1, projects, onSwitchProject: () => {} });
    await flush();

    const auditD = deferred<KnowledgeRunView>();
    knowledgeApi.startAudit.mockReturnValueOnce(auditD.promise);
    click(findButton('knowledge.fullAudit'));
    await flush();
    // IPC 未 resolve 前 busy 已禁用选择器。
    expect((container.querySelector('[data-testid="knowledge-project-select"]') as HTMLSelectElement).disabled).toBe(true);

    await act(async () => { auditD.resolve(runningRun('p1')); });
    await flush();
    // 运行中：进度面板出现，选择器仍禁用。
    expect(container.querySelector('[data-testid="knowledge-run-progress"]')).toBeTruthy();
    expect((container.querySelector('[data-testid="knowledge-project-select"]') as HTMLSelectElement).disabled).toBe(true);

    // 模拟主进程广播终态事件。
    knowledgeApi.getProjectSnapshot.mockResolvedValueOnce(snapshot('p1'));
    await act(async () => {
      emit?.({ kind: 'knowledge-run', taskId: 'p1', data: { ...runningRun('p1'), state: 'succeeded' } });
    });
    await flush();
    expect(container.querySelector('[data-testid="knowledge-run-progress"]')).toBeNull();
    expect((container.querySelector('[data-testid="knowledge-project-select"]') as HTMLSelectElement).disabled).toBe(false);
  });

  it('ignores knowledge-run events for other projects', async () => {
    knowledgeApi.getProjectSnapshot.mockResolvedValue(snapshot('p1'));
    let emit: ((ev: any) => void) | undefined;
    eventsApi.subscribe.mockImplementationOnce((cb: any) => { emit = cb; return () => {}; });
    render({ project: p1, projects, onSwitchProject: () => {} });
    await flush();

    await act(async () => {
      emit?.({ kind: 'knowledge-run', taskId: 'p2', data: runningRun('p2') });
    });
    await flush();
    expect(container.querySelector('[data-testid="knowledge-run-progress"]')).toBeNull();
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
    // This routing test keeps each operation independent; active-run blocking
    // is covered separately with a real awaiting-confirmation view.
    knowledgeApi.startInitialization.mockResolvedValue(succeededRun('p2', 'initialization'));
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
