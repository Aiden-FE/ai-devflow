# 工作台对话与 Agent 模型路由实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现四项工作台改进：AI 对话粘底滚动（用户上滚暂停+新消息提示）、按 agent 覆盖服务商/模型、需求创建 AI 两步唯一入口、AI 任务弹窗默认 AI+逐条编辑+重生成+一键创建。

**Architecture:** 前端交互类（①③④）集中在 `apps/desktop/src/pages/{TaskDetail,Workspace}.tsx`，共享一个滚动 hook；后端路由类（②）扩展 `packages/core` 数据模型、`provider-store.ts` 加密存储、`provider-router.ts` 路由、`Settings.tsx` 设置 UI。覆盖路由在专用 provider 不可用时回退默认有序路由，保留熔断降级。

**Tech Stack:** TypeScript、React、Electron（IPC + safeStorage）、Vitest、pnpm workspace。

## Global Constraints

- 提交信息遵循 Conventional Commits（如 `feat(desktop): ...`、`fix(agents): ...`）。
- UI 改动必须同时更新 `apps/desktop/src/i18n/zh.ts` 与 `apps/desktop/src/i18n/en.ts`。
- 验证命令：`pnpm verify`（typecheck + lint + test）；UI 集成另跑 `pnpm --filter @ai-devflow/desktop e2e`。
- 不重构四角色为步骤 agent；不为 `task_proposal` 新增正式步骤 Agent/tool。
- `modelRouteFor`（provider-router.ts 现有测试缝）保留不动；新增 `agentOverrideFor` 作为生产级覆盖入口，二者正交（前者 per-provider 测试注入，后者 per-workload 用户覆盖）。
- Agent 覆盖存储用 ProviderStore 内独立加密键 `agent-overrides:v1`（不改现有 `providers:v1` 数组形态，避免迁移风险）。

---

## File Structure

**新增：**
- `apps/desktop/src/hooks/useStickToBottom.ts` — 粘底滚动 hook + 纯函数 `isAtBottom`。
- `apps/desktop/src/components/NewMessagesButton.tsx` — 悬浮「↓ 新消息」按钮。
- `apps/desktop/src/hooks/__tests__/useStickToBottom.test.ts` — `isAtBottom` 单测。

**修改：**
- `packages/core/src/provider.ts` — 新增 `AgentKey`/`AgentModelOverride`/`workloadAgentKey`。
- `packages/agents/src/provider-router.ts` — `ProviderRouterDeps` 增 `agentOverrideFor`；`routesFor` 支持覆盖+回退。
- `packages/agents/src/__tests__/provider-router.test.ts` — 新增覆盖+回退用例。
- `apps/desktop/electron/provider-store.ts` — `agentOverrides` CRUD（独立加密键）。
- `apps/desktop/electron/pi-runtime.ts` — 生产接线 `agentOverrideFor`。
- `apps/desktop/electron/ipc.ts` — `agent-overrides:list/save/remove` 通道。
- `apps/desktop/electron/preload.ts` + `apps/desktop/electron/api.ts` — `api.agentOverrides.*`。
- `apps/desktop/src/pages/TaskDetail.tsx` — 对话区接入 hook + 按钮。
- `apps/desktop/src/pages/Workspace.tsx` — `CreateReqButton` AI 两步；`AiRefineRequirement`/`AiCreateTask` 接入滚动；`AiCreateTask` 重构；`CreateTaskModal` 默认 AI。
- `apps/desktop/src/pages/Settings.tsx` — 新增 `AgentModelSection`；改善 workload 标签。
- `apps/desktop/src/i18n/{zh,en}.ts` — 新增文案键。

---

## Task 1: 粘底滚动 hook 与悬浮按钮

**Files:**
- Create: `apps/desktop/src/hooks/useStickToBottom.ts`
- Create: `apps/desktop/src/components/NewMessagesButton.tsx`
- Test: `apps/desktop/src/hooks/__tests__/useStickToBottom.test.ts`

**Interfaces:**
- Produces: `isAtBottom(scrollTop, scrollHeight, clientHeight, threshold=120): boolean`（纯函数）；`useStickToBottom(deps: unknown[], threshold=120): { containerRef, paused, unreadCount, resume }`；`<NewMessagesButton count onResume />`。

- [ ] **Step 1: 写失败测试**

```ts
// apps/desktop/src/hooks/__tests__/useStickToBottom.test.ts
import { describe, it, expect } from 'vitest';
import { isAtBottom } from '../useStickToBottom.js';

describe('isAtBottom', () => {
  it('距底部小于阈值视为在底部', () => {
    expect(isAtBottom(880, 1000, 100, 120)).toBe(true);   // 1000-880-100=20 < 120
  });
  it('距底部大于等于阈值视为不在底部', () => {
    expect(isAtBottom(700, 1000, 100, 120)).toBe(false);  // 1000-700-100=200 >= 120
  });
  it('阈值边界：恰好等于阈值视为不在底部', () => {
    expect(isAtBottom(780, 1000, 100, 120)).toBe(false);  // 1000-780-100=120
  });
  it('clientHeight 大于 scrollHeight 时视为在底部', () => {
    expect(isAtBottom(0, 100, 200, 120)).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ai-devflow/desktop test useStickToBottom`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 hook 与纯函数**

```ts
// apps/desktop/src/hooks/useStickToBottom.ts
import { useEffect, useRef, useState } from 'react';

/** 距底部小于阈值视为「在底部」。纯函数，便于单测。 */
export function isAtBottom(scrollTop: number, scrollHeight: number, clientHeight: number, threshold = 120): boolean {
  return scrollHeight - scrollTop - clientHeight < threshold;
}

export interface StickToBottom {
  containerRef: React.RefObject<HTMLDivElement | null>;
  paused: boolean;
  unreadCount: number;
  resume: () => void;
}

/**
 * 粘底滚动：deps 变化时若未暂停则滚到底；用户上滚越过阈值则暂停并累计未读。
 * - 程序触发的滚动设 programmaticRef 标志，避免误判为用户上滚。
 * - 用户手动滚回底部（isAtBottom）时自动恢复。
 */
export function useStickToBottom(deps: unknown[], threshold = 120): StickToBottom {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [paused, setPaused] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const programmaticRef = useRef(false);

  // 依赖变化：未暂停则滚到底；已暂停则累计未读。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (!paused) {
      programmaticRef.current = true;
      el.scrollTop = el.scrollHeight;
      // 下一帧清除标志，避免触发自身 scroll 事件误判。
      requestAnimationFrame(() => { programmaticRef.current = false; });
    } else {
      setUnreadCount((n) => n + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  // 监听用户滚动：上滚越过阈值 -> 暂停；滚回底部 -> 恢复。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      if (programmaticRef.current) return;
      const atBottom = isAtBottom(el.scrollTop, el.scrollHeight, el.clientHeight, threshold);
      if (!atBottom && !paused) {
        setPaused(true);
      } else if (atBottom && paused) {
        setPaused(false);
        setUnreadCount(0);
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [paused, threshold]);

  const resume = () => {
    const el = containerRef.current;
    if (el) {
      programmaticRef.current = true;
      el.scrollTop = el.scrollHeight;
      requestAnimationFrame(() => { programmaticRef.current = false; });
    }
    setPaused(false);
    setUnreadCount(0);
  };

  return { containerRef, paused, unreadCount, resume };
}
```

