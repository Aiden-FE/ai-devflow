// 超时引擎：周期性扫描任务与规则，对逾期未投递的 (规则,任务) 触发桌面通知与 Webhook。
// 计时基于 statusChangedAt + minutes（见 core/timeout），重启后由首 tick 自动补发，计时正确恢复。
import type { Repositories } from '@ai-devflow/persistence';
import type { NotificationRule, Task } from '@ai-devflow/core';
import { findOverdue, applicableRules } from '@ai-devflow/core';
import { randomId, now } from '@ai-devflow/core';
import type { Notifier } from './notifier.js';
import { deepLinkForTask } from './notifier.js';
import { WebhookSender } from './webhook.js';

export const TIMEOUT_EVENT = 'task.timeout';

export interface TimeoutEngineOptions {
  intervalMs?: number;
}

export class TimeoutEngine {
  private timer?: NodeJS.Timeout;

  constructor(
    private repos: Repositories,
    private notifier: Notifier,
    private webhooks: WebhookSender,
    private opts: TimeoutEngineOptions = {},
  ) {}

  start(): void {
    const interval = this.opts.intervalMs ?? 30_000;
    this.timer = setInterval(() => {
      this.tick(now()).catch((e) => {
        // 引擎错误不应拖垮主进程
        // eslint-disable-next-line no-console
        console.error('[timeout-engine] tick error:', (e as Error).message);
      });
    }, interval);
    this.timer.unref?.();
    // 启动时立即 tick 一次，恢复重启前的逾期计时。
    this.tick(now()).catch(() => {});
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(nowMs: number): Promise<{ fired: number }> {
    const rules = this.repos.notificationRules.list().filter((r) => r.enabled);
    if (rules.length === 0) return { fired: 0 };
    const tasks = this.repos.tasks.list();
    const overdue = findOverdue(rules, tasks, nowMs);
    let fired = 0;
    for (const { taskId, ruleId } of overdue) {
      const rule = rules.find((r) => r.id === ruleId);
      const task = tasks.find((t) => t.id === taskId);
      if (!rule || !task) continue;
      fired += await this.fireForTask(rule, task);
    }
    return { fired };
  }

  private async fireForTask(rule: NotificationRule, task: Task): Promise<number> {
    let n = 0;
    for (const channel of rule.channels) {
      // 防重复：同一 (规则,任务,渠道) 只投递一次。
      if (this.repos.notificationDeliveries.exists(rule.id, task.id, channel)) continue;
      if (channel === 'desktop') {
        try {
          await this.notifier.notify({
            title: `任务超时 · ${task.status}`,
            body: task.title,
            taskId: task.id,
            deepLink: deepLinkForTask(task.id),
          });
          this.recordDelivery(rule.id, task.id, 'desktop', 'sent', undefined);
        } catch (e) {
          this.recordDelivery(rule.id, task.id, 'desktop', 'failed', (e as Error).message);
        }
        n++;
      } else if (channel === 'webhook') {
        const configs = this.repos.webhookConfigs.list().filter(
          (w) => w.enabled && (w.events.includes(TIMEOUT_EVENT) || w.events.includes('*')),
        );
        if (configs.length === 0) {
          // 没有可用 webhook，记录 suppressed 以便审计
          this.recordDelivery(rule.id, task.id, 'webhook', 'suppressed', '无启用的 webhook');
          continue;
        }
        let anyOk = false;
        for (const cfg of configs) {
          const res = await this.webhooks.deliver(cfg, TIMEOUT_EVENT, {
            id: task.id,
            title: task.title,
            status: task.status,
            projectId: task.projectId,
            iterationId: task.iterationId,
          }, { ruleId: rule.id, minutes: rule.minutes });
          if (res.ok) anyOk = true;
        }
        this.recordDelivery(rule.id, task.id, 'webhook', anyOk ? 'sent' : 'failed', anyOk ? undefined : '所有 webhook 投递失败');
        n++;
      }
    }
    return n;
  }

  private recordDelivery(
    ruleId: string,
    taskId: string,
    channel: 'desktop' | 'webhook',
    status: 'sent' | 'failed' | 'suppressed',
    detail?: string,
  ): void {
    this.repos.notificationDeliveries.insert({
      id: randomId(),
      ruleId,
      taskId,
      channel,
      sentAt: now(),
      status,
      detail,
    });
  }
}

export { applicableRules };
