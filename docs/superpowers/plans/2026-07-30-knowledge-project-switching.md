# Knowledge Project Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the knowledge page the same global project selection behavior as the workspace without allowing stale project state or cross-project knowledge commands.

**Architecture:** Keep `App.tsx` as the only current-project owner and pass the existing project list and switch callback into `KnowledgePage`. The page resets project-local state on ID changes, rejects stale snapshot responses, and disables its selector during mutations or unresolved draft confirmation.

**Tech Stack:** TypeScript 5.7, Electron typed API, React 18, Radix Select through existing shadcn/ui components, Tailwind CSS, Lucide React, Vitest 2, happy-dom, Playwright, pnpm.

## Global Constraints

- `App.tsx` remains the only owner of the current `Project`; do not create a knowledge-specific project store or persisted selection.
- Workspace and knowledge always observe the same selected project.
- If projects exist and no project is selected, knowledge navigation selects `projects[0]` before opening.
- If no projects exist, knowledge navigation remains disabled.
- Use the same `Select` contract and `h-9 w-56` trigger as `WorkspacePage`.
- Keep the current project path beside the selector; knowledge actions remain on the right.
- On `project.id` changes, clear snapshot, selected findings, pending stale state, and errors before loading the new project.
- Reject late responses from a previously selected project.
- Disable switching during initialization, audit, repair, confirm, or cancel requests and while a draft awaits confirmation.
- Do not redesign knowledge content, the sidebar, or workspace controls.
- Preserve Electron isolation and the existing knowledge IPC contract.
- Preserve unrelated dirty worktree changes. `App.tsx`, locale files, and knowledge tests must be staged narrowly if they overlap user edits.

## File Structure

- `apps/desktop/src/App.tsx` owns project selection, knowledge navigation, and prop wiring.
- `apps/desktop/src/pages/Knowledge.tsx` owns project-scoped snapshot and command state.
- `apps/desktop/src/__tests__/app-knowledge-navigation.test.tsx` proves first-project selection and workspace/knowledge synchronization.
- `apps/desktop/src/__tests__/knowledge-page.test.tsx` proves selector rendering, guards, reset, race rejection, and command attribution.
- `apps/desktop/scripts/run-e2e.mjs` proves the real Radix selector and cross-page synchronization.

---

### Task 1: Global Knowledge Navigation and Project Ownership

**Files:**
- Modify: `apps/desktop/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/desktop/src/App.tsx`
- Create: `apps/desktop/src/__tests__/app-knowledge-navigation.test.tsx`

**Interfaces:**
- Produces: `openKnowledge(): void` inside `App`.
- Passes: `project: Project`, `projects: Project[]`, and `onSwitchProject(projectId: string): void` to `KnowledgePage`.
- Preserves: `WorkspacePage` props and `switchProject(id)` as the only switch callback.

- [ ] **Step 1: Ensure the existing DOM test environment is available**

If `happy-dom` is not already present from the usage-dashboard plan, run:

`pnpm --filter @ai-devflow/desktop add -D happy-dom@^15.11.7`

Expected: `happy-dom` is listed once in desktop dev dependencies and the lockfile remains valid.

- [ ] **Step 2: Write the failing App navigation test**

Use `// @vitest-environment happy-dom`. Mock page modules as small buttons/text surfaces, and stub `window.api.projects.list`, `tasks.listAll`, and `events.subscribe`. Make the knowledge mock expose a switch button:

```tsx
vi.mock('../pages/Knowledge.js', () => ({
  KnowledgePage: ({ project, onSwitchProject }: {
    project: Project;
    onSwitchProject(id: string): void;
  }) => (
    <div>
      <span data-testid="knowledge-project">{project.id}</span>
      <button onClick={() => onSwitchProject('p2')}>switch knowledge project</button>
    </div>
  ),
}));
```

Return `[p1, p2]` while no project is initially selected. Render `App`, click knowledge, and assert it opens with `p1`. Click the mock switch, navigate to workspace, and assert the workspace mock receives `p2`. Add a no-project case that asserts the knowledge navigation button is disabled.

Run: `pnpm --filter @ai-devflow/desktop test -- src/__tests__/app-knowledge-navigation.test.tsx`

Expected: FAIL because knowledge is currently disabled whenever `project` is undefined and receives no switch props.

- [ ] **Step 3: Add first-project fallback and pass the shared contract**

Implement the navigation callback without a second state source:

```ts
const openKnowledge = useCallback(() => {
  const next = project ?? projects[0];
  if (!next) return;
  if (!project) setProject(next);
  setRoute('knowledge');
}, [project, projects]);
```

