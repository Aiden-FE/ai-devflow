# 工作台改进与维护者能力管理 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 落地 5 项已批准需求——移除本地 HTTP 勾选并放行任意 http/https baseURL、需求卡子任务折叠与分页、项目地址打开文件夹、维护者按角色扩展重构与指南、维护者 inspect:roles 自检脚本。

**Architecture:** Electron 主/preload/renderer 三层 + 共享 TS 包（core/agents）。需求 1/2/3 为用户侧（core 校验、IPC、renderer、i18n）；需求 4/5 为维护者侧，不进用户 UI。需求 4 给 `RoleProfile` 增加 `extensions` 字段并让 materializer/run-plan 按角色取用；需求 5 用 esbuild 在运行时打包 `profiles.ts` 源码读取常量（仓库无 tsx、agents 无 dist）。

**Tech Stack:** TypeScript、Electron 43、React、vitest（desktop 用 `environment: 'node'` + `renderToStaticMarkup`，无 jsdom）、node:sqlite、esbuild 0.24、Pi 0.80.10。

## Global Constraints

- Electron ≥ 43（`node:sqlite` 需要 Node 24 内建；见 `apps/desktop/package.json` 锁 `electron: ^43.1.1`）。
- `ProviderConfig` 以加密 JSON 存于 `credentials('providers:v1')`，**非 SQLite 列**；增删其字段无需 schema 迁移。
- Pi 0.80.10 **不支持 MCP**（dist 零 MCP 引用）；本计划不引入 MCP。
- 子进程环境白名单不可破坏（`run-plan.ts` 的 env 构造）。
- Renderer 沙箱：新增能力只能经显式 IPC 通道，无任意命令执行入口。
- i18n `zh.ts` 与 `en.ts` 必须同步增删键。
- 测试命令：core/agents 用 `pnpm --filter @ai-devflow/<pkg> test`（vitest run）；desktop 用 `pnpm --filter @ai-devflow/desktop test`；根脚本用 `pnpm test:scripts`（`node --test scripts/*.test.mjs`）。

## File Structure

| 文件 | 责任 | 任务 |
| --- | --- | --- |
| `packages/core/src/provider.ts` | `ProviderInput`/`normalizeProviderInput`：移除 `allowInsecureLocal`，放行 http/https | 1 |
| `packages/core/src/__tests__/provider.test.ts` | 校验测试 | 1 |
| `apps/desktop/electron/provider-store.ts` | 删除 `legacyAllowsLocalHTTP` 及其调用 | 1 |
| `apps/desktop/src/pages/Settings.tsx` | 删除 `allowLocal` state、checkbox、入参 | 1 |
| `apps/desktop/src/i18n/zh.ts` / `en.ts` | 删 `settings.providers.local`，改 hint | 1 |
| `apps/desktop/src/pages/Workspace.tsx` | `ReqItem` 折叠+分页、`paginate` 助手、打开文件夹 icon | 2, 3 |
| `apps/desktop/src/__tests__/workspace-reqitem.test.tsx` | 折叠/分页测试（新建） | 2 |
| `apps/desktop/electron/ipc.ts` | `projects.openFolder` 处理器 | 3 |
| `apps/desktop/electron/api.ts` / `preload.ts` | `projects.openFolder` 类型与暴露 | 3 |
| `apps/desktop/electron/__tests__/ipc.test.ts` | openFolder 测试 + electron mock 增 `openPath` | 3 |
| `packages/agents/src/profiles.ts` | `RoleProfile.extensions`、materialize 按角色、`validateRoleProfiles` | 4 |
| `packages/agents/src/run-plan.ts` | `--extension` 取自 `profile.extensions` | 4 |
| `packages/agents/src/__tests__/profiles.test.ts` / `run-plan.test.ts` | 扩展测试 | 4 |
| `docs/maintaining-role-capabilities.md` | 维护者指南（新建） | 5 |
| `scripts/inspect-roles.mjs` / `inspect-roles.test.mjs` | 自检脚本与测试（新建） | 6 |
| `package.json` | `inspect:roles` 脚本入口 | 6 |

---

### Task 1: 移除「本地兼容服务」勾选，放行任意 http/https baseURL

**Files:**
- Modify: `packages/core/src/provider.ts:70-74, 127, 150-170`
- Modify: `packages/core/src/__tests__/provider.test.ts`
- Modify: `apps/desktop/electron/provider-store.ts:57-65, 246`
- Modify: `apps/desktop/src/pages/Settings.tsx:405, 419, 426, 431, 451, 561`
- Modify: `apps/desktop/src/i18n/zh.ts:252-253`、`apps/desktop/src/i18n/en.ts`（同键）

**Interfaces:**
- Produces: `ProviderInput` 不再含 `allowInsecureLocal`；`normalizeProviderInput` 接受 `http:`/`https:` baseURL。

- [x] **Step 1: 写失败测试**（替换 `provider.test.ts` 中依赖旧门控的用例）

把 `packages/core/src/__tests__/provider.test.ts` 第 5-17 行用例中的 `allowInsecureLocal: false,` 删除，并替换第 26-36 行「requires an explicit opt-in for loopback HTTP」用例为：

