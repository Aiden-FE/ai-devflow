import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib.js';
import { useT } from '../i18n/index.js';
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

export function KnowledgePage({ project }: KnowledgePageProps): React.ReactElement {
  const t = useT();
  const [snapshot, setSnapshot] = useState<KnowledgeHealthSnapshot | undefined>(undefined);
  const [pendingRun, setPendingRun] = useState<KnowledgeRunView | undefined>(undefined);
  const [selectedFindings, setSelectedFindings] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const snap = await api.knowledge.getProjectSnapshot(project.id);
      setSnapshot(snap);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [project.id]);

  useEffect(() => { void refresh(); }, [refresh]);

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

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="m-0 text-lg font-semibold">{t('nav.knowledge')}</h2>
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

      {snapshot && (
        <div className="rounded-md border border-border bg-card p-3">
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
