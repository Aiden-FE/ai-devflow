import React, { useCallback, useEffect, useState } from 'react';
import { api, useAsync, LoadingOrError, fmtTime } from '../lib.js';
import { useT, useLocale } from '../i18n/index.js';
import { useTheme } from '../theme.js';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { Badge } from '../components/ui/badge.js';
import { Checkbox } from '../components/ui/checkbox.js';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '../components/ui/select.js';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '../components/ui/dialog.js';
import type { NotificationRule, WebhookConfig, WebhookDelivery, TaskStatus, ThemeMode, Locale, UpdateStatus, ProviderSummary, ProviderInput, ProviderKind, ProviderMigrationStatus, AgentKey, RetentionPolicy } from '@ai-devflow/core';

const PROVIDER_KINDS: ProviderKind[] = ['anthropic', 'openai', 'google', 'deepseek', 'openrouter', 'openai_compatible', 'anthropic_compatible'];
const COMPATIBLE_PROVIDER_KINDS: ProviderKind[] = ['openai_compatible', 'anthropic_compatible'];
const AGENT_KEYS: AgentKey[] = ['product', 'ux', 'dev_lead', 'dev', 'test', 'project_lead', 'chat'];
const MODEL_ROLES: AgentKey[] = AGENT_KEYS.filter((k) => k !== 'chat');
export { AGENT_KEYS };

const NOTIF_STATUSES: TaskStatus[] = ['ready', 'in_progress', 'awaiting_input', 'in_review'];

export function SettingsPage(): React.ReactElement {
  const t = useT();
  return (
    <div>
      <div className="mb-4"><h2 className="m-0 text-lg font-semibold">{t('settings.title')}</h2></div>
      <div className="flex flex-col gap-4">
        <ThemeSection />
        <LanguageSection />
        <UpdateSection />
        <RetentionSection />
        <ProviderSection />
        <AgentModelSection />
        <NotificationRulesSection />
        <WebhooksSection />
      </div>
    </div>
  );
}

type RetentionInputValues = Record<keyof RetentionPolicy, string>;

export function validateRetentionInputs(values: RetentionInputValues): RetentionPolicy {
  const policy: RetentionPolicy = {
    executionDetailDays: Number(values.executionDetailDays),
    archivedConversationDays: Number(values.archivedConversationDays),
    providerRawDays: Number(values.providerRawDays),
  };
  const limits: Array<[keyof RetentionPolicy, number]> = [
    ['executionDetailDays', 7],
    ['archivedConversationDays', 30],
    ['providerRawDays', 30],
  ];
  for (const [key, minimum] of limits) {
    if (!Number.isSafeInteger(policy[key]) || policy[key] < minimum) {
      throw new Error(`${key} 必须是不小于 ${minimum} 的整数天数`);
    }
  }
  return policy;
}

function policyValues(policy: RetentionPolicy): RetentionInputValues {
  return {
    executionDetailDays: String(policy.executionDetailDays),
    archivedConversationDays: String(policy.archivedConversationDays),
    providerRawDays: String(policy.providerRawDays),
  };
}

