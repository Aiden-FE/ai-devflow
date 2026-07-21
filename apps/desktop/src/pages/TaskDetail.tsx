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
import { Pencil, Pause, Play } from 'lucide-react';
import type { Task, LogEntry, ExecutionRecord, PendingQuestion, Requirement, TaskRole, AgentType } from '@ai-devflow/core';
import { Checkbox } from '../components/ui/checkbox.js';

export function TaskDetail({ taskId, onChanged }: { taskId: string; onChanged: () => void }): React.ReactElement {
  const t = useT();
  const [task, setTask] = useState<Task | undefined>();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [execs, setExecs] = useState<ExecutionRecord[]>([]);
  const [pending, setPending] = useState<PendingQuestion | undefined>();
  const [requirement, setRequirement] = useState<Requirement | undefined>();
  const [siblings, setSiblings] = useState<Task[]>([]);
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const load = async () => {
    const [tg, lg, ex, pn] = await Promise.all([
      api.tasks.get(taskId),
      api.tasks.logs(taskId),
      api.tasks.executions(taskId),
      api.tasks.pendingQuestion(taskId),
    ]);
    setTask(tg); setLogs(lg); setExecs(ex); setPending(pn);
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
    } else if (['task-status', 'task-event', 'task-awaiting', 'task-failed', 'task-canceled'].includes(ev.kind)) {
      load(); onChanged();
    }
  });

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setError(undefined);
    try { await fn(); await load(); onChanged(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  if (!task) return <EmptyState title={t('common.loading')} />;

  const editable = task.status === 'backlog' || task.status === 'ready';

  // 串行依赖状态：前置任务需进入 in_review/archived 才视为完成。
  const depIds = task.dependsOn ?? [];
  const predecessors = depIds.map((id) => siblings.find((s) => s.id === id) ?? null);
  const missingCount = predecessors.filter((p) => p === null).length;
  const presentDeps = predecessors.filter((p): p is Task => !!p);
  const blockedDeps = presentDeps.filter((p) => p.status !== 'in_review' && p.status !== 'archived');
  const depsOk = depIds.length === 0 || (missingCount === 0 && blockedDeps.length === 0);

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
          {task.status === 'in_review' && <Button size="sm" disabled={busy} onClick={() => act(() => api.tasks.updateStatus(task.id, 'archived'))}>{t('detail.archive')}</Button>}
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

      {task.status === 'awaiting_input' && pending && (
        <div className="rounded-lg border border-[var(--color-lane-awaiting)] bg-card p-3">
          <h4 className="mt-0 text-sm font-semibold">{t('detail.pending')}</h4>
          <div className="text-xs text-muted-foreground">{t('detail.pending.askedAt', { t: fmtTime(pending.askedAt) })}</div>
          <p className="mt-1 text-sm">{pending.question}</p>
          {pending.context && <pre className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{pending.context}</pre>}
          <Textarea className="mt-2" value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder={t('detail.pending.answerHint')} rows={3} />
          <div className="mt-2 flex justify-end">
            <Button size="sm" disabled={busy || !answer.trim()} onClick={() => act(async () => { await api.tasks.resume(task.id, answer); setAnswer(''); })}>{t('detail.answerResume')}</Button>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-border bg-card p-3">
        <h4 className="mt-0 text-sm font-semibold">{t('detail.logs')}</h4>
        <div ref={logRef} className="mt-1 h-48 overflow-y-auto rounded bg-[#0a0c10] p-2 font-mono text-xs scrollbar-thin">
          {logs.length === 0 ? <span className="text-muted-foreground">{t('detail.logs.empty')}</span> :
            logs.map((l) => <div key={l.id} className={`log-line-${l.level}`}>[{new Date(l.t).toLocaleTimeString()}] {l.text}</div>)}
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card p-3">
        <h4 className="mt-0 text-sm font-semibold">{t('detail.history')}</h4>
        {execs.length === 0 ? <EmptyState title={t('detail.history.empty')} /> : (
          <table className="w-full text-xs">
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

      {editing && <EditTaskDialog task={task} siblings={siblings} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); load(); onChanged(); }} />}
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
