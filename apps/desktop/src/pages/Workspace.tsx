import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, useAsync, LoadingOrError, EmptyState, LANES, laneForTask, StatusBadge, useStream } from '../lib.js';
import { useT } from '../i18n/index.js';
import { TaskDetail } from './TaskDetail.js';
import { ChatPanel, type ChatPanelMessage } from '../components/ChatPanel.js';
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
import { RejectTaskDialog } from '../components/RejectTaskDialog.js';
import { Plus, MessageSquarePlus, Archive, AlertCircle, Info, Maximize2, Minimize2, ChevronDown, ChevronRight, FolderOpen, Trash2, Loader2, Zap } from 'lucide-react';
import {
  boardDropAction,
  isBoardDraggable,
  type AiTaskProposal,
  type BoardDropAction,
  type Iteration,
  type Project,
  type Requirement,
  type Task,
  type TaskStatus,
  type TaskTypeLabel,
} from '@ai-devflow/core';
import type { AskTabs, AskAnswer } from '../../electron/api.js';

export function WorkspacePage({ project, projects, onSwitchProject, onNavigateSettings }: {
  project?: Project;
  projects: Project[];
  onSwitchProject: (id: string) => void;
  onNavigateSettings?: () => void;
}): React.ReactElement {
  const t = useT();
  const [error, setError] = useState<string | undefined>();
  const activeProject = project ?? projects[0];
  const iterationsQ = useAsync(() => (activeProject ? api.iterations.list(activeProject.id) : Promise.resolve([])), [activeProject?.id]);
  const [iterationId, setIterationId] = useState<string | undefined>(undefined);
  const iterations = iterationsQ.data ?? [];
  const activeIter = iterationId ?? iterations[0]?.id;
  const activeIteration = iterations.find((it) => it.id === activeIter);
  // 归档门禁：迭代下所有任务必须已归档（空迭代视为满足）。
  const archiveTasksQ = useAsync(() => (activeIter ? api.tasks.listByIteration(activeIter) : Promise.resolve([])), [activeIter]);
  const archiveTasks = archiveTasksQ.data ?? [];
  const allArchived = archiveTasks.length > 0 && archiveTasks.every((t) => t.status === 'archived');
  const canArchive = !!activeIteration && activeIteration.status === 'active' && (archiveTasks.length === 0 || allArchived);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const [archiveMsg, setArchiveMsg] = useState<string | undefined>();

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
        <div className="flex-1" />
        <CreateIterationButton projectId={activeProject.id} onCreated={iterationsQ.reload} />
      </div>
      {error && (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="h-4 w-4" /> {error}
        </div>
      )}
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
        {activeIter && (
          <Button
            variant="ghost"
            size="sm"
            disabled={!canArchive}
            title={!canArchive ? (activeIteration?.status === 'archived' ? t('ws.archiveIteration.alreadyArchived') : t('ws.archiveIteration.tasksNotArchived', { n: archiveTasks.filter((t) => t.status !== 'archived').length })) : t('ws.archiveIteration')}
            onClick={() => { setArchiveMsg(undefined); setArchiveConfirmOpen(true); }}
          >
            <Archive className="h-4 w-4" /> {t('ws.archiveIteration')}
          </Button>
        )}
      </div>
      {archiveMsg && (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-border bg-secondary/40 px-3 py-2 text-xs text-muted-foreground">
          <Info className="h-4 w-4" /> {archiveMsg}
        </div>
      )}
      <Dialog open={archiveConfirmOpen} onOpenChange={setArchiveConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('ws.archiveIteration.confirm.title')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <p>{t('ws.archiveIteration.confirm.body', { name: activeIteration?.name ?? '', version: activeIteration?.version ?? '' })}</p>
            <p className="text-xs text-muted-foreground">{t('ws.archiveIteration.confirm.mergeHint')}</p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setArchiveConfirmOpen(false)}>{t('common.cancel')}</Button>
            <Button variant="destructive" onClick={async () => {
              setArchiveConfirmOpen(false);
              setError(undefined);
              setArchiveMsg(undefined);
              try {
                const res = await api.iterations.archive(activeIter!);
                if (!res.ok) {
                  setError(res.reasons.join('；'));
                } else {
                  setArchiveMsg(res.merged ? t('ws.archiveIteration.merged', { version: activeIteration?.version ?? '' }) : t('ws.archiveIteration.mergeSkipped', { reason: res.reason ?? '' }));
                  iterationsQ.reload();
                  archiveTasksQ.reload();
                }
              } catch (e) {
                setError((e as Error).message);
              }
            }}>{t('ws.archiveIteration.confirm.confirm')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {activeIter ? <WorkspaceBody iterationId={activeIter} projectId={activeProject.id} projectPath={activeProject.path} onNavigateSettings={onNavigateSettings} /> : <EmptyState title={t('ws.emptyIteration')} hint={t('ws.emptyIteration.hint')} />}
    </div>
  );
}