```ts
  it('accepts http and https base URLs without an explicit opt-in', () => {
    const mk = (baseURL: string) => normalizeProviderInput({
      id: 'p1', kind: 'openai_compatible', displayName: 'Local', enabled: true,
      priority: 0, authType: 'api_key', apiKey: 'secret', baseURL, revision: 1, defaultModel: 'gpt-default',
    }).config.baseURL;
    expect(mk('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434/v1');
    expect(mk('http://192.168.1.10/v1')).toBe('http://192.168.1.10/v1');
    expect(mk('https://gateway.example/v1')).toBe('https://gateway.example/v1');
  });

  it('rejects non-http(s) protocols', () => {
    expect(() => normalizeProviderInput({
      id: 'p1', kind: 'openai_compatible', displayName: 'X', enabled: true,
      priority: 0, authType: 'api_key', apiKey: 'secret', baseURL: 'ftp://host/x', revision: 1,
    })).toThrow(/http 或 https/);
  });
```

- [x] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ai-devflow/core exec vitest run src/__tests__/provider.test.ts`
Expected: FAIL（旧门控仍对 loopback http 抛错 / `allowInsecureLocal` 类型仍在）。

- [x] **Step 3: 实现 core 改动**

`packages/core/src/provider.ts`：
- 删除第 72-73 行注释与 `allowInsecureLocal?: boolean;`。
- 删除第 127 行 `const LOCAL_HOSTS = [...]`。
- 把第 150 行注释改为 `* - Base URL 接受 http 或 https（http 会明文传输 API Key，由用户承担）。`
- 把第 161-169 行 baseURL 校验替换为：

```ts
  let baseURL: string | undefined;
  if (input.baseURL) {
    const url = new URL(input.baseURL);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Base URL 必须使用 http 或 https');
    }
    if (url.username || url.password) throw new Error('Base URL 禁止包含用户名或密码');
    if (url.hash || url.search) throw new Error('Base URL 禁止包含 query 或 fragment');
    baseURL = url.toString().replace(/\/$/, '');
  }
```

- [x] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @ai-devflow/core exec vitest run src/__tests__/provider.test.ts`
Expected: PASS。

- [x] **Step 5: 清理 provider-store 旧逻辑**

`apps/desktop/electron/provider-store.ts`：
- 删除第 57-65 行 `legacyAllowsLocalHTTP` 函数。
- 第 246 行 `allowInsecureLocal: legacyAllowsLocalHTTP(legacyBaseURL),` 整行删除（`normalizeProviderInput` 调用对象中移除该键）。

Run: `pnpm --filter @ai-devflow/desktop exec vitest run electron/__tests__/provider-store.test.ts`
Expected: PASS（既有迁移用例 baseURL 为 https，不依赖该函数）。

- [x] **Step 6: 清理 Settings UI**

`apps/desktop/src/pages/Settings.tsx`：
- 删除第 405 行 `const [allowLocal, setAllowLocal] = useState(false);`。
- `startAdd`（419）、`startReentry`（426）、`startEdit`（431）中各删除 `setAllowLocal(false);`。
- `save` 的 `input` 对象中删除第 451 行 `allowInsecureLocal: allowLocal,`。
- 删除第 561 行 checkbox `<label ...><Checkbox checked={allowLocal} ... />{t('settings.providers.local')}</label>`。

- [x] **Step 7: 更新 i18n**

`apps/desktop/src/i18n/zh.ts`：
- 第 252 行 `settings.providers.baseURL.hint` 值改为 `'http/https 均可；http 会明文传输 API Key，请仅在可信网络使用。'`
- 删除第 253 行 `'settings.providers.local': '...',`。

`apps/desktop/src/i18n/en.ts`：同步删除 `settings.providers.local` 并把 `settings.providers.baseURL.hint` 改为 `'http or https; http transmits the API Key in cleartext — use only on trusted networks.'`。

- [x] **Step 8: 全量校验**

Run: `pnpm --filter @ai-devflow/desktop test && pnpm --filter @ai-devflow/core test`
Expected: PASS（注意：`ipc.test.ts` 中若有 `allowInsecureLocal` 入参需一并删除——检查 `providers.save`/`completeReentry` 用例，当前用例未传该字段，应直接通过）。

- [x] **Step 9: 提交**

```bash
git add packages/core/src/provider.ts packages/core/src/__tests__/provider.test.ts apps/desktop/electron/provider-store.ts apps/desktop/src/pages/Settings.tsx apps/desktop/src/i18n/zh.ts apps/desktop/src/i18n/en.ts
git commit -m "feat(provider): drop allowInsecureLocal, allow any http/https baseURL"
```

---

### Task 2: 需求卡子任务折叠与分页

**Files:**
- Modify: `apps/desktop/src/pages/Workspace.tsx:21, 234-275`（imports、`ReqItem`、新增 `paginate` 导出）
- Modify: `apps/desktop/src/i18n/zh.ts` / `en.ts`
- Create: `apps/desktop/src/__tests__/workspace-reqitem.test.tsx`