Set knowledge navigation `disabled={projects.length === 0}`, use `openKnowledge` for its click handler, and render:

```tsx
{route === 'knowledge' && project && (
  <KnowledgePage
    project={project}
    projects={projects}
    onSwitchProject={switchProject}
  />
)}
```

Do not alter `openProject`, workspace switching, route names, or project persistence.

- [ ] **Step 4: Verify global synchronization and commit**

Run: `pnpm --filter @ai-devflow/desktop test -- src/__tests__/app-knowledge-navigation.test.tsx`

Run: `pnpm --filter @ai-devflow/desktop typecheck`

Expected: PASS.

```bash
git add -p apps/desktop/package.json pnpm-lock.yaml apps/desktop/src/App.tsx apps/desktop/src/__tests__/app-knowledge-navigation.test.tsx
git commit -m "feat(desktop): share project selection with knowledge"
```

### Task 2: Knowledge Selector, Reset, and Switching Guards

**Files:**
- Modify: `apps/desktop/src/pages/Knowledge.tsx`
- Modify: `apps/desktop/src/__tests__/knowledge-page.test.tsx`
- Modify: `apps/desktop/src/i18n/zh.ts`
- Modify: `apps/desktop/src/i18n/en.ts`

**Interfaces:**
- Produces: `KnowledgePageProps` with `project`, `projects`, and `onSwitchProject`.
- Preserves: all `api.knowledge` methods and project-ID arguments.
- Produces: `switchDisabled = busy || pendingRun?.confirmationState === 'pending'`.

- [ ] **Step 1: Replace the SSR-only test with controllable DOM coverage**

Mock the existing Select module as a native `<select>` in this unit test so project switching can be driven without testing Radix internals:

```tsx
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
```

Render with two projects and assert both names, active ID, active path, and `onSwitchProject('p2')` after a native change event.

- [ ] **Step 2: Write failing reset and stale-response tests**

Use deferred promises for `getProjectSnapshot`. Resolve `p1` once, select a finding and inject an error by rejecting an audit, then rerender with `project=p2`. Before resolving `p2`, assert the old health state, finding selection, and error are absent and the stable loading state is present.

Resolve the older `p1` request after the `p2` request has started and assert it cannot overwrite `p2`. Then resolve `p2` and assert only `p2` data is visible.

Run: `pnpm --filter @ai-devflow/desktop test -- src/__tests__/knowledge-page.test.tsx`

Expected: FAIL because current effects retain old local state and have no stale-response guard.

- [ ] **Step 3: Introduce the exact props and project header selector**

Define:

```ts
export interface KnowledgePageProps {
  project: Project;
  projects: Project[];
  onSwitchProject(projectId: string): void;
}
```

Import the existing Select primitives and render the trigger with `className="h-9 w-56"`. Put `project.path` beside it with truncation. Keep audit, initialize, and repair commands aligned on the right and allow the header to wrap at narrow widths.

Set `data-testid="knowledge-project-select"` and `aria-label={t('knowledge.project')}` on `SelectTrigger`, so the real Radix control has a stable accessible name without adding visible instructional copy. Set `data-testid="knowledge-shell"` and `data-project-id={project.id}` on the page root, and `data-snapshot-project-id={snapshot.projectId}` on the snapshot region for exact stale-state assertions.

- [ ] **Step 4: Reset project-local state and reject stale requests**

Use a monotonic request ref shared by the project-change effect and manual refresh:

```ts
const requestVersion = useRef(0);

const refresh = useCallback(async (reset = false) => {
  const version = ++requestVersion.current;
  if (reset) {
    setSnapshot(undefined);
    setPendingRun(undefined);
    setSelectedFindings(new Set());
    setError(undefined);
  }
  setLoading(true);
  try {
    const next = await api.knowledge.getProjectSnapshot(project.id);
    if (version === requestVersion.current) setSnapshot(next);
  } catch (error) {
    if (version === requestVersion.current) setError((error as Error).message);
  } finally {
    if (version === requestVersion.current) setLoading(false);
  }
}, [project.id]);

useEffect(() => {
  void refresh(true);
  return () => { requestVersion.current += 1; };
}, [refresh]);
```

Render a fixed-height loading surface while `loading && !snapshot`. Keep subsequent action refreshes on the current `project.id` closure.

- [ ] **Step 5: Guard every unsafe switching interval**

Use:

```ts
const switchDisabled = busy || pendingRun?.confirmationState === 'pending';
```

