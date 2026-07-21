// 桌面通知抽象。Electron 层注入真实实现；测试用 RecordingNotifier。

export interface DesktopNotification {
  title: string;
  body: string;
  taskId?: string;
  /** 深链：ai-devflow://task/<id>，Electron 点击通知时聚焦窗口并跳转。 */
  deepLink?: string;
}

export interface Notifier {
  notify(n: DesktopNotification): Promise<void>;
}

export class RecordingNotifier implements Notifier {
  calls: DesktopNotification[] = [];
  async notify(n: DesktopNotification): Promise<void> {
    this.calls.push(n);
  }
}

export class NullNotifier implements Notifier {
  async notify(): Promise<void> {
    /* no-op */
  }
}

export function deepLinkForTask(taskId: string): string {
  return `ai-devflow://task/${taskId}`;
}
