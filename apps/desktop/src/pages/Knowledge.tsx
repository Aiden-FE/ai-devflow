import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib.js';
import { useT } from '../i18n/index.js';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../components/ui/select.js';
import { ScanSearch, FolderPlus, Wrench, Check, X } from 'lucide-react';
import type { KnowledgeHealthSnapshot, KnowledgeRunView, Project } from '@ai-devflow/core';

const TYPE_LABELS: Record<string, string> = {
  context: 'Context', adr: 'ADR', feature: 'Feature', runbook: 'Runbook', product: 'Product', ux: 'UX',
};

export interface KnowledgePageProps {
  project: Project;
  projects: Project[];
  onSwitchProject(projectId: string): void;
}

export function KnowledgePage({ project, projects, onSwitchProject }: KnowledgePageProps): React.ReactElement {
  const t = useT();
  const [snapshot, setSnapshot] = useState<KnowledgeHealthSnapshot | undefined>(undefined);
  const [pendingRun, setPendingRun] = useState<KnowledgeRunView | undefined>(undefined);
  const [selectedFindings, setSelectedFindings] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  // Monotonic request version: shared by the project-change effect and manual
  // refresh so a late response from a previously selected project cannot
  // overwrite the current project's state.
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

  const startInit = async () => {
    setBusy(true); setError(undefined);
    try {
      const run = await api.knowledge.startInitialization(project.id);
      setPendingRun(run);
      void refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const startFull = async () => {
    setBusy(true); setError(undefined);
    try {
      await api.knowledge.startAudit(project.id, 'full');
      void refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const startRepair = async () => {
    if (selectedFindings.size === 0) return;
    setBusy(true); setError(undefined);
    try {
      const run = await api.knowledge.startRepair(project.id, [...selectedFindings]);
      setPendingRun(run);
      void refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const confirm = async () => {
    if (!pendingRun) return;
    setBusy(true); setError(undefined);
    try { await api.knowledge.confirmRun(pendingRun.id); setPendingRun(undefined); void refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const cancel = async () => {
    if (!pendingRun) return;
    setBusy(true); setError(undefined);
    try { await api.knowledge.cancelRun(pendingRun.id); setPendingRun(undefined); void refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const notInitialized = snapshot?.state === 'not_initialized';
  const switchDisabled = busy || pendingRun?.confirmationState === 'pending';

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
          <button className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-secondary" onClick={startFull} disabled={busy}>
            <ScanSearch className="mr-1 inline h-4 w-4" />{t('knowledge.fullAudit')}
          </button>
          <button
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-secondary disabled:opacity-40"
            onClick={startInit} disabled={busy || !notInitialized}
          >
            <FolderPlus className="mr-1 inline h-4 w-4" />{t('knowledge.initialize')}
          </button>
          <button
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-secondary disabled:opacity-40"
            onClick={startRepair} disabled={busy || selectedFindings.size === 0}
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
        <div className="rounded-md border border-border bg-card p-3">
          <div className="mb-2 text-sm font-medium">{t('knowledge.draft')}（{pendingRun.draftBranch}）</div>
          {pendingRun.diff && <pre className="max-h-64 overflow-auto rounded bg-secondary/40 p-2 text-xs">{pendingRun.diff}</pre>}
          <div className="mt-2 flex gap-2">
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