**Interfaces:**
- Produces: `export function paginate<T>(items: T[], page: number, pageSize: number): { items: T[]; totalPages: number }`；`ReqItem` 默认按 `subtasks.length > 0` 收起。

- [x] **Step 1: 写失败测试**（新建 `apps/desktop/src/__tests__/workspace-reqitem.test.tsx`）

```tsx
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LocaleProvider } from '../i18n/index.js';
import type { Requirement, Task } from '@ai-devflow/core';

Object.assign(globalThis, { window: { api: {} } });
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
```

- [x] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ai-devflow/desktop exec vitest run src/__tests__/workspace-reqitem.test.tsx`
Expected: FAIL（`paginate`/`ReqItem` 未导出）。

- [x] **Step 3: 实现 `paginate` 与 `ReqItem` 折叠/分页**

`apps/desktop/src/pages/Workspace.tsx`：
- 第 21 行 imports 追加 `ChevronDown, ChevronRight`：
```ts
import { Plus, MessageSquarePlus, Archive, AlertCircle, Maximize2, Minimize2, ChevronDown, ChevronRight, FolderOpen } from 'lucide-react';
```
（`FolderOpen` 供 Task 3 使用，此处一并加入。）

- 在 `ReqItem` 上方新增导出助手：
```ts
export function paginate<T>(items: T[], page: number, pageSize: number): { items: T[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const start = safePage * pageSize;
  return { items: items.slice(start, start + pageSize), totalPages };
}
```

- 把 `ReqItem`（第 234-275 行）改为（保留头部、收起子任务列表、展开后分页）：

```tsx
export function ReqItem({ req, tasks, onCreateTask, onArchived }: {
  req: Requirement; tasks: Task[]; onCreateTask: () => void; onArchived: () => void;
}): React.ReactElement {
  const t = useT();
  const [error, setError] = useState<string | undefined>();
  const subtasks = tasks.filter((x) => x.requirementId === req.id);
  const [collapsed, setCollapsed] = useState(subtasks.length > 0);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 10;
  const view = paginate(subtasks, page, PAGE_SIZE);
  const archive = async () => {
    setError(undefined);
    try { await api.requirements.archive(req.id); onArchived(); }
    catch (e) { setError((e as Error).message); }
  };
  return (
    <div className={`rounded-md border p-2.5 ${req.archived ? 'border-border/50 opacity-60' : 'border-border'}`}>
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{req.title}</span>
            <Badge variant="outline" className="text-[10px]">{t(`ws.priority.${req.priority}`)}</Badge>
            {req.archived && <Badge variant="success" className="text-[10px]">{t('ws.archived')}</Badge>}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {t('ws.acceptance')}：{req.acceptance || t('ws.acceptance.empty')} · {t('ws.subtasksCount', { n: subtasks.length })}
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={onCreateTask} disabled={req.archived}><Plus className="h-3.5 w-3.5" /> {t('ws.createTask')}</Button>
        {!req.archived && <Button size="sm" variant="outline" onClick={archive}><Archive className="h-3.5 w-3.5" /> {t('ws.archiveReq')}</Button>}
      </div>
      {subtasks.length > 0 && (
        <div className="mt-2 border-t border-border/60 pt-2">
          <button data-testid="req-subtasks-toggle" className="flex w-full items-center gap-1.5 text-xs font-medium text-muted-foreground"
            onClick={() => { setCollapsed((c) => !c); setPage(0); }}>
            {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            {collapsed ? t('ws.subtasks.expand', { n: subtasks.length }) : t('ws.subtasks.collapse')}
          </button>
          {!collapsed && (
            <div className="mt-1.5 flex flex-col gap-1">
              {view.items.map((s) => (
                <div key={s.id} data-testid="req-subtask-title" className="flex items-center gap-2 text-xs">
                  <StatusBadge status={s.status} />
                  <span className="truncate">{s.title}</span>
                </div>
              ))}
              {view.totalPages > 1 && (
                <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
                  <Button size="sm" variant="ghost" disabled={page <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>{t('ws.subtasks.prev')}</Button>
                  <span>{t('ws.subtasks.page', { cur: Math.min(page, view.totalPages - 1) + 1, total: view.totalPages })}</span>
                  <Button size="sm" variant="ghost" disabled={page >= view.totalPages - 1} onClick={() => setPage((p) => Math.min(view.totalPages - 1, p + 1))}>{t('ws.subtasks.next')}</Button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {error && <div className="mt-1.5 text-xs text-destructive">{error}</div>}
    </div>
  );
}
```

- [x] **Step 4: 增加 i18n 键**

`zh.ts` 在 `ws.subtasksCount` 行后追加：
```ts
  'ws.subtasks.expand': '展开子任务（{n}）',
  'ws.subtasks.collapse': '收起子任务',
  'ws.subtasks.prev': '上一页',
  'ws.subtasks.next': '下一页',
  'ws.subtasks.page': '第 {cur}/{total} 页',
```
`en.ts` 同步：
```ts
  'ws.subtasks.expand': 'Show subtasks ({n})',
  'ws.subtasks.collapse': 'Hide subtasks',
  'ws.subtasks.prev': 'Prev',
  'ws.subtasks.next': 'Next',
  'ws.subtasks.page': 'Page {cur}/{total}',
```

- [x] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @ai-devflow/desktop exec vitest run src/__tests__/workspace-reqitem.test.tsx`
Expected: PASS。

- [x] **Step 6: 提交**

```bash
git add apps/desktop/src/pages/Workspace.tsx apps/desktop/src/__tests__/workspace-reqitem.test.tsx apps/desktop/src/i18n/zh.ts apps/desktop/src/i18n/en.ts
git commit -m "feat(workspace): collapse requirement subtasks with >10 pagination"
```

---

### Task 3: 项目地址尾 icon 打开文件夹

**Files:**
- Modify: `apps/desktop/electron/ipc.ts:3-5, 79-155`（imports、新处理器）
- Modify: `apps/desktop/electron/api.ts:101-110`
- Modify: `apps/desktop/electron/preload.ts:21-28`
- Modify: `apps/desktop/electron/__tests__/ipc.test.ts:28`（mock 增 `openPath`）+ 新用例
- Modify: `apps/desktop/src/pages/Workspace.tsx:49`
- Modify: `apps/desktop/src/i18n/zh.ts` / `en.ts`

**Interfaces:**
- Produces: `api.projects.openFolder(id: string): Promise<{ ok: boolean; error?: string }>`，按 `projectId` 解析路径后 `shell.openPath`。

- [x] **Step 1: 写失败测试**

`apps/desktop/electron/__tests__/ipc.test.ts`：
- 第 28 行 electron mock 的 `shell` 改为用 `vi.hoisted` 注入可断言 mock。在文件顶部（`vi.mock('electron')` 之前）加：
```ts
const { openPathMock } = vi.hoisted(() => ({ openPathMock: vi.fn(async () => '') }));
```
- 把 mock 中 `shell: { openExternal() {} },` 改为 `shell: { openExternal() {}, openPath: openPathMock },`。
- 在 `describe('typed IPC wiring', ...)` 内新增用例：
```ts
  it('projects.openFolder opens the resolved project path and rejects unknown ids', async () => {
    openPathMock.mockClear();
    const dir = mkdtempSync(join(tmpdir(), 'aidf-open-'));
    const p = await call('projects', 'create', { name: 'P', path: dir, defaultBranch: 'main' }) as { id: string };
    const r = (await call('projects', 'openFolder', p.id)) as { ok: boolean; error?: string };
    expect(r.ok).toBe(true);
    expect(openPathMock).toHaveBeenCalledWith(dir);
    const bad = (await call('projects', 'openFolder', 'no-such-id')) as { ok: boolean };
    expect(bad.ok).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
```

- [x] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ai-devflow/desktop exec vitest run electron/__tests__/ipc.test.ts`
Expected: FAIL（`ai-devflow:projects:openFolder` 处理器未注册）。

- [x] **Step 3: 实现 IPC 三层**

`apps/desktop/electron/ipc.ts`：
- 第 3 行 `import { ipcMain, dialog, BrowserWindow, nativeTheme } from 'electron';` 改为 `import { ipcMain, dialog, BrowserWindow, nativeTheme, shell } from 'electron';`。
- 第 4 行 `import { mkdirSync, writeFileSync } from 'node:fs';` 改为 `import { mkdirSync, writeFileSync, existsSync } from 'node:fs';`。
- 第 5 行 `import { join } from 'node:path';` 改为 `import { join, isAbsolute } from 'node:path';`。
- 在 `projects` 处理器区（`pickFolder` 之后）新增：
```ts
  ipcMain.handle(channel('projects', 'openFolder'), async (_e, projectId: string) => {
    const project = repos.projects.get(projectId);
    if (!project?.path || !isAbsolute(project.path) || !existsSync(project.path)) {
      return { ok: false, error: '项目路径不可用' };
    }
    const err = await shell.openPath(project.path);
    return err ? { ok: false, error: err } : { ok: true };
  });
```

`apps/desktop/electron/api.ts`：在 `projects` 命名空间（约 101-110 行）加：
```ts
  openFolder(id: string): Promise<{ ok: boolean; error?: string }>;
```

`apps/desktop/electron/preload.ts`：在 `projects`（约 21-28 行）加：
```ts
    openFolder: (id: string) => invoke('projects', 'openFolder')(id),
```

- [x] **Step 4: renderer 加 icon**

`apps/desktop/src/pages/Workspace.tsx` 第 49 行 `<div className="text-xs text-muted-foreground">{activeProject.path}</div>` 改为：
```tsx
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <span className="truncate">{activeProject.path}</span>
          <Button size="icon-xs" variant="ghost" title={t('ws.openFolder')}
            onClick={async () => {
              const r = await api.projects.openFolder(activeProject.id);
              if (!r.ok) setError(r.error ?? t('ws.openFolder.fail'));
            }}>
            <FolderOpen className="h-3.5 w-3.5" />
          </Button>
        </div>
```
（`FolderOpen` 已在 Task 2 Step 3 一并 import；若 Task 3 先于 Task 2 执行，需单独把 `FolderOpen` 加入第 21 行 import。`Button` 已 import。`setError` 复用 `WorkspaceBody` 顶部 `const [error, setError] = useState<string | undefined>();`——若无则在 `WorkspacePage` 顶层加一个。）

- [x] **Step 5: 增加 i18n 键**

`zh.ts`：`'ws.openFolder': '在文件夹中打开', 'ws.openFolder.fail': '打开文件夹失败',`
`en.ts`：`'ws.openFolder': 'Reveal in folder', 'ws.openFolder.fail': 'Failed to open folder',`

- [x] **Step 6: 运行测试确认通过**

Run: `pnpm --filter @ai-devflow/desktop exec vitest run electron/__tests__/ipc.test.ts`
Expected: PASS。

- [x] **Step 7: 提交**

```bash
git add apps/desktop/electron/ipc.ts apps/desktop/electron/api.ts apps/desktop/electron/preload.ts apps/desktop/electron/__tests__/ipc.test.ts apps/desktop/src/pages/Workspace.tsx apps/desktop/src/i18n/zh.ts apps/desktop/src/i18n/en.ts
git commit -m "feat(workspace): open project folder via projects.openFolder IPC"
```

---

### Task 4: 按角色扩展重构（RoleProfile.extensions）

**Files:**
- Modify: `packages/agents/src/profiles.ts:30-78, 144-192`
- Modify: `packages/agents/src/run-plan.ts:84-102`
- Modify: `packages/agents/src/__tests__/profiles.test.ts`
- Modify: `packages/agents/src/__tests__/run-plan.test.ts`

**Interfaces:**
- Produces: `RoleProfile.extensions: string[]`；`export function validateRoleProfiles(profiles?, pool?): void`；materialize/run-plan 按 `profile.extensions` 取用。`BUILTIN_EXTENSIONS` 语义改为「可用扩展注册池」。

- [x] **Step 1: 写失败测试**

`packages/agents/src/__tests__/run-plan.test.ts`：在 `describe('buildPiRunPlan', ...)` 内新增：
```ts
  it('passes --extension args from the role profile extensions', () => {
    const plan = buildPiRunPlan(makeRunPlanFixture({ role: 'coder', executionId: 'e1', attemptId: 'a1' }));
    const profileDir = `/userData/pi-runtime/profiles/digest/coder`;
    for (const ext of ROLE_PROFILES.coder.extensions) {
      expect(plan.args).toContain(`${profileDir}/extensions/${ext}.ts`);
    }
    // 不含未声明的扩展
    expect(plan.args).not.toContain(`${profileDir}/extensions/does-not-exist.ts`);
  });
```

`packages/agents/src/__tests__/profiles.test.ts`：顶部 import 改为 `import { ProfileMaterializer, ROLE_PROFILES, BUILTIN_EXTENSIONS, validateRoleProfiles } from '../profiles.js';` 并新增 `import { readdirSync } from 'node:fs';`，在 `describe('ProfileMaterializer', ...)` 内新增：
```ts
  it('materializes exactly the extensions declared by the role profile', () => {
    const base = mkdtempSync(join(tmpdir(), 'profiles-'));
    const m = new ProfileMaterializer(ASSETS_ROOT, base);
    const { profileDir } = m.materialize({
      role: 'reviewer', providerId: 'p1', providerKind: 'openai', providerRevision: 1,
      providerName: 'openai', models: ['m'],
    });
    const extFiles = readdirSync(join(profileDir, 'extensions')).sort();
    expect(extFiles).toEqual(ROLE_PROFILES.reviewer.extensions.map((e) => `${e}.ts`).sort());
  });
});

describe('validateRoleProfiles', () => {
  it('passes for the built-in profiles', () => {
    expect(() => validateRoleProfiles()).not.toThrow();
  });
  it('rejects a role that references an unregistered extension', () => {
    expect(() => validateRoleProfiles(
      { ...ROLE_PROFILES, coder: { ...ROLE_PROFILES.coder, extensions: ['event-bridge', 'ghost'] } },
      BUILTIN_EXTENSIONS,
    )).toThrow(/未注册的扩展/);
  });
```
（注意：上面的 `describe('validateRoleProfiles'...)` 需放在 `describe('ProfileMaterializer')` 之外或文件末尾；实现时把第一个新增用例放在 `ProfileMaterializer` describe 内，第二个 describe 紧随其后。）

- [x] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ai-devflow/agents exec vitest run src/__tests__/profiles.test.ts src/__tests__/run-plan.test.ts`
Expected: FAIL（`extensions`/`validateRoleProfiles` 不存在）。

- [x] **Step 3: 实现 profiles.ts**

`packages/agents/src/profiles.ts`：
- `RoleProfile`（第 30-40 行）在 `skills` 后加字段：
```ts
  /** 该角色启用的扩展（名称取自 BUILTIN_EXTENSIONS 注册池）。 */
  extensions: string[];
```
- `ROLE_PROFILES`（第 53-78 行）每个角色对象加 `extensions: ['event-bridge', 'execution-policy', 'structured-result', 'checkpoint-context'],`（四角色相同，四个基建扩展支撑 `INTERNAL_TOOLS` 与 worktree/检查点行为）。
- `BUILTIN_EXTENSIONS` 注释（第 45 行）改为 `/** 可用扩展注册池：shared/extensions/ 下维护的内置扩展名。各角色通过 RoleProfile.extensions 声明启用子集。 */`。
- `ProfileMaterializer.materialize`（第 167-172 行）把 `for (const ext of BUILTIN_EXTENSIONS)` 改为按角色声明：
```ts
      const extDir = join(tmp, 'extensions');
      mkdirSync(extDir, { recursive: true });
      for (const ext of ROLE_PROFILES[input.role].extensions) {
        const src = join(this.assetsRoot, 'shared', 'extensions', `${ext}.ts`);
        if (existsSync(src)) cpSync(src, join(extDir, `${ext}.ts`));
      }
```
- 文件末尾新增校验函数并在模块加载时调用：
```ts
/**
 * 校验每个角色声明的扩展都存在于 BUILTIN_EXTENSIONS 注册池，且对应源文件存在。
 * 模块加载时调用，使配置错误在应用启动期 fail-fast，而非运行期才暴露。
 */
export function validateRoleProfiles(
  profiles: Record<TaskRole, RoleProfile> = ROLE_PROFILES,
  pool: readonly string[] = BUILTIN_EXTENSIONS,
): void {
  const poolSet = new Set(pool);
  for (const role of Object.keys(profiles) as TaskRole[]) {
    for (const ext of profiles[role].extensions) {
      if (!poolSet.has(ext)) throw new Error(`角色 ${role} 引用了未注册的扩展：${ext}`);
    }
  }
}
validateRoleProfiles();
```

- [x] **Step 4: 实现 run-plan.ts**

`packages/agents/src/run-plan.ts` 第 85-87 行：
```ts
  const args: string[] = [input.runtimeEntry, '--print', '--mode', 'json', '--no-extensions'];
  for (const ext of profile.extensions) {
    args.push('--extension', `${input.profileDir}/extensions/${ext}.ts`);
  }
```
（原来是 `for (const ext of BUILTIN_EXTENSIONS)`；改用 `profile.extensions`。`profile` 已在 L78 取得。）

- [x] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @ai-devflow/agents exec vitest run src/__tests__/profiles.test.ts src/__tests__/run-plan.test.ts`
Expected: PASS。

- [x] **Step 6: 全量 agents 测试 + 类型检查**

Run: `pnpm --filter @ai-devflow/agents test && pnpm --filter @ai-devflow/agents typecheck`
Expected: PASS（`pi-runner.test.ts` 用 fake runner，不依赖扩展清单变化）。

- [x] **Step 7: 提交**

```bash
git add packages/agents/src/profiles.ts packages/agents/src/run-plan.ts packages/agents/src/__tests__/profiles.test.ts packages/agents/src/__tests__/run-plan.test.ts
git commit -m "feat(agents): per-role extensions on RoleProfile, validated at load"
```

---

### Task 5: 维护者指南文档

**Files:**
- Create: `docs/maintaining-role-capabilities.md`

**Interfaces:**
- 无代码接口；文档反映 Task 4 落地后的机制。

- [x] **Step 1: 写文档**

创建 `docs/maintaining-role-capabilities.md`，内容：

````markdown
# 维护者指南：为角色 Agent 安装扩展、技能、工具

本文面向 ai-devflow 维护者。最终用户**不**可见这些配置——四角色 profile 由仓库维护、随应用发布。内置 Pi 运行时为 `@earendil-works/pi-coding-agent@0.80.10`。

## 角色能力来自哪里

- `packages/agents/src/profiles.ts` 的 `ROLE_PROFILES`：每角色的 `tools`/`excludedTools`/`skills`/`extensions`/`timeoutMs`。
- `packages/agents/assets/profiles/<role>/`：`SYSTEM.md`、`settings.json`、`skills/<name>/SKILL.md`。
- `packages/agents/assets/profiles/shared/extensions/<name>.ts`：扩展源文件；`BUILTIN_EXTENSIONS` 是其注册池。
- 运行时 `ProfileMaterializer` 把以上复制到内容寻址快照；`buildPiRunPlan` 用 `--skill`/`--extension`/`--tools` 显式注入（`--no-skills`/`--no-extensions` 关闭自动发现）。

## 新增一个 skill（按角色）

1. 创建 `packages/agents/assets/profiles/<role>/skills/<skill-name>/SKILL.md`。
2. 在 `ROLE_PROFILES[<role>].skills` 末尾加 `'<skill-name>'`。
3. `ROLE_PROFILES[<role>].version += 1`（触发新内容寻址快照，避免干扰在途执行）。
4. `pnpm --filter @ai-devflow/agents test` 与 `pnpm test:real:pi` 验证。

## 新增一个扩展（可按角色）

1. 创建 `packages/agents/assets/profiles/shared/extensions/<name>.ts`。
2. 在 `BUILTIN_EXTENSIONS`（注册池）加 `'<name>'`。
3. 在需要该扩展的 `ROLE_PROFILES[<role>].extensions` 加 `'<name>'`（默认四角色含 `event-bridge`/`execution-policy`/`structured-result`/`checkpoint-context` 四个基建扩展，勿删）。
4. `ROLE_PROFILES[<role>].version += 1`。
5. `validateRoleProfiles()`（模块加载时自动调用）会拒绝引用池外扩展名的配置。

## 新增/调整工具

- `ROLE_PROFILES[<role>].tools` 增减 Pi 内置工具名（`read`/`bash`/`edit`/`write`/`grep`/`find`/`ls`）。
- `excludedTools` 显式排除（如 reviewer 排除 `edit`/`write`）。
- `INTERNAL_TOOLS`（`ai_devflow_interaction`/`ai_devflow_report_result`）四角色强制启用，不可配。
- 自定义工具能力应通过扩展实现，而非 tools 白名单。

## MCP servers

**当前不支持。** Pi 0.80.10 的 dist 中无任何 MCP 引用（`mcpServers`/`--mcp` 均不存在）。安装 MCP servers 需先升级 Pi 版本，并按 `docs/architecture.md` §13.1 重新 staging、更新 manifest、校验和与四角色兼容性测试。

## settings.json

各角色 `settings.json` 的 `packages`/`extensions`/`skills` 保持 `[]`——应用通过 CLI 参数显式注入，不走 Pi 自动发现。仅在需要调整 `retry`/`defaultProjectTrust` 等运行时行为时编辑 settings.json。

## 打包与生效

- 开发态：`assetsRootFor()` 直读 `packages/agents/assets/profiles`，改完即可 `pnpm dev` 验证。
- 打包态：`pnpm stage:pi` 把 profiles 复制到 `build/pi-runtime/profiles` 并计算 `profilesDigest` 写入 manifest；electron-builder 经 `extraResources` 复制到 `resources/pi-runtime`（不入 asar）。

## 验证清单

- `pnpm inspect:roles`（见 `scripts/inspect-roles.mjs`）查看各角色生效的 tools/skills/extensions。
- `pnpm --filter @ai-devflow/agents test`：单测。
- `pnpm test:real:pi`：真实 Pi 四角色验证（需 `.env` 中的 `DEV_API_*`）。

## 安全

扩展是 Pi 子进程内执行的 TypeScript 文件（隔离 env）。新增自定义扩展须保持同等级安全姿态：不外泄凭证、尊重 worktree 写入边界（`execution-policy`）、不绕过 `ai_devflow_interaction`/`ai_devflow_report_result` 协议。
````

- [x] **Step 2: 提交**

```bash
git add docs/maintaining-role-capabilities.md
git commit -m "docs: maintainer guide for role agent skills/extensions/tools"
```

---

### Task 6: 维护者 inspect:roles 自检脚本

**Files:**
- Create: `scripts/inspect-roles.mjs`
- Create: `scripts/inspect-roles.test.mjs`
- Modify: `package.json`（加 `inspect:roles` 脚本）

**Interfaces:**
- Produces: `scripts/inspect-roles.mjs` 导出 `formatRoleCapabilities(profiles, internalTools, builtinExtensions, opts?)`（纯函数，供测试）；直接运行时用 esbuild 打包 `packages/agents/src/profiles.ts` 读取真实常量并打印（支持 `--json`）。

- [x] **Step 1: 写失败测试**（新建 `scripts/inspect-roles.test.mjs`）

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { formatRoleCapabilities } from './inspect-roles.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'inspect-roles.mjs');

function mockProfiles() {
  return {
    coder: { role: 'coder', version: 1, systemPromptFile: 'SYSTEM.md', tools: ['read', 'bash'], excludedTools: [], skills: ['tdd'], extensions: ['event-bridge', 'structured-result'], timeoutMs: 1000 },
  };
}

test('formatRoleCapabilities lists tools union internal tools, skills, extensions per role', () => {
  const out = formatRoleCapabilities(mockProfiles(), ['ai_devflow_interaction', 'ai_devflow_report_result'], ['event-bridge', 'structured-result', 'execution-policy']);
  assert.match(out, /coder/);
  assert.match(out, /read, bash, ai_devflow_interaction, ai_devflow_report_result/);
  assert.match(out, /tdd/);
  assert.match(out, /event-bridge, structured-result/);
});

test('formatRoleCapabilities --json returns parseable object with all roles', () => {
  const out = formatRoleCapabilities(mockProfiles(), ['ai_devflow_interaction'], ['event-bridge'], { json: true });
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed.coder.tools, ['read', 'bash', 'ai_devflow_interaction']);
});

test('script run prints all four roles (smoke, exercises esbuild bundle)', () => {
  const stdout = execFileSync('node', [script], { encoding: 'utf8' });
  for (const role of ['planner', 'coder', 'reviewer', 'tester']) assert.match(stdout, new RegExp(role));
});

test('script run --json parses and contains four roles', () => {
  const stdout = execFileSync('node', [script, '--json'], { encoding: 'utf8' });
  const parsed = JSON.parse(stdout);
  assert.deepEqual(Object.keys(parsed).sort(), ['coder', 'planner', 'reviewer', 'tester']);
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `pnpm test:scripts`（或 `node --test scripts/inspect-roles.test.mjs`）
Expected: FAIL（`inspect-roles.mjs` 不存在）。

- [x] **Step 3: 实现脚本**（新建 `scripts/inspect-roles.mjs`）

```js
// 维护者自检：打印各内置角色生效的 tools/skills/extensions。
// 直接运行时用 esbuild 打包 packages/agents/src/profiles.ts 读取真实常量（仓库无 tsx、agents 无 dist）。
import { build } from 'esbuild';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PROFILES_SRC = join(here, '..', 'packages', 'agents', 'src', 'profiles.ts');

/**
 * 纯函数：把角色能力格式化为文本或 JSON。供测试直接调用，不触发 esbuild。
 * @param {Record<string, {role:string;version:number;tools:string[];excludedTools:string[];skills:string[];extensions:string[];timeoutMs:number}>} profiles
 * @param {string[]} internalTools
 * @param {string[]} builtinExtensions  注册池（仅用于注释，不改变输出）
 * @param {{json?:boolean}} [opts]
 */
export function formatRoleCapabilities(profiles, internalTools, builtinExtensions, opts = {}) {
  const roles = Object.values(profiles);
  const view = Object.fromEntries(roles.map((p) => {
    const tools = [...p.tools, ...internalTools];
    return [p.role, { version: p.version, tools, excludedTools: p.excludedTools, skills: p.skills, extensions: p.extensions, timeoutMs: p.timeoutMs, systemPromptFile: p.systemPromptFile }];
  }));
  if (opts.json) return JSON.stringify(view, null, 2);
  const lines = [`# 内置角色生效能力（internal tools: ${internalTools.join(', ')}）`, ''];
  for (const p of roles) {
    lines.push(`## ${p.role} (v${p.version})`);
    lines.push(`- tools: ${[...p.tools, ...internalTools].join(', ')}`);
    if (p.excludedTools.length) lines.push(`- excludedTools: ${p.excludedTools.join(', ')}`);
    lines.push(`- skills: ${p.skills.join(', ')}`);
    lines.push(`- extensions: ${p.extensions.join(', ')}`);
    lines.push(`- timeoutMs: ${p.timeoutMs}`);
    lines.push('');
  }
  return lines.join('\n');
}

async function loadProfiles() {
  const entry = join(mkdtempSync(join(tmpdir(), 'inspect-roles-')), 'entry.mjs');
  writeFileSync(entry, `export { ROLE_PROFILES, INTERNAL_TOOLS, BUILTIN_EXTENSIONS } from '${PROFILES_SRC.replace(/\\/g, '/')}';\n`);
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent',
    external: ['node:*'],
  });
  const code = result.outputFiles[0].text;
  const dataUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  return import(dataUrl);
}

async function main() {
  const { ROLE_PROFILES, INTERNAL_TOOLS, BUILTIN_EXTENSIONS } = await loadProfiles();
  const json = process.argv.includes('--json');
  process.stdout.write(formatRoleCapabilities(ROLE_PROFILES, [...INTERNAL_TOOLS], [...BUILTIN_EXTENSIONS], { json }) + '\n');
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
```

- [x] **Step 4: 加 package.json 脚本**

根 `package.json` 的 `scripts` 加：
```json
    "inspect:roles": "node scripts/inspect-roles.mjs",
```

- [x] **Step 5: 运行测试确认通过**

Run: `pnpm test:scripts`
Expected: PASS（含 esbuild smoke：首次运行会打包 profiles.ts，应输出四角色）。

- [x] **Step 6: 手动验证**

Run: `pnpm inspect:roles` 与 `pnpm inspect:roles -- --json`
Expected: 文本输出四角色块 / JSON 含四角色键。

- [x] **Step 7: 提交**

```bash
git add scripts/inspect-roles.mjs scripts/inspect-roles.test.mjs package.json
git commit -m "feat(scripts): inspect:roles maintainer capability self-check"
```

---

## Self-Review 记录

- **Spec 覆盖**：需求 1 -> Task 1；需求 2 -> Task 2；需求 3 -> Task 3；需求 4（重构 + 指南）-> Task 4 + Task 5；需求 5 -> Task 6。无遗漏。
- **占位符扫描**：各 Step 均含完整代码或确切命令，无 TBD/TODO。
- **类型一致**：`paginate`、`formatRoleCapabilities`、`validateRoleProfiles`、`api.projects.openFolder` 在定义处与引用处签名一致；`RoleProfile.extensions` 在 profiles/run-plan/测试中一致。
- **已知约束**：Task 3 renderer `setError` 需确认 `WorkspacePage` 顶层存在该 state（若无须补声明）；Task 2/3 共用 `FolderOpen` import，执行顺序无关但二者须都加入。Task 6 esbuild 打包 `profiles.ts` 依赖其仅 `import type` 自 `@ai-devflow/core`（已核实 L18），运行时无 core 依赖。