```tsx
// apps/desktop/src/components/NewMessagesButton.tsx
import React from 'react';
import { ChevronDown } from 'lucide-react';
import { useT } from '../i18n/index.js';

/** 悬浮「↓ N 条新消息」按钮：仅 paused && count>0 时由调用方渲染。 */
export function NewMessagesButton({ count, onResume }: { count: number; onResume: () => void }): React.ReactElement | null {
  const t = useT();
  if (count <= 0) return null;
  return (
    <button
      type="button"
      onClick={onResume}
      className="absolute bottom-2 right-2 z-10 flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-xs shadow hover:bg-secondary"
    >
      <ChevronDown className="h-3.5 w-3.5" /> {t('chat.newMessages', { n: count })}
    </button>
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @ai-devflow/desktop test useStickToBottom`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/hooks/useStickToBottom.ts apps/desktop/src/components/NewMessagesButton.tsx apps/desktop/src/hooks/__tests__/useStickToBottom.test.ts
git commit -m "feat(desktop): 新增粘底滚动 hook 与新消息悬浮按钮"
```

---

## Task 2: TaskDetail 对话区接入粘底滚动

**Files:**
- Modify: `apps/desktop/src/pages/TaskDetail.tsx`（`:20` import、`:36` convRef、`:74-77` effect、`:175` 容器）

**Interfaces:**
- Consumes: Task 1 的 `useStickToBottom`、`NewMessagesButton`。

- [ ] **Step 1: 替换 import 与状态**

在 `apps/desktop/src/pages/TaskDetail.tsx` 顶部 import 块加入：
```ts
import { useStickToBottom } from '../hooks/useStickToBottom.js';
import { NewMessagesButton } from '../components/NewMessagesButton.js';
```
删除 `const convRef = useRef<HTMLDivElement>(null);`（`:36`），改由 hook 提供。

- [ ] **Step 2: 替换无条件滚动 effect**

将 `:74-77` 的：
```ts
  // 对话窗口自动滚动到底部
  useEffect(() => {
    if (convRef.current) convRef.current.scrollTop = convRef.current.scrollHeight;
  }, [messages, interactions]);
```
替换为：
```ts
  // 对话窗口粘底滚动：用户上滚越过阈值则暂停并提示新消息。
  const stick = useStickToBottom([messages, interactions]);
```

- [ ] **Step 3: 容器接 ref + relative + 悬浮按钮**

将 `:175` 的对话容器：
```tsx
        <div ref={convRef} className="mt-1 max-h-[52vh] min-h-[160px] flex-1 overflow-y-auto rounded p-2 text-xs scrollbar-thin" style={{ backgroundColor: 'var(--console-bg)', color: 'var(--console-fg)' }}>
```
替换为：
```tsx
        <div ref={stick.containerRef} className="relative mt-1 max-h-[52vh] min-h-[160px] flex-1 overflow-y-auto rounded p-2 text-xs scrollbar-thin" style={{ backgroundColor: 'var(--console-bg)', color: 'var(--console-fg)' }}>
          <NewMessagesButton count={stick.paused ? stick.unreadCount : 0} onResume={stick.resume} />
```
（注意：`<NewMessagesButton>` 放在该 `<div>` 内部、`messages.map` 之前。）

- [ ] **Step 4: 验证 typecheck + lint**

Run: `pnpm --filter @ai-devflow/desktop typecheck && pnpm --filter @ai-devflow/desktop lint`
Expected: 通过（无 `convRef` 未使用残留；`useRef` import 若不再被其他地方使用则保留无妨）。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/pages/TaskDetail.tsx
git commit -m "feat(desktop): 任务详情对话接入粘底滚动与新消息提示"
```

---

## Task 3: AI 弹窗对话（需求/任务）接入粘底滚动

**Files:**
- Modify: `apps/desktop/src/pages/Workspace.tsx`（`AiRefineRequirement` 约 `:456`、`AiCreateTask` 约 `:612`）

**Interfaces:**
- Consumes: Task 1 的 `useStickToBottom`、`NewMessagesButton`。

- [ ] **Step 1: 顶部 import**

在 `apps/desktop/src/pages/Workspace.tsx` import 块加入：
```ts
import { useStickToBottom } from '../hooks/useStickToBottom.js';
import { NewMessagesButton } from '../components/NewMessagesButton.js';
```

- [ ] **Step 2: AiRefineRequirement 接入**

在 `AiRefineRequirement` 组件内（`messages` state 声明之后）加入：
```ts
  const stick = useStickToBottom([messages]);
```
将其聊天容器：
```tsx
      <div className="h-48 overflow-y-auto rounded-md border border-border bg-background p-2 text-xs scrollbar-thin">
```
改为：
```tsx
      <div ref={stick.containerRef} className="relative h-48 overflow-y-auto rounded-md border border-border bg-background p-2 text-xs scrollbar-thin">
        <NewMessagesButton count={stick.paused ? stick.unreadCount : 0} onResume={stick.resume} />
```

- [ ] **Step 3: AiCreateTask 接入**

在 `AiCreateTask` 组件内（`messages` state 声明之后）加入：
```ts
  const stick = useStickToBottom([messages]);
```
将其聊天容器（`AiCreateTask` 中的 `h-48 overflow-y-auto` div）同样加 `ref={stick.containerRef}`、`relative` class，并在内部最前加 `<NewMessagesButton count={stick.paused ? stick.unreadCount : 0} onResume={stick.resume} />`。

- [ ] **Step 4: 验证**

Run: `pnpm --filter @ai-devflow/desktop typecheck && pnpm --filter @ai-devflow/desktop lint`
Expected: 通过。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/pages/Workspace.tsx
git commit -m "feat(desktop): 需求/任务 AI 对话接入粘底滚动"
```

---

## Task 4: 需求创建改为 AI 两步唯一入口

**Files:**
- Modify: `apps/desktop/src/pages/Workspace.tsx`（`CreateReqButton` 约 `:344`）
- Modify: `apps/desktop/src/i18n/zh.ts`、`apps/desktop/src/i18n/en.ts`

**Interfaces:**
- Consumes: `api.providers.list()`（检测可用服务商）、`api.ai.chat`（`AiRefineRequirement`）、`api.requirements.create`。

- [ ] **Step 1: 新增 i18n 键**

在 `apps/desktop/src/i18n/zh.ts` 的 `req.ai.*` 区块后追加：
```ts
  'req.ai.twoStepTitle': '与 AI 沟通需求',
  'req.ai.confirmTitle': '确认需求',
  'req.ai.noProvider': '尚未配置可用的 AI 服务商，请先前往「设置 → AI 服务商」配置。',
  'req.ai.goSettings': '去配置',
```
在 `apps/desktop/src/i18n/en.ts` 对应位置追加：
```ts
  'req.ai.twoStepTitle': 'Refine with AI',
  'req.ai.confirmTitle': 'Confirm requirement',
  'req.ai.noProvider': 'No AI provider available. Configure one under "Settings → AI providers" first.',
  'req.ai.goSettings': 'Configure',
