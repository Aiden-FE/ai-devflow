import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib.js';
import { useT } from '../i18n/index.js';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../components/ui/select.js';
import { KnowledgeDraftReview } from '../components/knowledge/KnowledgeDraftReview.js';
import { ScanSearch, FolderPlus, Wrench, Check, X, Loader2, AlertTriangle } from 'lucide-react';
import type { KnowledgeHealthSnapshot, KnowledgeRunView, KnowledgeRunKind, KnowledgeRunState, Project } from '@ai-devflow/core';

const TYPE_LABELS: Record<string, string> = {
  context: 'Context', adr: 'ADR', feature: 'Feature', runbook: 'Runbook', product: 'Product', ux: 'UX',
};

const TERMINAL_STATES: ReadonlySet<KnowledgeRunState> = new Set(['succeeded', 'failed', 'canceled']);

function readableRemoteError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(
    /^(?:Error:\s*)?Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,
    '',
  );
}

function confirmationValidationIssues(error: unknown): string[] {
  const message = readableRemoteError(error);
  const marker = '草稿校验阻断：';
  const markerIndex = message.indexOf(marker);
  if (markerIndex < 0) return [];
  const issues = message
    .slice(markerIndex)
    .split(/;\s*(?=草稿校验阻断：)/)
    .map((item) => item.replace(/^草稿校验阻断：\s*/, '').trim())
    .filter(Boolean);
  return [...new Set(issues)];
}

export interface KnowledgePageProps {
  project: Project;
  projects: Project[];
  onSwitchProject(projectId: string): void;
}

