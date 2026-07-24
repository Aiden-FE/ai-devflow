# AI 生成流程增强 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增强 ai-devflow 桌面端的 AI 生成需求/任务流程：流式输出、子任务删除、已有子任务上下文与跨批依赖、问答交互工具、大模态统一聊天界面。

**Architecture:** 改动集中在 chat 路径（`apps/desktop/electron/pi-ai.ts`）及其前端弹窗（`apps/desktop/src/pages/Workspace.tsx`）。后端流式化通过在 `executeTextOnRoute` 的 `message_update` 分支立即转发 `text_delta` 实现；问答工具通过为 Pi 子进程新增 IPC 通道（`stdio` 加 `'ipc'`）实现暂停-恢复；前端抽取统一 `ChatPanel` 组件承载聊天与问答卡片。

**Tech Stack:** TypeScript、React、Electron、Pi 子进程（JSON 事件流）、typebox（工具 schema）、vitest（单测）、playwright（e2e）、better-sqlite3（持久化）。

## Global Constraints

- 包管理器：pnpm workspace。根命令 `pnpm verify` = `pnpm -r typecheck && pnpm -r lint && pnpm -r test && pnpm test:scripts`。
- i18n：扁平点分 key，`apps/desktop/src/i18n/zh.ts`（默认）+ `en.ts`，新增 key 两个文件都要加。
- IPC 通道命名：`ai-devflow:${ns}:${method}`（`ipc.ts` 的 `channel` 函数）。
- 工具注册：Pi 扩展用 `pi.registerTool({ name, label, description, parameters: Type.Object(...), async execute(id, input) })`，返回 `{ content: [{type:'text',text:JSON.stringify(...)}], details }`。
- `STEP_AGENTS` 校验：`validateStepAgents()` 在模块加载期 fail-fast，新 extension 必须加入 `BUILTIN_EXTENSIONS` 池，新 tool 无需入池（由 bridge extension 注册）。
- 工具结果回传：`executeTextOnRoute` 的 `tool_execution_end` 分支捕获后经 `onToolResult(toolName, details)` 上报。

---

## File Structure

**新建：**
- `apps/desktop/src/components/ChatPanel.tsx` — 统一聊天面板组件（消息列表 + 输入行 + 问答卡片渲染槽）。
- `packages/agents/assets/profiles/shared/extensions/ask-bridge.ts` — 问答工具 `ai_devflow_ask` 扩展。
- `apps/desktop/electron/__tests__/pi-ai-streaming.test.ts` — 流式输出单测。
- `apps/desktop/electron/__tests__/ask-ipc.test.ts` — 问答 IPC 桥接单测。
- `apps/desktop/electron/__tests__/tasks-delete.test.ts` — 子任务删除 IPC 单测。
- `packages/persistence/src/__tests__/tasks-delete.test.ts` — 子任务删除守卫单测。
- `packages/agents/src/__tests__/process-supervisor-ipc.test.ts` — IPC 通道单测。

**修改：**
- `apps/desktop/electron/pi-ai.ts` — 流式化（Task 1）；问答 onMessage 桥接（Task 10）。
- `apps/desktop/src/pages/Workspace.tsx` — 子任务删除按钮（Task 5）；ChatPanel 接入（Task 3）；已有子任务上下文（Task 6）；问答卡片（Task 11）。
- `apps/desktop/src/components/ui/dialog.tsx` — 无需改（尺寸通过 className 覆盖）。
- `apps/desktop/electron/ipc.ts` — tasks.delete（Task 4）；ai:answer 反向通道（Task 10）。
- `apps/desktop/electron/preload.ts` — tasks.delete（Task 4）；ai.answer（Task 10）。
- `apps/desktop/electron/api.ts` — tasks.delete（Task 4）；AiStreamEvent 加 question（Task 10）；ai.answer（Task 10）。
- `apps/desktop/electron/main.ts` — sendAi 已存在，无需改。
- `packages/agents/src/process-supervisor.ts` — stdio 加 ipc（Task 9）。
- `packages/agents/src/profiles.ts` — BUILTIN_EXTENSIONS + STEP_AGENTS 接线（Task 12）。
- `packages/agents/assets/profiles/shared/extensions/task-bridge.ts` — dependsOn 描述（Task 6）。
- `packages/agents/assets/profiles/steps/task_proposer/SYSTEM.md` — 已有子任务说明（Task 6）；问答工具说明（Task 12）。
- `packages/agents/assets/profiles/steps/requirement_refiner/SYSTEM.md` — 问答工具说明（Task 12）。
- `apps/desktop/src/i18n/zh.ts` + `en.ts` — 新 key（各 Task 内）。
- `apps/desktop/electron/ipc.ts` — createBatch 跨批依赖（Task 7）。

---

### Task 1: AI 流式输出（需求 2）

**Files:**
- Modify: `apps/desktop/electron/pi-ai.ts`（`executeTextOnRoute` 的 `message_update` 分支约 342-351 行；末尾 flush 约 431 行）
- Test: `apps/desktop/electron/__tests__/pi-ai-streaming.test.ts`（新建）

**Interfaces:**
- Consumes: `executeTextOnRoute` 现有签名（不变）。
- Produces: `onDelta` 在收到每个 `text_delta` 时立即调用（而非末尾一次性 flush）。

- [ ] **Step 1: 写流式单测**

`apps/desktop/electron/__tests__/pi-ai-streaming.test.ts`：
```ts
import { describe, it, expect, vi } from 'vitest';

// 验证 executeTextOnRoute 在收到 message_update(text_delta) 时立即调用 onDelta，
// 而非缓冲到进程结束。通过 mock supervisor 逐行产出事件来断言调用时机。
describe('executeTextOnRoute streaming', () => {
  it('立即转发 text_delta，不缓冲到末尾', async () => {
    const onDelta = vi.fn();
    const deltas: string[] = [];
    // 构造 Pi stdout 事件序列：两个 text_delta + agent_end
    const events = [
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '你好' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '世界' } },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '你好世界' }] } },
      { type: 'agent_end' },
    ];
    const lines = events.map((e) => ({ stream: 'stdout' as const, text: JSON.stringify(e) }));
    const mockSpawned = {
      lines: (async function* () { for (const l of lines) yield l; })(),
      done: async () => ({ exitCode: 0, signal: null }),
      cancel: async () => {},
      pid: 12345,
    };
    const mockSupervisor = { spawn: () => mockSpawned };
    const { executeTextOnRoute } = await import('../pi-ai.js');
    // executeTextOnRoute 需要 route + deps；用最小桩。
    const route = { providerName: 'p', model: 'm', thinking: 'off', secret: 's' } as any;
    const deps = { supervisor: mockSupervisor, locator: {}, router: {} } as any;
    await executeTextOnRoute(route, [{ role: 'user', content: 'hi' }], onDelta, deps, 'task_chat' as any);
    // 断言：onDelta 被调用 2 次，且参数按序
    expect(onDelta).toHaveBeenCalledTimes(2);
    expect(onDelta).toHaveBeenNthCalledWith(1, '你好');
    expect(onDelta).toHaveBeenNthCalledWith(2, '世界');
  });

  it('不转发 thinking_delta（思维链抑制）', async () => {
    const onDelta = vi.fn();
    const events = [
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '内部思考' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '正文' } },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '正文' }] } },
      { type: 'agent_end' },
    ];
    const lines = events.map((e) => ({ stream: 'stdout' as const, text: JSON.stringify(e) }));
    const mockSpawned = {
      lines: (async function* () { for (const l of lines) yield l; })(),
      done: async () => ({ exitCode: 0, signal: null }),
      cancel: async () => {},
      pid: 12345,
    };
    const mockSupervisor = { spawn: () => mockSpawned };
    const { executeTextOnRoute } = await import('../pi-ai.js');
    const route = { providerName: 'p', model: 'm', thinking: 'off', secret: 's' } as any;
    const deps = { supervisor: mockSupervisor, locator: {}, router: {} } as any;
    await executeTextOnRoute(route, [{ role: 'user', content: 'hi' }], onDelta, deps, 'task_chat' as any);
    expect(onDelta).toHaveBeenCalledTimes(1);
    expect(onDelta).toHaveBeenCalledWith('正文');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ai-devflow/desktop test -- pi-ai-streaming`
Expected: FAIL（当前实现缓冲到末尾，onDelta 调用时机/次数不符）

- [ ] **Step 3: 改 message_update 分支为立即转发 + text_delta 守卫**

修改 `apps/desktop/electron/pi-ai.ts` 的 `executeTextOnRoute`。找到约 342-351 行的 `message_update` 分支：

改前：
```ts
        if (event.type === 'message_update') {
          // Pi 的文本增量在 assistantMessageEvent.delta（text_delta 事件）；顶层无 delta/text 字段。
          // 早期实现误读 event.delta，导致任何能正常返回的提供商都被判为「未收到任何文本输出」。
          const ame = event.assistantMessageEvent;
          const delta = typeof ame?.delta === 'string' ? ame.delta : '';
          if (delta) {
            full += delta;
            deltas.push(delta);
          }
        } else if (event.type === 'agent_end') {
```

改后：
```ts
        if (event.type === 'message_update') {
          // 流式输出：仅转发 text_delta（正文增量），丢弃 thinking_delta（思维链抑制）。
          // 早期实现缓冲到末尾才 flush，体验差；改为立即转发。
          const ame = event.assistantMessageEvent;
          if (ame?.type === 'text_delta') {
            const delta = typeof ame.delta === 'string' ? ame.delta : '';
            if (delta) {
              full += delta;
              onDelta?.(delta);
            }
          }
        } else if (event.type === 'agent_end') {
```

- [ ] **Step 4: 删除 deltas 缓冲声明与末尾 flush**

在 `executeTextOnRoute` 函数体内，删除 `const deltas: string[] = [];` 声明（约 335 行附近）。

删除末尾约 431 行的 flush 循环：

改前：
```ts
  for (const delta of deltas) onDelta?.(delta);
  return full;
}
```

改后：
```ts
  return full;
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @ai-devflow/desktop test -- pi-ai-streaming`
Expected: PASS

- [ ] **Step 6: 前端 catch 标注中断消息**

修改 `apps/desktop/src/pages/Workspace.tsx` 的 `AiRefineRequirement`（约 445-448 行）与 `AiCreateTask`（约 587-590 行）的 catch 分支。

`AiRefineRequirement` catch 改前：
```ts
    } catch (e) {
      setError((e as Error).message);
      setMessages((prev) => prev.filter((m) => !(m.role === 'assistant' && m.content === '')));
    } finally { setStreaming(false); }
```

改后：
```ts
    } catch (e) {
      setError((e as Error).message);
      // 流式后错误前已发 delta 会让 assistant 消息非空；标注中断而非删除，避免残留半截无标注文本。
      setMessages((prev) => prev.map((m) =>
        m.role === 'assistant' && m.content === ''
          ? null
          : m,
      ).filter(Boolean) as { role: 'user' | 'assistant'; content: string }[]);
      setMessages((prev) => prev.map((m, i) =>
        i === prev.length - 1 && m.role === 'assistant' && m.content
          ? { ...m, content: `${m.content}\n\n（生成中断）` }
          : m,
      ));
    } finally { setStreaming(false); }
```

