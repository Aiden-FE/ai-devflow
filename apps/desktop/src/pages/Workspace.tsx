import React, { useMemo, useState } from 'react';
import { api, useAsync, LoadingOrError, EmptyState, LANES, laneForTask, AgentBadge, StatusBadge, useStream } from '../lib.js';
import { useT } from '../i18n/index.js';
import { TaskDetail } from './TaskDetail.js';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { Textarea } from '../components/ui/textarea.js';
import { Badge } from '../components/ui/badge.js';
import { Checkbox } from '../components/ui/checkbox.js';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '../components/ui/select.js';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '../components/ui/dialog.js';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from '../components/ui/sheet.js';
import { ScrollArea } from '../components/ui/scroll-area.js';
import { Plus, MessageSquarePlus, Archive, AlertCircle, Maximize2, Minimize2 } from 'lucide-react';
import type { Project, Iteration, Requirement, Task, TaskStatus, TaskRole, AgentType, AiTaskProposal } from '@ai-devflow/core';

export function WorkspacePage({ project, projects, onSwitchProject }: {
  project?: Project;
  projects: Project[];
  onSwitchProject: (id: string) => void;
}): React.ReactElement {
  const t = useT();
  const activeProject = project ?? projects[0];
  const iterationsQ = useAsync(() => (activeProject ? api.iterations.list(activeProject.id) : Promise.resolve([])), [activeProject?.id]);
  const [iterationId, setIterationId] = useState<string | undefined>(undefined);
  const iterations = iterationsQ.data ?? [];
  const activeIter = iterationId ?? iterations[0]?.id;

  if (!activeProject) {
    return <EmptyState title={t('nav.projects')} hint={t('ws.emptyIteration.hint')} />;
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select value={activeProject.id} onValueChange={onSwitchProject}>
          <SelectTrigger className="h-9 w-56"><SelectValue /></SelectTrigger>
          <SelectContent>
            {projects.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <div className="text-xs text-muted-foreground">{activeProject.path}</div>
        <div className="flex-1" />
        <CreateIterationButton projectId={activeProject.id} onCreated={iterationsQ.reload} />
      </div>
      <div className="mb-3 flex items-center gap-2">
        <Select value={activeIter ?? ''} onValueChange={setIterationId}>
          <SelectTrigger className="h-9 w-64">
            <SelectValue placeholder={t('ws.noIteration')} />
          </SelectTrigger>
          <SelectContent>
            {iterations.length === 0 && <SelectItem value="" disabled>{t('ws.noIteration')}</SelectItem>}
            {iterations.map((it) => (
              <SelectItem key={it.id} value={it.id}>
                {it.name} · {it.version}{it.status === 'archived' ? ` ${t('ws.archivedIter')}` : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {activeIter && <Button variant="ghost" size="sm" onClick={async () => { await api.iterations.archive(activeIter); iterationsQ.reload(); }}><Archive className="h-4 w-4" /> {t('ws.archiveIteration')}</Button>}
      </div>
      {activeIter ? <WorkspaceBody iterationId={activeIter} /> : <EmptyState title={t('ws.emptyIteration')} hint={t('ws.emptyIteration.hint')} />}
    </div>
  );
}

function WorkspaceBody({ iterationId }: { iterationId: string }): React.ReactElement {
  const t = useT();
  const reqsQ = useAsync(() => api.requirements.list(iterationId), [iterationId]);
  const tasksQ = useAsync(() => api.tasks.listByIteration(iterationId), [iterationId]);
  const [selectedTask, setSelectedTask] = useState<string | undefined>(undefined);
  const [createTaskFor, setCreateTaskFor] = useState<string | undefined>(undefined);
  const [dragError, setDragError] = useState<string | undefined>();
  const [showArchived, setShowArchived] = useState(false);
  // 侧滑窗放大/还原（item 10）：默认约 640px；放大后覆盖除左侧 220px 菜单栏外的工作台。
  const [zoomed, setZoomed] = useState(false);

  useStream(() => tasksQ.reload());

  const tasksByLane = useMemo(() => {
    const map: Record<TaskStatus, Task[]> = { backlog: [], ready: [], in_progress: [], testing: [], in_review: [], awaiting_input: [], archived: [] };
    for (const task of tasksQ.data ?? []) map[laneForTask(task)].push(task);
    return map;
  }, [tasksQ.data]);

  const onDrop = async (status: TaskStatus, taskId: string) => {
    setDragError(undefined);
    try {
      if (status === 'in_progress') {
        // 拖入"开发中"= 启动任务（分派 Agent、创建 worktree、运行流水线）。
        // 仅 updateStatus 只会改状态而不会真正执行，故走 start；串行依赖由 orchestrator 校验。
        await api.tasks.start(taskId);
      } else {
        await api.tasks.updateStatus(taskId, status);
      }
      tasksQ.reload();
    } catch (e) { setDragError((e as Error).message); }
  };

  const reqs = reqsQ.data ?? [];
  const visibleReqs = showArchived ? reqs : reqs.filter((r) => !r.archived);

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-border bg-card p-3">
        <div className="mb-2 flex items-center gap-2">
          <h3 className="m-0 text-sm font-semibold">{t('ws.requirements')}</h3>
          <div className="flex-1" />
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Checkbox checked={showArchived} onCheckedChange={(v) => setShowArchived(v === true)} />
            {showArchived ? t('ws.hideArchived') : t('ws.showArchived')}
          </label>
          <CreateReqButton iterationId={iterationId} onCreated={reqsQ.reload} />
        </div>
        <LoadingOrError loading={reqsQ.loading} error={reqsQ.error} data={visibleReqs} reload={reqsQ.reload}>
          {(rs) => (
            <div className="flex flex-col gap-2">
              {rs.map((r) => (
                <ReqItem key={r.id} req={r} tasks={tasksQ.data ?? []}
                  onCreateTask={() => setCreateTaskFor(r.id)}
                  onArchived={() => { reqsQ.reload(); tasksQ.reload(); }} />
              ))}
            </div>
          )}
        </LoadingOrError>
      </div>

      {dragError && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="h-4 w-4" /> {t('ws.dragRejected', { msg: dragError })}
        </div>
      )}

      <div className="rounded-lg border border-border bg-card p-3">
        <h3 className="mt-0 text-sm font-semibold">{t('ws.kanban')} <span className="ml-1 text-xs font-normal text-muted-foreground">{t('ws.kanban.hint')}</span></h3>
        <LoadingOrError loading={tasksQ.loading} error={tasksQ.error} data={tasksQ.data} reload={tasksQ.reload}>
          {() => (
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-2 items-start">
              {LANES.map((lane) => (
                <Lane key={lane.status} status={lane.status} label={t(lane.labelKey)}
                  tasks={tasksByLane[lane.status]} selectedId={selectedTask}
                  onSelect={setSelectedTask} onDrop={onDrop} />
              ))}
            </div>
          )}
        </LoadingOrError>
      </div>

      {/* 任务详情：侧滑窗。放大后覆盖除左侧 220px 菜单栏外的工作台；蒙版只盖住工作台区域。 */}
      <Sheet open={!!selectedTask} onOpenChange={(o) => { if (!o) { setSelectedTask(undefined); setZoomed(false); } }}>
        <SheetContent
          overlayClassName="left-0 sm:left-[220px]"
          className={zoomed
            ? 'w-[calc(100vw-0px)] sm:w-[calc(100vw-220px)] max-w-none sm:max-w-none'
            : 'w-[640px] max-w-[90vw] sm:max-w-[640px]'}
        >
          <SheetHeader className="shrink-0">
            <div className="flex items-center gap-2 pr-8">
              <SheetTitle className="min-w-0 flex-1 truncate">{t('nav.workspace')}</SheetTitle>
              <Button size="icon-xs" variant="ghost" onClick={() => setZoomed((z) => !z)} title={zoomed ? t('detail.zoom.restore') : t('detail.zoom.expand')}>
                {zoomed ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </Button>
            </div>
          </SheetHeader>
          {selectedTask && (
            <ScrollArea className="min-h-0 min-w-0 flex-1">
              <TaskDetail taskId={selectedTask} onChanged={tasksQ.reload} />
            </ScrollArea>
          )}
        </SheetContent>
      </Sheet>

      {createTaskFor && (
        <CreateTaskModal requirementId={createTaskFor} onClose={() => setCreateTaskFor(undefined)}
          onCreated={() => { setCreateTaskFor(undefined); tasksQ.reload(); }} />
      )}
    </div>
  );
}

function Lane({ status, label, tasks, selectedId, onSelect, onDrop }: {
  status: TaskStatus; label: string; tasks: Task[]; selectedId?: string;
  onSelect: (id: string) => void; onDrop: (status: TaskStatus, taskId: string) => void;
}): React.ReactElement {
  const [over, setOver] = useState(false);
  return (
    <div
      data-lane={status}
      className={`min-h-[120px] rounded-md border p-2 ${over ? 'border-primary bg-secondary' : 'border-border bg-secondary/30'}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const id = e.dataTransfer.getData('text/plain'); if (id) onDrop(status, id); }}
    >
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium" style={{ color: `var(--color-lane-${status})` }}>
        <span className="h-2 w-2 rounded-full" style={{ background: 'currentColor' }} />
        {label} <span className="text-muted-foreground">{tasks.length}</span>
      </h3>
      <div className="flex flex-col gap-1.5">
        {tasks.map((task) => (
          <TaskCard key={task.id} task={task} selected={selectedId === task.id} onSelect={onSelect} />
        ))}
      </div>
    </div>
  );
}

function TaskCard({ task, selected, onSelect }: { task: Task; selected: boolean; onSelect: (id: string) => void }): React.ReactElement {
  const t = useT();
  const paused = task.status === 'awaiting_input';
  return (
    <div
      data-task-card={task.id}
      draggable
      onDragStart={(e) => e.dataTransfer.setData('text/plain', task.id)}
      onClick={() => onSelect(task.id)}
      className={`cursor-grab rounded-md border bg-secondary p-2 text-xs transition-colors hover:border-primary/60 ${selected ? 'border-primary' : 'border-border'} ${paused ? 'ring-1 ring-[var(--color-lane-awaiting)]' : ''}`}
    >
      <div className="break-words font-medium">{task.title}</div>
      <div className="mt-1 flex items-center gap-1.5">
        <AgentBadge type={task.agentType} />
        {paused && <Badge variant="secondary" className="text-[var(--color-lane-awaiting)]">{t('task.awaitingBadge')}</Badge>}
        {task.retryCount > 0 && <span className="text-muted-foreground">{t('task.retry', { n: task.retryCount })}</span>}
      </div>
    </div>
  );
}

function ReqItem({ req, tasks, onCreateTask, onArchived }: {
  req: Requirement; tasks: Task[]; onCreateTask: () => void; onArchived: () => void;
}): React.ReactElement {
  const t = useT();
  const [error, setError] = useState<string | undefined>();
  const subtasks = tasks.filter((x) => x.requirementId === req.id);
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
      {/* 关联子任务（需求 -> 任务） */}
      {subtasks.length > 0 && (
        <div className="mt-2 flex flex-col gap-1 border-t border-border/60 pt-2">
          {subtasks.map((s) => (
            <div key={s.id} className="flex items-center gap-2 text-xs">
              <StatusBadge status={s.status} />
              <span className="truncate">{s.title}</span>
            </div>
          ))}
        </div>
      )}
      {error && <div className="mt-1.5 text-xs text-destructive">{error}</div>}
    </div>
  );
}

function CreateIterationButton({ projectId, onCreated }: { projectId: string; onCreated: () => void }): React.ReactElement {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [version, setVersion] = useState('v1');
  const [error, setError] = useState<string | undefined>();
  const submit = async () => {
    try { await api.iterations.create(projectId, name, version); setOpen(false); setName(''); onCreated(); }
    catch (e) { setError((e as Error).message); }
  };
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> {t('ws.createIteration')}</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{t('ws.createIteration')}</DialogTitle></DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5"><Label>{t('iter.name')}</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('iter.name.hint')} /></div>
            <div className="flex flex-col gap-1.5"><Label>{t('iter.version')}</Label><Input value={version} onChange={(e) => setVersion(e.target.value)} /></div>
            {error && <div className="text-xs text-destructive">{error}</div>}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
            <Button disabled={!name} onClick={submit}>{t('common.create')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function CreateReqButton({ iterationId, onCreated }: { iterationId: string; onCreated: () => void }): React.ReactElement {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'manual' | 'ai'>('manual');
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [priority, setPriority] = useState<'low' | 'medium' | 'high'>('medium');
  const [acceptance, setAcceptance] = useState('');
  const [appliedHint, setAppliedHint] = useState(false);

  const reset = () => { setTitle(''); setDesc(''); setAcceptance(''); setPriority('medium'); setMode('manual'); setAppliedHint(false); };

  const submit = async () => {
    await api.requirements.create(iterationId, title, desc, priority, acceptance);
    setOpen(false); reset(); onCreated();
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}><Plus className="h-3.5 w-3.5" /> {t('ws.createReq')}</Button>
      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>{t('ws.createReq')}</DialogTitle></DialogHeader>
          <div className="flex gap-2">
            <Button size="sm" variant={mode === 'manual' ? 'default' : 'outline'} onClick={() => setMode('manual')}>{t('ws.createReq')}</Button>
            <Button size="sm" variant={mode === 'ai' ? 'default' : 'outline'} onClick={() => setMode('ai')}><MessageSquarePlus className="h-4 w-4" /> {t('req.ai.create')}</Button>
          </div>
          {appliedHint && <div className="rounded-md border border-ok/30 bg-ok/10 px-3 py-1.5 text-xs text-ok">{t('req.ai.applied')}</div>}
          {mode === 'manual' ? (
            <div className="flex flex-col gap-3">
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
          ) : (
            <AiRefineRequirement
              onApplied={(p) => {
                setTitle(p.title); setDesc(p.description); setAcceptance(p.acceptance); setPriority(p.priority);
                setMode('manual'); setAppliedHint(true);
              }}
            />
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setOpen(false); reset(); }}>{t('common.cancel')}</Button>
            <Button disabled={!title} onClick={submit}>{t('common.create')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function AiRefineRequirement({ onApplied }: { onApplied: (p: { title: string; description: string; acceptance: string; priority: 'low' | 'medium' | 'high' }) => void }): React.ReactElement {
  const t = useT();
  const [messages, setMessages] = useState<{ role: 'user' | 'assistant'; content: string }[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

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
      }, { mode: 'requirement' });
    } catch (e) {
      setError((e as Error).message);
      setMessages((prev) => prev.filter((m) => !(m.role === 'assistant' && m.content === '')));
    } finally { setStreaming(false); }
  };

  const propose = async () => {
    if (messages.length === 0) return;
    setError(undefined); setBusy(true);
    try {
      const draft = await api.ai.proposeRequirement(messages.filter((m) => m.content));
      onApplied(draft);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="mt-1 flex flex-col gap-3">
      <div className="h-48 overflow-y-auto rounded-md border border-border bg-background p-2 text-xs scrollbar-thin">
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
      <Button size="sm" variant="outline" onClick={propose} disabled={busy || streaming || messages.length === 0}>
        {busy ? t('task.ai.generating') : t('req.ai.propose')}
      </Button>
    </div>
  );
}

function CreateTaskModal({ requirementId, onClose, onCreated }: { requirementId: string; onClose: () => void; onCreated: (taskId: string) => void }): React.ReactElement {
  const t = useT();
  const [mode, setMode] = useState<'manual' | 'ai'>('manual');
  // 加载当前需求与已有兄弟任务：AI 生成带入需求上下文；手动创建可选择前置依赖。
  const reqQ = useAsync(() => api.requirements.get(requirementId), [requirementId]);
  const sibsQ = useAsync(() => api.tasks.listByRequirement(requirementId), [requirementId]);
  const requirement = reqQ.data;
  const siblings = sibsQ.data ?? [];
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{t('task.create')}</DialogTitle></DialogHeader>
        <div className="flex gap-2">
          <Button size="sm" variant={mode === 'manual' ? 'default' : 'outline'} onClick={() => setMode('manual')}>{t('task.create')}</Button>
          <Button size="sm" variant={mode === 'ai' ? 'default' : 'outline'} onClick={() => setMode('ai')}><MessageSquarePlus className="h-4 w-4" /> {t('task.ai.create')}</Button>
        </div>
        {mode === 'manual'
          ? <ManualCreateTask requirementId={requirementId} siblings={siblings} onCreated={onCreated} />
          : <AiCreateTask requirementId={requirementId} requirement={requirement} onCreated={onCreated} />}
      </DialogContent>
    </Dialog>
  );
}

function ManualCreateTask({ requirementId, siblings, onCreated }: { requirementId: string; siblings: Task[]; onCreated: (taskId: string) => void }): React.ReactElement {
  const t = useT();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [role, setRole] = useState<TaskRole>('coder');
  const [agentType, setAgentType] = useState<AgentType | ''>('');
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const toggleDep = (id: string) => setDependsOn((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  const submit = async () => {
    const task = await api.tasks.create({ requirementId, title, description, role, agentType: agentType || undefined, dependsOn: dependsOn.length ? dependsOn : undefined });
    onCreated(task.id);
  };
  return (
    <div className="mt-3 flex flex-col gap-3">
      <div className="flex flex-col gap-1.5"><Label>{t('task.title')}</Label><Input value={title} onChange={(e) => setTitle(e.target.value)} /></div>
      <div className="flex flex-col gap-1.5"><Label>{t('task.description')}</Label><Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} /></div>
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
      <DialogFooter>
        <Button variant="ghost" onClick={() => onCreated('')}>{t('common.cancel')}</Button>
        <Button disabled={!title} onClick={submit}>{t('common.create')}</Button>
      </DialogFooter>
    </div>
  );
}

function AiCreateTask({ requirementId, requirement, onCreated }: { requirementId: string; requirement?: Requirement; onCreated: (taskId: string) => void }): React.ReactElement {
  const t = useT();
  const [messages, setMessages] = useState<{ role: 'user' | 'assistant'; content: string }[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [proposals, setProposals] = useState<AiTaskProposal[] | undefined>();
  const [creating, setCreating] = useState(false);

  // 把当前需求内容作为上下文注入 AI，使生成的任务对齐需求与验收标准。
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

  const propose = async () => {
    if (messages.length === 0) return;
    setError(undefined); setProposals(undefined); setCreating(true);
    try {
      const list = await api.ai.propose(messages.filter((m) => m.content), context);
      setProposals(list);
    } catch (e) { setError((e as Error).message); }
    finally { setCreating(false); }
  };

  const createAll = async () => {
    if (!proposals) return;
    setCreating(true); setError(undefined);
    try {
      // 事务化批量创建：主进程把 dependsOn 的草稿引用映射为真实 taskId 并原子落库。
      // 无依赖任务保持并行，仅为真实串行关系建立依赖（无需手动“串行”开关）。
      const created = await api.tasks.createBatch({ requirementId, proposals });
      onCreated(created[created.length - 1]?.id ?? '');
    } catch (e) { setError((e as Error).message); }
    finally { setCreating(false); }
  };

  const titleOf = (draftId?: string) => proposals?.find((p) => p.draftId === draftId)?.title ?? draftId ?? '';

  return (
    <div className="mt-3 flex flex-col gap-3">
      {requirement && (
        <div className="rounded-md border border-border bg-secondary/40 p-2 text-xs">
          <span className="text-muted-foreground">{t('detail.linkage.req')}：</span>{requirement.title}
        </div>
      )}
      <div className="h-48 overflow-y-auto rounded-md border border-border bg-background p-2 text-xs scrollbar-thin">
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
      <div className="flex gap-2">
        <Input className="flex-1" value={input} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder={t('task.ai.placeholder')} disabled={streaming} />
        <Button size="sm" onClick={send} disabled={streaming || !input.trim()}>{t('task.ai.send')}</Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={propose} disabled={creating || messages.length === 0}>
          {creating ? t('task.ai.generating') : t('task.ai.propose')}
        </Button>
      </div>
      {proposals && (
        <div className="flex flex-col gap-2">
          <div className="text-xs font-medium text-muted-foreground">{t('task.ai.proposals')}</div>
          {proposals.map((p) => (
            <div key={p.draftId} className="rounded-md border border-border p-2 text-xs">
              <div className="flex flex-wrap items-center gap-1 font-medium">
                <span className="break-words">{p.title}</span>
                <Badge variant="outline" className="text-[10px]">{t(`role.${p.role}`)}</Badge>
                {(p.dependsOn?.length ?? 0) > 0 && (
                  <Badge variant="secondary" className="text-[10px]">
                    {t('task.dependsOn')}: {p.dependsOn!.map(titleOf).join('、')}
                  </Badge>
                )}
              </div>
              <div className="mt-0.5 break-words text-muted-foreground">{p.description}</div>
            </div>
          ))}
          <Button size="sm" onClick={createAll} disabled={creating}>{t('task.ai.createAll')}</Button>
        </div>
      )}
    </div>
  );
}

export type { Project, Iteration, Requirement, Task };
