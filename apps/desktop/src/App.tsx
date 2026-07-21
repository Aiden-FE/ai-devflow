import React, { useCallback, useEffect, useState } from 'react';
import { api } from './lib.js';
import { ProjectsPage } from './pages/Projects.js';
import { WorkspacePage } from './pages/Workspace.js';
import { SettingsPage } from './pages/Settings.js';
import { useLocale, useT } from './i18n/index.js';
import { Button } from './components/ui/button.js';
import { FolderKanban, LayoutDashboard, Settings as SettingsIcon, Globe, CircleDot } from 'lucide-react';
import type { Project, TaskStatus, Locale } from '@ai-devflow/core';

type Route = 'projects' | 'workspace' | 'settings';

export function App(): React.ReactElement {
  const t = useT();
  const { locale, setLocale } = useLocale();
  const [route, setRoute] = useState<Route>('projects');
  const [project, setProject] = useState<Project | undefined>(undefined);
  const [projects, setProjects] = useState<Project[]>([]);

  const loadProjects = useCallback(() => {
    api.projects.list().then(setProjects).catch(() => {});
  }, []);
  useEffect(() => { loadProjects(); }, [loadProjects]);

  // 跨项目状态：统计全部任务的 开发中/待沟通/测试中 数量。
  const [counts, setCounts] = useState<Record<TaskStatus, number>>({
    backlog: 0, ready: 0, in_progress: 0, awaiting_input: 0, in_review: 0, archived: 0,
  });
  const loadCounts = useCallback(() => {
    api.tasks.listAll().then((tasks) => {
      const c: Record<TaskStatus, number> = {
        backlog: 0, ready: 0, in_progress: 0, awaiting_input: 0, in_review: 0, archived: 0,
      };
      for (const task of tasks) c[task.status] = (c[task.status] ?? 0) + 1;
      setCounts(c);
    }).catch(() => {});
  }, []);
  useEffect(() => { loadCounts(); }, [loadCounts]);

  // 任务事件流 -> 刷新跨项目计数。
  useEffect(() => {
    const unsub = api.events.subscribe(() => { loadCounts(); });
    return unsub;
  }, [loadCounts]);

  const openProject = useCallback((p: Project) => {
    setProject(p);
    setRoute('workspace');
  }, []);

  const switchProject = useCallback((id: string) => {
    const p = projects.find((x) => x.id === id);
    if (p) setProject(p);
  }, [projects]);

  const navItem = (r: Route, icon: React.ReactNode, label: string) => (
    <button
      className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors ${
        route === r ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
      }`}
      onClick={() => setRoute(r)}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <div className="grid h-screen grid-cols-[220px_1fr] bg-background text-foreground">
      <aside className="flex flex-col gap-1 overflow-y-auto border-r border-border bg-card p-3">
        <h1 className="mb-3 px-2 text-base font-semibold">ai-devflow</h1>
        {navItem('projects', <FolderKanban className="h-4 w-4" />, t('nav.projects'))}
        {navItem('workspace', <LayoutDashboard className="h-4 w-4" />, t('nav.workspace'))}
        {navItem('settings', <SettingsIcon className="h-4 w-4" />, t('nav.settings'))}

        <div className="flex-1" />

        {/* 语言切换：内联按钮组,避免 Portal 定位在 Electron 下越界 */}
        <div className="flex items-center gap-1">
          <Globe className="h-4 w-4 text-muted-foreground" />
          <Button
            variant={locale === 'zh' ? 'secondary' : 'ghost'}
            size="sm"
            className="px-2 text-xs"
            onClick={() => setLocale('zh' as Locale)}
          >
            {t('settings.locale.zh')}
          </Button>
          <Button
            variant={locale === 'en' ? 'secondary' : 'ghost'}
            size="sm"
            className="px-2 text-xs"
            onClick={() => setLocale('en' as Locale)}
          >
            {t('settings.locale.en')}
          </Button>
        </div>

        {/* 左下角：跨项目状态汇总（替代原"当前项目"标识） */}
        <div className="mt-2 rounded-md border border-border bg-secondary/40 p-2.5">
          <div className="mb-1.5 text-xs font-medium text-muted-foreground">{t('status.cross.title')}</div>
          <CrossStat color="var(--color-lane-in_progress)" label={t('status.cross.in_progress')} n={counts.in_progress} />
          <CrossStat color="var(--color-lane-awaiting)" label={t('status.cross.awaiting')} n={counts.awaiting_input} />
          <CrossStat color="var(--color-lane-in_review)" label={t('status.cross.in_review')} n={counts.in_review} />
        </div>
      </aside>

      <main className="overflow-auto p-4">
        {route === 'projects' && <ProjectsPage onOpen={openProject} onChanged={loadProjects} />}
        {route === 'workspace' && (
          <WorkspacePage
            project={project}
            projects={projects}
            onSwitchProject={switchProject}
          />
        )}
        {route === 'settings' && <SettingsPage />}
      </main>
    </div>
  );
}

function CrossStat({ color, label, n }: { color: string; label: string; n: number }): React.ReactElement {
  return (
    <div className="flex items-center justify-between py-0.5 text-xs">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <CircleDot className="h-3 w-3" style={{ color }} />
        {label}
      </span>
      <span className="font-medium tabular-nums">{n}</span>
    </div>
  );
}