```
（同时新增 `chat.newMessages` 键，见 Task 1 引用；在 zh.ts 追加 `'chat.newMessages': '↓ {n} 条新消息'`，en.ts 追加 `'chat.newMessages': '↓ {n} new'`。）

- [ ] **Step 2: 重构 CreateReqButton 为 AI 两步**

将 `apps/desktop/src/pages/Workspace.tsx` 中整个 `CreateReqButton` 函数（从 `function CreateReqButton({ iterationId, onCreated }...` 到其对应闭合 `}`）替换为：

```tsx
function CreateReqButton({ iterationId, onCreated }: { iterationId: string; onCreated: () => void }): React.ReactElement {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [priority, setPriority] = useState<'low' | 'medium' | 'high'>('medium');
  const [acceptance, setAcceptance] = useState('');
  const [appliedHint, setAppliedHint] = useState(false);
  // 检测是否存在可用服务商（启用 + 有凭证 + 有模型配置）。
  const providersQ = useAsync(() => api.providers.list(), [open]);
  const hasUsableProvider = (providersQ.data ?? []).some((p) => p.enabled && p.hasCredential && p.health !== 'configuration_error');

  const reset = () => { setTitle(''); setDesc(''); setAcceptance(''); setPriority('medium'); setAppliedHint(false); };

  const submit = async () => {
    await api.requirements.create(iterationId, title, desc, priority, acceptance);
    setOpen(false); reset(); onCreated();
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}><Plus className="h-3.5 w-3.5" /> {t('ws.createReq')}</Button>
      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>{t('req.ai.twoStepTitle')}</DialogTitle></DialogHeader>
          {appliedHint && <div className="rounded-md border border-ok/30 bg-ok/10 px-3 py-1.5 text-xs text-ok">{t('req.ai.applied')}</div>}
          {/* Step 1：AI 沟通 */}
          {hasUsableProvider ? (
            <AiRefineRequirement
              onApplied={(p) => {
                setTitle(p.title); setDesc(p.description); setAcceptance(p.acceptance); setPriority(p.priority);
                setAppliedHint(true);
              }}
            />
          ) : (
            <div className="flex flex-col items-center gap-2 py-6 text-center text-xs text-muted-foreground">
              <span>{t('req.ai.noProvider')}</span>
              <Button size="sm" variant="outline" onClick={() => { setOpen(false); window.location.hash = '#/settings'; }}>{t('req.ai.goSettings')}</Button>
            </div>
          )}
          {/* Step 2：确认需求（可编辑；草稿到达前为空但允许直接编辑） */}
          <div className="mt-2 flex flex-col gap-3 border-t border-border pt-3">
            <div className="text-xs font-semibold text-muted-foreground">{t('req.ai.confirmTitle')}</div>
            <div className="flex flex-col gap-1.5"><Label>{t('req.title')}</Label><Input value={title} onChange={(e) => setTitle(e.target.value)} /></div>
            <div className="flex flex-col gap-1.5"><Label>{t('req.description')}</Label><Textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={2} /></div>
            <div className="flex flex-col gap-1.5">
              <Label>{t('ws.priority')}</Label>
              <Select value={priority} onValueChange={(v) => setPriority(v as 'low' | 'medium' | 'high')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">{t('ws.priority.low')}</SelectItem>
                  <SelectItem value="medium">{t('ws.priority.medium')}</SelectItem>
                  <SelectItem value="high">{t('ws.priority.high')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5"><Label>{t('req.acceptance')}</Label><Textarea value={acceptance} onChange={(e) => setAcceptance(e.target.value)} rows={2} placeholder={t('req.acceptance.hint')} /></div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setOpen(false); reset(); }}>{t('common.cancel')}</Button>
            <Button disabled={!title.trim() || !hasUsableProvider} onClick={submit}>{t('common.create')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
```

> 说明：移除了原 `mode` 切换与 manual 分支；`AiRefineRequirement.onApplied` 不再 `setMode('manual')`，改为填入 Step 2 字段并提示。`window.location.hash = '#/settings'` 依赖现有路由（若路由 hash 不同，以实际为准；可在实现时确认导航方式）。若应用无 hash 路由，则改为关闭弹窗并提示用户手动进入设置。

- [ ] **Step 3: 验证**

Run: `pnpm --filter @ai-devflow/desktop typecheck && pnpm --filter @ai-devflow/desktop lint`
Expected: 通过。

- [ ] **Step 4: 提交**

```bash
git add apps/desktop/src/pages/Workspace.tsx apps/desktop/src/i18n/zh.ts apps/desktop/src/i18n/en.ts
git commit -m "feat(desktop): 需求创建改为 AI 两步唯一入口"
```

---

## Task 5: AI 任务弹窗默认 AI + 逐条编辑 + 重生成 + 一键创建

**Files:**
- Modify: `apps/desktop/src/pages/Workspace.tsx`（`CreateTaskModal` 约 `:466`、`AiCreateTask` 约 `:540`）
- Modify: `apps/desktop/src/i18n/zh.ts`、`apps/desktop/src/i18n/en.ts`

**Interfaces:**
- Consumes: `api.ai.propose`（允许空 messages）、`api.tasks.createBatch`、`AiTaskProposal`、Task 1 hook（已在 Task 3 接入）。
- Produces: 重构后的 `AiCreateTask`（草稿可逐条编辑、可重生成、一键创建）。

- [ ] **Step 1: 新增 i18n 键**

zh.ts 在 `task.ai.*` 区块追加：
```ts
  'task.ai.generate': '生成任务',
  'task.ai.regenerate': '补充说明并重新生成',
  'task.ai.regenerate.confirm': '重新生成将覆盖当前草稿，是否继续？',
  'task.ai.supplement': '补充说明（可选）',
  'task.ai.editDraft': '编辑草稿',
  'task.ai.deleteDraft': '删除',
  'task.ai.addDraft': '新增空行',
  'task.ai.createAll.confirm': '将创建以上全部任务，是否继续？',
```
en.ts 对应：
```ts
  'task.ai.generate': 'Generate tasks',
  'task.ai.regenerate': 'Regenerate with notes',
  'task.ai.regenerate.confirm': 'Regenerating will overwrite current drafts. Continue?',
  'task.ai.supplement': 'Additional notes (optional)',
  'task.ai.editDraft': 'Edit draft',
  'task.ai.deleteDraft': 'Delete',
  'task.ai.addDraft': 'Add row',
  'task.ai.createAll.confirm': 'This will create all tasks above. Continue?',
```

- [ ] **Step 2: CreateTaskModal 默认 AI**

将 `CreateTaskModal` 中 `const [mode, setMode] = useState<'manual' | 'ai'>('manual');` 改为 `useState<'manual' | 'ai'>('ai');`。其余不变。

- [ ] **Step 3: 重构 AiCreateTask**

将 `apps/desktop/src/pages/Workspace.tsx` 中整个 `AiCreateTask` 函数替换为：

```tsx
function AiCreateTask({ requirementId, requirement, onCreated }: { requirementId: string; requirement?: Requirement; onCreated: (taskId: string) => void }): React.ReactElement {
  const t = useT();
  const [messages, setMessages] = useState<{ role: 'user' | 'assistant'; content: string }[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [proposals, setProposals] = useState<AiTaskProposal[] | undefined>();
  const [creating, setCreating] = useState(false);

  const context = requirement
    ? `【当前需求】\n标题：${requirement.title}\n描述：${requirement.description || '(无)'}\n验收标准：${requirement.acceptance || '(无)'}`
    : undefined;

  const send = async () => {
    if (!input.trim() || streaming) return;
    const userMsg = { role: 'user' as const, content: input.trim() };
    const next = [...messages, userMsg];
    setMessages(next); setInput(''); setStreaming(true); setError(undefined);
    let assistant = '';
    setMessages([...next, { role: 'assistant', content: '' }]);
    try {
      assistant = await api.ai.chat(next, (delta) => {
        assistant += delta;
        setMessages((prev) => { const c = [...prev]; c[c.length - 1] = { role: 'assistant', content: assistant }; return c; });
      }, { mode: 'task', context });
    } catch (e) {
      setError((e as Error).message);
      setMessages((prev) => prev.filter((m) => !(m.role === 'assistant' && m.content === '')));
    } finally { setStreaming(false); }
  };

  // 生成任务草稿：允许空消息（仅用需求上下文）。supplement 非空时作为补充说明追加到历史。
  const generate = async (supplement?: string) => {
    if (streaming || creating) return;
    if (supplement?.trim()) {
      const next = [...messages, { role: 'user' as const, content: supplement.trim() }];
      setMessages(next);
      setError(undefined); setProposals(undefined); setCreating(true);
      try {
        const list = await api.ai.propose(next.filter((m) => m.content), context);
        setProposals(list);
      } catch (e) { setError((e as Error).message); }
      finally { setCreating(false); }
      return;
    }
    setError(undefined); setProposals(undefined); setCreating(true);
    try {
      const list = await api.ai.propose(messages.filter((m) => m.content), context);
      setProposals(list);
    } catch (e) { setError((e as Error).message); }
    finally { setCreating(false); }
  };

  const regenerate = async () => {
    if (!confirm(t('task.ai.regenerate.confirm'))) return;
    await generate(input.trim() || undefined);
    setInput('');
  };

  // 逐条编辑草稿。
  const updateDraft = (draftId: string, patch: Partial<AiTaskProposal>) => {
    setProposals((prev) => prev?.map((p) => (p.draftId === draftId ? { ...p, ...patch } : p)));
  };
  const deleteDraft = (draftId: string) => {
    setProposals((prev) => prev?.filter((p) => p.draftId !== draftId));
  };
  const addDraft = () => {
    const draftId = `draft-${Date.now()}`;
    setProposals((prev) => [...(prev ?? []), { draftId, title: '', description: '', role: 'coder', dependsOn: [] }]);
  };

  const createAll = async () => {
    if (!proposals || proposals.length === 0) return;
    const valid = proposals.filter((p) => p.title.trim());
    if (valid.length === 0) { setError(t('task.ai.proposals')); return; }
    if (!confirm(t('task.ai.createAll.confirm'))) return;
    setCreating(true); setError(undefined);
    try {
      const created = await api.tasks.createBatch({ requirementId, proposals: valid });
      onCreated(created[created.length - 1]?.id ?? '');
    } catch (e) { setError((e as Error).message); }
    finally { setCreating(false); }
  };

  const titleOf = (draftId?: string) => proposals?.find((p) => p.draftId === draftId)?.title || draftId || '';

  return (
    <div className="mt-3 flex flex-col gap-3">
      {requirement && (
        <div className="rounded-md border border-border bg-secondary/40 p-2 text-xs">
          <span className="text-muted-foreground">{t('detail.linkage.req')}：</span>{requirement.title}
        </div>
      )}
      {/* 补充说明 + 生成/重生成 */}
      <div className="flex flex-col gap-1.5">
        <Label>{t('task.ai.supplement')}</Label>
        <div className="flex gap-2">
          <Input className="flex-1" value={input} onChange={(e) => setInput(e.target.value)} placeholder={t('task.ai.placeholder')} disabled={streaming} />
          {!proposals || proposals.length === 0
            ? <Button size="sm" onClick={() => generate(input.trim() || undefined)} disabled={creating || streaming}>{creating ? t('task.ai.generating') : t('task.ai.generate')}</Button>
            : <Button size="sm" variant="outline" onClick={regenerate} disabled={creating || streaming}>{t('task.ai.regenerate')}</Button>}
        </div>
      </div>
      {/* 对话区（接入粘底滚动已在 Task 3 完成；此处保留 messages 渲染） */}
      <div ref={undefined} className="relative h-48 overflow-y-auto rounded-md border border-border bg-background p-2 text-xs scrollbar-thin">
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">{t('task.ai.placeholder')}</div>
        ) : messages.map((m, i) => (
          <div key={i} className={`mb-2 ${m.role === 'user' ? 'text-right' : ''}`}>
            <span className={`inline-block max-w-[85%] whitespace-pre-wrap break-words rounded-md px-2 py-1 ${m.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-secondary'}`}>
              {m.content || t('task.ai.thinking')}
            </span>
          </div>
        ))}
      </div>
      {error && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}
      {/* 草稿列表：逐条可编辑 */}
      {proposals && proposals.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <div className="text-xs font-medium text-muted-foreground">{t('task.ai.proposals')}</div>
            <Button size="sm" variant="ghost" onClick={addDraft}>{t('task.ai.addDraft')}</Button>
          </div>
          {proposals.map((p) => (
            <div key={p.draftId} className="rounded-md border border-border p-2 text-xs">
              <div className="flex flex-wrap items-center gap-1.5">
                <Input className="h-7 flex-1" value={p.title} onChange={(e) => updateDraft(p.draftId, { title: e.target.value })} placeholder={t('task.title')} />
                <Select value={p.role} onValueChange={(v) => updateDraft(p.draftId, { role: v as TaskRole })}>
                  <SelectTrigger className="h-7 w-24"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="planner">{t('role.planner')}</SelectItem>
                    <SelectItem value="coder">{t('role.coder')}</SelectItem>
                    <SelectItem value="reviewer">{t('role.reviewer')}</SelectItem>
                    <SelectItem value="tester">{t('role.tester')}</SelectItem>
                  </SelectContent>
                </Select>
                <Button size="sm" variant="ghost" className="text-destructive" onClick={() => deleteDraft(p.draftId)}>{t('task.ai.deleteDraft')}</Button>
              </div>
              <Textarea className="mt-1.5 min-h-[40px]" value={p.description} onChange={(e) => updateDraft(p.draftId, { description: e.target.value })} rows={2} placeholder={t('task.description')} />
              {(proposals.filter((x) => x.draftId !== p.draftId).length) > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-2">
                  {proposals.filter((x) => x.draftId !== p.draftId).map((sib) => (
                    <label key={sib.draftId} className="flex items-center gap-1 text-[11px]">
                      <Checkbox
                        checked={(p.dependsOn ?? []).includes(sib.draftId)}
                        onCheckedChange={() => updateDraft(p.draftId, {
                          dependsOn: (p.dependsOn ?? []).includes(sib.draftId)
                            ? (p.dependsOn ?? []).filter((d) => d !== sib.draftId)
                            : [...(p.dependsOn ?? []), sib.draftId],
                        })}
                      />
                      <span className="truncate">{sib.title || sib.draftId}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          ))}
          <Button size="sm" onClick={createAll} disabled={creating}>{t('task.ai.createAll')}</Button>
        </div>
      )}
    </div>
  );
}
```

> 注意：上面 `<div ref={undefined} ...>` 是占位说明。由于 Task 3 已在该对话容器接入 `stick`，这里应保留 Task 3 接入的 `ref={stick.containerRef}`、`relative` 与 `<NewMessagesButton>`。实现时不要覆盖 Task 3 的改动——保持 `const stick = useStickToBottom([messages]);` 与对应 ref/按钮，仅替换其余结构。若 stick 未在该函数声明，需补声明。

- [ ] **Step 4: 确认 stick 接入未丢失**

检查 `AiCreateTask` 顶部仍有 `const stick = useStickToBottom([messages]);`，对话容器 `<div ref={stick.containerRef} className="relative ...">` 内仍有 `<NewMessagesButton count={stick.paused ? stick.unreadCount : 0} onResume={stick.resume} />`。若 Task 3 已加则保留；未加则补。

- [ ] **Step 5: 验证**

Run: `pnpm --filter @ai-devflow/desktop typecheck && pnpm --filter @ai-devflow/desktop lint`
Expected: 通过。

- [ ] **Step 6: 提交**

```bash
git add apps/desktop/src/pages/Workspace.tsx apps/desktop/src/i18n/zh.ts apps/desktop/src/i18n/en.ts
git commit -m "feat(desktop): AI 任务弹窗默认 AI + 逐条编辑 + 重生成 + 一键创建"
```

---

## Task 6: core 数据模型 — AgentKey / AgentModelOverride / workloadAgentKey

**Files:**
- Modify: `packages/core/src/provider.ts`
- Test: `packages/core/src/__tests__/provider.test.ts`（若不存在则新建；先查 `ls packages/core/src/__tests__/`）

**Interfaces:**
- Produces: `AgentKey`、`AgentModelOverride`、`workloadAgentKey(workload: Workload): AgentKey`。

- [ ] **Step 1: 写失败测试**

先确认测试目录存在：`ls packages/core/src/__tests__/ 2>/dev/null || echo NO_DIR`。
若存在，在 `packages/core/src/__tests__/provider.test.ts` 追加（或新建文件）：

```ts
import { describe, it, expect } from 'vitest';
import { workloadAgentKey } from '../provider.js';

describe('workloadAgentKey', () => {
  it('requirement_chat 映射到 requirement_refiner', () => {
    expect(workloadAgentKey('requirement_chat')).toBe('requirement_refiner');
  });
  it('task_proposal 映射到 task_proposer', () => {
    expect(workloadAgentKey('task_proposal')).toBe('task_proposer');
  });
  it('四角色同名', () => {
    expect(workloadAgentKey('planner')).toBe('planner');
    expect(workloadAgentKey('coder')).toBe('coder');
    expect(workloadAgentKey('reviewer')).toBe('reviewer');
    expect(workloadAgentKey('tester')).toBe('tester');
  });
  it('task_chat 映射到 chat', () => {
    expect(workloadAgentKey('task_chat')).toBe('chat');
  });
  it('requirement_proposal 归并到 chat', () => {
    expect(workloadAgentKey('requirement_proposal')).toBe('chat');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ai-devflow/core test workloadAgentKey`
Expected: FAIL（`workloadAgentKey` 未导出）。

- [ ] **Step 3: 实现类型与函数**

在 `packages/core/src/provider.ts` 的 `ModelRoleKey` 类型定义之后（约 `:32` 之后）新增：

```ts
/**
 * Agent 键：用户视角的「agent」标识，用于按 agent 覆盖 provider+模型。
 * 四角色同名；requirement_chat->requirement_refiner、task_proposal->task_proposer 为步骤 agent；
 * task_chat/requirement_proposal 归并到 chat。
 */
export type AgentKey =
  | 'planner'
  | 'coder'
  | 'reviewer'
  | 'tester'
  | 'requirement_refiner'
  | 'task_proposer'
  | 'chat';

/** 按 agent 覆盖 provider + 模型（用户配置；无密钥，引用 ProviderConfig.id）。 */
export interface AgentModelOverride {
  agentKey: AgentKey;
  providerId: string;
  model: string;
}

/** workload -> agent 键（用于覆盖路由解析）。 */
export function workloadAgentKey(workload: Workload): AgentKey {
  switch (workload) {
    case 'planner': return 'planner';
    case 'coder': return 'coder';
    case 'reviewer': return 'reviewer';
    case 'tester': return 'tester';
    case 'requirement_chat': return 'requirement_refiner';
    case 'task_proposal': return 'task_proposer';
    case 'task_chat':
    case 'requirement_proposal': return 'chat';
  }
}
```

- [ ] **Step 4: 确认 core 包导出**

检查 `packages/core/src/index.ts` 是否 re-export `provider.ts`（通常 `export * from './provider.js'`）。若是则无需改动；否则追加 `export { workloadAgentKey, type AgentKey, type AgentModelOverride } from './provider.js';`。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @ai-devflow/core test workloadAgentKey`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/provider.ts packages/core/src/__tests__/provider.test.ts
git commit -m "feat(core): 新增 AgentKey/AgentModelOverride/workloadAgentKey"
```

---

## Task 7: ProviderStore agentOverrides CRUD

**Files:**
- Modify: `apps/desktop/electron/provider-store.ts`
- Test: `apps/desktop/electron/__tests__/provider-store.test.ts`（先查是否存在；不存在则新建）

**Interfaces:**
- Consumes: Task 6 的 `AgentModelOverride`、`AgentKey`。
- Produces: `ProviderStore.listAgentOverrides()`、`saveAgentOverride(o)`、`removeAgentOverride(agentKey)`。

- [ ] **Step 1: 写失败测试**

先查：`ls apps/desktop/electron/__tests__/ 2>/dev/null || echo NO_DIR`。
新建或追加 `apps/desktop/electron/__tests__/provider-store.test.ts`，使用内存 `ProviderCredentialSink` 与恒等 crypto（参照现有 store 测试模式）：

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { ProviderStore } from '../provider-store.js';

function makeStore() {
  const map = new Map<string, string>();
  const sink = {
    get: (k: string) => map.get(k),
    upsert: (k: string, v: string) => { map.set(k, v); },
    delete: (k: string) => { map.delete(k); },
    transaction: <T>(fn: () => T): T => fn(),
  };
  const crypto = { encrypt: (v: string) => v, decrypt: (v: string) => v };
  return new ProviderStore(sink, crypto, () => {});
}

describe('ProviderStore agentOverrides', () => {
  let store: ProviderStore;
  beforeEach(() => { store = makeStore(); });

  it('空存储返回空数组', () => {
    expect(store.listAgentOverrides()).toEqual([]);
  });

  it('saveAgentOverride 按 agentKey upsert', () => {
    store.saveAgentOverride({ agentKey: 'requirement_refiner', providerId: 'p1', model: 'claude-3-5-sonnet' });
    store.saveAgentOverride({ agentKey: 'coder', providerId: 'p2', model: 'gpt-4o' });
    expect(store.listAgentOverrides()).toHaveLength(2);
    // 同 agentKey 更新
    store.saveAgentOverride({ agentKey: 'requirement_refiner', providerId: 'p3', model: 'm1' });
    const r = store.listAgentOverrides();
    expect(r).toHaveLength(2);
    expect(r.find((o) => o.agentKey === 'requirement_refiner')).toEqual({ agentKey: 'requirement_refiner', providerId: 'p3', model: 'm1' });
  });

  it('removeAgentOverride 删除指定 agentKey', () => {
    store.saveAgentOverride({ agentKey: 'coder', providerId: 'p2', model: 'gpt-4o' });
    store.removeAgentOverride('coder');
    expect(store.listAgentOverrides()).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ai-devflow/desktop test provider-store`
Expected: FAIL（方法不存在）。

- [ ] **Step 3: 实现 CRUD**

在 `apps/desktop/electron/provider-store.ts` 顶部 import 块追加：
```ts
import type { AgentModelOverride, AgentKey } from '@ai-devflow/core';
```
在 `PROVIDERS_KEY` 常量旁新增：
```ts
const AGENT_OVERRIDES_KEY = 'agent-overrides:v1';
```
在 `ProviderStore` 类内（`resolveSecret` 方法之后）新增三个方法：

```ts
  /** 读取全部 agent 模型覆盖（解密失败视为空）。 */
  listAgentOverrides(): AgentModelOverride[] {
    const raw = this.credentials.get(AGENT_OVERRIDES_KEY);
    if (!raw) return [];
    try {
      const json = this.crypto.decrypt(raw);
      const parsed = JSON.parse(json) as AgentModelOverride[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /** 按 agentKey upsert 一条覆盖。 */
  saveAgentOverride(o: AgentModelOverride): void {
    const list = this.listAgentOverrides().filter((x) => x.agentKey !== o.agentKey);
    list.push(o);
    this.credentials.upsert(AGENT_OVERRIDES_KEY, this.crypto.encrypt(JSON.stringify(list)));
  }

  /** 删除指定 agentKey 的覆盖。 */
  removeAgentOverride(agentKey: AgentKey): void {
    const list = this.listAgentOverrides().filter((x) => x.agentKey !== agentKey);
    this.credentials.upsert(AGENT_OVERRIDES_KEY, this.crypto.encrypt(JSON.stringify(list)));
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @ai-devflow/desktop test provider-store`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/electron/provider-store.ts apps/desktop/electron/__tests__/provider-store.test.ts
git commit -m "feat(desktop): ProviderStore 新增 agentOverrides 加密存储"
```

---

## Task 8: ProviderRouter 覆盖路由 + 回退

**Files:**
- Modify: `packages/agents/src/provider-router.ts`
- Test: `packages/agents/src/__tests__/provider-router.test.ts`

**Interfaces:**
- Consumes: Task 6 的 `workloadAgentKey`；现有 `ProviderRoute`、`resolveModelFor`、`DEFAULT_THINKING_BY_ROLE`。
- Produces: `ProviderRouterDeps.agentOverrideFor?: (workload) => { providerId: string; model: string } | undefined`；`routesFor` 支持覆盖+回退。

- [ ] **Step 1: 写失败测试**

在 `packages/agents/src/__tests__/provider-router.test.ts` 顶部若未 import `workloadAgentKey` 则无需；测试用 `agentOverrideFor`。在该文件末尾追加（沿用其现有 harness 工厂；若文件有 `createHarness` 辅助，参照其签名）：

```ts
import type { ProviderConfig } from '@ai-devflow/core';

function overrideHarness(providers: ProviderConfig[], opts: { secret?: (id: string) => string | undefined; agentOverrideFor?: (w: string) => { providerId: string; model: string } | undefined }) {
  const health = new Map<string, { state: 'closed' | 'open' | 'half_open'; cooldownUntil?: number; lastFailureKind?: string }>();
  return {
    router: new ProviderRouter({
      listProviders: () => providers,
      resolveSecret: opts.secret ?? ((id) => `secret-${id}`),
      health: {
        get: (pid: string, rid: string) => health.get(`${pid}:${rid}`) as any,
        listByProvider: (pid: string) => [...health.entries()].filter(([k]) => k.startsWith(pid + ':')).map(([, v]) => ({ providerId: pid, routeId: '', consecutiveFailures: 0, updatedAt: 0, ...v }) as any),
        upsert: (v: any) => { health.set(`${v.providerId}:${v.routeId}`, { state: v.state, cooldownUntil: v.cooldownUntil, lastFailureKind: v.lastFailureKind }); },
        clearProvider: (pid: string) => { for (const k of [...health.keys()]) if (k.startsWith(pid + ':')) health.delete(k); },
      },
      now: () => 1000,
      sleep: async () => {},
      agentOverrideFor: opts.agentOverrideFor,
    }),
  };
}

describe('ProviderRouter agent override', () => {
  const p1: ProviderConfig = { id: 'p1', kind: 'openai', displayName: 'P1', enabled: true, priority: 0, authType: 'api_key', credentialRef: 'provider:p1', defaultModel: 'gpt-4o', revision: 1 };
  const p2: ProviderConfig = { id: 'p2', kind: 'anthropic', displayName: 'P2', enabled: true, priority: 1, authType: 'api_key', credentialRef: 'provider:p2', defaultModel: 'claude-3-5-sonnet', revision: 1 };

  it('覆盖存在时仅返回该 provider 并强制 model', () => {
    const { router } = overrideHarness([p1, p2], { agentOverrideFor: () => ({ providerId: 'p2', model: 'claude-opus' }) });
    const routes = router.routesFor('requirement_chat');
    expect(routes).toHaveLength(1);
    expect(routes[0]!.providerId).toBe('p2');
    expect(routes[0]!.model).toBe('claude-opus');
  });

  it('覆盖 provider 被禁用时回退到默认有序路由', () => {
    const p2Disabled = { ...p2, enabled: false };
    const { router } = overrideHarness([p1, p2Disabled], { agentOverrideFor: () => ({ providerId: 'p2', model: 'claude-opus' }) });
    const routes = router.routesFor('requirement_chat');
    expect(routes.map((r) => r.providerId)).toEqual(['p1']);
    expect(routes[0]!.model).toBe('gpt-4o');
  });

  it('覆盖 provider 无凭证时回退到默认路由', () => {
    const { router } = overrideHarness([p1, p2], { secret: (id) => (id === 'p2' ? undefined : `secret-${id}`), agentOverrideFor: () => ({ providerId: 'p2', model: 'claude-opus' }) });
    const routes = router.routesFor('requirement_chat');
    expect(routes.map((r) => r.providerId)).toEqual(['p1']);
  });

  it('无覆盖时走默认 workloadModels/defaultModel', () => {
    const { router } = overrideHarness([p1, p2], {});
    const routes = router.routesFor('coder');
    expect(routes.map((r) => r.providerId)).toEqual(['p1', 'p2']);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ai-devflow/agents test provider-router`
Expected: FAIL（`agentOverrideFor` 不在 deps 类型；覆盖不生效）。

- [ ] **Step 3: 扩展 deps 与 routesFor**

在 `packages/agents/src/provider-router.ts`：
1. 顶部 import 行追加 `workloadAgentKey`：
```ts
import type { FailureKind, ModelRoleKey, ProviderConfig, ProviderHealth, ProviderKind, Workload } from '@ai-devflow/core';
import { workloadAgentKey } from '@ai-devflow/core';
```
（确认 `@ai-devflow/core` 已导出 `workloadAgentKey`——Task 6 Step 4 已处理。）

2. 在 `ProviderRouterDeps` 接口追加字段（保留 `modelRouteFor` 不动）：
```ts
export interface ProviderRouterDeps {
  listProviders(): ProviderConfig[];
  resolveSecret(providerId: string): string | undefined;
  health: ProviderHealthStore;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** 集成测试缝：存在时覆盖用户配置解析（含 thinking 等级），供 real-pi 等测试注入非生产模型。 */
  modelRouteFor?: (provider: ProviderConfig, workload: Workload) => ModelRoute | undefined;
  /** 生产级 agent 覆盖：按 workload 返回用户配置的 {providerId, model}；命中则仅用该 provider+model，不可用时回退默认路由。 */
  agentOverrideFor?: (workload: Workload) => { providerId: string; model: string } | undefined;
}
```

3. 将 `routesFor` 方法整体替换为以下实现（提取私有 `collectCandidates`，支持 `forcedModel`）：

```ts
  /** 生成某 workload 的候选路线。覆盖存在且可用时仅返回该 provider+model；不可用回退默认有序路由。 */
  routesFor(workload: Workload, now = this.deps.now()): ProviderRoute[] {
    const override = this.deps.agentOverrideFor?.(workload);
    if (override) {
      const overrideCandidates = this.collectCandidates(
        this.deps.listProviders().filter((p) => p.enabled && p.id === override.providerId),
        workload,
        now,
        override,
      );
      const overrideActive = overrideCandidates.filter((c) => !c.cooling).map((c) => c.route);
      if (overrideActive.length > 0) return overrideActive;
      // 覆盖 provider 不可用（禁用/无凭证/冷却中无 half-open）-> 回退默认路由。
    }
    const candidates = this.collectCandidates(
      this.deps.listProviders().filter((p) => p.enabled).sort((a, b) => a.priority - b.priority),
      workload,
      now,
      undefined,
    );
    const active = candidates.filter((c) => !c.cooling).map((c) => c.route);
    if (active.length > 0) return active;
    // 全部冷却：仅选最早到期的一条 half-open 探测（无到期者如 auth 不可探测）。
    const probes = candidates
      .filter((c) => c.probeEligible)
      .sort((a, b) => (a.cooldownUntil ?? 0) - (b.cooldownUntil ?? 0));
    if (probes.length > 0) return [probes[0]!.route];
    return [];
  }

  /** 收集候选：遍历 providers，按 override/seam/默认解析模型与 thinking，叠加健康/冷却状态。 */
  private collectCandidates(
    providers: ProviderConfig[],
    workload: Workload,
    now: number,
    override: { providerId: string; model: string } | undefined,
  ): { route: ProviderRoute; cooling: boolean; cooldownUntil?: number; probeEligible: boolean }[] {
    const candidates: { route: ProviderRoute; cooling: boolean; cooldownUntil?: number; probeEligible: boolean }[] = [];
    for (const provider of providers) {
      const authHealth = this.deps.health.get(provider.id, PROVIDER_AUTH_ROUTE_ID);
      if (authHealth?.state === 'open' || authHealth?.state === 'half_open') continue;
      const secret = this.deps.resolveSecret(provider.id);
      if (!secret) continue;
      const seam = this.deps.modelRouteFor?.(provider, workload);
      let model: string | undefined;
      let thinking: ModelChoice['thinking'];
      if (override && provider.id === override.providerId) {
        model = override.model;
        thinking = DEFAULT_THINKING_BY_ROLE[workloadRoleKey(workload)];
      } else if (seam) {
        model = seam.primary.model;
        thinking = seam.primary.thinking;
      } else {
        model = resolveModelFor(provider, workload);
        thinking = DEFAULT_THINKING_BY_ROLE[workloadRoleKey(workload)];
      }
      if (model === undefined) continue;
      const providerName = providerNameFor(provider);
      const routeId = `${provider.id}:${workload}`;
      const h = this.deps.health.get(provider.id, routeId);
      const isOpen = h?.state === 'open';
      const isHalfOpen = h?.state === 'half_open';
      const cooling = !!isHalfOpen || (!!isOpen && (h!.cooldownUntil === undefined || h!.cooldownUntil > now));
      candidates.push({
        route: {
          providerId: provider.id,
          providerRevision: provider.revision,
          providerKind: provider.kind,
          providerName,
          routeId,
          model,
          models: [model],
          thinking,
          baseURL: provider.baseURL,
          secret,
        },
        cooling,
        cooldownUntil: h?.cooldownUntil,
        probeEligible: !!isOpen && h?.cooldownUntil !== undefined,
      });
    }
    return candidates;
  }
```

> 说明：`workloadAgentKey` import 仅用于类型注释一致性；实际 thinking 解析仍用现有 `workloadRoleKey`（保持与 `DEFAULT_THINKING_BY_ROLE` 一致）。若 lint 报 `workloadAgentKey` 未使用，可移除该 import（保留 `agentOverrideFor` 即可）。优先保证 lint 通过。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @ai-devflow/agents test provider-router`
Expected: PASS（新用例 + 原有用例全过）。

- [ ] **Step 5: 提交**

```bash
git add packages/agents/src/provider-router.ts packages/agents/src/__tests__/provider-router.test.ts
git commit -m "feat(agents): ProviderRouter 支持按 agent 覆盖路由与回退"
```

---

## Task 9: 生产接线 agentOverrideFor

**Files:**
- Modify: `apps/desktop/electron/pi-runtime.ts`（`:132-139` router 构造）

**Interfaces:**
- Consumes: Task 7 的 `ProviderStore.listAgentOverrides`、Task 6 的 `workloadAgentKey`。

- [ ] **Step 1: 接线**

在 `apps/desktop/electron/pi-runtime.ts` 顶部 import 块，把：
```ts
import type { ProviderConfig, ProviderHealth } from '@ai-devflow/core';
```
改为：
```ts
import { workloadAgentKey, type ProviderConfig, type ProviderHealth } from '@ai-devflow/core';
```
将 `createPiRuntime` 中 router 构造（`:132-139`）：
```ts
  const router = new ProviderRouter({
    listProviders: (): ProviderConfig[] => providerStore.listConfigs(),
    resolveSecret: (providerId) => providerStore.resolveSecret(providerId),
    health,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
```
改为：
```ts
  const router = new ProviderRouter({
    listProviders: (): ProviderConfig[] => providerStore.listConfigs(),
    resolveSecret: (providerId) => providerStore.resolveSecret(providerId),
    health,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    agentOverrideFor: (workload) => {
      const o = providerStore.listAgentOverrides().find((x) => x.agentKey === workloadAgentKey(workload));
      return o ? { providerId: o.providerId, model: o.model } : undefined;
    },
  });
```

- [ ] **Step 2: 验证**

Run: `pnpm --filter @ai-devflow/desktop typecheck`
Expected: 通过。

- [ ] **Step 3: 提交**

```bash
git add apps/desktop/electron/pi-runtime.ts
git commit -m "feat(desktop): 生产接线 agentOverrideFor 路由覆盖"
```

---

## Task 10: IPC + preload + api 契约

**Files:**
- Modify: `apps/desktop/electron/ipc.ts`
- Modify: `apps/desktop/electron/preload.ts`
- Modify: `apps/desktop/electron/api.ts`

**Interfaces:**
- Consumes: Task 7 的 `ProviderStore` 方法、Task 6 的 `AgentModelOverride`/`AgentKey`。
- Produces: `api.agentOverrides.{list,save,remove}`。

- [ ] **Step 1: IPC 处理器**

在 `apps/desktop/electron/ipc.ts` 顶部 import 追加类型：
```ts
import type { AiChatMessage, AiTaskProposal, Task, TaskStatus, ThemeMode, RejectTaskInput, ProviderConfig, AgentModelOverride, AgentKey } from '@ai-devflow/core';
```
在 `providers` 区块末尾（`listModels` handler 之后）追加：
```ts
  // ---- Agent 模型覆盖（按 agent 钉选 provider+model；无密钥） ----
  ipcMain.handle(channel('agent-overrides', 'list'), () => providerStore?.listAgentOverrides() ?? []);
  ipcMain.handle(channel('agent-overrides', 'save'), (_e, o: AgentModelOverride) => {
    if (!providerStore) throw new Error('provider store 不可用');
    providerStore.saveAgentOverride(o);
    return providerStore.listAgentOverrides();
  });
  ipcMain.handle(channel('agent-overrides', 'remove'), (_e, agentKey: AgentKey) => {
    if (!providerStore) throw new Error('provider store 不可用');
    providerStore.removeAgentOverride(agentKey);
    return providerStore.listAgentOverrides();
  });
```

- [ ] **Step 2: preload 暴露**

在 `apps/desktop/electron/preload.ts` 的 `api` 对象中，`providers` 块之后加入：
```ts
  agentOverrides: {
    list: () => invoke('agent-overrides', 'list')(),
    save: (o) => invoke('agent-overrides', 'save')(o),
    remove: (agentKey) => invoke('agent-overrides', 'remove')(agentKey),
  },
```

- [ ] **Step 3: api 契约类型**

在 `apps/desktop/electron/api.ts` 顶部 import 追加：
```ts
  AgentModelOverride,
  AgentKey,
```
（加到现有 `@ai-devflow/core` import 列表。）
在 `DesktopApi` 接口中，`providers` 块之后加入：
```ts
  // ---- Agent 模型覆盖 ----
  agentOverrides: {
    list(): Promise<AgentModelOverride[]>;
    save(o: AgentModelOverride): Promise<AgentModelOverride[]>;
    remove(agentKey: AgentKey): Promise<AgentModelOverride[]>;
  };
```

- [ ] **Step 4: 验证**

Run: `pnpm --filter @ai-devflow/desktop typecheck`
Expected: 通过。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/electron/ipc.ts apps/desktop/electron/preload.ts apps/desktop/electron/api.ts
git commit -m "feat(desktop): agentOverrides IPC + preload + api 契约"
```

---

## Task 11: 设置页 AgentModelSection + workload 标签改善 + i18n

**Files:**
- Modify: `apps/desktop/src/pages/Settings.tsx`
- Modify: `apps/desktop/src/i18n/zh.ts`、`apps/desktop/src/i18n/en.ts`

**Interfaces:**
- Consumes: Task 10 的 `api.agentOverrides.*`、`api.providers.list/listModels`、Task 6 的 `AgentKey`/`AgentModelOverride`。

- [ ] **Step 1: 新增 i18n 键**

zh.ts 在 `settings.providers.*` 区块末尾追加：
```ts
  'settings.agentModels': 'Agent 模型分配',
  'settings.agentModels.hint': '为指定 agent 钉选服务商与模型；不设置则跟随默认有序路由。专用服务商不可用时会自动回退。',
  'settings.agentModels.agent': 'Agent',
  'settings.agentModels.workload': '对应工作负载',
  'settings.agentModels.effective': '当前生效',
  'settings.agentModels.override': '专用服务商 / 模型',
  'settings.agentModels.followDefault': '跟随默认路由',
  'settings.agentModels.provider': '服务商',
  'settings.agentModels.model': '模型',
  'settings.agentModels.agent.requirement_refiner': '需求细化',
  'settings.agentModels.agent.task_proposer': '任务生成',
  'settings.agentModels.agent.planner': '规划',
  'settings.agentModels.agent.coder': '编码',
  'settings.agentModels.agent.reviewer': '审查',
  'settings.agentModels.agent.tester': '测试',
  'settings.agentModels.agent.chat': '对话',
  'settings.agentModels.workload.requirement_refiner': 'requirement_chat',
  'settings.agentModels.workload.task_proposer': 'task_proposal',
  'settings.agentModels.workload.planner': 'planner',
  'settings.agentModels.workload.coder': 'coder',
  'settings.agentModels.workload.reviewer': 'reviewer',
  'settings.agentModels.workload.tester': 'tester',
  'settings.agentModels.workload.chat': 'task_chat / requirement_proposal',
```
en.ts 对应追加英文文案（同键名，英文值，如 `'settings.agentModels': 'Agent model assignment'` 等）。

- [ ] **Step 2: 改善现有 workload 标签**

在 `Settings.tsx` 的 `ProviderSection` 中，将 `<details>` 内 `MODEL_ROLES.map((role) => ...)` 的 `<Label className="text-[11px]">{role}</Label>` 改为带说明：
```tsx
                    <Label className="text-[11px]">{role} <span className="text-muted-foreground">({t(`settings.agentModels.workload.${role}`)})</span></Label>
```
（`role` 取值为 `planner/coder/reviewer/tester/chat/proposal`；`settings.agentModels.workload.proposal` 需补一键：zh `'task_proposal / requirement_proposal'`，en 同理。）

- [ ] **Step 3: 新增 AgentModelSection 组件**

在 `apps/desktop/src/pages/Settings.tsx` 顶部 import 块追加类型：
```ts
import type { NotificationRule, WebhookConfig, WebhookDelivery, TaskStatus, ThemeMode, Locale, UpdateStatus, ProviderSummary, ProviderInput, ProviderKind, ModelRoleKey, ProviderMigrationStatus, AgentKey, AgentModelOverride } from '@ai-devflow/core';
```
新增常量（在 `MODEL_ROLES` 附近）：
```ts
const AGENT_KEYS: AgentKey[] = ['planner', 'coder', 'reviewer', 'tester', 'requirement_refiner', 'task_proposer', 'chat'];
```
在 `SettingsPage` 的 `<ProviderSection />` 之后加入 `<AgentModelSection />`：
```tsx
        <ProviderSection />
        <AgentModelSection />
```
在文件末尾（`ProviderSection` 之后）新增组件：

```tsx
function AgentModelSection(): React.ReactElement {
  const t = useT();
  const providersQ = useAsync(() => api.providers.list(), []);
  const overridesQ = useAsync(() => api.agentOverrides.list(), []);
  const [draft, setDraft] = useState<Record<AgentKey, { providerId: string; model: string }>>({} as Record<AgentKey, { providerId: string; model: string }>);
  const [busy, setBusy] = useState<AgentKey | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    const map = {} as Record<AgentKey, { providerId: string; model: string }>;
    for (const o of overridesQ.data ?? []) map[o.agentKey] = { providerId: o.providerId, model: o.model };
    setDraft(map);
  }, [overridesQ.data]);

  const providers = (providersQ.data ?? []).filter((p) => p.enabled && p.hasCredential);
  const reload = () => { overridesQ.reload(); };

  const save = async (agentKey: AgentKey) => {
    setBusy(agentKey); setError(undefined);
    try {
      const v = draft[agentKey];
      if (v?.providerId && v?.model) {
        await api.agentOverrides.save({ agentKey, providerId: v.providerId, model: v.model });
      } else {
        await api.agentOverrides.remove(agentKey);
      }
      reload();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(undefined); }
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="m-0 text-sm font-semibold">{t('settings.agentModels')}</h3>
      <p className="text-xs text-muted-foreground">{t('settings.agentModels.hint')}</p>
      <div className="mt-2 flex flex-col gap-2">
        {AGENT_KEYS.map((agentKey) => {
          const ov = draft[agentKey];
          const providerId = ov?.providerId ?? '';
          const model = ov?.model ?? '';
          const effective = providerId ? providers.find((p) => p.id === providerId)?.displayName ?? providerId : t('settings.agentModels.followDefault');
          return (
            <div key={agentKey} className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2 text-xs">
              <div className="flex min-w-[160px] flex-col">
                <span className="font-medium">{t(`settings.agentModels.agent.${agentKey}`)}</span>
                <span className="text-muted-foreground">{t('settings.agentModels.workload')}：{t(`settings.agentModels.workload.${agentKey}`)}</span>
              </div>
              <div className="flex flex-1 flex-wrap items-center gap-2">
                <span className="text-muted-foreground">{t('settings.agentModels.effective')}：{effective}{model ? ` / ${model}` : ''}</span>
                <Select value={providerId} onValueChange={(v) => setDraft({ ...draft, [agentKey]: { providerId: v, model: draft[agentKey]?.model ?? '' } })}>
                  <SelectTrigger className="h-7 w-40"><SelectValue placeholder={t('settings.agentModels.followDefault')} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">{t('settings.agentModels.followDefault')}</SelectItem>
                    {providers.map((p) => <SelectItem key={p.id} value={p.id}>{p.displayName}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Input className="h-7 w-48" value={model} onChange={(e) => setDraft({ ...draft, [agentKey]: { providerId, model: e.target.value } })} placeholder={t('settings.providers.model.default.hint')} />
                <Button size="sm" variant="outline" disabled={busy === agentKey} onClick={() => save(agentKey)}>{t('common.save')}</Button>
              </div>
            </div>
          );
        })}
      </div>
      {error && <div className="mt-2 break-words text-xs text-destructive">{error}</div>}
    </div>
  );
}
```

- [ ] **Step 4: 验证**

Run: `pnpm --filter @ai-devflow/desktop typecheck && pnpm --filter @ai-devflow/desktop lint`
Expected: 通过。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/pages/Settings.tsx apps/desktop/src/i18n/zh.ts apps/desktop/src/i18n/en.ts
git commit -m "feat(desktop): 设置页新增 Agent 模型分配区与 workload 标签改善"
```

---

## Task 12: 全量验证与收尾

**Files:** 无（验证任务）。

- [ ] **Step 1: 全量 verify**

Run: `pnpm verify`
Expected: typecheck + lint + test 全通过。

- [ ] **Step 2: 桌面 e2e（若可用）**

Run: `pnpm --filter @ai-devflow/desktop e2e`
Expected: 通过（或确认无新增失败）。

- [ ] **Step 3: 手测清单**

- 任务详情对话：新消息自动滚底；上滚后悬浮「↓ N 条新消息」出现；点击恢复。
- 需求 AI 对话、任务 AI 对话：同上粘底滚动。
- 新建需求：弹窗仅 AI 两步；无可用服务商时显示空态+去配置；AI 出草稿填入确认区可编辑后创建。
- 任务弹窗：默认 AI；点「生成任务」可空消息生成；草稿逐条可编辑/删除/加行；补充说明+重新生成覆盖；一键创建全部。
- 设置页：Agent 模型分配区可为各 agent 钉选 provider+model；任务/需求对话使用对应 agent 时走指定 provider；专用 provider 禁用后回退默认。

- [ ] **Step 4: 更新 CHANGELOG（可选）**

若发版流程需要，在 `CHANGELOG.md` 顶部新增小节描述本次四项变更（由 `scripts/gen-changelog.mjs` 在发版时自动生成，通常无需手改；仅当有用户可见行为变更需提前说明时补充）。

- [ ] **Step 5: 最终提交（若有残留）**

```bash
git add -A
git commit -m "chore: 工作台对话与 Agent 模型路由收尾" || echo "nothing to commit"
```

---

## 自检（Self-Review）

- **Spec 覆盖**：①Task1-3；②Task6-11；③Task4；④Task5。四项全覆盖。
- **占位符扫描**：Task 5 Step 3 的 `<div ref={undefined}>` 已显式标注为「占位说明」并指明保留 Task 3 接入，非真实占位符；其余步骤均含完整代码。
- **类型一致性**：`AgentKey`（Task6）→ `workloadAgentKey`（Task6/9）→ `AgentModelOverride`（Task6/7/10/11）→ `agentOverrideFor`（Task8/9）签名一致；`api.agentOverrides.save` 返回 `AgentModelOverride[]`（Task10/11 消费一致）。
- **风险点**：
  - Task 4 的 `window.location.hash` 导航需确认与实际路由一致；若应用使用其他导航方式，实现时替换为正确跳转。
  - Task 8 重构 `routesFor` 提取 `collectCandidates`，需确保原有 `modelRouteFor` 测试用例（`provider-router.test.ts` 现有用例 + `real-pi.test.ts:283`）仍通过；`modelRouteFor` 逻辑保留在 `collectCandidates` 中，行为等价。
  - Task 5 重构 `AiCreateTask` 较大，需仔细保留 Task 3 的 `stick` 接入。
