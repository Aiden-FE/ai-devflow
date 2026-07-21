import React, { useEffect, useRef, useState } from 'react';
import { api, StatusBadge, AgentBadge, fmtTime, useStream, EmptyState } from '../lib.js';
import { useT } from '../i18n/index.js';
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
import { Pencil, Pause, Play, ChevronDown, ChevronRight, CheckCircle2, ShieldQuestion, MessageCircleQuestion, AlertTriangle } from 'lucide-react';
import type { Task, LogEntry, ExecutionRecord, PendingQuestion, Requirement, TaskRole, AgentType, TaskMessage, PendingInteraction } from '@ai-devflow/core';
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
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [confirmAccept, setConfirmAccept] = useState(false);
  const convRef = useRef<HTMLDivElement>(null);

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

  // 对话窗口自动滚动到底部
  useEffect(() => {
    if (convRef.current) convRef.current.scrollTop = convRef.current.scrollHeight;
  }, [messages]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setError(undefined);
    try { await fn(); await load(); onChanged(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  if (!task) return <EmptyState title={t('common.loading')} />;

  const editable = task.status === 'ready';

  // 串行依赖状态：前置任务需进入 in_review/archived 才视为完成。
  const depIds = task.dependsOn ?? [];
  const predecessors = depIds.map((id) => siblings.find((s) => s.id === id) ?? null);
  const missingCount = predecessors.filter((p) => p === null).length;
  const presentDeps = predecessors.filter((p): p is Task => !!p);
  const blockedDeps = presentDeps.filter((p) => p.status !== 'in_review' && p.status !== 'archived');
  const depsOk = depIds.length === 0 || (missingCount === 0 && blockedDeps.length === 0);

  const pendingInteraction = interactions.find((x) => x.status === 'pending');

  return (
    <div className="flex flex-col gap-3 px-4 pb-6">
      <div className="rounded-lg border border-border bg-card p-3">
        <div className="flex items-center gap-2">
          <h3 className="m-0 flex-1 text-base font-semibold">{task.title}</h3>
          <StatusBadge status={task.status} />
          <AgentBadge type={task.agentType} />
          {editable && <Button size="sm" variant="ghost" onClick={() => setEditing(true)}><Pencil className="h-3.5 w-3.5" /> {t('detail.edit')}</Button>}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{task.description || `(${t('common.empty')})`}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {task.status === 'ready' && <Button size="sm" disabled={busy || !depsOk} onClick={() => act(() => api.tasks.start(task.id))}><Play className="h-3.5 w-3.5" /> {t('detail.start')}</Button>}
          {task.status === 'in_progress' && <Button size="sm" variant="outline" disabled={busy} onClick={() => act(() => api.tasks.cancel(task.id))}>{t('detail.cancel')}</Button>}
          {(task.status === 'ready' || task.status === 'in_progress') && task.retryCount > 0 && <Button size="sm" variant="outline" disabled={busy} onClick={() => act(() => api.tasks.retry(task.id))}>{t('detail.retry')}</Button>}
          {(task.status === 'in_progress' || task.status === 'in_review') && <Button size="sm" variant="outline" disabled={busy} onClick={() => act(() => api.tasks.pause(task.id))}><Pause className="h-3.5 w-3.5" /> {t('detail.pause')}</Button>}
          {task.status === 'in_review' && <Button size="sm" disabled={busy} onClick={() => setConfirmAccept(true)}><CheckCircle2 className="h-3.5 w-3.5" /> {t('detail.archive')}</Button>}
          {task.status === 'in_review' && <Button size="sm" variant="outline" disabled={busy} onClick={() => act(() => api.tasks.updateStatus(task.id, 'in_progress'))}>{t('detail.testFail')}</Button>}
        </div>
        <div className="mt-2 grid grid-cols-[100px_1fr] gap-x-3 gap-y-0.5 text-xs">
          <span className="text-muted-foreground">{t('detail.retryCount')}</span><span>{task.retryCount}</span>
          <span className="text-muted-foreground">{t('detail.statusChangedAt')}</span><span>{fmtTime(task.statusChangedAt)}</span>
          <span className="text-muted-foreground">{t('detail.createdAt')}</span><span>{fmtTime(task.createdAt)}</span>
          <span className="text-muted-foreground">{t('detail.worktree')}</span><span className="break-all">{task.worktreePath ?? t('detail.worktree.none')}</span>
        </div>
        {error && <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">{error}</div>}
      </div>

      {/* 关联：需求 + 同级子任务 */}
      {requirement && (
        <div className="rounded-lg border border-border bg-card p-3">
          <h4 className="mt-0 text-xs font-semibold text-muted-foreground">{t('detail.linkage.req')}</h4>
          <div className="text-sm">{requirement.title}{requirement.archived && <Badge variant="success" className="ml-2 text-[10px]">{t('ws.archived')}</Badge>}</div>
          <Separator className="my-2" />
          <h4 className="text-xs font-semibold text-muted-foreground">{t('detail.linkage.siblings')} ({siblings.length})</h4>
          <div className="mt-1 flex flex-col gap-1">
            {siblings.length === 0 ? <span className="text-xs text-muted-foreground">{t('common.empty')}</span> : siblings.map((s) => (
              <div key={s.id} className="flex items-center gap-2 text-xs">
                <StatusBadge status={s.status} />
                <span>{s.title}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 串行依赖状态 */}
      {depIds.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-3">
          <h4 className="mt-0 text-xs font-semibold text-muted-foreground">{t('detail.dependsOn')}</h4>
          <div className="mt-1 flex flex-col gap-1">
            {presentDeps.map((p) => (
              <div key={p.id} className="flex items-center gap-2 text-xs">
                <StatusBadge status={p.status} />
                <span>{p.title}</span>
              </div>
            ))}
            {missingCount > 0 && <div className="text-xs text-destructive">{t('detail.dependsOn.missing')}</div>}
          </div>
          <div className={`mt-1.5 text-xs ${depsOk ? 'text-ok' : 'text-warn'}`}>
            {depsOk
              ? t('detail.dependsOn.ready')
              : t('detail.dependsOn.blocked', { names: blockedDeps.map((b) => b.title).join('、') })}
          </div>
        </div>
      )}

      {/* 待处理交互（澄清/授权/确认） */}
      {task.status === 'awaiting_input' && pendingInteraction && (
        <InteractionCard
          interaction={pendingInteraction}
          answer={answer}
          setAnswer={setAnswer}
          busy={busy}
          onResolve={(response) => act(async () => {
            await api.tasks.resolveInteraction(task.id, pendingInteraction.id, response);
            setAnswer('');
          })}
          legacyPending={pending}
          onLegacyResume={(ans) => act(async () => { await api.tasks.resume(task.id, ans); setAnswer(''); })}
        />
      )}
      {/* 兼容旧 pendingQuestion（无对应 interaction 的历史数据） */}
      {task.status === 'awaiting_input' && !pendingInteraction && pending && (
        <div className="rounded-lg border border-[var(--color-lane-awaiting)] bg-card p-3">
          <h4 className="mt-0 flex items-center gap-1.5 text-sm font-semibold"><MessageCircleQuestion className="h-4 w-4" /> {t('detail.pending')}</h4>
          <div className="text-xs text-muted-foreground">{t('detail.pending.askedAt', { t: fmtTime(pending.askedAt) })}</div>
          <p className="mt-1 text-sm">{pending.question}</p>
          {pending.context && <pre className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{pending.context}</pre>}
          <Textarea className="mt-2" value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder={t('detail.pending.answerHint')} rows={3} />
          <div className="mt-2 flex justify-end">
            <Button size="sm" disabled={busy || !answer.trim()} onClick={() => act(async () => { await api.tasks.resume(task.id, answer); setAnswer(''); })}>{t('detail.answerResume')}</Button>
          </div>
        </div>
      )}

      {/* 对话窗口：实时消息，角色清晰，自动滚动，刷新/重启后历史不丢失 */}
      <div className="rounded-lg border border-border bg-card p-3">
        <h4 className="mt-0 text-sm font-semibold">{t('detail.conversation')}</h4>
        <div ref={convRef} className="mt-1 max-h-96 overflow-y-auto rounded bg-console-bg p-2 text-xs scrollbar-thin" style={{ backgroundColor: 'var(--console-bg)', color: 'var(--console-fg)' }}>
          {messages.length === 0 ? <span className="text-muted-foreground">{t('detail.conversation.empty')}</span> :
            messages.map((m) => <MessageBubble key={m.id} m={m} />)}
        </div>
      </div>

      {/* 执行记录：可折叠区域 */}
      <div className="rounded-lg border border-border bg-card p-3">
        <button className="flex w-full items-center gap-1.5 text-sm font-semibold" onClick={() => setShowHistory((v) => !v)}>
          {showHistory ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          {showHistory ? t('detail.history.hide') : t('detail.history.show')}
        </button>
        {showHistory && (
          <div className="mt-2">
            <h4 className="text-xs font-semibold text-muted-foreground">{t('detail.logs')}</h4>
            <div className="mt-1 max-h-40 overflow-y-auto rounded p-2 font-mono text-xs scrollbar-thin" style={{ backgroundColor: 'var(--console-bg)', color: 'var(--console-fg)' }}>
              {logs.length === 0 ? <span className="text-muted-foreground">{t('detail.logs.empty')}</span> :
                logs.map((l) => <div key={l.id} className={`log-line-${l.level}`}>[{new Date(l.t).toLocaleTimeString()}] {l.text}</div>)}
            </div>
            <h4 className="mt-3 text-xs font-semibold text-muted-foreground">{t('detail.history')}</h4>
            {execs.length === 0 ? <EmptyState title={t('detail.history.empty')} /> : (
              <table className="mt-1 w-full text-xs">
                <thead><tr><th className="text-left text-muted-foreground">{t('detail.col.attempt')}</th><th className="text-left text-muted-foreground">{t('detail.col.agent')}</th><th className="text-left text-muted-foreground">{t('detail.col.status')}</th><th className="text-left text-muted-foreground">{t('detail.col.started')}</th><th className="text-left text-muted-foreground">{t('detail.col.ended')}</th><th className="text-left text-muted-foreground">{t('detail.col.summary')}</th></tr></thead>
                <tbody>
                  {execs.map((e) => (
                    <tr key={e.id} className="border-t border-border">
                      <td>{e.attempt}</td>
                      <td>{t(`agent.${e.agentType}`)}</td>
                      <td><Badge variant={e.status === 'succeeded' ? 'success' : e.status === 'failed' ? 'error' : 'warning'}>{e.status}</Badge></td>
                      <td>{fmtTime(e.startedAt)}</td>
                      <td>{fmtTime(e.endedAt)}</td>
                      <td className="text-muted-foreground">{e.summary ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {editing && <EditTaskDialog task={task} siblings={siblings} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); load(); onChanged(); }} />}

      {/* 验收通过并归档：二次确认 */}
      <Dialog open={confirmAccept} onOpenChange={setConfirmAccept}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{t('detail.archive.confirm.title')}</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">{t('detail.archive.confirm.body')}</p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmAccept(false)}>{t('common.cancel')}</Button>
            <Button disabled={busy} onClick={() => act(async () => { await api.tasks.accept(task.id); setConfirmAccept(false); })}>{t('common.confirm')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MessageBubble({ m }: { m: TaskMessage }): React.ReactElement {
  const t = useT();
  const time = new Date(m.t).toLocaleTimeString();
  const roleLabel = t(`detail.msg.${m.role}`);
  if (m.kind === 'error') {
    return (
      <div className="my-1.5 flex justify-center">
        <span className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-destructive">⚠ {m.text} <span className="opacity-60">{time}</span></span>
      </div>
    );
  }
  if (m.kind === 'status' || m.role === 'system') {
    return (
      <div className="my-1.5 flex justify-center">
        <span className="rounded-md bg-secondary/60 px-2 py-1 text-muted-foreground">{m.text} <span className="opacity-60">{time}</span></span>
      </div>
    );
  }
  if (m.kind === 'tool_call') {
    return (
      <div className="my-1">
        <div className="flex items-center gap-1.5 text-muted-foreground"><span className="font-mono text-[10px]">{roleLabel} · {m.toolName ?? 'tool'}</span><span className="opacity-60">{time}</span></div>
        <div className="mt-0.5 rounded-md border border-border bg-secondary/40 px-2 py-1 font-mono">{m.text}{m.toolInput ? <span className="opacity-60"> {truncate(m.toolInput, 160)}</span> : null}</div>
      </div>
    );
  }
  if (m.kind === 'tool_result' || m.role === 'tool') {
    return (
      <div className="my-1">
        <div className="flex items-center gap-1.5 text-muted-foreground"><span className="font-mono text-[10px]">{roleLabel}</span><span className="opacity-60">{time}</span></div>
        <div className={`mt-0.5 rounded-md border px-2 py-1 font-mono ${m.isError ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-border bg-secondary/40'}`}>{m.toolResult ?? m.text}</div>
      </div>
    );
  }
  // user/assistant 文本与请求类消息
  const isUser = m.role === 'user';
  const accent = m.kind === 'clarification_request' ? 'border-[var(--color-lane-awaiting)]'
    : m.kind === 'approval_request' ? 'border-warn'
    : m.kind === 'confirmation_request' ? 'border-primary'
    : 'border-border';
  return (
    <div className={`my-1.5 flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] rounded-md border px-2 py-1 ${accent} ${isUser ? 'bg-primary text-primary-foreground' : 'bg-secondary'}`}>
        <div className="flex items-center gap-1.5 text-[10px] opacity-70"><span>{roleLabel}</span><span>{time}</span>
          {m.kind === 'clarification_request' && <MessageCircleQuestion className="h-3 w-3" />}
          {m.kind === 'approval_request' && <ShieldQuestion className="h-3 w-3" />}
          {m.kind === 'confirmation_request' && <AlertTriangle className="h-3 w-3" />}
        </div>
        <div className="whitespace-pre-wrap">{m.text}{m.toolName ? <span className="font-mono opacity-70"> · {m.toolName}</span> : null}</div>
      </div>
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function InteractionCard({ interaction, answer, setAnswer, busy, onResolve, legacyPending, onLegacyResume }: {
  interaction: PendingInteraction;
  answer: string;
  setAnswer: (s: string) => void;
  busy: boolean;
  onResolve: (response: string) => void;
  legacyPending?: PendingQuestion;
  onLegacyResume: (answer: string) => void;
}): React.ReactElement {
  const t = useT();
  const kindLabel = interaction.kind === 'clarification' ? t('detail.interaction.clarification')
    : interaction.kind === 'approval' ? t('detail.interaction.approval')
    : t('detail.interaction.confirmation');
  return (
    <div className="rounded-lg border border-[var(--color-lane-awaiting)] bg-card p-3">
      <h4 className="mt-0 flex items-center gap-1.5 text-sm font-semibold">
        {interaction.kind === 'approval' ? <ShieldQuestion className="h-4 w-4" /> : interaction.kind === 'clarification' ? <MessageCircleQuestion className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
        {kindLabel}
      </h4>
      <div className="text-xs text-muted-foreground">{fmtTime(interaction.createdAt)}</div>
      <p className="mt-1 text-sm">{interaction.title}</p>
      {interaction.detail && <pre className="mt-1 whitespace-pre-wrap rounded bg-secondary/40 p-2 font-mono text-xs text-muted-foreground">{interaction.detail}</pre>}
      {interaction.kind === 'clarification' && (
        <>
          <Textarea className="mt-2" value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder={t('detail.interaction.answerHint')} rows={3} />
          <div className="mt-2 flex justify-end">
            <Button size="sm" disabled={busy || !answer.trim()} onClick={() => onResolve(answer)}>{t('detail.answerResume')}</Button>
          </div>
        </>
      )}
      {interaction.kind === 'approval' && (
        <>
          <div className="mt-2 rounded-md border border-warn/40 bg-warn/10 px-2 py-1.5 text-xs text-warn">{t('detail.interaction.denyHint')}</div>
          <div className="mt-2 flex justify-end gap-2">
            <Button size="sm" variant="outline" className="text-destructive" disabled={busy} onClick={() => onResolve('deny')}>{t('detail.interaction.deny')}</Button>
            <Button size="sm" disabled={busy} onClick={() => onResolve('allow')}>{t('detail.interaction.approve')}</Button>
          </div>
        </>
      )}
      {interaction.kind === 'confirmation' && (
        <div className="mt-2 flex justify-end gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onResolve('cancel')}>{t('detail.interaction.cancel')}</Button>
          <Button size="sm" disabled={busy} onClick={() => onResolve('confirm')}>{t('detail.interaction.confirm')}</Button>
        </div>
      )}
      {/* legacy 兜底：无交互但有 pendingQuestion 时仍可回答 */}
      {legacyPending && interaction.kind !== 'clarification' && (
        <div className="mt-2 border-t border-border/60 pt-2">
          <Textarea className="mt-1" value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder={t('detail.pending.answerHint')} rows={2} />
          <div className="mt-2 flex justify-end">
            <Button size="sm" variant="ghost" disabled={busy || !answer.trim()} onClick={() => onLegacyResume(answer)}>{t('detail.answerResume')}</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function EditTaskDialog({ task, siblings, onClose, onSaved }: { task: Task; siblings: Task[]; onClose: () => void; onSaved: () => void }): React.ReactElement {
  const t = useT();
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [role, setRole] = useState<TaskRole>(task.role);
  const [agentType, setAgentType] = useState<AgentType | ''>(task.agentType ?? '');
  const [dependsOn, setDependsOn] = useState<string[]>(task.dependsOn ?? []);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const toggleDep = (id: string) => setDependsOn((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  const save = async () => {
    setBusy(true); setError(undefined);
    try {
      await api.tasks.update({ id: task.id, title, description, role, agentType: agentType || null, dependsOn });
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
            <Label>{t('task.role')}</Label>
            <Select value={role} onValueChange={(v) => setRole(v as TaskRole)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="planner">{t('role.planner')}</SelectItem>
                <SelectItem value="coder">{t('role.coder')}</SelectItem>
                <SelectItem value="reviewer">{t('role.reviewer')}</SelectItem>
                <SelectItem value="tester">{t('role.tester')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>{t('task.agent')}</Label>
            <Select value={agentType} onValueChange={(v) => setAgentType(v as AgentType | '')}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="">{t('agent.default')}</SelectItem>
                <SelectItem value="claude_code">{t('agent.claude_code')}</SelectItem>
                <SelectItem value="codex">{t('agent.codex')}</SelectItem>
                <SelectItem value="pi">{t('agent.pi')}</SelectItem>
                <SelectItem value="test">{t('agent.test')}</SelectItem>
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
