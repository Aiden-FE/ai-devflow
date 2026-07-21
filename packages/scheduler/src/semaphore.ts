/** 简单异步信号量，用于并发上限。 */
export class Semaphore {
  private permits: number;
  private waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = Math.max(1, permits);
  }

  async acquire(): Promise<() => void> {
    if (this.permits > 0) {
      this.permits--;
      return this.release.bind(this);
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.permits--;
    return this.release.bind(this);
  }

  private release(): void {
    this.permits++;
    const next = this.waiters.shift();
    if (next) {
      // 把许可转交给等待者
      this.permits--;
      next();
    }
  }

  get available(): number {
    return this.permits;
  }
}