function WorkspaceBody({ iterationId, projectId, projectPath, onNavigateSettings }: { iterationId: string; projectId: string; projectPath?: string; onNavigateSettings?: () => void }): React.ReactElement {
  const t = useT();
  const reqsQ = useAsync(() => api.requirements.list(iterationId), [iterationId]);
  const tasksQ = useAsync(() => api.tasks.listByIteration(iterationId), [iterationId]);
  const [selectedTask, setSelectedTask] = useState<string | undefined>(undefined);
  const [createTaskFor, setCreateTaskFor] = useState<string | undefined>(undefined);
  const [dragError, setDragError] = useState<string | undefined>();
  const [draggedTaskId, setDraggedTaskId] = useState<string | undefined>();
  const [pendingDropReject, setPendingDropReject] = useState<{ taskId: string; target: 'ready' | 'in_progress' } | undefined>();
  const [rejectBusy, setRejectBusy] = useState(false);
  const [rejectError, setRejectError] = useState<string | undefined>();
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
    setDraggedTaskId(undefined);
    const action = dropActionFor(tasksQ.data ?? [], taskId, status);
    if (!action) return;
    try {
      if (action.kind === 'start') {
        await api.tasks.start(taskId);
      } else if (action.kind === 'accept') {
        await api.tasks.accept(taskId);
      } else {
        setRejectError(undefined);
        setPendingDropReject({ taskId, target: action.target });
        return;
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
          <CreateReqButton iterationId={iterationId} projectId={projectId} projectPath={projectPath} onCreated={reqsQ.reload} onNavigateSettings={onNavigateSettings} />
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
                  draggedTask={(tasksQ.data ?? []).find((task) => task.id === draggedTaskId)}
                  onSelect={setSelectedTask} onDrop={onDrop} onDragState={setDraggedTaskId} />
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
        <CreateTaskModal requirementId={createTaskFor} projectId={projectId} projectPath={projectPath} onClose={() => setCreateTaskFor(undefined)}
          onCreated={() => { setCreateTaskFor(undefined); tasksQ.reload(); }} />
      )}

      {pendingDropReject && (
        <RejectTaskDialog
          initialTarget={pendingDropReject.target}
          lockedTarget={pendingDropReject.target}
          busy={rejectBusy}
          error={rejectError}
          onClose={() => { setPendingDropReject(undefined); setRejectError(undefined); }}
          onSubmit={async (reason, target) => {
            setRejectBusy(true);
            setRejectError(undefined);
            try {
              await api.tasks.reject({ taskId: pendingDropReject.taskId, reason, target });
              setPendingDropReject(undefined);
              tasksQ.reload();
            } catch (error) {
              setRejectError((error as Error).message);
            } finally {
              setRejectBusy(false);
            }
          }}
        />
      )}
    </div>
  );
}

export function dropActionFor(tasks: Task[], taskId: string, target: TaskStatus): BoardDropAction | undefined {
  const task = tasks.find((candidate) => candidate.id === taskId);
  return task ? boardDropAction(task.status, target) : undefined;
}

function Lane({ status, label, tasks, selectedId, draggedTask, onSelect, onDrop, onDragState }: {
  status: TaskStatus; label: string; tasks: Task[]; selectedId?: string;
  draggedTask?: Task;
  onSelect: (id: string) => void;
  onDrop: (status: TaskStatus, taskId: string) => void;
  onDragState: (id?: string) => void;
}): React.ReactElement {
  const [over, setOver] = useState(false);
  const canDrop = !!draggedTask && boardDropAction(draggedTask.status, status) !== undefined;
  useEffect(() => { if (!canDrop) setOver(false); }, [canDrop]);
  return (
    <div
      data-lane={status}
      className={`min-h-[120px] rounded-md border p-2 ${over ? 'border-primary bg-secondary' : 'border-border bg-secondary/30'}`}
      onDragOver={(e) => { if (canDrop) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        const id = e.dataTransfer.getData('text/plain');
        if (!canDrop || !draggedTask || id !== draggedTask.id) return;
        e.preventDefault();
        setOver(false);
        onDrop(status, id);
      }}
    >
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium" style={{ color: `var(--color-lane-${status})` }}>
        <span className="h-2 w-2 rounded-full" style={{ background: 'currentColor' }} />
        {label} <span className="text-muted-foreground">{tasks.length}</span>
      </h3>
      <div className="flex flex-col gap-1.5">
        {tasks.map((task) => (
          <TaskCard key={task.id} task={task} selected={selectedId === task.id} onSelect={onSelect} onDragState={onDragState} />
        ))}
      </div>
    </div>
  );
}

