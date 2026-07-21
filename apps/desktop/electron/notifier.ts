// Electron 桌面通知实现：发送通知并处理点击 -> 深链聚焦窗口并跳转任务。
import { Notification, BrowserWindow, shell } from 'electron';
import type { Notifier, DesktopNotification } from '@ai-devflow/notifications';

export class ElectronNotifier implements Notifier {
  constructor(private getWindow: () => BrowserWindow | undefined, private onDeepLink: (taskId: string) => void) {}

  async notify(n: DesktopNotification): Promise<void> {
    const note = new Notification({
      title: n.title,
      body: n.body,
    });
    note.on('click', () => {
      const win = this.getWindow();
      if (win) {
        if (win.isMinimized()) win.restore();
        win.focus();
      }
      if (n.taskId) this.onDeepLink(n.taskId);
    });
    note.show();
  }
}

/** 处理 ai-devflow:// 协议深链。 */
export function parseDeepLink(url: string): { taskId: string } | undefined {
  const m = /^ai-devflow:\/\/task\/(.+)$/.exec(url);
  if (m) return { taskId: decodeURIComponent(m[1]!) };
  return undefined;
}

export { shell };
