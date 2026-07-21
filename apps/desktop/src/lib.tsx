// 渲染器共享：API 访问、数据 hook、看板泳道定义、通用状态组件。
import React, { useEffect, useState } from 'react';
import type { TaskStatus, AgentEvent, Task } from '@ai-devflow/core';
import { Badge } from './components/ui/badge.js';
import { Button } from './components/ui/button.js';
import { useT } from './i18n/index.js';

export const api = window.api;

/** 五条可见泳道：ready -> in_progress -> testing(测试中) -> in_review(待验收) -> archived。backlog（需求池）已移除；awaiting_input 为暂停标识不独立成道。 */
export const LANES: { status: TaskStatus; labelKey: string }[] = [
  { status: 'ready', labelKey: 'status.ready' },
  { status: 'in_progress', labelKey: 'status.in_progress' },
  { status: 'testing', labelKey: 'status.testing' },
  { status: 'in_review', labelKey: 'status.in_review' },
  { status: 'archived', labelKey: 'status.archived' },
];

/**
 * 任务所属的泳道：awaiting_input（待沟通/待授权）任务回到其暂停前的来源泳道展示，
 * 以“待沟通”标识区分；其余任务按自身状态归属。
 */
export function laneForTask(task: Task): TaskStatus {
  if (task.status === 'awaiting_input') return task.pausedFrom ?? 'in_progress';
  return task.status;
}

/** 状态对应的泳道色 CSS 变量名。 */
export function laneColorVar(status: TaskStatus): string {
  return `var(--color-lane-${status})`;
}

// 简单的异步数据 hook，统一处理 loading/error/empty 状态。
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): {
  data: T | undefined;
  loading: boolean;
  error: string | undefined;
  reload: () => void;
} {
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fn()
      .then((d) => { if (alive) { setData(d); setError(undefined); } })
      .catch((e) => { if (alive) setError((e as Error).message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  return { data, loading, error, reload: () => setTick((t) => t + 1) };
}

// 事件流 hook：订阅主进程事件，按 taskId 触发回调。
export function useStream(onEvent: (e: { kind: string; taskId: string; data: unknown }) => void): void {
  useEffect(() => {
    const unsub = api.events.subscribe(onEvent);
    return unsub;
  }, [onEvent]);
}

// ---- 通用状态组件 ----
export function Spinner(): React.ReactElement {
  const t = useT();
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-muted-foreground">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-primary" />
      <div className="text-sm">{t('common.loading')}</div>
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }): React.ReactElement {
  return (
    <div className="flex flex-col items-center justify-center gap-1 py-10 text-center text-muted-foreground">
      <div className="text-2xl opacity-40">∅</div>
      <div className="text-sm">{title}</div>
      {hint && <div className="text-xs">{hint}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }): React.ReactElement {
  const t = useT();
  return (
    <div className="flex flex-col items-center gap-2 py-8">
      <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">⚠ {message}</div>
      {onRetry && <Button size="sm" variant="outline" onClick={onRetry}>{t('common.retry')}</Button>}
    </div>
  );
}

export function LoadingOrError<T>({ loading, error, data, reload, children }: {
  loading: boolean; error: string | undefined; data: T | undefined; reload: () => void;
  children: (d: T) => React.ReactElement;
}): React.ReactElement {
  const t = useT();
  if (loading && data === undefined) return <Spinner />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (data === undefined || (Array.isArray(data) && data.length === 0)) {
    return <EmptyState title={t('common.empty')} />;
  }
  return children(data);
}

export function StatusBadge({ status }: { status: TaskStatus }): React.ReactElement {
  const t = useT();
  const variant: 'default' | 'secondary' | 'outline' | 'success' | 'warning' =
    status === 'archived' ? 'success'
      : status === 'in_progress' ? 'warning'
        : status === 'testing' ? 'default'
          : status === 'awaiting_input' ? 'secondary'
            : status === 'in_review' ? 'default'
              : 'outline';
  return <Badge variant={variant}>{t(`status.${status}`)}</Badge>;
}

// 格式化时间戳
export function fmtTime(t?: number): string {
  if (!t) return '-';
  return new Date(t).toLocaleString();
}

export type { AgentEvent };