export function TaskCard({ task, selected, onSelect, onDragState }: {
  task: Task;
  selected: boolean;
  onSelect: (id: string) => void;
  onDragState: (id?: string) => void;
}): React.ReactElement {
  const t = useT();
  const paused = task.status === 'awaiting_input';
  const draggable = isBoardDraggable(task.status);
  return (
    <div
      data-task-card={task.id}
      draggable={draggable}
      onDragStart={(e) => {
        if (!draggable) return;
        e.dataTransfer.setData('text/plain', task.id);
        onDragState(task.id);
      }}
      onDragEnd={() => onDragState(undefined)}
      onClick={() => onSelect(task.id)}
      className={`${draggable ? 'cursor-grab' : 'cursor-pointer'} rounded-md border bg-secondary p-2 text-xs transition-colors hover:border-primary/60 ${selected ? 'border-primary' : 'border-border'} ${paused ? 'ring-1 ring-[var(--color-lane-awaiting)]' : ''}`}
    >
      <div className="break-words font-medium">{task.title}</div>
      <div className="mt-1 flex items-center gap-1.5">
        {paused && <Badge variant="secondary" className="text-[var(--color-lane-awaiting)]">{t('task.awaitingBadge')}</Badge>}
        {task.retryCount > 0 && <span className="text-muted-foreground">{t('task.retry', { n: task.retryCount })}</span>}
      </div>
    </div>
  );
}

