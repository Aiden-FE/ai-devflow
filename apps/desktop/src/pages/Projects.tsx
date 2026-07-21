import React, { useState } from 'react';
import { api, useAsync, LoadingOrError } from '../lib.js';
import { useT } from '../i18n/index.js';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { Checkbox } from '../components/ui/checkbox.js';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '../components/ui/dialog.js';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/tabs.js';
import { FolderOpen, Plus, Trash2, ExternalLink } from 'lucide-react';
import type { Project } from '@ai-devflow/core';

/** 客户端名推导（与主进程 deriveProjectName 一致）：URL 或路径 -> 大驼峰。 */
function deriveName(input: string): string {
  const s = input.trim().replace(/[\\/]+$/, '');
  const last = (s.split(/[\\/]/).pop() ?? s).replace(/\.git$/i, '');
  const parts = last.split(/[-_.]+/).filter(Boolean);
  if (parts.length === 0) return last;
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

export function ProjectsPage({ onOpen, onChanged }: { onOpen: (p: Project) => void; onChanged: () => void }): React.ReactElement {
  const t = useT();
  const { data, loading, error, reload } = useAsync(() => api.projects.list(), []);
  const [creating, setCreating] = useState(false);

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <h2 className="m-0 text-lg font-semibold">{t('projects.title')}</h2>
        <div className="flex-1" />
        <Button variant="outline" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> {t('projects.new')}
        </Button>
      </div>
      {creating && (
        <CreateProjectModal onClose={() => setCreating(false)} onCreated={() => { setCreating(false); reload(); onChanged(); }} />
      )}
      <LoadingOrError loading={loading} error={error} data={data} reload={reload}>
        {(projects) => (
          <div className="flex flex-col gap-2">
            {projects.map((p) => (
              <div key={p.id} className="flex items-center gap-2 rounded-lg border border-border bg-card p-3">
                <div className="flex-1 cursor-pointer" onClick={() => onOpen(p)}>
                  <div className="font-semibold">{p.name}</div>
                  <div className="text-xs text-muted-foreground">{p.path} · {t('projects.branch')} {p.defaultBranch}</div>
                </div>
                <Button size="sm" variant="outline" onClick={() => onOpen(p)}>
                  <ExternalLink className="h-3.5 w-3.5" /> {t('projects.open')}
                </Button>
                <DeleteProjectButton project={p} onDeleted={() => { reload(); onChanged(); }} />
              </div>
            ))}
          </div>
        )}
      </LoadingOrError>
    </div>
  );
}

function CreateProjectModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }): React.ReactElement {
  const t = useT();
  const [tab, setTab] = useState<'import' | 'new'>('import');

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('projects.new')}</DialogTitle>
          <DialogDescription className="sr-only">{t('projects.new')}</DialogDescription>
        </DialogHeader>
        <Tabs value={tab} onValueChange={(v) => setTab(v as 'import' | 'new')}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="import">{t('projects.tab.import')}</TabsTrigger>
            <TabsTrigger value="new">{t('projects.tab.new')}</TabsTrigger>
          </TabsList>
          <TabsContent value="import" className="mt-4">
            <ImportForm onCreated={onCreated} onClose={onClose} />
          </TabsContent>
          <TabsContent value="new" className="mt-4">
            <NewAtDirForm onCreated={onCreated} onClose={onClose} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

/** 文件夹选择按钮：选择后若名称为空，填充推导名。 */
function FolderPickerButton({ onPicked }: { onPicked: (p: { path: string; name: string }) => void }): React.ReactElement {
  const t = useT();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      className="shrink-0"
      disabled={busy}
      title={t('projects.pickFolder')}
      onClick={async () => {
        setBusy(true);
        try {
          const picked = await api.projects.pickFolder();
          if (picked) onPicked(picked);
        } finally { setBusy(false); }
      }}
    >
      <FolderOpen className="h-4 w-4" />
    </Button>
  );
}

function ImportForm({ onCreated, onClose }: { onCreated: () => void; onClose: () => void }): React.ReactElement {
  const t = useT();
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true); setError(undefined);
    try {
      await api.projects.create({ name: name.trim(), path: path.trim(), defaultBranch });
      onCreated();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label>{t('projects.name')}</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('projects.name.hint')} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>{t('projects.path')}</Label>
        <div className="flex gap-2">
          <Input className="flex-1" value={path} onChange={(e) => setPath(e.target.value)} placeholder={t('projects.path.hint')} onBlur={() => { if (!name.trim() && path.trim()) setName(deriveName(path)); }} />
          <FolderPickerButton onPicked={({ path: p, name: n }) => {
            setPath(p);
            if (!name.trim()) setName(n);
          }} />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>{t('projects.defaultBranch')}</Label>
        <Input value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)} />
      </div>
      {error && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
        <Button disabled={busy || !name.trim() || !path.trim()} onClick={submit}>
          {busy ? t('projects.importing') : t('projects.import')}
        </Button>
      </DialogFooter>
    </div>
  );
}

function NewAtDirForm({ onCreated, onClose }: { onCreated: () => void; onClose: () => void }): React.ReactElement {
  const t = useT();
  const [name, setName] = useState('');
  const [parentDir, setParentDir] = useState('');
  const [gitInit, setGitInit] = useState(true);
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true); setError(undefined);
    try {
      await api.projects.createAtPath({ name: name.trim(), parentDir: parentDir.trim(), gitInit, defaultBranch });
      onCreated();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label>{t('projects.name')}</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('projects.name.hint')} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>{t('projects.parentDir')}</Label>
        <div className="flex gap-2">
          <Input className="flex-1" value={parentDir} onChange={(e) => setParentDir(e.target.value)} placeholder={t('projects.parentDir.hint')} />
          <FolderPickerButton onPicked={({ path: p }) => setParentDir(p)} />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>{t('projects.defaultBranch')}</Label>
        <Input value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)} disabled={!gitInit} />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={gitInit} onCheckedChange={(v) => setGitInit(v === true)} />
        {t('projects.gitInit')}
      </label>
      {error && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
        <Button disabled={busy || !name.trim() || !parentDir.trim()} onClick={submit}>
          {busy ? t('projects.creating') : t('common.create')}
        </Button>
      </DialogFooter>
    </div>
  );
}

function DeleteProjectButton({ project, onDeleted }: { project: Project; onDeleted: () => void }): React.ReactElement {
  const t = useT();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const del = async () => {
    try { await api.projects.delete(project.id); onDeleted(); }
    catch (e) { setError((e as Error).message); }
  };
  return (
    <>
      <Button size="icon" variant="ghost" className="text-destructive" onClick={() => setConfirm(true)}>
        <Trash2 className="h-4 w-4" />
      </Button>
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('projects.deleteConfirm.title')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm">{t('projects.deleteConfirm.body', { name: project.name })}</p>
          {error && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(false)}>{t('common.cancel')}</Button>
            <Button variant="destructive" onClick={del}>{t('projects.deleteConfirm.confirm')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