`AiCreateTask` catch（约 587-590 行）改后：
```ts
    } catch (e) {
      setError((e as Error).message);
      setMessages((prev) => prev.filter((m) => !(m.role === 'assistant' && m.content === '')));
      setMessages((prev) => prev.map((m, i) =>
        i === prev.length - 1 && m.role === 'assistant' && m.content
          ? { ...m, content: `${m.content}\n\n（生成中断）` }
          : m,
      ));
    } finally { setStreaming(false); }
```

- [ ] **Step 7: 加 i18n key**

`apps/desktop/src/i18n/zh.ts` 末尾 `task.ai` 块加：
```ts
  'task.ai.interrupted': '（生成中断）',
```
`en.ts` 对应位置加：
```ts
  'task.ai.interrupted': '(generation interrupted)',
```

然后回退 Step 6 的硬编码文案：把 `AiRefineRequirement` 与 `AiCreateTask` catch 里的 `\n\n（生成中断）` 改为 `\n\n${t('task.ai.interrupted')}`。

- [ ] **Step 8: typecheck + 提交**

Run: `pnpm --filter @ai-devflow/desktop typecheck`
Expected: 无错误

```bash
git add apps/desktop/electron/pi-ai.ts apps/desktop/electron/__tests__/pi-ai-streaming.test.ts apps/desktop/src/pages/Workspace.tsx apps/desktop/src/i18n/zh.ts apps/desktop/src/i18n/en.ts
git commit -m "feat(desktop): AI 对话流式输出（立即转发 text_delta + 思维链抑制）"
```

---

### Task 2: 统一 ChatPanel 组件（需求 5 前半）

**Files:**
- Create: `apps/desktop/src/components/ChatPanel.tsx`
- Test: `apps/desktop/src/components/__tests__/ChatPanel.test.tsx`（新建）

**Interfaces:**
- Consumes: `useStickToBottom`（`../hooks/useStickToBottom.js`）、`NewMessagesButton`（`./NewMessagesButton.js`）、`Button`/`Input`（ui 组件）、`useT`（i18n）。
- Produces: `<ChatPanel messages onSend loading placeholder error renderMessage? />`，`ChatPanelMessage` 类型。

- [ ] **Step 1: 定义 ChatPanelMessage 类型与组件 props**

`apps/desktop/src/components/ChatPanel.tsx`：
```tsx
import React from 'react';
import { useStickToBottom } from '../hooks/useStickToBottom.js';
import { NewMessagesButton } from './NewMessagesButton.js';
import { Button } from './ui/button.js';
import { Input } from './ui/input.js';
import { useT } from '../i18n/index.js';

/** ChatPanel 消息类型：普通文本消息 + 可扩展的特殊消息（如问答卡片）。 */
export type ChatPanelMessage =
  | { id: string; role: 'user' | 'assistant'; content: string }
  | { id: string; role: 'assistant'; kind: 'question'; content: string };

export interface ChatPanelProps {
  messages: ChatPanelMessage[];
  onSend: (text: string) => void;
  loading: boolean;
  placeholder: string;
  thinkingLabel: string;
  sendLabel: string;
  error?: string;
  /** 自定义消息渲染（如问答卡片）；返回 null 则用默认气泡。 */
  renderMessage?: (msg: ChatPanelMessage, index: number) => React.ReactNode | null;
}

export function ChatPanel({ messages, onSend, loading, placeholder, thinkingLabel, sendLabel, error, renderMessage }: ChatPanelProps): React.ReactElement {
  const t = useT();
  const [input, setInput] = React.useState('');
  const stick = useStickToBottom([messages]);

  const send = () => {
    if (!input.trim() || loading) return;
    onSend(input.trim());
    setInput('');
  };

  return (
    <div className="flex flex-col gap-2">
      <div ref={stick.containerRef} className="relative flex-1 min-h-[280px] max-h-[60vh] overflow-y-auto rounded-md border border-border bg-background p-2 text-xs scrollbar-thin">
        <NewMessagesButton count={stick.paused ? stick.unreadCount : 0} onResume={stick.resume} />
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">{placeholder}</div>
        ) : messages.map((m, i) => {
          const custom = renderMessage?.(m, i);
          if (custom !== undefined && custom !== null) return <div key={m.id} className="mb-2">{custom}</div>;
          return (
            <div key={m.id} className={`mb-2 ${m.role === 'user' ? 'text-right' : ''}`}>
              <span className={`inline-block max-w-[85%] whitespace-pre-wrap break-words rounded-md px-2 py-1 ${m.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-secondary'}`}>
                {m.content || thinkingLabel}
              </span>
            </div>
          );
        })}
      </div>
      {error && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}
      <div className="flex gap-2">
        <Input className="flex-1" value={input} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder={placeholder} disabled={loading} />
        <Button size="sm" onClick={send} disabled={loading || !input.trim()}>{sendLabel}</Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 写组件单测**

`apps/desktop/src/components/__tests__/ChatPanel.test.tsx`：
```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatPanel, ChatPanelMessage } from '../ChatPanel.js';

// 桩 useT 与 hooks/ui（假设项目已有 testing setup；若无从项目现有组件测试复制 setup）
vi.mock('../../i18n/index.js', () => ({ useT: () => (k: string) => k }));

describe('ChatPanel', () => {
  it('空消息时显示 placeholder', () => {
    render(<ChatPanel messages={[]} onSend={() => {}} loading={false} placeholder="说点什么" thinkingLabel="思考中" sendLabel="发送" />);
    expect(screen.getByText('说点什么')).toBeTruthy();
  });

  it('输入并点发送调用 onSend', () => {
    const onSend = vi.fn();
    render(<ChatPanel messages={[]} onSend={onSend} loading={false} placeholder="p" thinkingLabel="t" sendLabel="发送" />);
    const input = screen.getByPlaceholderText('p') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '你好' } });
    fireEvent.click(screen.getByText('发送'));
    expect(onSend).toHaveBeenCalledWith('你好');
  });

  it('renderMessage 覆盖默认气泡', () => {
    const messages: ChatPanelMessage[] = [{ id: '1', role: 'assistant', kind: 'question', content: '问' }];
    render(<ChatPanel messages={messages} onSend={() => {}} loading={false} placeholder="p" thinkingLabel="t" sendLabel="发送"
      renderMessage={() => <div data-testid="custom">自定义卡片</div>} />);
    expect(screen.getByTestId('custom')).toBeTruthy();
  });
});
```

- [ ] **Step 3: 运行测试确认通过（若项目无 RTL setup 则跳过组件测试，仅 typecheck）**

Run: `pnpm --filter @ai-devflow/desktop test -- ChatPanel`
Expected: PASS（若 RTL 未配置，确认 `@testing-library/react` 是否已装；若未装，删除测试文件，改为仅 typecheck）

```bash
git add apps/desktop/src/components/ChatPanel.tsx apps/desktop/src/components/__tests__/ChatPanel.test.tsx
git commit -m "feat(desktop): 抽取统一 ChatPanel 组件"
```

---

### Task 3: 大模态 + 两个弹窗接入 ChatPanel（需求 5 后半）

**Files:**
- Modify: `apps/desktop/src/pages/Workspace.tsx`（`AiRefineRequirement` 约 420-474 行；`AiCreateTask` 约 550-692 行；`CreateReqButton` Dialog 约 374-415 行；`CreateTaskModal` Dialog 约 485-496 行）

**Interfaces:**
- Consumes: `ChatPanel`（Task 2）。
- Produces: 两个弹窗使用大尺寸 + ChatPanel；消息状态改为 `ChatPanelMessage[]`。

- [ ] **Step 1: 改两处 DialogContent 尺寸**

`CreateReqButton` 的 Dialog（约 375 行）：
改前：`<DialogContent className="max-w-lg">`
改后：`<DialogContent className="max-w-[min(1100px,92vw)] w-[92vw] h-[88vh] max-h-[88vh] flex flex-col gap-4 overflow-hidden">`

`CreateTaskModal` 的 Dialog（约 486 行）：
改前：`<DialogContent className="max-w-lg">`
改后：`<DialogContent className="max-w-[min(1100px,92vw)] w-[92vw] h-[88vh] max-h-[88vh] flex flex-col gap-4 overflow-hidden">`

- [ ] **Step 2: AiRefineRequirement 接入 ChatPanel**