export function paginate<T>(items: T[], page: number, pageSize: number): { items: T[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const start = safePage * pageSize;
  return { items: items.slice(start, start + pageSize), totalPages };
}

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

function CreateReqButton({ iterationId, projectId, projectPath, onCreated, onNavigateSettings }: { iterationId: string; projectId: string; projectPath?: string; onCreated: () => void; onNavigateSettings?: () => void }): React.ReactElement {
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

  // 脏状态检测：表单已被编辑（手动填写或 AI 草稿已填入）时，关闭需二次确认防丢失（Issue 4）。
  const dirty = !!(title.trim() || desc.trim() || acceptance.trim()) || priority !== 'medium';
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // 确认放弃后的后续动作（如“去配置”需跳转设置页）。
  const [afterDiscard, setAfterDiscard] = useState<(() => void) | undefined>();
  const requestClose = (after?: () => void) => {
    if (dirty) { setAfterDiscard(() => after); setConfirmDiscard(true); }
    else { setOpen(false); reset(); after?.(); }
  };
  const discard = () => {
    setConfirmDiscard(false); setOpen(false); reset();
    afterDiscard?.(); setAfterDiscard(undefined);
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}><Plus className="h-3.5 w-3.5" /> {t('ws.createReq')}</Button>
      <Dialog open={open} onOpenChange={(o) => { if (o) setOpen(true); else requestClose(); }}>
        <DialogContent className="max-w-[min(1100px,92vw)] w-[92vw] h-[88vh] max-h-[88vh] flex flex-col gap-4 overflow-hidden">
          <DialogHeader className="shrink-0"><DialogTitle>{t('req.ai.twoStepTitle')}</DialogTitle></DialogHeader>
          {appliedHint && <div className="shrink-0 rounded-md border border-ok/30 bg-ok/10 px-3 py-1.5 text-xs text-ok">{t('req.ai.applied')}</div>}
          {/* 中部整体可滚动（Issue 2）：AI 沟通固定高度，确认表单随内容滚动，创建/取消按钮始终可见 */}
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
            {/* Step 1：AI 沟通 */}
            {hasUsableProvider ? (
              <div className="flex h-[42vh] shrink-0 flex-col">
                <AiRefineRequirement
                  projectPath={projectPath}
                  projectId={projectId}
                  onApplied={(p) => {
                    setTitle(p.title); setDesc(p.description); setAcceptance(p.acceptance); setPriority(p.priority);
                    setAppliedHint(true);
                  }}
                />
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 py-6 text-center text-xs text-muted-foreground">
                <span>{t('req.ai.noProvider')}</span>
                <Button size="sm" variant="outline" onClick={() => requestClose(() => onNavigateSettings?.())}>{t('req.ai.goSettings')}</Button>
              </div>
            )}
            {/* Step 2：确认需求（可编辑；草稿到达前为空但允许直接编辑） */}
            <div className="flex flex-col gap-3 border-t border-border pt-3">
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
          </div>
          <DialogFooter className="shrink-0">
            <Button variant="ghost" onClick={() => requestClose()}>{t('common.cancel')}</Button>
            <Button disabled={!title.trim() || !hasUsableProvider} onClick={submit}>{t('common.create')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* 关闭二次确认（Issue 4）：已编辑/已生成内容时提示丢失风险 */}
      <Dialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{t('common.discard.title')}</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">{t('common.discard.body')}</p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDiscard(false)}>{t('common.discard.keep')}</Button>
            <Button variant="destructive" onClick={discard}>{t('common.discard.confirm')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export type AskCardState = { toolUseId: string; tabs: AskTabs; submitted: boolean };

export function AskCard({ state, onSubmit }: { state: AskCardState; onSubmit: (answers: AskAnswer) => void }): React.ReactElement {
  const t = useT();
  const [activeTab, setActiveTab] = useState(0);
  const [error, setError] = useState<string | undefined>();
  const [local, setLocal] = useState<Record<string, Record<string, string | string[]>>>(() => {
    const init: Record<string, Record<string, string | string[]>> = {};
    for (const tab of state.tabs) {
      init[tab.id] = {};
      for (const q of tab.questions) init[tab.id][q.id] = q.kind === 'multi' ? [] : '';
    }
    return init;
  });

  const submit = () => {
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

  if (state.submitted) {
    // 提交后 AI 仍在继续处理（chat 流未结束）：展示 spinner + 提示，避免“提交后无任何反馈”的干等体验。
    return (
      <div className="flex items-center gap-1.5 rounded-md border border-border bg-secondary/40 p-2 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        {t('chat.ask.submitted')}
      </div>
    );
  }
  const tab = state.tabs[activeTab];
  const lastTab = activeTab >= state.tabs.length - 1;

  return (
    <div className="rounded-md border border-border p-2 text-xs">
      {state.tabs.length > 1 && (
        <div className="flex gap-1 border-b border-border pb-1.5 mb-1.5">
          {state.tabs.map((tb, i) => (
            <button key={tb.id} onClick={() => setActiveTab(i)} className={`px-2 py-0.5 rounded ${i === activeTab ? 'bg-primary text-primary-foreground' : 'bg-secondary'}`}>{tb.title}</button>
          ))}
        </div>
      )}
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
        {state.tabs.length > 1 && !lastTab && <Button size="sm" variant="ghost" onClick={() => setActiveTab((i) => i + 1)}>{t('chat.ask.next')}</Button>}
        <Button size="sm" onClick={submit} disabled={state.tabs.length > 1 && !lastTab}>{t('chat.ask.submit')}</Button>
      </div>
    </div>
  );
}

function AiRefineRequirement({ projectId, projectPath, onApplied }: { projectId: string; projectPath?: string; onApplied: (p: { title: string; description: string; acceptance: string; priority: 'low' | 'medium' | 'high' }) => void }): React.ReactElement {
  const t = useT();
  const [messages, setMessages] = useState<ChatPanelMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [askCards, setAskCards] = useState<Record<string, AskCardState>>({});
  const sessionRef = useRef<string | undefined>(undefined);
  // 当前对话段（两次问答之间）的累计正文/思考：问答卡片插入后重置，
  // 使答复后的增量写入新助手气泡，避免与卡片前的正文重复。
  const segRef = useRef({ text: '', thinking: '' });

  // 把增量同步到末条普通助手消息；末条不是助手消息（如刚插入问答卡片）时追加新气泡。
  const syncAssistant = (patch: { content?: string; thinking?: string }) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === 'assistant' && !('kind' in last)) {
        const next = [...prev];
        next[next.length - 1] = { ...last, ...patch };
        return next;
      }
      return [...prev, { id: `a-${Date.now()}-${prev.length}`, role: 'assistant', content: patch.content ?? '', thinking: patch.thinking ?? '' }];
    });
  };

  const send = async (text: string) => {
    if (streaming) return;
    const userMsg: ChatPanelMessage = { id: `u-${Date.now()}`, role: 'user', content: text };
    const next = [...messages, userMsg];
    segRef.current = { text: '', thinking: '' };
    setMessages(next); setStreaming(true); setError(undefined);
    setMessages([...next, { id: `a-${Date.now()}`, role: 'assistant', content: '', thinking: '' }]);
    try {
      await api.ai.chat(next.map((m) => ({ role: m.role, content: m.content })), (delta) => {
        segRef.current.text += delta;
        syncAssistant({ content: segRef.current.text, thinking: segRef.current.thinking });
      }, {
        mode: 'requirement',
        projectPath,
        projectId,
        // 思考链增量（Issue 5）：实时展示思考细节，思考结束后折叠。
        onThinking: (delta) => {
          segRef.current.thinking += delta;
          syncAssistant({ content: segRef.current.text, thinking: segRef.current.thinking });
        },
        // AI 在需求足够清晰时调用 ai_devflow_propose_requirement 工具生成草稿；
        // 工具结果经事件流回传，直接填入表单，无需用户点“生成需求草稿”按钮。
        onRequirementProposal: (draft) => onApplied(draft),
        onQuestion: (sessionId, toolUseId, tabs) => {
          sessionRef.current = sessionId;
          setAskCards((prev) => ({ ...prev, [toolUseId]: { toolUseId, tabs, submitted: false } }));
          setMessages((prev) => [...prev, { id: `q-${toolUseId}`, role: 'assistant', kind: 'question', content: '' }]);
          // 问答卡片插入后重置段累计：答复后的增量写入新助手气泡。
          segRef.current = { text: '', thinking: '' };
        },
      });
      // 清理既无正文又无思考的空助手气泡（如仅产出草稿未输出文本的轮次）。
      setMessages((prev) => prev.filter((m) => !('kind' in m) && m.role === 'assistant' ? !!(m.content || m.thinking) : true));
    } catch (e) {
      setError((e as Error).message);
      // 流式后错误前已发 delta 会让 assistant 消息非空；标注中断而非删除，避免残留半截无标注文本。
      setMessages((prev) => prev.filter((m) => !('kind' in m) && m.role === 'assistant' ? !!(m.content || m.thinking) : true));
      setMessages((prev) => prev.map((m, i) =>
        i === prev.length - 1 && m.role === 'assistant' && !('kind' in m) && m.content
          ? { ...m, content: `${m.content}\n\n${t('task.ai.interrupted')}` }
          : m,
      ));
    } finally { setStreaming(false); }
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <ChatPanel
        messages={messages}
        onSend={send}
        loading={streaming}
        placeholder={t('req.ai.placeholder')}
        thinkingLabel={t('req.ai.thinking')}
        sendLabel={t('task.ai.send')}
        error={error}
        renderMessage={(msg) => {
          if (!('kind' in msg) || msg.kind !== 'question') return null;
          const card = askCards[msg.id.replace(/^q-/, '')];
          if (!card) return null;
          return (
            <AskCard
              state={card}
              onSubmit={async (answers) => {
                if (!sessionRef.current) return;
                await api.ai.answer(sessionRef.current, card.toolUseId, answers);
                setAskCards((prev) => ({ ...prev, [card.toolUseId]: { ...card, submitted: true } }));
                // 提交后立即插入助手占位气泡（Issue 1）：展示“思考中” spinner，
                // 避免答复后干等无反馈；后续增量经 syncAssistant 写入该气泡。
                setMessages((prev) => [...prev, { id: `a-${Date.now()}-${prev.length}`, role: 'assistant', content: '', thinking: '' }]);
              }}
            />
          );
        }}
      />
    </div>
  );
}