export function KnowledgePage({ project, projects, onSwitchProject }: KnowledgePageProps): React.ReactElement {
  const t = useT();
  const [snapshot, setSnapshot] = useState<KnowledgeHealthSnapshot | undefined>(undefined);
  // activeRun: 服务端权威运行态（running/awaiting_confirmation）。切页重进后从 IPC 恢复，避免按钮可重复点击。
  const [activeRun, setActiveRun] = useState<KnowledgeRunView | undefined>(undefined);
  const [selectedFindings, setSelectedFindings] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [confirmationFailure, setConfirmationFailure] = useState<{ runId: string; issues: string[] } | undefined>(undefined);

  // Monotonic request version: shared by the project-change effect and manual
  // refresh so a late response from a previously selected project cannot
  // overwrite the current project's state.
  const requestVersion = useRef(0);

  const refresh = useCallback(async (reset = false) => {
    const version = ++requestVersion.current;
    if (reset) {
      setSnapshot(undefined);
      setActiveRun(undefined);
      setSelectedFindings(new Set());
      setError(undefined);
      setConfirmationFailure(undefined);
    }
    setLoading(true);
    try {
      const [next, active] = await Promise.all([
        api.knowledge.getProjectSnapshot(project.id),
        api.knowledge.getActiveRun(project.id),
      ]);
      if (version === requestVersion.current) {
        setSnapshot(next);
        setActiveRun(active);
      }
    } catch (e) {
      if (version === requestVersion.current) setError((e as Error).message);
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, [project.id]);

  useEffect(() => {
    void refresh(true);
    return () => { requestVersion.current += 1; };
  }, [refresh]);

  // 订阅知识运行事件：实时更新 activeRun，运行结束时自动刷新快照与清空 activeRun。
  useEffect(() => {
    const unsub = api.events.subscribe((ev) => {
      if (ev.kind !== 'knowledge-run' || ev.taskId !== project.id) return;
      const view = ev.data as KnowledgeRunView;
      if (view.projectId !== project.id) return;
      requestVersion.current += 1; // 取消任何在途的旧 refresh，避免覆盖最新事件态
      if (TERMINAL_STATES.has(view.state)) {
        setActiveRun(undefined);
        void refresh();
      } else {
        setActiveRun(view);
        if (view.state === 'awaiting_confirmation') {
          // 草稿就绪后刷新 findings/快照（diff 已随 view 携带）。
          void refresh();
        }
      }
    });
    return unsub;
  }, [project.id, refresh]);

  const startInit = async () => {
    setBusy(true); setError(undefined); setConfirmationFailure(undefined);
    try {
      const run = await api.knowledge.startInitialization(project.id);
      if (!TERMINAL_STATES.has(run.state)) setActiveRun(run);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const startFull = async () => {
    setBusy(true); setError(undefined); setConfirmationFailure(undefined);
    try {
      const run = await api.knowledge.startAudit(project.id, 'full');
      if (!TERMINAL_STATES.has(run.state)) setActiveRun(run);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const startRepair = async () => {
    if (selectedFindings.size === 0) return;
    setBusy(true); setError(undefined); setConfirmationFailure(undefined);
    try {
      const run = await api.knowledge.startRepair(project.id, [...selectedFindings]);
      if (!TERMINAL_STATES.has(run.state)) setActiveRun(run);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const pendingRun = activeRun?.state === 'awaiting_confirmation' ? activeRun : undefined;
  const runningRun = activeRun?.state === 'running' ? activeRun : undefined;
  const validationIssues = pendingRun
    ? confirmationFailure?.runId === pendingRun.id
      ? confirmationFailure.issues
      : [...new Set(
          pendingRun.findings
            .filter((finding) => finding.severity === 'error')
            .map((finding) => finding.message),
        )]
    : [];
  const confirm = async () => {
    if (!pendingRun) return;
    setBusy(true); setError(undefined); setConfirmationFailure(undefined);
    try { await api.knowledge.confirmRun(pendingRun.id); setActiveRun(undefined); void refresh(); }
    catch (e) {
      const issues = confirmationValidationIssues(e);
      if (issues.length > 0) setConfirmationFailure({ runId: pendingRun.id, issues });
      else setError(readableRemoteError(e));
    }
    finally { setBusy(false); }
  };
  const cancel = async () => {
    if (!pendingRun) return;
    setBusy(true); setError(undefined);
    try { await api.knowledge.cancelRun(pendingRun.id); setActiveRun(undefined); void refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const notInitialized = snapshot?.state === 'not_initialized';
  // 任一活跃运行都阻止新知识操作；待确认草稿只能通过确认或取消进入终态。
  const operationDisabled = busy || !!activeRun;
  const switchDisabled = operationDisabled;
  const runKindLabel = (kind: KnowledgeRunKind) => t(`knowledge.runKind.${kind}`);
  const runStateLabel = (state: KnowledgeRunState) => t(`knowledge.runState.${state}`);

  return (
    <div className="flex flex-col gap-4" data-testid="knowledge-shell" data-project-id={project.id}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Select value={project.id} onValueChange={onSwitchProject} disabled={switchDisabled}>
            <SelectTrigger
              className="h-9 w-56"
              aria-label={t('knowledge.project')}
              data-testid="knowledge-project-select"
              title={switchDisabled ? t('knowledge.switchDisabled') : undefined}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="truncate text-xs text-muted-foreground" title={project.path}>{project.path}</span>
        </div>
        <div className="flex gap-2">
          <button className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-secondary disabled:opacity-40" onClick={startFull} disabled={operationDisabled}>
            <ScanSearch className="mr-1 inline h-4 w-4" />{t('knowledge.fullAudit')}
          </button>
          <button
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-secondary disabled:opacity-40"
            onClick={startInit} disabled={operationDisabled || !notInitialized}
          >
            <FolderPlus className="mr-1 inline h-4 w-4" />{t('knowledge.initialize')}
          </button>
          <button
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-secondary disabled:opacity-40"
            onClick={startRepair} disabled={operationDisabled || selectedFindings.size === 0}
          >
            <Wrench className="mr-1 inline h-4 w-4" />{t('knowledge.repair')}
          </button>
        </div>
      </div>

      {loading && !snapshot && (
        <div className="flex h-40 items-center justify-center rounded-md border border-border bg-card text-sm text-muted-foreground">
          {t('knowledge.loading')}
        </div>
      )}

      {/* 进行中运行：用户友好的进度指示，让用户感知后台处理信息（替代无反馈的“按钮又能点击”）。 */}
      {runningRun && (
        <div
          className="flex items-center gap-3 rounded-md border border-border bg-card p-3"
          data-testid="knowledge-run-progress"
          data-run-id={runningRun.id}
          data-run-kind={runningRun.kind}
          data-run-state={runningRun.state}
        >
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          <div className="flex flex-col">
            <span className="text-sm font-medium">{t('knowledge.runProgress')}：{runKindLabel(runningRun.kind)}</span>
            <span className="text-xs text-muted-foreground">{runStateLabel(runningRun.state)}</span>
          </div>
          {runningRun.draftBranch && (
            <span className="ml-auto truncate text-xs text-muted-foreground" title={runningRun.draftBranch}>{runningRun.draftBranch}</span>
          )}
        </div>
      )}

      {snapshot && (
        <div className="rounded-md border border-border bg-card p-3" data-snapshot-project-id={snapshot.projectId}>
          <div className="text-sm text-muted-foreground">{t('knowledge.state')}: <span className="font-medium text-foreground">{snapshot.state}</span></div>
          <div className="mt-2 flex flex-wrap gap-3 text-xs">
            {Object.entries(snapshot.counts).map(([type, n]) => (
              <span key={type} className="rounded bg-secondary/60 px-2 py-0.5">{TYPE_LABELS[type] ?? type}: {n}</span>
            ))}
          </div>
        </div>
      )}

      {pendingRun && (
        <div className="overflow-hidden rounded-md border border-border bg-card">
          <KnowledgeDraftReview
            diff={pendingRun.diff}
            changedPaths={pendingRun.changedPaths}
            draftBranch={pendingRun.draftBranch}
          />
          {validationIssues.length > 0 && (
            <div
              className="flex gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-2.5 text-destructive"
              data-testid="knowledge-draft-validation"
              role="alert"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="min-w-0">
                <div className="text-xs font-medium">{t('knowledge.draft.validationTitle')}</div>
                <div className="mt-0.5 text-xs text-destructive/80">{t('knowledge.draft.validationRetained')}</div>
                <ul className="mt-1.5 max-h-40 list-disc space-y-1 overflow-auto pl-4 text-xs">
                  {validationIssues.map((issue) => (
                    <li key={issue} className="break-words">{issue}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          <div className="flex gap-2 px-3 py-3">
            <button className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground" onClick={confirm} disabled={busy}>
              <Check className="mr-1 inline h-4 w-4" />{t('common.confirm')}
            </button>
            <button className="rounded-md border border-border px-3 py-1.5 text-sm" onClick={cancel} disabled={busy}>
              <X className="mr-1 inline h-4 w-4" />{t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {snapshot && snapshot.findings.length > 0 && (
        <div className="rounded-md border border-border bg-card p-3">
          <div className="mb-2 text-sm font-medium">{t('knowledge.findings')}</div>
          <ul className="flex flex-col gap-1 text-xs">
            {snapshot.findings.map((f) => (
              <li key={f.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={selectedFindings.has(f.id)}
                  onChange={(e) => {
                    const next = new Set(selectedFindings);
                    if (e.target.checked) next.add(f.id); else next.delete(f.id);
                    setSelectedFindings(next);
                  }}
                />
                <span className={f.severity === 'error' ? 'text-destructive' : f.severity === 'warn' ? 'text-amber-500' : 'text-muted-foreground'}>
                  [{f.severity}] {f.code}: {f.message}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && <div className="text-xs text-destructive">{error}</div>}
    </div>
  );
}
