import React, { useEffect, useState } from 'react';
import { api, StatusBadge, fmtTime, useStream, EmptyState } from '../lib.js';
import { useT } from '../i18n/index.js';
import { ChatThread, type ChatItem } from '../components/ChatThread.js';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { Textarea } from '../components/ui/textarea.js';
import { Badge } from '../components/ui/badge.js';
import { Separator } from '../components/ui/separator.js';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '../components/ui/select.js';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '../components/ui/dialog.js';
import { Pencil, Pause, Play, ChevronDown, ChevronRight, CheckCircle2, ShieldQuestion, MessageCircleQuestion, AlertTriangle, Send, XCircle } from 'lucide-react';
import type { Task, LogEntry, ExecutionRecord, PendingQuestion, Requirement, TaskTypeLabel, TaskMessage, PendingInteraction } from '@ai-devflow/core';
import { Checkbox } from '../components/ui/checkbox.js';

export function TaskDetail({ taskId, onChanged }: { taskId: string; onChanged: () => void }): React.ReactElement {
  const t = useT();
  const [task, setTask] = useState<Task | undefined>();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [execs, setExecs] = useState<ExecutionRecord[]>([]);
  const [pending, setPending] = useState<PendingQuestion | undefined>();
  const [messages, setMessages] = useState<TaskMessage[]>([]);
  const [interactions, setInteractions] = useState<PendingInteraction[]>([]);
  const [requirement, setRequirement] = useState<Requirement | undefined>();
  const [siblings, setSiblings] = useState<Task[]>([]);
  // 同级子任务默认收起（与 Workspace ReqItem 一致），避免挤压主内容。
  const [siblingsCollapsed, setSiblingsCollapsed] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [confirmAccept, setConfirmAccept] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);

  const load = async () => {
    const [tg, lg, ex, pn, msgs, inters] = await Promise.all([
      api.tasks.get(taskId),
      api.tasks.logs(taskId),
      api.tasks.executions(taskId),
      api.tasks.pendingQuestion(taskId),
      api.tasks.messages(taskId),
      api.tasks.interactions(taskId),
    ]);
    setTask(tg); setLogs(lg); setExecs(ex); setPending(pn); setMessages(msgs); setInteractions(inters);
    if (tg) {
      const [req, sibs] = await Promise.all([
        api.requirements.get(tg.requirementId),
        api.tasks.listByRequirement(tg.requirementId),
      ]);
      setRequirement(req);
      setSiblings(sibs.filter((s) => s.id !== taskId));
    }
  };

  useEffect(() => { load(); }, [taskId]);

  useStream((ev) => {
    if (ev.taskId !== taskId) return;
    if (ev.kind === 'log') {
      setLogs((prev) => [...prev, ev.data as LogEntry]);
    } else if (ev.kind === 'task-message') {
      setMessages((prev) => [...prev, ev.data as TaskMessage]);
    } else if (ev.kind === 'task-interaction') {
      const ni = ev.data as PendingInteraction;
      setInteractions((prev) => [...prev.filter((x) => x.id !== ni.id), ni]);
    } else if (['task-status', 'task-event', 'task-awaiting', 'task-failed', 'task-canceled'].includes(ev.kind)) {
      load(); onChanged();
    }
  });

  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setError(undefined);
    try { await fn(); await load(); onChanged(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  if (!task) return <EmptyState title={t('common.loading')} />;

  const editable = task.status === 'ready';

  // 依赖状态：前置任务需进入 in_review/archived 才视为完成。
  const depIds = task.dependsOn ?? [];
  const predecessors = depIds.map((id) => siblings.find((s) => s.id === id) ?? null);
  const missingCount = predecessors.filter((p) => p === null).length;
  const presentDeps = predecessors.filter((p): p is Task => !!p);
  const blockedDeps = presentDeps.filter((p) => p.status !== 'in_review' && p.status !== 'archived');
  const depsOk = depIds.length === 0 || (missingCount === 0 && blockedDeps.length === 0);

  const pendingInteraction = interactions.find((x) => x.status === 'pending');
  const canPause = task.status === 'in_progress' || task.status === 'testing' || task.status === 'in_review';

  return (
    <div className="flex min-w-0 flex-col gap-3 px-4 pb-6">
      {/* 头部：标题/描述/状态控制 */}
      <div className="min-w-0 rounded-lg border border-border bg-card p-3">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="m-0 min-w-0 flex-1 break-words text-base font-semibold">{task.title}</h3>
          <StatusBadge status={task.status} />
          {editable && <Button size="sm" variant="ghost" onClick={() => setEditing(true)}><Pencil className="h-3.5 w-3.5" /> {t('detail.edit')}</Button>}
        </div>
        <p className="mt-1 break-words text-xs text-muted-foreground">{task.description || `(${t('common.empty')})`}</p>
        {task.status === 'testing' && (
          <div className="mt-2 flex items-center gap-1.5 rounded-md border border-[var(--color-lane-testing)]/40 bg-[var(--color-lane-testing)]/10 px-2 py-1.5 text-xs text-[var(--color-lane-testing)]">
            <ShieldQuestion className="h-3.5 w-3.5" /> {t('detail.testing.hint')}
          </div>
        )}
        <div className="mt-2 flex flex-wrap gap-2">
          {task.status === 'ready' && <Button size="sm" disabled={busy || !depsOk} onClick={() => act(() => api.tasks.start(task.id))}><Play className="h-3.5 w-3.5" /> {t('detail.start')}</Button>}
          {task.status === 'in_progress' && <Button size="sm" variant="outline" disabled={busy} onClick={() => act(() => api.tasks.cancel(task.id))}>{t('detail.cancel')}</Button>}
          {(task.status === 'ready' || task.status === 'in_progress') && task.retryCount > 0 && <Button size="sm" variant="outline" disabled={busy} onClick={() => act(() => api.tasks.retry(task.id))}>{t('detail.retry')}</Button>}
          {canPause && <Button size="sm" variant="outline" disabled={busy} onClick={() => act(() => api.tasks.pause(task.id))}><Pause className="h-3.5 w-3.5" /> {t('detail.pause')}</Button>}
          {task.status === 'in_review' && <Button size="sm" disabled={busy} onClick={() => setConfirmAccept(true)}><CheckCircle2 className="h-3.5 w-3.5" /> {t('detail.archive')}</Button>}
          {task.status === 'in_review' && <Button size="sm" variant="outline" className="text-destructive" disabled={busy} onClick={() => setRejectOpen(true)}><XCircle className="h-3.5 w-3.5" /> {t('detail.reject')}</Button>}
        </div>
        <div className="mt-2 grid grid-cols-[100px_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
          <span className="text-muted-foreground">{t('detail.retryCount')}</span><span>{task.retryCount}</span>
          <span className="text-muted-foreground">{t('detail.statusChangedAt')}</span><span>{fmtTime(task.statusChangedAt)}</span>
          <span className="text-muted-foreground">{t('detail.createdAt')}</span><span>{fmtTime(task.createdAt)}</span>
          <span className="text-muted-foreground">{t('detail.worktree')}</span><span className="break-all">{task.worktreePath ?? t('detail.worktree.none')}</span>
        </div>
        {error && <div className="mt-2 break-words rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">{error}</div>}
      </div>

      {/* 关联：需求 + 同级子任务 */}
      {requirement && (
        <div className="min-w-0 rounded-lg border border-border bg-card p-3">
          <h4 className="mt-0 text-xs font-semibold text-muted-foreground">{t('detail.linkage.req')}</h4>
          <div className="break-words text-sm">{requirement.title}{requirement.archived && <Badge variant="success" className="ml-2 text-[10px]">{t('ws.archived')}</Badge>}</div>
          <Separator className="my-2" />
          <Separator className="my-2" />
          <button
            className="flex w-full items-center gap-1.5 text-xs font-semibold text-muted-foreground"
            onClick={() => setSiblingsCollapsed((c) => !c)}
            aria-expanded={!siblingsCollapsed}
          >
            {siblingsCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            {t('detail.linkage.siblings')} ({siblings.length})
          </button>
          {!siblingsCollapsed && (
            <div className="mt-1 flex flex-col gap-1">
              {siblings.length === 0 ? <span className="text-xs text-muted-foreground">{t('common.empty')}</span> : siblings.map((s) => (
                <div key={s.id} className="flex min-w-0 items-center gap-2 text-xs">
                  <StatusBadge status={s.status} />
                  <span className="truncate">{s.title}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 依赖状态 */}
      {depIds.length > 0 && (
        <div className="min-w-0 rounded-lg border border-border bg-card p-3">
          <h4 className="mt-0 text-xs font-semibold text-muted-foreground">{t('detail.dependsOn')}</h4>
          <div className="mt-1 flex flex-col gap-1">
            {presentDeps.map((p) => (
              <div key={p.id} className="flex min-w-0 items-center gap-2 text-xs">
                <StatusBadge status={p.status} />
                <span className="truncate">{p.title}</span>
              </div>
            ))}
            {missingCount > 0 && <div className="text-xs text-destructive">{t('detail.dependsOn.missing')}</div>}
          </div>
          <div className={`mt-1.5 break-words text-xs ${depsOk ? 'text-ok' : 'text-warn'}`}>
            {depsOk
              ? t('detail.dependsOn.ready')
              : t('detail.dependsOn.blocked', { names: blockedDeps.map((b) => b.title).join('、') })}
          </div>
        </div>
      )}

      {/* 对话窗口：统一聊天界面（消息气泡 + 工具卡片 + 自动滚动）；底部 Composer 仅 awaiting_input 出现 */}
      <div className="flex min-w-0 flex-col rounded-lg border border-border bg-card p-3">
        <h4 className="mt-0 text-sm font-semibold">{t('detail.conversation')}</h4>
        <ChatThread
          className="mt-1"
          items={messages.map(taskMessageToItem)}
          placeholder={t('detail.conversation.empty')}
          thinkingLabel={t('detail.conversation.empty')}
          footer={task.status === 'awaiting_input' ? (
            <Composer
              interaction={pendingInteraction}
              legacyPending={pending}
              busy={busy}
              onResolve={(response) => act(async () => {
                if (pendingInteraction) await api.tasks.resolveInteraction(task.id, pendingInteraction.id, response);
              })}
              onResume={(ans) => act(async () => { await api.tasks.resume(task.id, ans); })}
            />
          ) : undefined}
        />
      </div>

      {/* 执行记录：可折叠区域 */}
      <div className="min-w-0 rounded-lg border border-border bg-card p-3">
        <button className="flex w-full items-center gap-1.5 text-sm font-semibold" onClick={() => setShowHistory((v) => !v)}>
          {showHistory ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          {showHistory ? t('detail.history.hide') : t('detail.history.show')}
        </button>
        {showHistory && (
          <div className="mt-2 min-w-0">
            <h4 className="text-xs font-semibold text-muted-foreground">{t('detail.logs')}</h4>
            <div className="mt-1 max-h-40 overflow-auto rounded p-2 font-mono text-xs scrollbar-thin" style={{ backgroundColor: 'var(--console-bg)', color: 'var(--console-fg)' }}>
              {logs.length === 0 ? <span className="text-muted-foreground">{t('detail.logs.empty')}</span> :
                logs.map((l) => <div key={l.id} className={`log-line-${l.level} whitespace-pre-wrap break-all`}>[{new Date(l.t).toLocaleTimeString()}] {l.text}</div>)}
            </div>
            <h4 className="mt-3 text-xs font-semibold text-muted-foreground">{t('detail.history')}</h4>
            {execs.length === 0 ? <EmptyState title={t('detail.history.empty')} /> : (
              <div className="mt-1 overflow-x-auto scrollbar-thin">
                <table className="w-full min-w-[560px] text-xs">
                  <thead><tr><th className="text-left text-muted-foreground">{t('detail.col.attempt')}</th><th className="text-left text-muted-foreground">{t('detail.col.status')}</th><th className="text-left text-muted-foreground">{t('detail.col.started')}</th><th className="text-left text-muted-foreground">{t('detail.col.ended')}</th><th className="text-left text-muted-foreground">{t('detail.col.summary')}</th></tr></thead>
                  <tbody>
                    {execs.map((e) => (
                      <tr key={e.id} className="border-t border-border">
                        <td>{e.attempt}</td>
                        <td><Badge variant={e.status === 'succeeded' ? 'success' : e.status === 'failed' ? 'error' : 'warning'}>{e.status}</Badge></td>
                        <td className="whitespace-nowrap">{fmtTime(e.startedAt)}</td>
                        <td className="whitespace-nowrap">{fmtTime(e.endedAt)}</td>
                        <td className="max-w-[240px] break-all text-muted-foreground">{e.summary ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {editing && <EditTaskDialog task={task} siblings={siblings} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); load(); onChanged(); }} />}

      {/* 验收通过并归档：二次确认 */}
      <Dialog open={confirmAccept} onOpenChange={setConfirmAccept}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{t('detail.archive.confirm.title')}</DialogTitle></DialogHeader>
          <p className="break-words text-sm text-muted-foreground">{t('detail.archive.confirm.body')}</p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmAccept(false)}>{t('common.cancel')}</Button>
            <Button disabled={busy} onClick={() => act(async () => { await api.tasks.accept(task.id); setConfirmAccept(false); })}>{t('common.confirm')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 验收不通过退回：原因必填，目标状态可选待开发/开发中（默认开发中） */}
      {rejectOpen && (
        <RejectDialog
          onClose={() => setRejectOpen(false)}
          onSubmit={(reason, target) => act(async () => {
            await api.tasks.reject({ taskId: task.id, reason, target });
            setRejectOpen(false);
          })}
          busy={busy}
        />
      )}
    </div>
  );
}

/** TaskMessage -> 统一 ChatItem 映射：工具调用/结果归并为 tool 卡片（含可展开入参与输出）。 */
function taskMessageToItem(m: TaskMessage): ChatItem {
  const base = { id: m.id };
  if (m.kind === 'error') return { ...base, type: 'error', text: m.text ?? '' };
  if (m.kind === 'status') return { ...base, type: 'status', text: m.text ?? '' };
  if (m.kind === 'tool_call') {
    return { ...base, type: 'tool', toolName: m.toolName, title: m.text, input: m.toolInput };
  }
  if (m.kind === 'tool_result' || m.role === 'tool') {
    return { ...base, type: 'tool', toolName: m.toolName, output: m.toolResult ?? m.text ?? '', isError: m.isError };
  }
  // text / clarification_request / approval_request / confirmation_request 统一按消息气泡渲染。
  return { ...base, type: 'message', role: m.role, text: m.text ?? '' };
}

/** 固定在对话底部的输入/操作区：澄清→文本回复并恢复；授权/确认→明确按钮。 */
function Composer({ interaction, legacyPending, busy, onResolve, onResume }: {
  interaction?: PendingInteraction;
  legacyPending?: PendingQuestion;
  busy: boolean;
  onResolve: (response: string) => void;
  onResume: (answer: string) => void;
}): React.ReactElement {
  const t = useT();
  const [text, setText] = useState('');
  const kind = interaction?.kind;

  if (kind === 'approval') {
    return (
      <div className="mt-2 rounded-md border border-warn/40 bg-warn/10 p-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-warn"><ShieldQuestion className="h-3.5 w-3.5" /> {interaction!.title}</div>
        {interaction!.detail && <div className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded bg-background/60 p-1.5 font-mono text-[11px]">{interaction!.detail}</div>}
        <div className="mt-2 flex justify-end gap-2">
          <Button size="sm" variant="outline" className="text-destructive" disabled={busy} onClick={() => onResolve('deny')}>{t('detail.interaction.deny')}</Button>
          <Button size="sm" disabled={busy} onClick={() => onResolve('allow')}>{t('detail.interaction.approve')}</Button>
        </div>
      </div>
    );
  }
  if (kind === 'confirmation') {
    return (
      <div className="mt-2 rounded-md border border-primary/40 bg-primary/10 p-2">
        <div className="flex items-center gap-1.5 text-xs font-medium"><AlertTriangle className="h-3.5 w-3.5" /> {interaction!.title}</div>
        <div className="mt-2 flex justify-end gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onResolve('cancel')}>{t('detail.interaction.cancel')}</Button>
          <Button size="sm" disabled={busy} onClick={() => onResolve('confirm')}>{t('detail.interaction.confirm')}</Button>
        </div>
      </div>
    );
  }
  // 澄清（含手动暂停创建的澄清交互）或历史 pendingQuestion：文本回复并恢复
  const hint = kind === 'clarification' ? interaction!.title : legacyPending?.question;
  const send = () => {
    const v = text.trim();
    if (!v) return;
    if (kind === 'clarification') onResolve(v);
    else onResume(v);
    setText('');
  };
  return (
    <div className="mt-2 border-t border-border/60 pt-2">
      {hint && <div className="mb-1 flex items-center gap-1.5 break-words text-xs text-muted-foreground"><MessageCircleQuestion className="h-3.5 w-3.5 shrink-0" /> {hint}</div>}
      <div className="flex items-end gap-2">
        <Textarea className="min-h-[38px] flex-1" value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder={t('detail.composer.placeholder')} rows={2} disabled={busy} />
        <Button size="sm" disabled={busy || !text.trim()} onClick={send}><Send className="h-3.5 w-3.5" /> {t('detail.composer.send')}</Button>
      </div>
    </div>
  );
}

/** 验收不通过退回弹窗：原因必填；目标状态可选待开发/开发中（默认开发中）。 */
function RejectDialog({ onClose, onSubmit, busy }: { onClose: () => void; onSubmit: (reason: string, target: 'ready' | 'in_progress') => void; busy: boolean }): React.ReactElement {
  const t = useT();
  const [reason, setReason] = useState('');
  const [target, setTarget] = useState<'ready' | 'in_progress'>('in_progress');
  const [touched, setTouched] = useState(false);
  const reasonOk = reason.trim().length > 0;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{t('detail.reject.title')}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>{t('detail.reject.reason')}</Label>
            <Textarea value={reason} onChange={(e) => { setReason(e.target.value); setTouched(true); }} rows={4} placeholder={t('detail.reject.reason.placeholder')} autoFocus />
            {touched && !reasonOk && <span className="text-xs text-destructive">{t('detail.reject.reasonRequired')}</span>}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>{t('detail.reject.target')}</Label>
            <Select value={target} onValueChange={(v) => setTarget(v as 'ready' | 'in_progress')}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="in_progress">{t('detail.reject.target.in_progress')}</SelectItem>
                <SelectItem value="ready">{t('detail.reject.target.ready')}</SelectItem>
              </SelectContent>
            </Select>
            <span className="text-[11px] text-muted-foreground">{target === 'in_progress' ? t('detail.reject.target.in_progress.hint') : t('detail.reject.target.ready.hint')}</span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="destructive" disabled={busy || !reasonOk} onClick={() => onSubmit(reason.trim(), target)}>{t('detail.reject.submit')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditTaskDialog({ task, siblings, onClose, onSaved }: { task: Task; siblings: Task[]; onClose: () => void; onSaved: () => void }): React.ReactElement {
  const t = useT();
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [typeLabel, setTypeLabel] = useState<TaskTypeLabel | ''>(task.typeLabel ?? '');
  const [dependsOn, setDependsOn] = useState<string[]>(task.dependsOn ?? []);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const toggleDep = (id: string) => setDependsOn((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  const save = async () => {
    setBusy(true); setError(undefined);
    try {
      await api.tasks.update({ id: task.id, title, description, typeLabel: typeLabel || undefined, dependsOn });
      onSaved();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{t('detail.editTitle')}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5"><Label>{t('task.title')}</Label><Input value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          <div className="flex flex-col gap-1.5"><Label>{t('task.description')}</Label><Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} /></div>
          <div className="flex flex-col gap-1.5">
            <Label>{t('task.typeLabel')}</Label>
            <Select value={typeLabel} onValueChange={(v) => setTypeLabel(v as TaskTypeLabel | '')}>
              <SelectTrigger><SelectValue placeholder={t('task.typeLabel.none')} /></SelectTrigger>
              <SelectContent>
                <SelectItem value="">{t('task.typeLabel.none')}</SelectItem>
                <SelectItem value="frontend">{t('task.typeLabel.frontend')}</SelectItem>
                <SelectItem value="backend">{t('task.typeLabel.backend')}</SelectItem>
                <SelectItem value="fullstack">{t('task.typeLabel.fullstack')}</SelectItem>
                <SelectItem value="integration">{t('task.typeLabel.integration')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {siblings.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <Label>{t('task.dependsOn')}</Label>
              <div className="flex flex-col gap-1.5 rounded-md border border-border p-2">
                <span className="text-[11px] text-muted-foreground">{t('task.dependsOn.hint')}</span>
                {siblings.map((s) => (
                  <label key={s.id} className="flex items-center gap-2 text-xs">
                    <Checkbox checked={dependsOn.includes(s.id)} onCheckedChange={() => toggleDep(s.id)} />
                    <span className="truncate">{s.title}</span>
                    <StatusBadge status={s.status} />
                  </label>
                ))}
              </div>
            </div>
          )}
          {error && <div className="text-xs text-destructive">{error}</div>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button disabled={busy || !title} onClick={save}>{t('common.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
