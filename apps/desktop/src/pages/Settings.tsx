import React, { useEffect, useState } from 'react';
import { api, useAsync, LoadingOrError, fmtTime } from '../lib.js';
import { useT } from '../i18n/index.js';
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
import type { AgentDetection, NotificationRule, WebhookConfig, WebhookDelivery, TaskStatus, AiProviderConfig, ThemeMode, TaskRole, AgentType, Project, RoleAgentConfig, ProjectSettings, AgentCapabilitySupport } from '@ai-devflow/core';

const NOTIF_STATUSES: TaskStatus[] = ['ready', 'in_progress', 'awaiting_input', 'in_review'];

const ROLES: TaskRole[] = ['planner', 'coder', 'reviewer', 'tester'];

export function SettingsPage(): React.ReactElement {
  const t = useT();
  return (
    <div>
      <div className="mb-4"><h2 className="m-0 text-lg font-semibold">{t('settings.title')}</h2></div>
      <div className="flex flex-col gap-4">
        <ThemeSection />
        <UpdateSection />
        <AgentSection />
        <AgentConfigSection />
        <NotificationRulesSection />
        <WebhooksSection />
        <AiProviderSection />
      </div>
    </div>
  );
}

// ---- 应用更新（Part 6） ----
function UpdateSection(): React.ReactElement {
  const t = useT();
  const { data, error, reload } = useAsync(() => api.updates.status(), []);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const unsub = api.events.subscribe((ev) => {
      if (ev.kind === 'update-status') reload();
    });
    return unsub;
  }, [reload]);

  const check = async () => {
    setBusy(true);
    try { await api.updates.check(); await reload(); }
    finally { setBusy(false); }
  };

  const status = data ?? { state: 'idle' as const, currentVersion: '' };
  const state = status.state;

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="m-0 text-sm font-semibold">{t('update.title')}</h3>
      <div className="mt-2 flex items-center gap-2">
        <Badge variant="outline">{t('settings.agents.col.version')}: {status.currentVersion || '-'}</Badge>
        {status.version && <Badge variant="success">→ {status.version}</Badge>}
      </div>
      <div className="mt-2 text-xs text-muted-foreground">
        {state === 'idle' && t('update.idle')}
        {state === 'checking' && t('update.checking')}
        {state === 'available' && t('update.available', { v: status.version ?? '' })}
        {state === 'downloading' && t('update.downloading', { p: Math.round(status.progress?.percent ?? 0) })}
        {state === 'downloaded' && t('update.downloaded', { v: status.version ?? '' })}
        {state === 'no-update' && t('update.noUpdate')}
        {state === 'error' && t('update.error', { msg: status.error ?? '' })}
      </div>
      {state === 'downloading' && (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-secondary">
          <div className="h-full bg-primary transition-all" style={{ width: `${status.progress?.percent ?? 0}%` }} />
        </div>
      )}
      {error && <div className="mt-2 text-xs text-destructive">{error}</div>}
      <div className="mt-3 flex gap-2">
        {state === 'downloaded' ? (
          <>
            <Button size="sm" onClick={() => api.updates.installUpdate()}>{t('update.installNow')}</Button>
            <Button size="sm" variant="ghost" onClick={reload}>{t('update.later')}</Button>
          </>
        ) : (
          <Button size="sm" variant="outline" disabled={busy || state === 'checking'} onClick={check}>
            {busy || state === 'checking' ? t('update.checking') : t('update.check')}
          </Button>
        )}
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