function RetentionSection(): React.ReactElement {
  const t = useT();
  const [values, setValues] = useState<RetentionInputValues>({
    executionDetailDays: '90', archivedConversationDays: '180', providerRawDays: '365',
  });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [message, setMessage] = useState<string | undefined>();
  const [lastRunAt, setLastRunAt] = useState<number | undefined>();
  const [confirmCompact, setConfirmCompact] = useState(false);

  useEffect(() => {
    api.settings.getRetention()
      .then((result) => {
        setValues(policyValues(result.policy));
        setLastRunAt(result.lastRunAt);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(undefined); setMessage(undefined);
    try { await action(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <RetentionSettingsView
      values={values}
      loading={loading}
      busy={busy}
      error={error}
      message={message}
      lastRunAt={lastRunAt}
      confirmCompact={confirmCompact}
      onChange={(key, value) => setValues((current) => ({ ...current, [key]: value }))}
      onSave={() => run(async () => {
        const saved = await api.settings.setRetention(validateRetentionInputs(values));
        setValues(policyValues(saved));
        setMessage(t('settings.retention.saved'));
      })}
      onClean={() => run(async () => {
        const result = await api.settings.runRetention();
        setLastRunAt(result.ranAt);
        setMessage(t('settings.retention.cleaned', {
          n: result.logsDeleted + result.attemptsDeleted + result.messagesDeleted + result.providerRowsRolledUp,
        }));
      })}
      onCompactRequest={() => setConfirmCompact(true)}
      onCompactCancel={() => setConfirmCompact(false)}
      onCompactConfirm={() => {
        setConfirmCompact(false);
        void run(async () => {
          await api.settings.compactDatabase(true);
          setMessage(t('settings.retention.compacted'));
        });
      }}
    />
  );
}

export interface RetentionSettingsViewProps {
  values: RetentionInputValues;
  loading: boolean;
  busy: boolean;
  error?: string;
  message?: string;
  lastRunAt?: number;
  confirmCompact: boolean;
  onChange: (key: keyof RetentionPolicy, value: string) => void;
  onSave: () => void;
  onClean: () => void;
  onCompactRequest: () => void;
  onCompactConfirm: () => void;
  onCompactCancel: () => void;
}

export function RetentionSettingsView(props: RetentionSettingsViewProps): React.ReactElement {
  const t = useT();
  const fields: Array<[keyof RetentionPolicy, string, number]> = [
    ['executionDetailDays', t('settings.retention.execution'), 7],
    ['archivedConversationDays', t('settings.retention.conversation'), 30],
    ['providerRawDays', t('settings.retention.provider'), 30],
  ];
  return (
    <div data-compact-confirm={props.confirmCompact} className="rounded-lg border border-border bg-card p-4">
      <h3 className="m-0 text-sm font-semibold">{t('settings.retention.title')}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{t('settings.retention.hint')}</p>
      {props.loading ? <div className="mt-3 text-xs text-muted-foreground">{t('common.loading')}</div> : (
        <>
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            {fields.map(([key, label, minimum]) => (
              <div key={key} className="flex min-w-0 flex-col gap-1.5">
                <Label htmlFor={`retention-${key}`}>{label}</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id={`retention-${key}`}
                    type="number"
                    min={minimum}
                    step={1}
                    value={props.values[key]}
                    onChange={(event) => props.onChange(key, event.target.value)}
                  />
                  <span className="shrink-0 text-xs text-muted-foreground">{t('settings.retention.days')}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 text-xs text-muted-foreground">
            {t('settings.retention.lastRun')}: {props.lastRunAt ? fmtTime(props.lastRunAt) : t('settings.retention.never')}
          </div>
          {(props.error || props.message) && (
            <div className={`mt-2 text-xs ${props.error ? 'text-destructive' : 'text-muted-foreground'}`}>{props.error ?? props.message}</div>
          )}
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <Button variant="outline" disabled={props.busy} onClick={props.onClean}>{t('settings.retention.clean')}</Button>
            <Button variant="outline" disabled={props.busy} onClick={props.onCompactRequest}>{t('settings.retention.compact')}</Button>
            <Button disabled={props.busy} onClick={props.onSave}>{t('common.save')}</Button>
          </div>
        </>
      )}
      <Dialog open={props.confirmCompact} onOpenChange={(open) => { if (!open) props.onCompactCancel(); }}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{t('settings.retention.compactConfirm')}</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">{t('settings.retention.compactBody')}</p>
          <DialogFooter>
            <Button variant="ghost" onClick={props.onCompactCancel}>{t('common.cancel')}</Button>
            <Button variant="destructive" onClick={props.onCompactConfirm}>{t('settings.retention.compact')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---- 应用更新（Part 6） ----
function UpdateSection(): React.ReactElement {
  const t = useT();
  const [status, setStatus] = useState<UpdateStatus | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [installError, setInstallError] = useState<string | undefined>();
  const [manualDownload, setManualDownload] = useState<{ arch?: string } | undefined>();

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.updates.status());
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // 直接消费事件流中的 update-status，避免依赖不稳定的 reload 回调导致重订或漏事件。
  useEffect(() => {
    const unsub = api.events.subscribe((ev) => {
      if (ev.kind === 'update-status') refresh();
    });
    return unsub;
  }, [refresh]);

  const check = async () => {
    setBusy(true); setInstallError(undefined); setManualDownload(undefined);
    try { await api.updates.check(); await refresh(); }
    finally { setBusy(false); }
  };

  // 立即升级：处理中状态可见；失败进入 error 并展示可诊断信息（绝不静默 no-op）。
  // 未签名 macOS 返回 manual-download，保持 downloaded 状态并提示用户去 GitHub Releases 手动下载。
  const install = async () => {
    setBusy(true); setInstallError(undefined); setManualDownload(undefined);
    try {
      const r = await api.updates.installUpdate();
      if (!r.ok) {
        setInstallError(r.error ?? t('update.installFailed'));
      } else if (r.action === 'manual-download') {
        setManualDownload({ arch: r.arch });
      }
      await refresh();
    } catch (e) {
      setInstallError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="rounded-lg border border-border bg-card p-4"><h3 className="m-0 text-sm font-semibold">{t('update.title')}</h3><div className="mt-2 text-xs text-muted-foreground">{t('common.loading')}</div></div>;

  const state = status?.state ?? 'idle';
  const isInstalling = state === 'installing';

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="m-0 text-sm font-semibold">{t('update.title')}</h3>
      <div className="mt-2 flex items-center gap-2">
        <Badge variant="outline">{t('settings.agents.col.version')}: {status?.currentVersion || '-'}</Badge>
        {status?.version && <Badge variant="success">→ {status.version}</Badge>}
      </div>
      <div className="mt-2 text-xs text-muted-foreground">
        {state === 'idle' && t('update.idle')}
        {state === 'checking' && t('update.checking')}
        {state === 'available' && t('update.available', { v: status?.version ?? '' })}
        {state === 'downloading' && t('update.downloading', { p: Math.round(status?.progress?.percent ?? 0) })}
        {state === 'downloaded' && t('update.downloaded', { v: status?.version ?? '' })}
        {state === 'installing' && t('update.installing')}
        {state === 'no-update' && t('update.noUpdate')}
        {state === 'error' && t('update.error', { msg: status?.error ?? '' })}
      </div>
      {state === 'downloading' && (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-secondary">
          <div className="h-full bg-primary transition-all" style={{ width: `${status?.progress?.percent ?? 0}%` }} />
        </div>
      )}
      {(installError || error) && <div className="mt-2 break-words rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">{installError ?? error}</div>}
      {manualDownload && (
        <div className="mt-2 break-words rounded-md border border-ok/40 bg-ok/10 px-2 py-1.5 text-xs text-ok">
          {t('update.manualDownload', { arch: manualDownload.arch ?? '' })}
        </div>
      )}
      <div className="mt-3 flex gap-2">
        {state === 'downloaded' ? (
          <Button size="sm" disabled={busy || isInstalling} onClick={install}>
            {isInstalling ? t('update.installing') : t('update.installNow')}
          </Button>
        ) : (
          <Button size="sm" variant="outline" disabled={busy || state === 'checking' || isInstalling} onClick={check}>
            {busy || state === 'checking' ? t('update.checking') : t('update.check')}
          </Button>
        )}
      </div>
    </div>
  );
}

// ---- 界面语言（Part 2）：复用 LocaleProvider，切换立即生效且重启后保持 ----
function LanguageSection(): React.ReactElement {
  const t = useT();
  const { locale, setLocale } = useLocale();
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="m-0 text-sm font-semibold">{t('settings.language')}</h3>
      <p className="text-xs text-muted-foreground">{t('settings.language.hint')}</p>
      <div className="mt-2 flex flex-col gap-1.5">
        <Label>{t('settings.language')}</Label>
        <Select value={locale} onValueChange={(v) => setLocale(v as Locale)}>
          <SelectTrigger className="w-56" data-testid="lang-select"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="zh">{t('settings.locale.zh')}</SelectItem>
            <SelectItem value="en">{t('settings.locale.en')}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

// ---- 主题（Part 1） ----
function ThemeSection(): React.ReactElement {
  const t = useT();
  const { mode, setMode } = useTheme();
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="m-0 text-sm font-semibold">{t('settings.theme')}</h3>
      <p className="text-xs text-muted-foreground">{t('settings.theme.hint')}</p>
      <div className="mt-2 flex flex-col gap-1.5">
        <Label>{t('settings.theme')}</Label>
        <Select value={mode} onValueChange={(v) => setMode(v as ThemeMode)}>
          <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="system">{t('settings.theme.system')}</SelectItem>
            <SelectItem value="light">{t('settings.theme.light')}</SelectItem>
            <SelectItem value="dark">{t('settings.theme.dark')}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}


function NotificationRulesSection(): React.ReactElement {
  const t = useT();
  const { data, loading, error, reload } = useAsync(() => api.notificationRules.list(), []);
  const [editing, setEditing] = useState<NotificationRule | undefined>();
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-1 flex items-center gap-2">
        <h3 className="m-0 text-sm font-semibold">{t('settings.notifRules')}</h3>
        <div className="flex-1" />
        <Button size="sm" onClick={() => setEditing({ id: '', status: 'in_progress', minutes: 30, channels: ['desktop'], enabled: true })}>{t('settings.notifRules.new')}</Button>
      </div>
      <p className="text-xs text-muted-foreground">{t('settings.notifRules.hint')}</p>
      <LoadingOrError loading={loading} error={error} data={data} reload={reload}>
        {(rules) => (
          <table className="mt-2 w-full text-sm">
            <thead><tr><th className="text-left text-muted-foreground">{t('settings.notifRules.col.status')}</th><th className="text-left text-muted-foreground">{t('settings.notifRules.col.minutes')}</th><th className="text-left text-muted-foreground">{t('settings.notifRules.col.channels')}</th><th className="text-left text-muted-foreground">{t('settings.notifRules.col.enabled')}</th><th></th></tr></thead>
            <tbody>
              {rules.map((r: NotificationRule) => (
                <tr key={r.id} className="border-t border-border">
                  <td>{t(`status.${r.status}`)}</td>
                  <td>{r.minutes}</td>
                  <td className="text-xs">{r.channels.map((c) => t(`settings.notifRules.${c}`)).join(', ')}</td>
                  <td>{r.enabled ? t('common.yes') : t('common.no')}</td>
                  <td className="text-right">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>{t('common.edit')}</Button>
                    <Button size="sm" variant="ghost" className="text-destructive" onClick={async () => { await api.notificationRules.delete(r.id); reload(); }}>{t('common.delete')}</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </LoadingOrError>
      {editing && <RuleModal rule={editing} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); reload(); }} />}
    </div>
  );
}

function RuleModal({ rule, onClose, onSaved }: { rule: NotificationRule; onClose: () => void; onSaved: () => void }): React.ReactElement {
  const t = useT();
  const [r, setR] = useState<NotificationRule>(rule);
  const set = (p: Partial<NotificationRule>) => setR({ ...r, ...p });
  const save = async () => {
    if (r.id) await api.notificationRules.update(r);
    else await api.notificationRules.create(r);
    onSaved();
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{r.id ? t('common.edit') : t('settings.notifRules.new')}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>{t('settings.notifRules.col.status')}</Label>
            <Select value={r.status} onValueChange={(v) => set({ status: v as TaskStatus })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {NOTIF_STATUSES.map((s) => <SelectItem key={s} value={s}>{t(`status.${s}`)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5"><Label>{t('settings.notifRules.minutes')}</Label><Input type="number" value={r.minutes} onChange={(e) => set({ minutes: Number(e.target.value) })} /></div>
          <div className="flex flex-col gap-1.5">
            <Label>{t('settings.notifRules.channels')}</Label>
            <div className="flex gap-4">
              <label className="flex items-center gap-1.5 text-sm"><Checkbox checked={r.channels.includes('desktop')} onCheckedChange={(v) => set({ channels: v ? [...r.channels, 'desktop'] : r.channels.filter((c) => c !== 'desktop') })} /> {t('settings.notifRules.desktop')}</label>
              <label className="flex items-center gap-1.5 text-sm"><Checkbox checked={r.channels.includes('webhook')} onCheckedChange={(v) => set({ channels: v ? [...r.channels, 'webhook'] : r.channels.filter((c) => c !== 'webhook') })} /> {t('settings.notifRules.webhook')}</label>
            </div>
          </div>
          <label className="flex items-center gap-1.5 text-sm"><Checkbox checked={r.enabled} onCheckedChange={(v) => set({ enabled: v === true })} /> {t('settings.notifRules.col.enabled')}</label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button onClick={save}>{t('common.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function WebhooksSection(): React.ReactElement {
  const t = useT();
  const { data, loading, error, reload } = useAsync(() => api.webhooks.list(), []);
  const [editing, setEditing] = useState<WebhookConfig | undefined>();
  const [deliveriesFor, setDeliveriesFor] = useState<string | undefined>();
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-1 flex items-center gap-2">
        <h3 className="m-0 text-sm font-semibold">{t('settings.webhooks')}</h3>
        <div className="flex-1" />
        <Button size="sm" onClick={() => setEditing({ id: '', name: '', url: '', secret: '', events: ['task.timeout'], enabled: true, createdAt: 0 })}>{t('settings.webhooks.new')}</Button>
      </div>
      <p className="text-xs text-muted-foreground">{t('settings.webhooks.hint')}</p>
      <LoadingOrError loading={loading} error={error} data={data} reload={reload}>
        {(list) => (
          <table className="mt-2 w-full text-sm">
            <thead><tr><th className="text-left text-muted-foreground">{t('settings.webhooks.col.name')}</th><th className="text-left text-muted-foreground">{t('settings.webhooks.col.url')}</th><th className="text-left text-muted-foreground">{t('settings.webhooks.col.events')}</th><th className="text-left text-muted-foreground">{t('settings.webhooks.col.enabled')}</th><th></th></tr></thead>
            <tbody>
              {list.map((w: WebhookConfig) => (
                <tr key={w.id} className="border-t border-border">
                  <td>{w.name}</td>
                  <td className="text-xs">{w.url}</td>
                  <td className="text-xs">{w.events.join(', ')}</td>
                  <td>{w.enabled ? t('common.yes') : t('common.no')}</td>
                  <td className="text-right">
                    <Button size="sm" variant="ghost" onClick={async () => { const r = await api.webhooks.test(w.id); alert(r.ok ? `${t('common.ok')} (HTTP ${r.status})` : `${t('common.fail')} (HTTP ${r.status})`); }}>{t('settings.webhooks.test')}</Button>
                    <Button size="sm" variant="ghost" onClick={() => setDeliveriesFor(w.id)}>{t('settings.webhooks.deliveries')}</Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(w)}>{t('common.edit')}</Button>
                    <Button size="sm" variant="ghost" className="text-destructive" onClick={async () => { await api.webhooks.delete(w.id); reload(); }}>{t('common.delete')}</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </LoadingOrError>
      {editing && <WebhookModal wh={editing} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); reload(); }} />}
      {deliveriesFor && <DeliveriesModal webhookId={deliveriesFor} onClose={() => setDeliveriesFor(undefined)} />}
    </div>
  );
}

function WebhookModal({ wh, onClose, onSaved }: { wh: WebhookConfig; onClose: () => void; onSaved: () => void }): React.ReactElement {
  const t = useT();
  const [w, setW] = useState<WebhookConfig>(wh);
  const [eventsText, setEventsText] = useState(wh.events.join(', '));
  const set = (p: Partial<WebhookConfig>) => setW({ ...w, ...p });
  const save = async () => {
    const events = eventsText.split(',').map((s) => s.trim()).filter(Boolean);
    if (w.id) await api.webhooks.update({ ...w, events, secret: w.secret });
    else await api.webhooks.create({ name: w.name, url: w.url, secret: w.secret, events });
    onSaved();
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{w.id ? t('common.edit') : t('settings.webhooks.new')}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5"><Label>{t('settings.webhooks.col.name')}</Label><Input value={w.name} onChange={(e) => set({ name: e.target.value })} /></div>
          <div className="flex flex-col gap-1.5"><Label>{t('settings.webhooks.url')}</Label><Input value={w.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://example.com/hook" /></div>
          <div className="flex flex-col gap-1.5"><Label>{t('settings.webhooks.secret')}</Label><Input value={w.secret} onChange={(e) => set({ secret: e.target.value })} placeholder={w.id ? t('settings.webhooks.secret.hint') : ''} /></div>
          <div className="flex flex-col gap-1.5"><Label>{t('settings.webhooks.events')}</Label><Input value={eventsText} onChange={(e) => setEventsText(e.target.value)} placeholder={t('settings.webhooks.events.hint')} /></div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button disabled={!w.name || !w.url} onClick={save}>{t('common.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeliveriesModal({ webhookId, onClose }: { webhookId: string; onClose: () => void }): React.ReactElement {
  const t = useT();
  const { data, loading, error } = useAsync(() => api.webhooks.deliveries(webhookId), [webhookId]);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{t('settings.webhooks.deliveries')}</DialogTitle></DialogHeader>
        <LoadingOrError loading={loading} error={error} data={data} reload={() => {}}>
          {(list: WebhookDelivery[]) => (
            <table className="w-full text-sm">
              <thead><tr><th className="text-left text-muted-foreground">{t('settings.webhooks.deliveries.col.time')}</th><th className="text-left text-muted-foreground">{t('settings.webhooks.deliveries.col.event')}</th><th className="text-left text-muted-foreground">{t('settings.webhooks.deliveries.col.status')}</th><th className="text-left text-muted-foreground">{t('settings.webhooks.deliveries.col.attempt')}</th><th className="text-left text-muted-foreground">{t('settings.webhooks.deliveries.col.result')}</th></tr></thead>
              <tbody>
                {list.map((d) => (
                  <tr key={d.id} className="border-t border-border">
                    <td className="text-xs">{fmtTime(d.sentAt)}</td>
                    <td className="text-xs">{d.event}</td>
                    <td>{d.status}</td>
                    <td>{d.attempt}</td>
                    <td>{d.ok ? <Badge variant="success">{t('common.ok')}</Badge> : <Badge variant="error">{t('common.fail')}</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </LoadingOrError>
      </DialogContent>
    </Dialog>
  );
}

export function ProviderMigrationNotice({
  state,
  onReenter,
  message = 'Provider migration requires attention.',
  actionLabel = 'Re-enter provider',
}: {
  state: ProviderMigrationStatus['state'];
  onReenter(): void;
  message?: string;
  actionLabel?: string;
}): React.ReactElement | null {
  if (state === 'ready') return null;
  return (
    <div data-migration-state={state} className="mt-2 flex items-center justify-between gap-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-2">
      <span className="text-xs text-warn">{message}</span>
      <Button data-testid="provider-migration-reentry" size="sm" variant="outline" onClick={onReenter}>{actionLabel}</Button>
    </div>
  );
}

function ProviderSection(): React.ReactElement {
  const t = useT();
  const { data, reload } = useAsync(() => api.providers.list(), []);
  const { data: migration, reload: reloadMigration } = useAsync(() => api.providers.migrationStatus(), []);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ProviderSummary | undefined>();
  const [kind, setKind] = useState<ProviderKind>('openai_compatible');
  const [displayName, setDisplayName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseURL, setBaseURL] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [defaultModel, setDefaultModel] = useState('');
  const [workloadModels, setWorkloadModels] = useState<Partial<Record<AgentKey, string>>>({});
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelRefreshed, setModelRefreshed] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; error?: string }>>({});
  const [reentry, setReentry] = useState(false);

  const startAdd = () => {
    setReentry(false);
    setEditing(undefined); setKind('openai_compatible'); setDisplayName(''); setApiKey('');
    setBaseURL(''); setEnabled(true);
    setDefaultModel(''); setWorkloadModels({}); setAvailableModels([]); setModelRefreshed(false); setError(undefined); setOpen(true);
  };
  const startReentry = () => {
    setReentry(true);
    setEditing(undefined); setKind('openai_compatible'); setDisplayName(''); setApiKey('');
    setBaseURL(''); setEnabled(true);
    setDefaultModel(''); setWorkloadModels({}); setAvailableModels([]); setModelRefreshed(false); setError(undefined); setOpen(true);
  };
  const startEdit = (p: ProviderSummary) => {
    setReentry(false);
    setEditing(p); setKind(p.kind); setDisplayName(p.displayName); setApiKey('');
    setBaseURL(p.baseURL ?? ''); setEnabled(p.enabled);
    setDefaultModel(p.defaultModel ?? ''); setWorkloadModels(p.workloadModels ?? {}); setAvailableModels([]); setModelRefreshed(false); setError(undefined); setOpen(true);
  };
  const save = async () => {
    setError(undefined);
    const workloadEntries = Object.entries(workloadModels).filter(([, v]) => v?.trim());
    const hasWorkload = workloadEntries.length === 6;
    if (!defaultModel.trim() && !hasWorkload) {
      setError(t('settings.providers.model.required'));
      return;
    }
    try {
      const list = data ?? [];
      const input: ProviderInput = {
        id: editing?.id ?? crypto.randomUUID(),
        kind, displayName, enabled,
        priority: editing?.priority ?? list.length,
        authType: 'api_key',
        apiKey: apiKey || undefined,
        baseURL: baseURL || undefined,
        defaultModel: defaultModel.trim() || undefined,
        workloadModels: workloadEntries.length > 0 ? Object.fromEntries(workloadEntries) as Record<AgentKey, string> : undefined,
        revision: editing?.revision ?? 1,
      };
      if (reentry) await api.providers.completeReentry(input);
      else await api.providers.save(input);
      setOpen(false);
      reload();
      reloadMigration();
    } catch (e) { setError((e as Error).message); }
  };
  const remove = async (id: string) => { await api.providers.remove(id); reload(); };
  const move = async (index: number, dir: -1 | 1) => {
    const list = [...(data ?? [])];
    const j = index + dir;
    if (j < 0 || j >= list.length) return;
    const tmp = list[index]!;
    list[index] = list[j]!;
    list[j] = tmp;
    await api.providers.reorder(list.map((p) => p.id));
    reload();
  };
  const test = async (id: string) => {
    const r = await api.providers.test(id);
    setTestResults((prev) => ({ ...prev, [id]: { ok: r.ok, error: r.error } }));
  };
  const refreshModels = async () => {
    if (!COMPATIBLE_PROVIDER_KINDS.includes(kind)) return;
    setModelLoading(true);
    setError(undefined);
    try {
      const models = await api.providers.listModels(editing?.id ?? '');
      setAvailableModels(models.map((m) => m.id));
      setModelRefreshed(true);
    } catch (e) {
      setError(t('settings.providers.model.refreshError') + (e instanceof Error ? `: ${e.message}` : ''));
    } finally {
      setModelLoading(false);
    }
  };

  const list = data ?? [];
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <h3 className="m-0 text-sm font-semibold">{t('settings.providers')}</h3>
        <Button onClick={startAdd}>{t('settings.providers.add')}</Button>
      </div>
      <p className="text-xs text-muted-foreground">{t('settings.providers.hint')}</p>
      <ProviderMigrationNotice
        state={migration?.state ?? 'ready'}
        onReenter={startReentry}
        message={t(`settings.providers.migration.${migration?.state ?? 'ready'}`)}
        actionLabel={t('settings.providers.migration.action')}
      />
      {list.length === 0 && <p className="mt-2 text-xs text-muted-foreground">{t('settings.providers.empty')}</p>}
      <div className="mt-2 flex flex-col gap-2">
        {list.map((p, i) => (
          <div key={p.id} className="flex items-center justify-between rounded-md border border-border px-3 py-2">
            <div className="flex flex-col">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{p.displayName}</span>
                <Badge variant="outline">{p.kind}</Badge>
                <Badge variant="outline">{t(`settings.providers.health.${p.health}`)}</Badge>
                {p.hasCredential && <Badge variant="outline">{t('settings.providers.apiKey.set')}</Badge>}
                {!p.enabled && <Badge variant="outline">off</Badge>}
              </div>
              {p.baseURL && <span className="text-[11px] text-muted-foreground">{p.baseURL}</span>}
              {p.health === 'configuration_error' && (
                <span className="text-[11px] text-warn">{t('settings.providers.configuration_error')}</span>
              )}
              {testResults[p.id] && (
                <span className={`text-[11px] ${testResults[p.id]!.ok ? 'text-ok' : 'text-destructive'}`}>
                  {testResults[p.id]!.ok ? t('settings.providers.testOk') : `${t('settings.providers.testFail')}${testResults[p.id]!.error ? `: ${testResults[p.id]!.error}` : ''}`}
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-1">
              <Button variant="ghost" size="sm" onClick={() => move(i, -1)}>{t('settings.providers.up')}</Button>
              <Button variant="ghost" size="sm" onClick={() => move(i, 1)}>{t('settings.providers.down')}</Button>
              <Button variant="ghost" size="sm" onClick={() => test(p.id)}>{t('settings.providers.test')}</Button>
              <Button variant="ghost" size="sm" onClick={() => startEdit(p)}>{t('common.edit')}</Button>
              <Button variant="ghost" size="sm" onClick={() => remove(p.id)}>{t('common.delete')}</Button>
            </div>
          </div>
        ))}
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{reentry ? t('settings.providers.migration.action') : editing ? t('settings.providers.edit') : t('settings.providers.add')}</DialogTitle></DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>{t('settings.providers.kind')}</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as ProviderKind)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PROVIDER_KINDS.map((k) => <SelectItem key={k} value={k}>{k}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5"><Label>{t('settings.providers.name')}</Label><Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} /></div>
            <div className="flex flex-col gap-1.5"><Label>{t('settings.providers.apiKey')}</Label><Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={editing?.hasCredential ? t('settings.providers.apiKey.hint') : ''} /></div>
            {COMPATIBLE_PROVIDER_KINDS.includes(kind) && (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label>{t('settings.providers.baseURL')}</Label>
                  <Input value={baseURL} onChange={(e) => setBaseURL(e.target.value)} placeholder="https://host/v1" />
                  <span className="text-[11px] text-muted-foreground">{t('settings.providers.baseURL.hint')}</span>
                </div>
              </>
            )}
            <label className="flex items-center gap-2 text-xs"><Checkbox checked={enabled} onCheckedChange={(v) => setEnabled(v === true)} />{t('settings.providers.enabled')}</label>
            <div className="flex flex-col gap-1.5">
              <Label>{t('settings.providers.model.default')}</Label>
              <div className="flex gap-2">
                <Input
                  list="model-suggestions"
                  value={defaultModel}
                  onChange={(e) => setDefaultModel(e.target.value)}
                  placeholder={t('settings.providers.model.default.hint')}
                  className="flex-1"
                />
                {COMPATIBLE_PROVIDER_KINDS.includes(kind) && editing && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={modelLoading}
                    onClick={refreshModels}
                  >
                    {modelLoading ? t('settings.providers.model.refreshing') : t('settings.providers.model.refresh')}
                  </Button>
                )}
              </div>
              {availableModels.length > 0 && (
                <datalist id="model-suggestions">
                  {availableModels.map((m) => <option key={m} value={m} />)}
                </datalist>
              )}
              {modelRefreshed && !modelLoading && availableModels.length === 0 && (
                <span className="text-[11px] text-muted-foreground">{t('settings.providers.model.empty')}</span>
              )}
            </div>
            <details className="text-xs">
              <summary>{t('settings.providers.model.workloads')}</summary>
              <div className="mt-2 flex flex-col gap-2">
                {MODEL_ROLES.map((role) => (
                  <div key={role} className="flex flex-col gap-1">
                    <Label className="text-[11px]">{t(`settings.agentModels.agent.${role}`)} <span className="text-muted-foreground">({t(`settings.agentModels.workload.${role}`)})</span></Label>
                    <Input
                      value={workloadModels[role] ?? ''}
                      onChange={(e) => setWorkloadModels({ ...workloadModels, [role]: e.target.value })}
                    />
                  </div>
                ))}
              </div>
            </details>
            {error && <div className="break-words text-xs text-destructive">{error}</div>}
          </div>
          <DialogFooter><Button onClick={save}>{t('common.save')}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AgentModelSection(): React.ReactElement {
  const t = useT();
  const providersQ = useAsync(() => api.providers.list(), []);
  const overridesQ = useAsync(() => api.agentOverrides.list(), []);
  const [draft, setDraft] = useState<Record<AgentKey, { providerId: string; model: string }>>({} as Record<AgentKey, { providerId: string; model: string }>);
  const [busy, setBusy] = useState<AgentKey | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    const map = {} as Record<AgentKey, { providerId: string; model: string }>;
    for (const o of overridesQ.data ?? []) map[o.agentKey] = { providerId: o.providerId, model: o.model };
    setDraft(map);
  }, [overridesQ.data]);

  const providers = (providersQ.data ?? []).filter((p) => p.enabled && p.hasCredential);
  const reload = () => { overridesQ.reload(); };

  const save = async (agentKey: AgentKey) => {
    setBusy(agentKey); setError(undefined);
    try {
      const v = draft[agentKey];
      if (v?.providerId && v?.model) {
        await api.agentOverrides.save({ agentKey, providerId: v.providerId, model: v.model });
      } else {
        await api.agentOverrides.remove(agentKey);
      }
      reload();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(undefined); }
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="m-0 text-sm font-semibold">{t('settings.agentModels')}</h3>
      <p className="text-xs text-muted-foreground">{t('settings.agentModels.hint')}</p>
      <div className="mt-2 flex flex-col gap-2">
        {AGENT_KEYS.map((agentKey) => {
          const ov = draft[agentKey];
          const providerId = ov?.providerId ?? '';
          const model = ov?.model ?? '';
          const effective = providerId ? providers.find((p) => p.id === providerId)?.displayName ?? providerId : t('settings.agentModels.followDefault');
          return (
            <div key={agentKey} className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2 text-xs">
              <div className="flex min-w-[160px] flex-col">
                <span className="font-medium">{t(`settings.agentModels.agent.${agentKey}`)}</span>
                <span className="text-muted-foreground">{t('settings.agentModels.workload')}：{t(`settings.agentModels.workload.${agentKey}`)}</span>
              </div>
              <div className="flex flex-1 flex-wrap items-center gap-2">
                <span className="text-muted-foreground">{t('settings.agentModels.effective')}：{effective}{model ? ` / ${model}` : ''}</span>
                <Select value={providerId} onValueChange={(v) => setDraft({ ...draft, [agentKey]: { providerId: v, model: draft[agentKey]?.model ?? '' } })}>
                  <SelectTrigger className="h-7 w-40"><SelectValue placeholder={t('settings.agentModels.followDefault')} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">{t('settings.agentModels.followDefault')}</SelectItem>
                    {providers.map((p) => <SelectItem key={p.id} value={p.id}>{p.displayName}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Input className="h-7 w-48" value={model} onChange={(e) => setDraft({ ...draft, [agentKey]: { providerId, model: e.target.value } })} placeholder={t('settings.providers.model.default.hint')} />
                <Button size="sm" variant="outline" disabled={busy === agentKey} onClick={() => save(agentKey)}>{t('common.save')}</Button>
              </div>
            </div>
          );
        })}
      </div>
      {error && <div className="mt-2 break-words text-xs text-destructive">{error}</div>}
    </div>
  );
}