Pass it to `Select.disabled`. Because each initialization, audit, repair, confirm, and cancel path sets `busy` before awaiting and clears it in `finally`, this covers every in-flight command. Keep the selector disabled after initialization or repair returns an awaiting-confirmation run; only successful confirm or cancel clears `pendingRun`.

Add tests with deferred mutation promises and awaiting-confirmation runs. Assert the selector is disabled while each promise is pending and until confirm/cancel resolves. After switching to `p2`, click audit/initialize/repair and assert every API call receives `p2`, never `p1`.

- [ ] **Step 6: Add only the required bilingual state copy**

Add `knowledge.project`, `knowledge.loading`, and a selector-disabled title explaining that the current operation or draft must finish first. Use existing `common.confirm`, `common.cancel`, and action labels; do not add instructional body text to the page.

- [ ] **Step 7: Verify page behavior and commit**

Run: `pnpm --filter @ai-devflow/desktop test -- src/__tests__/knowledge-page.test.tsx src/__tests__/app-knowledge-navigation.test.tsx`

Run: `pnpm --filter @ai-devflow/desktop typecheck`

Expected: PASS for list rendering, global callback wiring, reset, stale-response rejection, guards, and new-project command attribution.

```bash
git add -p apps/desktop/src/pages/Knowledge.tsx apps/desktop/src/__tests__/knowledge-page.test.tsx apps/desktop/src/i18n/zh.ts apps/desktop/src/i18n/en.ts
git commit -m "feat(desktop): add guarded knowledge project switcher"
```

### Task 3: Real Desktop Synchronization E2E

**Files:**
- Modify: `apps/desktop/scripts/run-e2e.mjs`

**Interfaces:**
- Consumes: existing project creation API, sidebar navigation, workspace project selector, and knowledge project selector.
- Produces: a real Radix interaction test at default and minimum window widths.

- [ ] **Step 1: Create two deterministic projects in the E2E fixture**

Create a second temporary Git repository and project before navigation. Name the projects `E2E Proj A` and `E2E Proj B`, and add both directories to final cleanup. Open project A first so it becomes the global selection.

- [ ] **Step 2: Prove knowledge-to-workspace synchronization**

Navigate to `知识库`, locate the project combobox by accessible name, and choose project B. Assert `knowledge-shell[data-project-id]` changes immediately to B, the adjacent path equals repository B, and the next rendered snapshot has `data-snapshot-project-id` equal to B. Assert no snapshot carrying A remains visible during the transition.

Navigate to `工作台` and assert its existing project selector shows `E2E Proj B`. Switch back to project A in workspace, return to knowledge, and assert knowledge now shows project A without an independent selection.

- [ ] **Step 3: Prove the unresolved-draft guard in the real UI**

Extend `startFakeProvider` to detect `resultKind=knowledge_initialization` in the request messages and return this exact report payload through `ai_devflow_report_result`:

```js
payload: {
  kind: 'knowledge_initialization',
  changedPaths: [],
  knowledgeIds: [],
}
```

The host-generated deterministic knowledge skeleton supplies the actual draft changes. Start initialization for project B, wait for the draft confirmation surface, and assert the project combobox is disabled. Cancel the run, wait for the confirmation surface to disappear, and assert the combobox is enabled again. Do not add a production test-only IPC endpoint.

- [ ] **Step 4: Verify narrow layout and no page overflow**

Set the BrowserWindow to 960x640 and assert selector text/path do not overlap the action buttons and document-level horizontal overflow is at most two pixels:

```js
const layout = await win.evaluate(() => ({
  overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  selectorVisible: Boolean(document.querySelector('[data-testid="knowledge-project-select"]')),
}));
check('知识库最小窗口无页面级横向溢出', layout.overflow <= 2);
check('知识库项目选择器在最小窗口可见', layout.selectorVisible);
```

- [ ] **Step 5: Run the focused and full verification commands**

Run: `pnpm --filter @ai-devflow/desktop test -- src/__tests__/knowledge-page.test.tsx src/__tests__/app-knowledge-navigation.test.tsx`

Run: `pnpm --filter @ai-devflow/desktop typecheck`

Run: `pnpm --filter @ai-devflow/desktop build`

Run: `pnpm --filter @ai-devflow/desktop e2e`

Expected: all commands PASS and workspace/knowledge always show the same project.

- [ ] **Step 6: Commit the synchronization coverage**

```bash
git add -p apps/desktop/scripts/run-e2e.mjs
git commit -m "test(desktop): cover knowledge project synchronization"
```