改前（约 420-474 行完整替换）：
```tsx
function AiRefineRequirement({ onApplied }: { onApplied: (p: { title: string; description: string; acceptance: string; priority: 'low' | 'medium' | 'high' }) => void }): React.ReactElement {
  const t = useT();
  const [messages, setMessages] = useState<{ role: 'user' | 'assistant'; content: string }[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const stick = useStickToBottom([messages]);

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
      }, {
        mode: 'requirement',
        onRequirementProposal: (draft) => onApplied(draft),
      });
    } catch (e) {
      setError((e as Error).message);
      setMessages((prev) => prev.filter((m) => !(m.role === 'assistant' && m.content === '')));
    } finally { setStreaming(false); }
  };

  return (
    <div className="mt-1 flex flex-col gap-3">
      <div ref={stick.containerRef} className="relative h-48 overflow-y-auto rounded-md border border-border bg-background p-2 text-xs scrollbar-thin">
        <NewMessagesButton count={stick.paused ? stick.unreadCount : 0} onResume={stick.resume} />
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">{t('req.ai.placeholder')}</div>
        ) : messages.map((m, i) => (
          <div key={i} className={`mb-2 ${m.role === 'user' ? 'text-right' : ''}`}>
            <span className={`inline-block max-w-[85%] rounded-md px-2 py-1 ${m.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-secondary'}`}>
              {m.content || t('req.ai.thinking')}
            </span>
          </div>
        ))}
      </div>
      {error && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}
      <div className="flex gap-2">
        <Input className="flex-1" value={input} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder={t('req.ai.placeholder')} disabled={streaming} />
        <Button size="sm" onClick={send} disabled={streaming || !input.trim()}>{t('task.ai.send')}</Button>
      </div>
    </div>
  );
}
```

改后（用 ChatPanel；保留流式错误标注逻辑）：
```tsx
function AiRefineRequirement({ onApplied }: { onApplied: (p: { title: string; description: string; acceptance: string; priority: 'low' | 'medium' | 'high' }) => void }): React.ReactElement {
  const t = useT();
  const [messages, setMessages] = useState<ChatPanelMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const send = async (text: string) => {
    if (streaming) return;
    const userMsg: ChatPanelMessage = { id: `u-${Date.now()}`, role: 'user', content: text };
    const next = [...messages, userMsg];
    setMessages(next); setStreaming(true); setError(undefined);
    let assistant = '';
    setMessages([...next, { id: `a-${Date.now()}`, role: 'assistant', content: '' }]);
    try {
      assistant = await api.ai.chat(next.map((m) => ({ role: m.role, content: m.content })), (delta) => {
        assistant += delta;
        setMessages((prev) => prev.map((m, i) =>
          i === prev.length - 1 && m.role === 'assistant' ? { ...m, content: assistant } : m,
        ));
      }, {
        mode: 'requirement',
        onRequirementProposal: (draft) => onApplied(draft),
      });
    } catch (e) {
      setError((e as Error).message);
      setMessages((prev) => prev.filter((m) => !(m.role === 'assistant' && m.content === '')));
      setMessages((prev) => prev.map((m, i) =>
        i === prev.length - 1 && m.role === 'assistant' && m.content
          ? { ...m, content: `${m.content}\n\n${t('task.ai.interrupted')}` }
          : m,
      ));
    } finally { setStreaming(false); }
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <ChatPanel
        messages={messages}
        onSend={send}
        loading={streaming}
        placeholder={t('req.ai.placeholder')}
        thinkingLabel={t('req.ai.thinking')}
        sendLabel={t('task.ai.send')}
        error={error}
      />
    </div>
  );
}
```

- [ ] **Step 3: AiCreateTask 接入 ChatPanel**

`AiCreateTask`（约 550-692 行）替换消息列表与输入行为 ChatPanel，保留草稿编辑区。改 `send` 签名与 `messages` 类型：

改前 `send`（约 567-591 行）与消息列表 JSX（约 627-645 行）。

改后完整 `AiCreateTask`：
```tsx
function AiCreateTask({ requirementId, requirement, projectPath, onCreated }: { requirementId: string; requirement?: Requirement; projectPath?: string; onCreated: (taskId: string) => void }): React.ReactElement {
  const t = useT();
  const [messages, setMessages] = useState<ChatPanelMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [proposals, setProposals] = useState<AiTaskProposal[] | undefined>();
  const [creating, setCreating] = useState(false);

  const context = requirement
    ? `【当前需求】\n标题：${requirement.title}\n描述：${requirement.description || '(无)'}\n验收标准：${requirement.acceptance || '(无)'}`
    : undefined;

  const send = async (text: string) => {
    if (streaming) return;
    const userMsg: ChatPanelMessage = { id: `u-${Date.now()}`, role: 'user', content: text };
    const next = [...messages, userMsg];
    setMessages(next); setStreaming(true); setError(undefined);
    let assistant = '';
    setMessages([...next, { id: `a-${Date.now()}`, role: 'assistant', content: '' }]);
    try {
      assistant = await api.ai.chat(next.map((m) => ({ role: m.role, content: m.content })), (delta) => {
        assistant += delta;
        setMessages((prev) => prev.map((m, i) =>
          i === prev.length - 1 && m.role === 'assistant' ? { ...m, content: assistant } : m,
        ));
      }, {
        mode: 'task_proposal',
        context,
        projectPath,
        onTaskProposal: (tasks) => setProposals(tasks.map((x) => ({ draftId: x.draftId, title: x.title, description: x.description, role: x.role, dependsOn: x.dependsOn })) as AiTaskProposal[]),
      });
      if (!assistant.trim()) {
        setMessages((prev) => prev.filter((m) => !(m.role === 'assistant' && m.content === '')));
      }
    } catch (e) {
      setError((e as Error).message);
      setMessages((prev) => prev.filter((m) => !(m.role === 'assistant' && m.content === '')));
      setMessages((prev) => prev.map((m, i) =>
        i === prev.length - 1 && m.role === 'assistant' && m.content
          ? { ...m, content: `${m.content}\n\n${t('task.ai.interrupted')}` }
          : m,
      ));
    } finally { setStreaming(false); }
  };

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

  return (
    <div className="flex flex-col gap-3 flex-1 min-h-0">
      {requirement && (
        <div className="rounded-md border border-border bg-secondary/40 p-2 text-xs">
          <span className="text-muted-foreground">{t('detail.linkage.req')}：</span>{requirement.title}
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <ChatPanel
          messages={messages}
          onSend={send}
          loading={streaming}
          placeholder={t('task.ai.placeholder')}
          thinkingLabel={t('task.ai.thinking')}
          sendLabel={t('task.ai.send')}
          error={error}
        />
      </div>
      {proposals && proposals.length > 0 && (
        <div className="flex flex-col gap-2 max-h-[40vh] overflow-y-auto">
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
                <Button size="sm" variant="ghost" onClick={() => deleteDraft(p.draftId)}>{t('task.ai.deleteDraft')}</Button>
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

- [ ] **Step 4: 补 import + typecheck**

`Workspace.tsx` 顶部 import 加：
```ts
import { ChatPanel, type ChatPanelMessage } from '../components/ChatPanel.js';
```

Run: `pnpm --filter @ai-devflow/desktop typecheck`
Expected: 无错误（若 `useStickToBottom`/`NewMessagesButton` 在 Workspace 不再直接使用，移除其 import 以避免 lint unused 警告——检查是否还有其他用处，ReqItem 不用，TaskDetail 可能用，但 TaskDetail 是独立文件。Workspace.tsx 内若不再用则移除）

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/pages/Workspace.tsx
git commit -m "feat(desktop): AI 弹窗放大并统一使用 ChatPanel"
```

---

### Task 4: 子任务删除后端（需求 1 后端）

**Files:**
- Modify: `apps/desktop/electron/ipc.ts`（tasks 命名空间，约 343 行后新增）、`apps/desktop/electron/preload.ts`（tasks 对象）、`apps/desktop/electron/api.ts`（DesktopApi.tasks）
- Test: `apps/desktop/electron/__tests__/tasks-delete.test.ts`（新建）

**Interfaces:**
- Consumes: `repos.tasks.delete`（已存在）、`repos.tasks.listByRequirement`（已存在）。
- Produces: `api.tasks.delete(id): Promise<{ ok: true } | { ok: false; blockedBy: { id: string; title: string }[] }>`。

- [ ] **Step 1: 写删除守卫单测**

`apps/desktop/electron/__tests__/tasks-delete.test.ts`：
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from 'better-sqlite3';
import { createRepos } from '@ai-devflow/persistence';

describe('tasks delete with dependency guard', () => {
  let db: Database;
  let repos: ReturnType<typeof createRepos>;
  beforeEach(() => {
    db = new Database(':memory:');
    repos = createRepos(db);
    // 建 project + iteration + requirement + 两个任务（B 依赖 A）
    repos.projects.insert({ id: 'p1', name: 'P', path: '/p', createdAt: 0, updatedAt: 0 });
    repos.iterations.insert({ id: 'it1', projectId: 'p1', name: 'I', active: true, createdAt: 0, updatedAt: 0 });
    repos.requirements.insert({ id: 'r1', iterationId: 'it1', title: 'R', description: '', acceptance: '', priority: 'medium', archived: false, createdAt: 0, updatedAt: 0 });
    repos.tasks.insert({ id: 'A', requirementId: 'r1', iterationId: 'it1', projectId: 'p1', title: 'A', description: '', status: 'ready', role: 'coder', stages: [], currentStage: 0, statusChangedAt: 0, createdAt: 0, updatedAt: 0, retryCount: 0, dependsOn: [] });
    repos.tasks.insert({ id: 'B', requirementId: 'r1', iterationId: 'it1', projectId: 'p1', title: 'B', description: '', status: 'ready', role: 'coder', stages: [], currentStage: 0, statusChangedAt: 0, createdAt: 0, updatedAt: 0, retryCount: 0, dependsOn: ['A'] });
  });

  it('被依赖时拒绝删除并返回阻塞列表', () => {
    const siblings = repos.tasks.listByRequirement('r1');
    const blockers = siblings.filter((t) => (t.dependsOn ?? []).includes('A'));
    expect(blockers.map((b) => b.id)).toEqual(['B']);
    // 不执行删除
    expect(repos.tasks.get('A')).toBeDefined();
  });

  it('无依赖时删除成功', () => {
    const siblings = repos.tasks.listByRequirement('r1');
    const blockers = siblings.filter((t) => (t.dependsOn ?? []).includes('B'));
    expect(blockers).toEqual([]);
    repos.tasks.delete('B');
    expect(repos.tasks.get('B')).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试确认通过**

Run: `pnpm --filter @ai-devflow/desktop test -- tasks-delete`
Expected: PASS（仓库层 delete 与 listByRequirement 已存在）

- [ ] **Step 3: 加 IPC handler**

`apps/desktop/electron/ipc.ts`，在 `tasks:interactions` handler（约 343 行）后新增：
```ts
  // 子任务删除（硬删除 + 依赖守卫）：被同需求下其它任务的 dependsOn 引用时拒绝删除。
  ipcMain.handle(channel('tasks', 'delete'), (_e, id: string): { ok: true } | { ok: false; blockedBy: { id: string; title: string }[] } => {
    const task = repos.tasks.get(id);
    if (!task) throw new Error('任务不存在');
    const siblings = repos.tasks.listByRequirement(task.requirementId);
    const blockers = siblings.filter((t) => t.id !== id && (t.dependsOn ?? []).includes(id));
    if (blockers.length > 0) {
      return { ok: false, blockedBy: blockers.map((b) => ({ id: b.id, title: b.title })) };
    }
    repos.tasks.delete(id);
    return { ok: true };
  });
```

- [ ] **Step 4: 加 api 契约**

`apps/desktop/electron/api.ts` 的 `DesktopApi.tasks` 命名空间，在 `interactions` 后加：
```ts
    /** 删除子任务（硬删除）；被其它任务 dependsOn 引用时拒绝并返回阻塞列表。 */
    delete(id: string): Promise<{ ok: true } | { ok: false; blockedBy: { id: string; title: string }[] }>;
```

- [ ] **Step 5: 加 preload 暴露**

`apps/desktop/electron/preload.ts` 的 `tasks` 对象，在 `interactions` 后加：
```ts
    delete: (id) => invoke('tasks', 'delete')(id),
```

- [ ] **Step 6: typecheck + 提交**

Run: `pnpm --filter @ai-devflow/desktop typecheck`
Expected: 无错误

```bash
git add apps/desktop/electron/ipc.ts apps/desktop/electron/preload.ts apps/desktop/electron/api.ts apps/desktop/electron/__tests__/tasks-delete.test.ts
git commit -m "feat(desktop): 子任务删除后端（硬删除+依赖守卫）"
```

---

### Task 5: 子任务删除前端（需求 1 前端）

**Files:**
- Modify: `apps/desktop/src/pages/Workspace.tsx`（`ReqItem` 子任务列表约 299-304 行）、`apps/desktop/src/i18n/zh.ts` + `en.ts`

- [ ] **Step 1: 加 i18n key**

`zh.ts` 的 `ws.subtasks` 块加：
```ts
  'ws.subtasks.delete': '删除',
  'ws.subtasks.delete.confirm': '确定删除子任务「{title}」？',
  'ws.subtasks.delete.blocked': '无法删除：被以下任务依赖：{titles}',
```
`en.ts` 对应加：
```ts
  'ws.subtasks.delete': 'Delete',
  'ws.subtasks.delete.confirm': 'Delete subtask "{title}"?',
  'ws.subtasks.delete.blocked': 'Cannot delete: depended on by: {titles}',
```

- [ ] **Step 2: ReqItem 子任务行加删除按钮与逻辑**

`Workspace.tsx` 的 `ReqItem` 组件内，找到子任务渲染块（约 299-304 行）：

改前：
```tsx
              {view.items.map((s) => (
                <div key={s.id} data-testid="req-subtask-title" className="flex items-center gap-2 text-xs">
                  <StatusBadge status={s.status} />
                  <span className="truncate">{s.title}</span>
                </div>
              ))}
```

改后（加 hover 删除按钮 + 守卫提示）：
```tsx
              {view.items.map((s) => (
                <div key={s.id} data-testid="req-subtask-title" className="group flex items-center gap-2 text-xs">
                  <StatusBadge status={s.status} />
                  <span className="flex-1 truncate">{s.title}</span>
                  <Button
                    size="sm" variant="ghost" className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100"
                    onClick={async () => {
                      if (!confirm(t('ws.subtasks.delete.confirm', { title: s.title }))) return;
                      const res = await api.tasks.delete(s.id);
                      if (!res.ok) {
                        setError(t('ws.subtasks.delete.blocked', { titles: res.blockedBy.map((b) => b.title).join('、') }));
                      } else {
                        onArchived();
                      }
                    }}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))}
```

`ReqItem` 顶部 import 补 `Trash2`（lucide-react）。在 `Workspace.tsx` 顶部 lucide import 行（约 23 行）加 `Trash2`：

改前：
```ts
import { Plus, MessageSquarePlus, Archive, AlertCircle, Maximize2, Minimize2, ChevronDown, ChevronRight, FolderOpen } from 'lucide-react';
```
改后：
```ts
import { Plus, MessageSquarePlus, Archive, AlertCircle, Maximize2, Minimize2, ChevronDown, ChevronRight, FolderOpen, Trash2 } from 'lucide-react';
```

`ReqItem` 需要确认 `setError` 与 `onArchived` 在作用域内（现有代码已有 `setError` 与 `onArchived`，`onArchived` 触发父级刷新）。

- [ ] **Step 3: typecheck + 手动验证**

Run: `pnpm --filter @ai-devflow/desktop typecheck`
Expected: 无错误

```bash
git add apps/desktop/src/pages/Workspace.tsx apps/desktop/src/i18n/zh.ts apps/desktop/src/i18n/en.ts
git commit -m "feat(desktop): 子任务列表删除按钮（依赖守卫提示）"
```

---

### Task 6: 已有子任务上下文 + schema/SYSTEM 更新（需求 3）

**Files:**
- Modify: `apps/desktop/src/pages/Workspace.tsx`（`AiCreateTask` 的 context 约 561-563 行）、`packages/agents/assets/profiles/shared/extensions/task-bridge.ts`（dependsOn 描述）、`packages/agents/assets/profiles/steps/task_proposer/SYSTEM.md`

**Interfaces:**
- Consumes: `api.tasks.listByRequirement`（已存在）。
- Produces: context 字符串含已有子任务清单；task-bridge schema dependsOn 描述更新。

- [ ] **Step 1: AiCreateTask 拼装已有子任务上下文**

`AiCreateTask` 需要拿到已有子任务。组件 props 已有 `requirementId`。用 `useAsync` 或在组件内 `useState` + `useEffect` 加载。

`AiCreateTask` 函数内，在 `context` 定义前（约 560 行）加：
```tsx
  const [existingTasks, setExistingTasks] = useState<Task[]>([]);
  useEffect(() => {
    if (!requirementId) return;
    api.tasks.listByRequirement(requirementId).then(setExistingTasks).catch(() => {});
  }, [requirementId]);
```

（确保 `useEffect` 已 import；`Workspace.tsx` 顶部 React import 改为 `import React, { useEffect, useMemo, useState } from 'react';`）

改 `context` 定义（约 561-563 行）：

改前：
```tsx
  const context = requirement
    ? `【当前需求】\n标题：${requirement.title}\n描述：${requirement.description || '(无)'}\n验收标准：${requirement.acceptance || '(无)'}`
    : undefined;
```

改后：
```tsx
  const existingBlock = existingTasks.length > 0
    ? `\n\n【已有子任务】（请勿重复创建，新任务可依赖这些任务，依赖时用其 taskId）\n${existingTasks.map((t) => `- [${t.id}] 「${t.title}」 状态:${t.status} 依赖:[${(t.dependsOn ?? []).join(',')}]`).join('\n')}`
    : '';
  const context = requirement
    ? `【当前需求】\n标题：${requirement.title}\n描述：${requirement.description || '(无)'}\n验收标准：${requirement.acceptance || '(无)'}${existingBlock}`
    : existingBlock || undefined;
```

- [ ] **Step 2: 更新 task-bridge.ts 的 dependsOn 描述**

`packages/agents/assets/profiles/shared/extensions/task-bridge.ts`（约 34-36 行）：

改前：
```ts
            dependsOn: Type.Array(Type.String(), {
              description: "依赖的其它 draftId 列表；无依赖则为空数组",
            }),
```

改后：
```ts
            dependsOn: Type.Array(Type.String(), {
              description: "依赖的任务标识列表；可引用同批次 draftId 或已有任务 taskId（形如 T-xxx）。无依赖则为空数组",
            }),
```

- [ ] **Step 3: 更新 task_proposer SYSTEM.md**

`packages/agents/assets/profiles/steps/task_proposer/SYSTEM.md`，在"### 4. 方案确定后再产出子任务"段（约 23 行）后插入已有子任务说明，并更新依赖约束段。

在"### 4. 方案确定后再产出子任务"段的末尾（约 32 行 `- 不要编造需求或代码中不存在的功能；不确定时给出最保守的拆分。`）后加：
```markdown

  ### 已有子任务（重要）
  - 上下文中可能包含【已有子任务】清单（带 taskId、标题、状态、依赖）。这些是需求下已存在的任务。
  - 不得重复创建已存在的任务；只在它们之外补充缺失的子任务。
  - 新任务的 `dependsOn` 可引用已有任务的 taskId（形如 T-xxx），以建立跨批次依赖，避免丢失依赖链路。
```

更新"## 依赖约束"段（约 41-42 行）：

改前：
```markdown
## 依赖约束
- `dependsOn` 不得自引用、不得成环、引用的 `draftId` 必须在本批任务中存在。
```

改后：
```markdown
## 依赖约束
- `dependsOn` 不得自引用、不得成环。
- `dependsOn` 可引用同批次 draftId 或已有任务 taskId（见上下文【已有子任务】清单）。
- 引用不存在的标识会被过滤（不会报错，但依赖关系会丢失），请确保引用准确。
```

- [ ] **Step 4: typecheck + 提交**

Run: `pnpm --filter @ai-devflow/desktop typecheck && pnpm --filter @ai-devflow/agents typecheck`
Expected: 无错误

```bash
git add apps/desktop/src/pages/Workspace.tsx packages/agents/assets/profiles/shared/extensions/task-bridge.ts packages/agents/assets/profiles/steps/task_proposer/SYSTEM.md
git commit -m "feat(agents): task_proposer 传入已有子任务上下文并支持跨批依赖"
```

---

### Task 7: createBatch 跨批依赖映射（需求 3 后端）

**Files:**
- Modify: `apps/desktop/electron/ipc.ts`（`tasks:createBatch` 约 233-272 行）

**Interfaces:**
- Consumes: `repos.tasks.listByRequirement`（已存在）。
- Produces: createBatch 的 dependsOn 同时接受同批 draftId 与已有 taskId。

- [ ] **Step 1: 改 createBatch 映射逻辑**

`apps/desktop/electron/ipc.ts` 的 `createBatch` handler（约 233-272 行）：

改前（约 243-250 行）：
```ts
    const draftToId = new Map<string, string>();
    const created: Task[] = [];
    for (const p of ordered) {
      const id = randomId();
      draftToId.set(p.draftId, id);
      const dependsOn = (p.dependsOn ?? [])
        .map((d) => draftToId.get(d))
        .filter((x): x is string => !!x);
```

改后（加已有 taskId 集合，映射时优先匹配已有 taskId，再匹配同批 draftId）：
```ts
    // 已有子任务 taskId 集合：跨批依赖允许引用它们。
    const existing = repos.tasks.listByRequirement(input.requirementId);
    const existingIds = new Set(existing.map((t) => t.id));
    const draftToId = new Map<string, string>();
    const created: Task[] = [];
    for (const p of ordered) {
      const id = randomId();
      draftToId.set(p.draftId, id);
      const dependsOn = (p.dependsOn ?? [])
        .map((d) => {
          if (existingIds.has(d)) return d;          // 已有 taskId：原样保留
          return draftToId.get(d);                    // 同批 draftId：映射为真实 taskId
        })
        .filter((x): x is string => !!x);
```

- [ ] **Step 2: 更新 AiTaskProposal 注释**

`packages/core/src/types.ts` 的 `AiTaskProposal`（约 264-265 行）：

改前：
```ts
    /** 依赖的其它草稿 draftId 列表（DAG；无依赖则保持并行）。 */
    dependsOn?: string[];
```

改后：
```ts
    /** 依赖的任务标识列表（DAG；无依赖则保持并行）。可引用同批 draftId 或已有任务 taskId。 */
    dependsOn?: string[];
```

- [ ] **Step 3: validateProposalDag 兼容已有 taskId**

检查 `packages/core/src` 里 `validateProposalDag`：它校验 dependsOn 引用的 draftId 必须在本批存在。跨批依赖会引用已有 taskId（不在本批），需放宽校验。

读 `packages/core/src/types.ts` 或同目录的 DAG 校验函数。若 `validateProposalDag` 对引用不存在的 draftId 报错，改为"仅校验无环与无自引用，不强制引用必须在本批存在"（已有 taskId 合法性由 createBatch 的 existingIds 判断）。

具体：找到 `validateProposalDag` 函数，删除或放宽"引用的 draftId 必须在本批存在"的校验分支（保留无环、无自引用校验）。

- [ ] **Step 4: typecheck + 提交**

Run: `pnpm verify:unit`
Expected: 无错误

```bash
git add apps/desktop/electron/ipc.ts packages/core/src/types.ts
git commit -m "feat(desktop): createBatch 支持跨批依赖（dependsOn 引用已有 taskId）"
```

---

### Task 8: 问答工具 ask-bridge 扩展（需求 4 工具层）

**Files:**
- Create: `packages/agents/assets/profiles/shared/extensions/ask-bridge.ts`

**Interfaces:**
- Consumes: `ExtensionAPI`（`@earendil-works/pi-coding-agent`）、`typebox`。
- Produces: `ai_devflow_ask` 工具，`execute` 通过 `process.send` 发请求 + `await Promise` 等答案。

- [ ] **Step 1: 创建 ask-bridge.ts**

`packages/agents/assets/profiles/shared/extensions/ask-bridge.ts`：
```ts
// ask-bridge：注册交互式问答工具 ai_devflow_ask。
// - AI 在需要向用户澄清多个问题时调用此工具：支持多 tab、每问单选/多选/自由描述，统一提交。
// - execute 通过 process.send（Node IPC）向父进程发请求，阻塞等待答案后 resolve。
//   依赖 PiProcessSupervisor 的 stdio 含 'ipc' 通道（见 process-supervisor 改造）。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const pending = new Map<string, (answer: unknown) => void>();

// 监听父进程回灌的答案（模块加载时注册一次）。
if (typeof process !== 'undefined' && typeof process.on === 'function') {
  process.on('message', (msg: unknown) => {
    if (msg && typeof msg === 'object' && (msg as { kind?: string }).kind === 'ask_answer') {
      const m = msg as { toolUseId: string; answers: unknown };
      const resolve = pending.get(m.toolUseId);
      if (resolve) {
        pending.delete(m.toolUseId);
        resolve(m.answers);
      }
    }
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ai_devflow_ask",
    label: "Ask user structured questions",
    description:
      "当需要向用户澄清多个问题时调用此工具：支持多个 tab（分组）、每个问题可为单选/多选/自由描述，用户统一提交后返回答案。一次调用收集一组相关问题，避免逐条往返。",
    parameters: Type.Object({
      tabs: Type.Array(
        Type.Object({
          id: Type.String({ description: "tab 标识" }),
          title: Type.String({ description: "tab 标题" }),
          questions: Type.Array(
            Type.Object({
              id: Type.String({ description: "问题标识" }),
              kind: Type.Union(
                [Type.Literal("single"), Type.Literal("multi"), Type.Literal("text")],
                { description: "single=单选，multi=多选，text=自由描述" },
              ),
              question: Type.String({ description: "问题文本" }),
              options: Type.Optional(
                Type.Array(
                  Type.Object({
                    value: Type.String(),
                    label: Type.String(),
                  }),
                  { description: "选项列表（single/multi 必填，text 可选作为占位提示）" },
                ),
              ),
              required: Type.Optional(Type.Boolean({ description: "是否必答" })),
            }),
            { minItems: 1 },
          ),
        }),
        { minItems: 1, description: "问题分组（tab）列表" },
      ),
    }),
    async execute(id, input) {
      // 通过 Node IPC 向父进程发请求。
      if (typeof process !== 'undefined' && typeof process.send === 'function') {
        process.send({ kind: 'ask', toolUseId: id, payload: input });
      }
      // 阻塞等待父进程回灌答案。
      const answers = await new Promise<unknown>((resolve) => {
        pending.set(id, resolve);
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ aiDevflowAsk: input, answers }) }],
        details: { input, answers },
      };
    },
  });
}
```

- [ ] **Step 2: typecheck + 提交**

Run: `pnpm --filter @ai-devflow/agents typecheck`
Expected: 无错误

```bash
git add packages/agents/assets/profiles/shared/extensions/ask-bridge.ts
git commit -m "feat(agents): 新增 ai_devflow_ask 问答工具扩展"
```

---

### Task 9: process-supervisor IPC 通道（需求 4 进程层）

**Files:**
- Modify: `packages/agents/src/process-supervisor.ts`（`SpawnFn` 约 64-67 行；`spawn` 约 91-243 行）、`packages/agents/src/__tests__/process-supervisor-ipc.test.ts`（新建）

**Interfaces:**
- Consumes: `ChildProcess`（Node）。
- Produces: `SpawnedPi` 新增 `send(msg): boolean` 与 `onMessage(cb): void`；stdio 改为含 `'ipc'`。

- [ ] **Step 1: 写 IPC 通道单测**

`packages/agents/src/__tests__/process-supervisor-ipc.test.ts`：
```ts
import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { PiProcessSupervisor } from '../process-supervisor.js';

describe('PiProcessSupervisor IPC', () => {
  it('spawn 的 stdio 含 ipc 通道，且 SpawnedPi 暴露 send/onMessage', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const fakeChild = {
      pid: 999,
      stdin: new PassThrough(),
      stdout,
      stderr,
      killed: false,
      kill: vi.fn(),
      once: vi.fn(),
      on: vi.fn(),
      send: vi.fn(() => true),
      disconnect: vi.fn(),
    };
    const spawnFn = vi.fn((_cmd, _args, opts) => {
      // 断言 stdio 含 ipc
      expect(opts.stdio).toContain('ipc');
      return fakeChild as any;
    });
    const supervisor = new PiProcessSupervisor({ platform: 'linux', spawnFn } as any);
    const spawned = supervisor.spawn(
      { command: 'node', args: ['x'], env: {} },
      { cwd: '/tmp', timeoutMs: 5000 },
    );
    expect(typeof spawned.send).toBe('function');
    expect(typeof spawned.onMessage).toBe('function');
    spawned.send({ kind: 'ask', toolUseId: 't1' });
    expect(fakeChild.send).toHaveBeenCalledWith({ kind: 'ask', toolUseId: 't1' });
    const cb = vi.fn();
    spawned.onMessage(cb);
    // fakeChild.on 被调用注册 'message'
    const onCall = fakeChild.on.mock.calls.find((c) => c[0] === 'message');
    expect(onCall).toBeTruthy();
    onCall![1]({ kind: 'ask_answer', toolUseId: 't1', answers: {} });
    expect(cb).toHaveBeenCalledWith({ kind: 'ask_answer', toolUseId: 't1', answers: {} });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @ai-devflow/agents test -- process-supervisor-ipc`
Expected: FAIL（当前无 send/onMessage，stdio 无 ipc）

- [ ] **Step 3: 改 SpawnFn 类型与 stdio 配置**

`packages/agents/src/process-supervisor.ts`（约 64-67 行）：

改前：
```ts
export type SpawnFn = (
  command: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; detached: boolean; stdio: ['pipe', 'pipe', 'pipe'] },
) => ChildProcess;
```

改后：
```ts
export type SpawnFn = (
  command: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; detached: boolean; stdio: ['pipe', 'pipe', 'pipe', 'ipc'] },
) => ChildProcess;
```

`spawn` 方法内（约 94-98 行）：

改前：
```ts
      const child = this.spawnFn(plan.command, plan.args, {
        cwd: opts.cwd,
        env: plan.env,
        detached,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
```

改后：
```ts
      const child = this.spawnFn(plan.command, plan.args, {
        cwd: opts.cwd,
        env: plan.env,
        detached,
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      });
```

- [ ] **Step 4: SpawnedPi 接口加 send/onMessage**

`packages/agents/src/process-supervisor.ts`（约 14-19 行）：

改前：
```ts
export interface SpawnedPi {
  lines: AsyncIterable<RawLine>;
  cancel(): Promise<void>;
  done(): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
  pid?: number;
}
```

改后：
```ts
export interface SpawnedPi {
  lines: AsyncIterable<RawLine>;
  cancel(): Promise<void>;
  done(): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
  pid?: number;
  /** 通过 Node IPC 向子进程发消息（问答答案回灌）。 */
  send(msg: unknown): boolean;
  /** 注册子进程 IPC 消息监听（问答请求接收）。 */
  onMessage(cb: (msg: unknown) => void): void;
}
```

- [ ] **Step 5: spawn 返回对象加 send/onMessage 实现**

`packages/agents/src/process-supervisor.ts` 的 `spawn` 返回对象（约 228-242 行）：

改前：
```ts
      return {
        pid: child.pid,
        lines: merged(),
        async cancel() {
          clearTimeout(timer);
          await killProcess();
        },
        async done() {
          try {
            return await settledPromise;
          } finally {
            clearTimeout(timer);
          }
        },
      };
```

改后：
```ts
      return {
        pid: child.pid,
        lines: merged(),
        send(msg: unknown): boolean {
          if (typeof child.send === 'function') return child.send(msg);
          return false;
        },
        onMessage(cb: (msg: unknown) => void): void {
          if (typeof child.on === 'function') child.on('message', (msg: unknown) => cb(msg));
        },
        async cancel() {
          clearTimeout(timer);
          await killProcess();
        },
        async done() {
          try {
            return await settledPromise;
          } finally {
            clearTimeout(timer);
          }
        },
      };
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm --filter @ai-devflow/agents test -- process-supervisor-ipc`
Expected: PASS

- [ ] **Step 7: 问答挂起期间暂停超时**

`packages/agents/src/process-supervisor.ts`，在 `spawn` 内 `onMessage` 集成超时暂停。由于 Step 5 的 `onMessage` 是消费者注册回调，超时暂停需在回调内处理。改为：`onMessage` 回调收到 `kind==='ask'` 时 `clearTimeout(timer)`，收到 `kind==='ask_answer'` 时重设 timer。

修改 Step 5 的 `onMessage` 实现为内部维护 timer 引用：
```ts
        onMessage(cb: (msg: unknown) => void): void {
          if (typeof child.on !== 'function') return;
          child.on('message', (msg: unknown) => {
            const m = msg as { kind?: string };
            if (m?.kind === 'ask') clearTimeout(timer);
            else if (m?.kind === 'ask_answer') {
              timer.refresh();
            }
            cb(msg);
          });
        },
```
（`timer` 是 `setTimeout` 返回值，`refresh()` 重新计时）

- [ ] **Step 8: 更新现有 process-supervisor 测试 mock**

检查 `packages/agents/src/__tests__/process-supervisor.test.ts`，其 `SpawnFn` mock 的 stdio 类型需从 `['pipe','pipe','pipe']` 改为 `['pipe','pipe','pipe','ipc']`，且 fakeChild 需补 `send`/`on` 方法桩。运行全部 agents 测试：

Run: `pnpm --filter @ai-devflow/agents test`
Expected: PASS

- [ ] **Step 9: typecheck + 提交**

Run: `pnpm --filter @ai-devflow/agents typecheck`
Expected: 无错误

```bash
git add packages/agents/src/process-supervisor.ts packages/agents/src/__tests__/process-supervisor-ipc.test.ts packages/agents/src/__tests__/process-supervisor.test.ts
git commit -m "feat(agents): PiProcessSupervisor 新增子进程 IPC 通道（问答暂停-恢复）"
```

---

### Task 10: 问答 main 侧桥接 + IPC（需求 4 桥接层）

**Files:**
- Modify: `apps/desktop/electron/pi-ai.ts`（`executeTextOnRoute` spawn 后加 onMessage；`createPiAiService.chat` 加 onAsk；`PiTextExecutor` 签名）、`apps/desktop/electron/ipc.ts`（ai:answer 反向通道；ai:chat handler 加 onAsk）、`apps/desktop/electron/preload.ts`（ai.answer）、`apps/desktop/electron/api.ts`（AiStreamEvent 加 question；ai.answer）
- Test: `apps/desktop/electron/__tests__/ask-ipc.test.ts`（新建）

**Interfaces:**
- Consumes: `SpawnedPi.send/onMessage`（Task 9）。
- Produces: `AiStreamEvent` 新增 `question`；`api.ai.answer(sessionId, toolUseId, answers)`。

- [ ] **Step 1: 定义问答类型**

`apps/desktop/electron/api.ts`，在 `AiTaskProposalDraft` 后新增：
```ts
/** 问答工具的问题结构（多 tab）。 */
export type AskTabs = Array<{
  id: string;
  title: string;
  questions: Array<{
    id: string;
    kind: 'single' | 'multi' | 'text';
    question: string;
    options?: Array<{ value: string; label: string }>;
    required?: boolean;
  }>;
}>;

/** 问答工具的答案结构。 */
export type AskAnswer = Array<{
  tabId: string;
  answers: Array<{ questionId: string; value: string | string[] }>;
}>;
```

更新 `AiStreamEvent`（约 96-101 行）：

改前：
```ts
export type AiStreamEvent =
  | { type: 'delta'; sessionId: string; text: string }
  | { type: 'done'; sessionId: string; fullText: string }
  | { type: 'error'; sessionId: string; error: string }
  | { type: 'requirement_proposal'; sessionId: string; draft: AiRequirementProposalDraft }
  | { type: 'task_proposal'; sessionId: string; tasks: AiTaskProposalDraft[] };
```

改后：
```ts
export type AiStreamEvent =
  | { type: 'delta'; sessionId: string; text: string }
  | { type: 'done'; sessionId: string; fullText: string }
  | { type: 'error'; sessionId: string; error: string }
  | { type: 'requirement_proposal'; sessionId: string; draft: AiRequirementProposalDraft }
  | { type: 'task_proposal'; sessionId: string; tasks: AiTaskProposalDraft[] }
  | { type: 'question'; sessionId: string; toolUseId: string; tabs: AskTabs };
```

`DesktopApi.ai` 命名空间（约 253-273 行）加：
```ts
      /** 提交问答工具的答案（统一提交所有 tab）。 */
      answer(sessionId: string, toolUseId: string, answers: AskAnswer): Promise<void>;
```

- [ ] **Step 2: PiTextExecutor 签名加 onAsk**

`apps/desktop/electron/pi-ai.ts`（约 42-50 行）：

改前：
```ts
export interface PiTextExecutor {
  (
    workload: ChatWorkload,
    messages: AiChatMessage[],
    onDelta?: (text: string) => void,
    options?: { onlyProviderId?: string; cwd?: string },
    onToolResult?: (toolName: string, payload: unknown) => void,
  ): Promise<string>;
}
```

改后：
```ts
export interface PiTextExecutor {
  (
    workload: ChatWorkload,
    messages: AiChatMessage[],
    onDelta?: (text: string) => void,
    options?: { onlyProviderId?: string; cwd?: string },
    onToolResult?: (toolName: string, payload: unknown) => void,
    onAsk?: (toolUseId: string, tabs: unknown) => void,
  ): Promise<string>;
}
```

- [ ] **Step 3: executeTextOnRoute 注册 onMessage**

`apps/desktop/electron/pi-ai.ts` 的 `executeTextOnRoute`，在 spawn 后（`const spawned = deps.supervisor.spawn(...)` 之后）加：
```ts
  spawned.onMessage((msg) => {
    const m = msg as { kind?: string; toolUseId?: string; payload?: unknown };
    if (m?.kind === 'ask' && m.toolUseId) {
      onAsk?.(m.toolUseId, m.payload);
    }
  });
```

`executeTextOnRoute` 签名（约 273-281 行）加 `onAsk` 参数：

改前：
```ts
export async function executeTextOnRoute(
  route: ProviderRoute,
  messages: AiChatMessage[],
  onDelta: ((text: string) => void) | undefined,
  deps: ProductionExecutorDeps,
  workload: ChatWorkload,
  onToolResult?: (toolName: string, payload: unknown) => void,
  cwdOverride?: string,
): Promise<string> {
```

改后：
```ts
export async function executeTextOnRoute(
  route: ProviderRoute,
  messages: AiChatMessage[],
  onDelta: ((text: string) => void) | undefined,
  deps: ProductionExecutorDeps,
  workload: ChatWorkload,
  onToolResult?: (toolName: string, payload: unknown) => void,
  cwdOverride?: string,
  onAsk?: (toolUseId: string, tabs: unknown) => void,
): Promise<string> {
```

- [ ] **Step 4: createProductionTextExecutor 透传 onAsk**

`apps/desktop/electron/pi-ai.ts` 的 `createProductionTextExecutor`（约 455 行）返回的 executor 函数，透传 `onAsk` 到 `executeTextOnRoute`。找到该函数体，把 `onAsk` 参数加到返回的闭包签名与 `executeTextOnRoute` 调用。

改 executor 返回的闭包（约 460 行附近，签名与 `PiTextExecutor` 一致）：

改前：
```ts
  return (workload, messages, onDelta, options, onToolResult) => {
    ...
    return executeTextOnRoute(route, messages, onDelta, deps, workload, onToolResult, options?.cwd);
  };
```

改后：
```ts
  return (workload, messages, onDelta, options, onToolResult, onAsk) => {
    ...
    return executeTextOnRoute(route, messages, onDelta, deps, workload, onToolResult, options?.cwd, onAsk);
  };
```

- [ ] **Step 5: createPiAiService.chat 透传 onAsk**

`apps/desktop/electron/pi-ai.ts` 的 `chat` 方法（约 532-541 行）：

改前：
```ts
    chat(messages, onDelta, opts) {
      const workload = workloadFromMode(opts?.mode);
      const promptMessages: AiChatMessage[] =
        opts?.context && messages.length > 0
          ? [{ role: 'user', content: `【上下文】\n${opts.context}\n\n${messages[messages.length - 1]!.content}` }]
          : messages;
      return executeText(workload, promptMessages, onDelta, opts?.projectPath ? { cwd: opts.projectPath } : undefined, opts?.onToolResult);
    },
```

改后：
```ts
    chat(messages, onDelta, opts) {
      const workload = workloadFromMode(opts?.mode);
      const promptMessages: AiChatMessage[] =
        opts?.context && messages.length > 0
          ? [{ role: 'user', content: `【上下文】\n${opts.context}\n\n${messages[messages.length - 1]!.content}` }]
          : messages;
      return executeText(workload, promptMessages, onDelta, opts?.projectPath ? { cwd: opts.projectPath } : undefined, opts?.onToolResult, opts?.onAsk);
    },
```

`PiAiService.chat` 的 opts 类型也需加 `onAsk?`（找到 `PiAiService` 接口定义，在 `onToolResult?` 后加 `onAsk?: (toolUseId: string, tabs: unknown) => void`）。

- [ ] **Step 6: 会话 Map + resolveAsk**

`apps/desktop/electron/pi-ai.ts`，在 `createPiAiService` 之前加会话注册表：
```ts
// 问答会话注册表：sessionId -> SpawnedPi（用于 answer 回灌答案到子进程）。
const askSessions = new Map<string, { send: (msg: unknown) => boolean }>();

export function resolveAsk(sessionId: string, _toolUseId: string, answers: unknown): void {
  const session = askSessions.get(sessionId);
  if (session) session.send({ kind: 'ask_answer', toolUseId: _toolUseId, answers });
}
```

`executeTextOnRoute` 内，spawn 后注册会话、结束后清理。在 Step 3 的 `spawned.onMessage(...)` 后加：
```ts
  askSessions.set(/* sessionId 需从外部传入或生成 */);
```

注意：`executeTextOnRoute` 目前无 sessionId。需给 `executeTextOnRoute` 加 `sessionId` 参数，或让 `onAsk` 回调携带 sessionId（由 service 层生成）。采用后者：`onAsk` 改为 `(toolUseId, tabs) => void`，service 层在 `chat` 方法内生成 sessionId 并注册 askSessions。

改 `createPiAiService.chat`：
```ts
    chat(messages, onDelta, opts) {
      const workload = workloadFromMode(opts?.mode);
      const sessionId = randomUUID();
      const promptMessages: AiChatMessage[] =
        opts?.context && messages.length > 0
          ? [{ role: 'user', content: `【上下文】\n${opts.context}\n\n${messages[messages.length - 1]!.content}` }]
          : messages;
      const executorOpts = opts?.projectPath ? { cwd: opts.projectPath } : undefined;
      const promise = executeText(workload, promptMessages, onDelta, executorOpts, opts?.onToolResult, (toolUseId, tabs) => {
        opts?.onAsk?.(toolUseId, tabs);
      });
      // 注册会话供 resolveAsk 回灌（executor 内 spawned 通过闭包捕获，需暴露 send）。
      // 为此 executeText 需返回 spawned 句柄——改用 callback 方式：onAsk 时把 send 经额外回调上交。
      return promise;
    },
```

由于 `executeText` 是闭包，spawned 句柄未暴露给 service 层。最简方案：让 `onAsk` 回调第二个参数为 `send` 函数。改 `PiTextExecutor` 的 `onAsk` 签名为 `(toolUseId: string, tabs: unknown, send: (msg: unknown) => boolean) => void`。

`executeTextOnRoute` 的 `onMessage` 回调改为：
```ts
  spawned.onMessage((msg) => {
    const m = msg as { kind?: string; toolUseId?: string; payload?: unknown };
    if (m?.kind === 'ask' && m.toolUseId) {
      onAsk?.(m.toolUseId, m.payload, (reply: unknown) => spawned.send(reply));
    }
  });
```

`chat` 方法改为：
```ts
    chat(messages, onDelta, opts) {
      const workload = workloadFromMode(opts?.mode);
      const promptMessages: AiChatMessage[] =
        opts?.context && messages.length > 0
          ? [{ role: 'user', content: `【上下文】\n${opts.context}\n\n${messages[messages.length - 1]!.content}` }]
          : messages;
      const executorOpts = opts?.projectPath ? { cwd: opts.projectPath } : undefined;
      return executeText(workload, promptMessages, onDelta, executorOpts, opts?.onToolResult, (toolUseId, tabs, send) => {
        opts?.onAsk?.(toolUseId, tabs, send);
      });
    },
```

这样 `onAsk` 回调直接携带 `send`，service 层无需维护会话 Map。`resolveAsk` 不再需要全局 Map。

删除 Step 6 开头的 `askSessions`/`resolveAsk` 全局定义，改为在 `ipc.ts` 内用闭包持有 `send`。

- [ ] **Step 7: ipc.ts ai:chat handler 加 onAsk + ai:answer 反向通道**

`apps/desktop/electron/ipc.ts` 的 `ai:chat` handler（约 504-534 行），在 `onToolResult` 后加 `onAsk`：

改前（约 533 行 `},` 后）：
```ts
        });
        sendAi({ type: 'done', sessionId: payload.sessionId, fullText });
```

改后：
```ts
        },
        onAsk: (toolUseId, tabs, send) => {
          sendAi({ type: 'question', sessionId: payload.sessionId, toolUseId, tabs: tabs as any });
          // 保存 send 以便 ai:answer 回灌。
          pendingAsks.set(payload.sessionId, { toolUseId, send });
        },
      });
      sendAi({ type: 'done', sessionId: payload.sessionId, fullText });
```

在 `registerIpc` 函数顶部加 `pendingAsks` Map（`ipc.ts` 内，handler 外）：
```ts
// 问答待答：sessionId -> { toolUseId, send }。
const pendingAsks = new Map<string, { toolUseId: string; send: (msg: unknown) => boolean }>();
```

新增 `ai:answer` handler（在 `ai:chat` handler 后）：
```ts
  ipcMain.on('ai-devflow:ai:answer', (_e, payload: { sessionId: string; toolUseId: string; answers: unknown }) => {
    const pending = pendingAsks.get(payload.sessionId);
    if (pending && pending.toolUseId === payload.toolUseId) {
      pending.send({ kind: 'ask_answer', toolUseId: payload.toolUseId, answers: payload.answers });
      pendingAsks.delete(payload.sessionId);
    }
  });
```

`ai:chat` handler 完成后（`done` 或 `error`）清理 pendingAsks：在 `sendAi({ type: 'done', ...})` 与 catch 的 `sendAi({ type: 'error', ...})` 前加 `pendingAsks.delete(payload.sessionId);`。

- [ ] **Step 8: preload + api 暴露 ai.answer**

`apps/desktop/electron/preload.ts` 的 `ai` 对象（约 117-147 行），在 `proposeRequirement` 后加：
```ts
      answer: (sessionId: string, toolUseId: string, answers: unknown) => ipcRenderer.send('ai-devflow:ai:answer', { sessionId, toolUseId, answers }),
```

并在 `chat` 的 listener 里加 `question` 分支（约 126-141 行）：

改前 listener 内：
```ts
            if (ev.type === 'delta') {
              onChunk(ev.text);
            } else if (ev.type === 'requirement_proposal') {
```

改后：
```ts
            if (ev.type === 'delta') {
              onChunk(ev.text);
            } else if (ev.type === 'question') {
              opts?.onQuestion?.(ev.toolUseId, ev.tabs);
            } else if (ev.type === 'requirement_proposal') {
```

`chat` 方法 opts 类型加 `onQuestion?`：
```ts
      chat(
        messages: AiChatMessage[],
        onChunk: (delta: string) => void,
        opts?: { mode?: 'task' | 'requirement' | 'task_proposal'; context?: string; projectPath?: string; onRequirementProposal?: (draft: AiRequirementProposalDraft) => void; onTaskProposal?: (tasks: AiTaskProposalDraft[]) => void; onQuestion?: (toolUseId: string, tabs: AskTabs) => void },
      ): Promise<string> {
```

`api.ts` 的 `DesktopApi.ai.chat` opts 类型也加 `onQuestion?`。

- [ ] **Step 9: 写桥接单测**

`apps/desktop/electron/__tests__/ask-ipc.test.ts`：
```ts
import { describe, it, expect, vi } from 'vitest';

describe('ask IPC bridge', () => {
  it('onAsk 回调携带 send 函数', () => {
    // 验证 executeTextOnRoute 的 onAsk 把 toolUseId/tabs/send 透传给 onAsk 回调
    const onAsk = vi.fn();
    const events = [
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '正在提问' } },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '正在提问' }] } },
      { type: 'agent_end' },
    ];
    const lines = events.map((e) => ({ stream: 'stdout' as const, text: JSON.stringify(e) }));
    let messageCb: ((msg: unknown) => void) | null = null;
    const mockSpawned = {
      lines: (async function* () { for (const l of lines) yield l; })(),
      done: async () => ({ exitCode: 0, signal: null }),
      cancel: async () => {},
      pid: 1,
      send: vi.fn(() => true),
      onMessage: vi.fn((cb: (msg: unknown) => void) => { messageCb = cb; }),
    };
    const mockSupervisor = { spawn: () => mockSpawned };
    const { executeTextOnRoute } = require('../pi-ai.js');
    const route = { providerName: 'p', model: 'm', thinking: 'off', secret: 's' } as any;
    const deps = { supervisor: mockSupervisor, locator: {}, router: {} } as any;
    const promise = executeTextOnRoute(route, [{ role: 'user', content: 'hi' }], undefined, deps, 'task_proposal' as any, undefined, undefined, onAsk);
    // 模拟子进程发来 ask 请求
    messageCb!({ kind: 'ask', toolUseId: 'tu1', payload: { tabs: [] } });
    expect(onAsk).toHaveBeenCalledWith('tu1', { tabs: [] }, expect.any(Function));
    // 调用 send 应回灌到 spawned.send
    const sendFn = onAsk.mock.calls[0]![2] as (msg: unknown) => boolean;
    sendFn({ kind: 'ask_answer', toolUseId: 'tu1', answers: [] });
    expect(mockSpawned.send).toHaveBeenCalledWith({ kind: 'ask_answer', toolUseId: 'tu1', answers: [] });
    return promise;
  });
});
```

- [ ] **Step 10: 运行测试 + typecheck + 提交**

Run: `pnpm --filter @ai-devflow/desktop test -- ask-ipc && pnpm --filter @ai-devflow/desktop typecheck`
Expected: PASS / 无错误

```bash
git add apps/desktop/electron/pi-ai.ts apps/desktop/electron/ipc.ts apps/desktop/electron/preload.ts apps/desktop/electron/api.ts apps/desktop/electron/__tests__/ask-ipc.test.ts
git commit -m "feat(desktop): 问答工具 main 侧桥接 + ai:answer 反向通道"
```

---

### Task 11: 问答卡片前端 UI（需求 4 UI）

**Files:**
- Modify: `apps/desktop/src/pages/Workspace.tsx`（`AiRefineRequirement`/`AiCreateTask` 接入 onQuestion + renderMessage 问答卡片）、`apps/desktop/src/i18n/zh.ts` + `en.ts`

**Interfaces:**
- Consumes: `ChatPanel.renderMessage`（Task 2）、`api.ai.answer`（Task 10）、`AskTabs`/`AskAnswer` 类型（Task 10）。
- Produces: 问答卡片消息渲染 + 提交。

- [ ] **Step 1: 加 i18n key**

`zh.ts` 加：
```ts
  'chat.ask.submit': '提交',
  'chat.ask.required': '请回答必填问题',
  'chat.ask.submitted': '已提交',
  'chat.ask.tab': '问题 {n}',
```
`en.ts` 加：
```ts
  'chat.ask.submit': 'Submit',
  'chat.ask.required': 'Please answer required questions',
  'chat.ask.submitted': 'Submitted',
  'chat.ask.tab': 'Questions {n}',
```

- [ ] **Step 2: 定义问答状态与卡片组件**

`Workspace.tsx` 内（`ChatPanel` import 后）加问答状态类型与卡片组件：
```tsx
type AskCardState = { toolUseId: string; tabs: AskTabs; submitted: boolean; answers: Record<string, Record<string, string | string[]>> };

function AskCard({ state, onSubmit }: { state: AskCardState; onSubmit: (answers: AskAnswer) => void }): React.ReactElement {
  const t = useT();
  const [activeTab, setActiveTab] = useState(0);
  const [local, setLocal] = useState<Record<string, Record<string, string | string[]>>>(() => {
    const init: Record<string, Record<string, string | string[]>> = {};
    for (const tab of state.tabs) {
      init[tab.id] = {};
      for (const q of tab.questions) init[tab.id][q.id] = q.kind === 'multi' ? [] : '';
    }
    return init;
  });

  const submit = () => {
    // 校验必填
    for (const tab of state.tabs) {
      for (const q of tab.questions) {
        if (q.required) {
          const v = local[tab.id]?.[q.id];
          if (q.kind === 'multi' ? !Array.isArray(v) || v.length === 0 : !v) { setError(t('chat.ask.required')); return; }
        }
      }
    }
    setError(undefined);
    const answers: AskAnswer = state.tabs.map((tab) => ({
      tabId: tab.id,
      answers: tab.questions.map((q) => ({ questionId: q.id, value: local[tab.id]?.[q.id] ?? (q.kind === 'multi' ? [] : '') })),
    }));
    onSubmit(answers);
  };

  const [error, setError] = useState<string | undefined>();
  const tab = state.tabs[activeTab];

  if (state.submitted) {
    return <div className="rounded-md border border-border bg-secondary/40 p-2 text-xs text-muted-foreground">{t('chat.ask.submitted')}</div>;
  }

  return (
    <div className="rounded-md border border-border p-2 text-xs">
      <div className="flex gap-1 border-b border-border pb-1.5 mb-1.5">
        {state.tabs.map((tb, i) => (
          <button key={tb.id} onClick={() => setActiveTab(i)} className={`px-2 py-0.5 rounded ${i === activeTab ? 'bg-primary text-primary-foreground' : 'bg-secondary'}`}>{tb.title}</button>
        ))}
      </div>
      <div className="flex flex-col gap-2">
        {tab.questions.map((q) => (
          <div key={q.id} className="flex flex-col gap-1">
            <label className="font-medium">{q.question}{q.required && <span className="text-destructive"> *</span>}</label>
            {q.kind === 'text' ? (
              <Textarea rows={2} value={(local[tab.id]?.[q.id] as string) ?? ''} onChange={(e) => setLocal((p) => ({ ...p, [tab.id]: { ...p[tab.id], [q.id]: e.target.value } }))} />
            ) : q.kind === 'single' ? (
              <Select value={(local[tab.id]?.[q.id] as string) ?? ''} onValueChange={(v) => setLocal((p) => ({ ...p, [tab.id]: { ...p[tab.id], [q.id]: v } }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{q.options?.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
              </Select>
            ) : (
              <div className="flex flex-wrap gap-2">
                {q.options?.map((o) => {
                  const arr = (local[tab.id]?.[q.id] as string[]) ?? [];
                  return (
                    <label key={o.value} className="flex items-center gap-1">
                      <Checkbox checked={arr.includes(o.value)} onCheckedChange={() => setLocal((p) => {
                        const cur = (p[tab.id]?.[q.id] as string[]) ?? [];
                        return { ...p, [tab.id]: { ...p[tab.id], [q.id]: cur.includes(o.value) ? cur.filter((x) => x !== o.value) : [...cur, o.value] } };
                      })} />
                      <span>{o.label}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>
      {error && <div className="mt-1.5 text-destructive">{error}</div>}
      <div className="mt-2 flex justify-end gap-1">
        {state.tabs.length > 1 && activeTab < state.tabs.length - 1 && <Button size="sm" variant="ghost" onClick={() => setActiveTab((i) => i + 1)}>下一步</Button>}
        <Button size="sm" onClick={submit} disabled={state.tabs.length > 1 && activeTab < state.tabs.length - 1}>{t('chat.ask.submit')}</Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: AiRefineRequirement / AiCreateTask 接入 onQuestion**

`AiRefineRequirement` 的 `messages` 类型从 `ChatPanelMessage[]` 扩展为承载问答卡片。在 `ChatPanelMessage` 的 union 里已加 `kind: 'question'`。改 `AiRefineRequirement`：

加 `askCards` 状态：
```tsx
  const [askCards, setAskCards] = useState<Record<string, AskCardState>>({});
```

`api.ai.chat` 调用加 `onQuestion`：
```tsx
      }, {
        mode: 'requirement',
        onRequirementProposal: (draft) => onApplied(draft),
        onQuestion: (toolUseId, tabs) => {
          setAskCards((prev) => ({ ...prev, [toolUseId]: { toolUseId, tabs, submitted: false, answers: {} } }));
          setMessages((prev) => [...prev, { id: `q-${toolUseId}`, role: 'assistant', kind: 'question', content: '' }]);
        },
      });
```

`ChatPanel` 的 `renderMessage` prop 渲染问答卡片：
```tsx
      <ChatPanel
        messages={messages}
        onSend={send}
        loading={streaming}
        placeholder={t('req.ai.placeholder')}
        thinkingLabel={t('req.ai.thinking')}
        sendLabel={t('task.ai.send')}
        error={error}
        renderMessage={(msg) => {
          if (msg.kind === 'question') {
            const card = askCards[(msg as any).id.replace('q-', '')];
            if (!card) return null;
            return <AskCard state={card} onSubmit={async (answers) => {
              await api.ai.answer(/* sessionId 需从 chat 闭包拿到 */, card.toolUseId, answers);
              setAskCards((prev) => ({ ...prev, [card.toolUseId]: { ...card, submitted: true } }));
            }} />;
          }
          return null;
        }}
      />
```

注意：`sessionId` 需在 `AiRefineRequirement` 内捕获。`api.ai.chat` 返回 Promise，但 `onQuestion` 在 Promise resolve 前触发。需让 `api.ai.chat` 暴露 sessionId（或由调用方传入）。最简方案：`AiRefineRequirement` 内自生成 sessionId 并在 `onQuestion` 时已知。但当前 `chat` 在 preload 内自生成 sessionId。

改为：`api.ai.chat` 的 opts 增加可选 `sessionId` 由调用方传入，preload 用它而非自生成。或在 `onQuestion` 回调里把 sessionId 一并返回。

采用后者：`onQuestion` 回调签名改为 `(sessionId, toolUseId, tabs)`。更新 Task 10 Step 8 的 preload listener 与 api 类型。

`AiRefineRequirement` 的 `onQuestion` 改为：
```tsx
        onQuestion: (sessionId, toolUseId, tabs) => {
          sessionRef.current = sessionId;
          setAskCards((prev) => ({ ...prev, [toolUseId]: { toolUseId, tabs, submitted: false, answers: {} } }));
          setMessages((prev) => [...prev, { id: `q-${toolUseId}`, role: 'assistant', kind: 'question' as const, content: '' }]);
        },
```

加 `const sessionRef = useRef<string>();`，AskCard 提交时用 `sessionRef.current`。

`AiCreateTask` 同理接入。

- [ ] **Step 4: ChatPanelMessage 联合类型加 question 变体**

`apps/desktop/src/components/ChatPanel.tsx` 的 `ChatPanelMessage` 已含 `kind: 'question'` 变体（Task 2 Step 1 已定义）。确认 `content` 字段在该变体存在（用于 id）。

- [ ] **Step 5: typecheck + 提交**

Run: `pnpm --filter @ai-devflow/desktop typecheck`
Expected: 无错误

```bash
git add apps/desktop/src/pages/Workspace.tsx apps/desktop/src/i18n/zh.ts apps/desktop/src/i18n/en.ts
git commit -m "feat(desktop): 问答卡片前端 UI（多 tab/单选多选/自由描述）"
```

---

### Task 12: step agent 接线 + SYSTEM.md（需求 4 接线）

**Files:**
- Modify: `packages/agents/src/profiles.ts`（`BUILTIN_EXTENSIONS` 约 48-55 行；`STEP_AGENTS` 约 143-164 行）、`packages/agents/assets/profiles/steps/task_proposer/SYSTEM.md`、`packages/agents/assets/profiles/steps/requirement_refiner/SYSTEM.md`

**Interfaces:**
- Consumes: `ask-bridge` 扩展（Task 8）。
- Produces: 两个 step agent 启用 `ai_devflow_ask` 工具。

- [ ] **Step 1: BUILTIN_EXTENSIONS 加 ask-bridge**

`packages/agents/src/profiles.ts`（约 48-55 行）：

改前：
```ts
export const BUILTIN_EXTENSIONS = [
  'event-bridge',
  'execution-policy',
  'structured-result',
  'checkpoint-context',
  'requirement-bridge',
  'task-bridge',
] as const;
```

改后：
```ts
export const BUILTIN_EXTENSIONS = [
  'event-bridge',
  'execution-policy',
  'structured-result',
  'checkpoint-context',
  'requirement-bridge',
  'task-bridge',
  'ask-bridge',
] as const;
```

- [ ] **Step 2: STEP_AGENTS 两个 step 加 ai_devflow_ask + ask-bridge**

`packages/agents/src/profiles.ts`（约 143-164 行）：

改前：
```ts
    requirement_refiner: {
      step: 'requirement_refiner',
      version: 1,
      systemPromptFile: 'SYSTEM.md',
      skills: ['brainstorming'],
      tools: ['ai_devflow_propose_requirement'],
      extensions: ['requirement-bridge'],
      timeoutMs: 10 * 60_000,
    },
    task_proposer: {
      step: 'task_proposer',
      version: 2,
      systemPromptFile: 'SYSTEM.md',
      skills: ['brainstorming'],
      // read-only 探索工具用于「探索相关项目逻辑」：研读真实代码以判断子任务拆分与实施计划是否可行。
      // 不给写工具：本环节只产出任务草稿，不落地任何代码改动。
      tools: ['read', 'grep', 'find', 'ls', 'ai_devflow_propose_task'],
      extensions: ['task-bridge'],
      timeoutMs: 15 * 60_000,
    },
```

改后：
```ts
    requirement_refiner: {
      step: 'requirement_refiner',
      version: 2,
      systemPromptFile: 'SYSTEM.md',
      skills: ['brainstorming'],
      tools: ['ai_devflow_propose_requirement', 'ai_devflow_ask'],
      extensions: ['requirement-bridge', 'ask-bridge'],
      timeoutMs: 10 * 60_000,
    },
    task_proposer: {
      step: 'task_proposer',
      version: 3,
      systemPromptFile: 'SYSTEM.md',
      skills: ['brainstorming'],
      // read-only 探索工具用于「探索相关项目逻辑」：研读真实代码以判断子任务拆分与实施计划是否可行。
      // 不给写工具：本环节只产出任务草稿，不落地任何代码改动。
      tools: ['read', 'grep', 'find', 'ls', 'ai_devflow_propose_task', 'ai_devflow_ask'],
      extensions: ['task-bridge', 'ask-bridge'],
      timeoutMs: 15 * 60_000,
    },
```

- [ ] **Step 3: 运行 validateStepAgents 校验**

Run: `pnpm --filter @ai-devflow/agents typecheck`
Expected: 无错误（ask-bridge 已在池中）

- [ ] **Step 4: 更新 task_proposer SYSTEM.md 加问答工具说明**

`packages/agents/assets/profiles/steps/task_proposer/SYSTEM.md`，在"### 3. 逐步澄清研发侧不清晰的问题"段后加：

```markdown

  ### 何时使用 ai_devflow_ask 工具
  - 当有**多个需要用户拍板的研发侧问题**需要一次性收集时，调用 `ai_devflow_ask` 工具（而非逐条对话）。
  - 工具支持多个 tab（分组）、每问单选/多选/自由描述，用户统一提交后返回答案。
  - 单个简单问题仍用普通对话一次一问；ai_devflow_ask 用于"一组关联问题"的批量澄清。
```

- [ ] **Step 5: 更新 requirement_refiner SYSTEM.md 加问答工具说明**

`packages/agents/assets/profiles/steps/requirement_refiner/SYSTEM.md`，在"## 职责"段后加：

```markdown

  ## 何时使用 ai_devflow_ask 工具
  - 当有**多个需要用户澄清的需求问题**需要一次性收集时，调用 `ai_devflow_ask` 工具（而非逐条对话）。
  - 工具支持多个 tab（分组）、每问单选/多选/自由描述，用户统一提交后返回答案。
  - 单个简单问题仍用普通对话一次一问；ai_devflow_ask 用于"一组关联问题"的批量澄清。
```

- [ ] **Step 6: 运行 inspect:roles 确认接线**

Run: `pnpm inspect:roles`
Expected: 输出中 `requirement_refiner` 与 `task_proposer` 的 tools 含 `ai_devflow_ask`，extensions 含 `ask-bridge`。

- [ ] **Step 7: 提交**

```bash
git add packages/agents/src/profiles.ts packages/agents/assets/profiles/steps/task_proposer/SYSTEM.md packages/agents/assets/profiles/steps/requirement_refiner/SYSTEM.md
git commit -m "feat(agents): requirement_refiner 与 task_proposer 接入 ai_devflow_ask 工具"
```

---

## Self-Review 结果

**1. Spec coverage：** 5 项需求均有对应 Task。需求 1（Task 4-5）、需求 2（Task 1）、需求 3（Task 6-7）、需求 4（Task 8-12）、需求 5（Task 2-3）。

**2. Placeholder scan：** 无 TBD/TODO。Task 7 Step 3 需读 `validateProposalDag` 后调整，已给出调整方向（放宽引用校验），执行时读源码定位具体行。

**3. Type consistency：** `ChatPanelMessage`（Task 2）在 Task 3/11 一致使用；`AskTabs`/`AskAnswer`（Task 10）在 Task 11 一致；`onAsk` 签名 `(toolUseId, tabs, send)`（Task 10 Step 6）在 pi-ai.ts/ipc.ts/preload 一致；`SpawnedPi.send/onMessage`（Task 9）在 Task 10 一致。

**4. 风险项：** Task 9 Step 7 的超时暂停依赖 `timer.refresh()`，需确认 Node `setTimeout` 返回值支持 `refresh()`（Node 标准 Timeout 对象支持）。Task 10 Step 6 的 `onAsk` 携带 `send` 方案替代了全局会话 Map，简化了架构。Task 11 Step 3 的 `sessionId` 透传方案（`onQuestion` 回调携带 sessionId）需与 Task 10 Step 8 的 preload listener 一致。