export function CreateTaskModal({ requirementId, projectId, projectPath, onClose, onCreated }: { requirementId: string; projectId: string; projectPath?: string; onClose: () => void; onCreated: (taskId: string) => void }): React.ReactElement {
  const t = useT();
  const [mode, setMode] = useState<'manual' | 'ai'>('ai');
  // 加载当前需求与已有兄弟任务：AI 生成带入需求上下文；手动创建可选择前置依赖。
  const reqQ = useAsync(() => api.requirements.get(requirementId), [requirementId]);
  const sibsQ = useAsync(() => api.tasks.listByRequirement(requirementId), [requirementId]);
  const requirement = reqQ.data;
  const siblings = sibsQ.data ?? [];
  // 脏状态（Issue 4）：子组件上报是否已编辑/已生成内容；关闭时二次确认防丢失。
  const [dirty, setDirty] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const requestClose = () => {
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };
  return (
    <>
      <Dialog open onOpenChange={(o) => { if (!o) requestClose(); }}>
        <DialogContent className="max-w-[min(1100px,92vw)] w-[92vw] h-[88vh] max-h-[88vh] flex flex-col gap-4 overflow-hidden">
          <DialogHeader className="shrink-0"><DialogTitle>{t('task.create')}</DialogTitle></DialogHeader>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant={mode === 'manual' ? 'default' : 'outline'} onClick={() => setMode('manual')}>{t('task.create')}</Button>
            <Button size="sm" variant={mode === 'ai' ? 'default' : 'outline'} onClick={() => setMode('ai')}><MessageSquarePlus className="h-4 w-4" /> {t('task.ai.create')}</Button>
          </div>
          {mode === 'manual'
            ? <ManualCreateTask requirementId={requirementId} siblings={siblings} onCancel={requestClose} onDirtyChange={setDirty} onCreated={onCreated} />
            : <AiCreateTask requirementId={requirementId} requirement={requirement} projectId={projectId} projectPath={projectPath} onDirtyChange={setDirty} onCreated={onCreated} />}
        </DialogContent>
      </Dialog>
      {/* 关闭二次确认（Issue 4）：已编辑/已生成内容时提示丢失风险 */}
      <Dialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{t('common.discard.title')}</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">{t('common.discard.body')}</p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDiscard(false)}>{t('common.discard.keep')}</Button>
            <Button variant="destructive" onClick={() => { setConfirmDiscard(false); onClose(); }}>{t('common.discard.confirm')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ManualCreateTask({ requirementId, siblings, onCancel, onDirtyChange, onCreated }: { requirementId: string; siblings: Task[]; onCancel: () => void; onDirtyChange?: (dirty: boolean) => void; onCreated: (taskId: string) => void }): React.ReactElement {
  const t = useT();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [typeLabel, setTypeLabel] = useState<TaskTypeLabel | ''>('');
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const toggleDep = (id: string) => setDependsOn((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  // 脏状态上报（Issue 4）：任一字段已填写时关闭需二次确认。
  const dirty = !!(title.trim() || description.trim() || typeLabel) || dependsOn.length > 0;
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);
  const submit = async () => {
    const task = await api.tasks.create({ requirementId, title, description, typeLabel: typeLabel || undefined, dependsOn: dependsOn.length ? dependsOn : undefined });
    onCreated(task.id);
  };
  return (
    <div className="mt-3 flex min-h-0 flex-1 flex-col">
      {/* 字段区可滚动（Issue 2）：依赖多/描述长时不遮挡底部创建/取消按钮 */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
        <div className="flex flex-col gap-1.5"><Label>{t('task.title')}</Label><Input value={title} onChange={(e) => setTitle(e.target.value)} /></div>
        <div className="flex flex-col gap-1.5"><Label>{t('task.description')}</Label><Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} /></div>
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
      </div>
      <DialogFooter className="mt-3 shrink-0">
        <Button variant="ghost" onClick={onCancel}>{t('common.cancel')}</Button>
        <Button disabled={!title} onClick={submit}>{t('common.create')}</Button>
      </DialogFooter>
    </div>
  );
}

export const normalizeAssistantStreamText = (text: string): string => text.trimStart();

export async function cancelActiveAiSession(ref: { current: string | undefined }): Promise<void> {
  const sessionId = ref.current;
  if (!sessionId) return;
  ref.current = undefined;
  await api.ai.cancel(sessionId);
}

export function AiCreateTask({ requirementId, requirement, projectId, projectPath, onDirtyChange, onCreated }: { requirementId: string; requirement?: Requirement; projectId: string; projectPath?: string; onDirtyChange?: (dirty: boolean) => void; onCreated: (taskId: string) => void }): React.ReactElement {
  const t = useT();
  const [messages, setMessages] = useState<ChatPanelMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [proposals, setProposals] = useState<AiTaskProposal[] | undefined>();
  const [creating, setCreating] = useState(false);
  const [askCards, setAskCards] = useState<Record<string, AskCardState>>({});
  const sessionRef = useRef<string | undefined>(undefined);
  const activeSessionRef = useRef<string | undefined>(undefined);
  // 当前对话段（两次问答之间）的累计正文/思考：问答卡片插入后重置，
  // 使答复后的增量写入新助手气泡，避免与卡片前的正文重复。
  const segRef = useRef({ text: '', thinking: '' });
  // 已有子任务：拼入上下文供 task_proposer 避免重复创建，并允许新任务跨批依赖这些 taskId。
  const [existingTasks, setExistingTasks] = useState<Task[]>([]);
  useEffect(() => {
    if (!requirementId) return;
    api.tasks.listByRequirement(requirementId).then(setExistingTasks).catch(() => {});
  }, [requirementId]);
  useEffect(() => () => { void cancelActiveAiSession(activeSessionRef); }, []);

  // 脏状态上报（Issue 4）：已有对话或草稿时关闭需二次确认。
  const dirty = messages.length > 0 || (proposals?.length ?? 0) > 0;
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  // 把当前需求内容作为上下文注入 AI，使拆解对齐需求与验收标准。
  const existingBlock = existingTasks.length > 0
    ? `\n\n【已有子任务】（请勿重复创建，新任务可依赖这些任务，依赖时用其 taskId）\n${existingTasks.map((t) => `- [${t.id}] 「${t.title}」 状态:${t.status} 依赖:[${(t.dependsOn ?? []).join(',')}]`).join('\n')}`
    : '';
  const context = requirement
    ? `【当前需求】\n标题：${requirement.title}\n描述：${requirement.description || '(无)'}\n验收标准：${requirement.acceptance || '(无)'}${existingBlock}`
    : existingBlock || undefined;

  // 把增量同步到末条普通助手消息；末条不是助手消息（如刚插入问答卡片）时追加新气泡。
  const syncAssistant = (patch: { content?: string; thinking?: string }) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === 'assistant' && !('kind' in last)) {
        const next = [...prev];
        next[next.length - 1] = { ...last, ...patch };
        return next;
      }
      return [...prev, { id: `a-${Date.now()}-${prev.length}`, role: 'assistant', content: patch.content ?? '', thinking: patch.thinking ?? '' }];
    });
  };

  // 多轮沟通：研发视角的 task_proposer 会先用 brainstorming 梳理、探索仓库代码、一次一问地澄清，
  // 方案确定后调用 ai_devflow_propose_task 工具产出任务草稿（经 onTaskProposal 回传）。
  const send = async (text: string) => {
    if (streaming) return;
    let requestSessionId: string | undefined;
    const userMsg: ChatPanelMessage = { id: `u-${Date.now()}`, role: 'user', content: text };
    const next = [...messages, userMsg];
    segRef.current = { text: '', thinking: '' };
    setMessages(next); setStreaming(true); setError(undefined);
    setMessages([...next, { id: `a-${Date.now()}`, role: 'assistant', content: '', thinking: '' }]);
    try {
      await api.ai.chat(next.map((m) => ({ role: m.role, content: m.content })), (delta) => {
        segRef.current.text += delta;
        syncAssistant({ content: normalizeAssistantStreamText(segRef.current.text), thinking: segRef.current.thinking });
      }, {
        mode: 'task_proposal',
        context,
        projectPath,
        projectId,
        onSession: (sessionId) => {
          requestSessionId = sessionId;
          activeSessionRef.current = sessionId;
        },
        // 思考链增量（Issue 5）：实时展示思考细节，思考结束后折叠。
        onThinking: (delta) => {
          segRef.current.thinking += delta;
          syncAssistant({ content: normalizeAssistantStreamText(segRef.current.text), thinking: segRef.current.thinking });
        },
        onTaskProposal: (tasks) => setProposals(tasks.map((x) => ({ draftId: x.draftId, title: x.title, description: x.description, typeLabel: x.typeLabel, dependsOn: x.dependsOn })) as AiTaskProposal[]),
        onQuestion: (sessionId, toolUseId, tabs) => {
          sessionRef.current = sessionId;
          setAskCards((prev) => ({ ...prev, [toolUseId]: { toolUseId, tabs, submitted: false } }));
          setMessages((prev) => [...prev, { id: `q-${toolUseId}`, role: 'assistant', kind: 'question', content: '' }]);
          // 问答卡片插入后重置段累计：答复后的增量写入新助手气泡。
          segRef.current = { text: '', thinking: '' };
        },
      });
      // 清理既无正文又无思考的空助手气泡（如仅产出草稿未输出文本的轮次）。
      setMessages((prev) => prev.filter((m) => !('kind' in m) && m.role === 'assistant' ? !!(m.content || m.thinking) : true));
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setError((e as Error).message);
      setMessages((prev) => prev.filter((m) => !('kind' in m) && m.role === 'assistant' ? !!(m.content || m.thinking) : true));
      setMessages((prev) => prev.map((m, i) =>
        i === prev.length - 1 && m.role === 'assistant' && !('kind' in m) && m.content
          ? { ...m, content: `${m.content}\n\n${t('task.ai.interrupted')}` }
          : m,
      ));
    } finally {
      if (activeSessionRef.current === requestSessionId) activeSessionRef.current = undefined;
      setStreaming(false);
    }
  };

  // 一键生成（Issue 3）：需求已足够清晰时无需补充描述，直接基于需求上下文生成任务草稿。
  const quickGenerate = () => send(t('task.ai.quickGenerate.prompt'));

  // 逐条编辑草稿。
  const updateDraft = (draftId: string, patch: Partial<AiTaskProposal>) => {
    setProposals((prev) => prev?.map((p) => (p.draftId === draftId ? { ...p, ...patch } : p)));
  };
  const deleteDraft = (draftId: string) => {
    setProposals((prev) => prev?.filter((p) => p.draftId !== draftId));
  };
  const addDraft = () => {
    const draftId = `draft-${Date.now()}`;
    setProposals((prev) => [...(prev ?? []), { draftId, title: '', description: '', dependsOn: [] }]);
  };

  const createAll = async () => {
    if (!proposals || proposals.length === 0) return;
    const valid = proposals.filter((p) => p.title.trim());
    if (valid.length === 0) { setError(t('task.ai.proposals')); return; }
    if (!confirm(t('task.ai.createAll.confirm'))) return;
    setCreating(true); setError(undefined);
    try {
      // 事务化批量创建：主进程把 dependsOn 的草稿引用映射为真实 taskId 并原子落库。
      // 无依赖任务保持并行，仅为真实串行关系建立依赖（无需手动“串行”开关）。
      const created = await api.tasks.createBatch({ requirementId, proposals: valid });
      onCreated(created[created.length - 1]?.id ?? '');
    } catch (e) { setError((e as Error).message); }
    finally { setCreating(false); }
  };

  return (
    <div className="flex flex-col gap-3 flex-1 min-h-0">
      {requirement && (
        <div className="shrink-0 rounded-md border border-border bg-secondary/40 p-2 text-xs">
          <span className="text-muted-foreground">{t('detail.linkage.req')}：</span>{requirement.title}
        </div>
      )}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <ChatPanel
          messages={messages}
          onSend={send}
          loading={streaming}
          placeholder={t('task.ai.placeholder')}
          thinkingLabel={t('task.ai.thinking')}
          sendLabel={t('task.ai.send')}
          error={error}
          emptyAction={requirement ? (
            <div className="flex flex-col items-center gap-1.5">
              <Button size="sm" onClick={quickGenerate} disabled={streaming} data-testid="quick-generate">
                <Zap className="h-3.5 w-3.5" /> {t('task.ai.quickGenerate')}
              </Button>
              <span className="text-[11px]">{t('task.ai.quickGenerate.hint')}</span>
            </div>
          ) : undefined}
          renderMessage={(msg) => {
            if (!('kind' in msg) || msg.kind !== 'question') return null;
            const card = askCards[msg.id.replace(/^q-/, '')];
            if (!card) return null;
            return (
              <AskCard
                state={card}
                onSubmit={async (answers) => {
                  if (!sessionRef.current) return;
                  await api.ai.answer(sessionRef.current, card.toolUseId, answers);
                  setAskCards((prev) => ({ ...prev, [card.toolUseId]: { ...card, submitted: true } }));
                  // 提交后立即插入助手占位气泡（Issue 1）：展示“思考中” spinner，
                  // 避免答复后干等无反馈；后续增量经 syncAssistant 写入该气泡。
                  setMessages((prev) => [...prev, { id: `a-${Date.now()}-${prev.length}`, role: 'assistant', content: '', thinking: '' }]);
                }}
              />
            );
          }}
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
                <Select value={p.typeLabel ?? ''} onValueChange={(v) => updateDraft(p.draftId, { typeLabel: (v || undefined) as TaskTypeLabel | undefined })}>
                  <SelectTrigger className="h-7 w-24"><SelectValue placeholder={t('task.typeLabel.none')} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">{t('task.typeLabel.none')}</SelectItem>
                    <SelectItem value="frontend">{t('task.typeLabel.frontend')}</SelectItem>
                    <SelectItem value="backend">{t('task.typeLabel.backend')}</SelectItem>
                    <SelectItem value="fullstack">{t('task.typeLabel.fullstack')}</SelectItem>
                    <SelectItem value="integration">{t('task.typeLabel.integration')}</SelectItem>
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

export type { Project, Iteration, Requirement, Task };