function AgentSection(): React.ReactElement {
  const t = useT();
  const { data, loading, error, reload } = useAsync(() => api.agents.detectAll(), []);
  const [busy, setBusy] = useState(false);
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-1 flex items-center gap-2">
        <h3 className="m-0 text-sm font-semibold">{t('settings.agents')}</h3>
        <div className="flex-1" />
        <Button size="sm" variant="outline" disabled={busy} onClick={async () => { setBusy(true); await reload(); setBusy(false); }}>
          {busy ? t('settings.agents.detecting') : t('settings.agents.redetect')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t('settings.agents.hint')}</p>
      <LoadingOrError loading={loading} error={error} data={data} reload={reload}>
        {(list) => (
          <table className="mt-2 w-full text-sm">
            <thead><tr><th className="text-left text-muted-foreground">{t('settings.agents.col.agent')}</th><th className="text-left text-muted-foreground">{t('settings.agents.col.available')}</th><th className="text-left text-muted-foreground">{t('settings.agents.col.version')}</th><th className="text-left text-muted-foreground">{t('settings.agents.col.note')}</th></tr></thead>
            <tbody>
              {list.map((d: AgentDetection) => (
                <tr key={d.agentType} className="border-t border-border">
                  <td>{t(`agent.${d.agentType}`)}</td>
                  <td>{d.available ? <Badge variant="success">{t('common.yes')}</Badge> : <Badge variant="error">{t('common.no')}</Badge>}</td>
                  <td className="text-xs">{d.version ?? '-'}</td>
                  <td className="text-xs text-muted-foreground">{d.reason ?? (d.path ? d.path : '')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </LoadingOrError>
    </div>
  );
}

// ---- 项目 Agent 能力配置（Part 2） ----
function AgentConfigSection(): React.ReactElement {
  const t = useT();
  const projectsQ = useAsync(() => api.projects.list(), []);
  const capsQ = useAsync(() => api.agents.capabilities(), []);
  const [projectId, setProjectId] = useState<string | undefined>(undefined);
  const projects = projectsQ.data ?? [];
  const activeProjectId = projectId ?? projects[0]?.id;

  const settingsQ = useAsync(
    () => (activeProjectId ? api.settings.getProjectSettings(activeProjectId) : Promise.resolve({} as ProjectSettings)),
    [activeProjectId],
  );
  const [draft, setDraft] = useState<ProjectSettings>({});
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (settingsQ.data) {
      setDraft(settingsQ.data);
      setSaved(false);
    }
  }, [settingsQ.data, activeProjectId]);

  const caps = (capsQ.data ?? {}) as Partial<Record<AgentType, AgentCapabilitySupport>>;

  const setRole = (role: TaskRole, patch: Partial<RoleAgentConfig>) => {
    setDraft((prev) => ({
      ...prev,
      roleConfigs: { ...prev.roleConfigs, [role]: { ...(prev.roleConfigs?.[role] ?? {}), ...patch } },
    }));
    setSaved(false);
  };

  const save = async () => {
    if (!activeProjectId) return;
    setError(undefined);
    try {
      await api.settings.updateProjectSettings(activeProjectId, draft);
      setSaved(true);
      settingsQ.reload();
    } catch (e) { setError((e as Error).message); }
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="m-0 text-sm font-semibold">{t('settings.agentConfig')}</h3>
      <p className="text-xs text-muted-foreground">{t('settings.agentConfig.hint')}</p>
      <LoadingOrError loading={projectsQ.loading} error={projectsQ.error} data={projectsQ.data} reload={projectsQ.reload}>
        {(projs: Project[]) => (
          <div className="mt-2 flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>{t('settings.agentConfig.project')}</Label>
              <Select value={activeProjectId ?? ''} onValueChange={setProjectId}>
                <SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {projs.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {ROLES.map((role) => {
              const cfg = draft.roleConfigs?.[role] ?? {};
              const agent: AgentType | '' = cfg.agentType ?? '';
              const effAgent = (agent || 'claude_code') as AgentType;
              const support = caps[effAgent];
              return (
                <div key={role} className="rounded-md border border-border p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="text-sm font-medium">{t(`role.${role}`)}</span>
                    <div className="flex-1" />
                    <Select value={agent} onValueChange={(v) => setRole(role, { agentType: (v || undefined) as AgentType | undefined })}>
                      <SelectTrigger className="h-8 w-44"><SelectValue placeholder={t('agent.default')} /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="">{t('agent.default')}</SelectItem>
                        <SelectItem value="claude_code">{t('agent.claude_code')}</SelectItem>
                        <SelectItem value="codex">{t('agent.codex')}</SelectItem>
                        <SelectItem value="pi">{t('agent.pi')}</SelectItem>
                        <SelectItem value="test">{t('agent.test')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid grid-cols-1 gap-2">
                    <CapabilityField
                      label={t('settings.agentConfig.tools')}
                      value={(cfg.tools ?? []).join(',')}
                      supported={support ? support.tools : undefined}
                      hint={support && !support.tools ? t('settings.agentConfig.unsupported') : undefined}
                      onChange={(v) => setRole(role, { tools: splitCsv(v) })}
                    />
                    <CapabilityField
                      label={t('settings.agentConfig.disallowedTools')}
                      value={(cfg.disallowedTools ?? []).join(',')}
                      supported={support ? support.tools : undefined}
                      hint={support && !support.tools ? t('settings.agentConfig.unsupported') : undefined}
                      onChange={(v) => setRole(role, { disallowedTools: splitCsv(v) })}
                    />
                    <CapabilityField
                      label={t('settings.agentConfig.plugins')}
                      value={(cfg.plugins ?? []).join(',')}
                      supported={support ? support.plugins : undefined}
                      hint={support && !support.plugins ? t('settings.agentConfig.unsupported') : undefined}
                      onChange={(v) => setRole(role, { plugins: splitCsv(v) })}
                    />
                    <CapabilityField
                      label={t('settings.agentConfig.skills')}
                      value={(cfg.skills ?? []).join(',')}
                      supported={support ? support.skills !== false : undefined}
                      hint={support && support.skills === false ? t('settings.agentConfig.unsupported') : undefined}
                      onChange={(v) => setRole(role, { skills: splitCsv(v) })}
                    />
                    <label className={`flex items-center gap-1.5 text-xs ${support && !support.approval ? 'opacity-50' : ''}`}>
                      <Checkbox
                        checked={cfg.requireApproval === true}
                        disabled={!!support && !support.approval}
                        onCheckedChange={(v) => setRole(role, { requireApproval: v === true })}
                      />
                      {t('settings.agentConfig.requireApproval')}
                      {support && !support.approval && <span className="text-muted-foreground">({t('settings.agentConfig.unsupported')})</span>}
                    </label>
                  </div>
                </div>
              );
            })}
            {error && <div className="text-xs text-destructive">{error}</div>}
            {saved && !error && <div className="text-xs text-ok">{t('settings.agentConfig.saved')}</div>}
            <div>
              <Button size="sm" onClick={save}>{t('common.save')}</Button>
            </div>
          </div>
        )}
      </LoadingOrError>
    </div>
  );
}

function CapabilityField({ label, value, supported, hint, onChange }: {
  label: string;
  value: string;
  supported?: boolean;
  hint?: string;
  onChange: (v: string) => void;
}): React.ReactElement {
  const disabled = supported === false;
  return (
    <div className={`flex flex-col gap-1 ${disabled ? 'opacity-50' : ''}`}>
      <Label className="text-xs">{label}{hint ? <span className="ml-1 text-muted-foreground">({hint})</span> : null}</Label>
      <Input value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} className="h-8 text-xs" />
    </div>
  );
}

function splitCsv(v: string): string[] {
  return v.split(',').map((s) => s.trim()).filter(Boolean);
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

function AiProviderSection(): React.ReactElement {
  const t = useT();
  const { data, reload } = useAsync(() => api.settings.getAiProvider(), []);
  const [provider, setProvider] = useState<'anthropic' | 'openai'>('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [baseURL, setBaseURL] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) {
      setProvider(data.provider);
      setApiKey('');
      setModel(data.model);
      setBaseURL(data.baseURL ?? '');
    }
  }, [data]);

  const save = async () => {
    setError(undefined);
    try {
      const cfg: AiProviderConfig = { provider, apiKey, model, baseURL: baseURL || undefined };
      await api.settings.setAiProvider(cfg);
      setApiKey('');
      setSaved(true);
      reload();
    } catch (e) { setError((e as Error).message); }
  };
  const clear = async () => {
    setError(undefined);
    try { await api.settings.setAiProvider(undefined); setSaved(true); reload(); } catch (e) { setError((e as Error).message); }
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="m-0 text-sm font-semibold">{t('settings.ai')}</h3>
      <p className="text-xs text-muted-foreground">{t('settings.ai.hint')}</p>
      {!data && <p className="mt-2 text-xs text-muted-foreground">{t('settings.ai.unset')}</p>}
      <div className="mt-2 flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label>{t('settings.ai.provider')}</Label>
          <Select value={provider} onValueChange={(v) => setProvider(v as 'anthropic' | 'openai')}>
            <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="anthropic">{t('settings.ai.provider.anthropic')}</SelectItem>
              <SelectItem value="openai">{t('settings.ai.provider.openai')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5"><Label>{t('settings.ai.apiKey')}</Label><Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={data ? t('settings.ai.apiKey.hint') : ''} /></div>
        <div className="flex flex-col gap-1.5"><Label>{t('settings.ai.model')}</Label><Input value={model} onChange={(e) => setModel(e.target.value)} placeholder={provider === 'anthropic' ? t('settings.ai.model.anthropic.hint') : t('settings.ai.model.openai.hint')} /></div>
        <div className="flex flex-col gap-1.5"><Label>{t('settings.ai.baseURL')}</Label><Input value={baseURL} onChange={(e) => setBaseURL(e.target.value)} placeholder="https://..." /></div>
        {error && <div className="text-xs text-destructive">{error}</div>}
        {saved && !error && <div className="text-xs text-ok">{t('common.ok')}</div>}
        <div className="flex gap-2">
          <Button onClick={save}>{t('settings.ai.save')}</Button>
          {data && <Button variant="ghost" onClick={clear}>{t('settings.ai.clear')}</Button>}
        </div>
      </div>
    </div>
  );
}
