// 按键 FIFO 串行锁：同一 key 的调用按到达顺序串行执行，不同 key 并行。
// 用于知识沉淀/迭代归档等需要按迭代串行的操作（设计 §7.4 并发任务）。

export class KeyedLock {
  private tails = new Map<string, Promise<void>>();

  /** 在 key 上串行执行 action；返回 action 的结果。 */
  async run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.tails.set(key, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  /** 当前是否存在挂起的尾 Promise（测试与诊断用）。 */
  hasPending(key: string): boolean {
    return this.tails.has(key);
  }
}
