import { describe, it, expect } from 'vitest';
import { KeyedLock } from '../keyed-lock.js';

describe('KeyedLock', () => {
  it('serializes calls on the same key in FIFO order', async () => {
    const lock = new KeyedLock();
    const order: string[] = [];
    const slow = lock.run('k', async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push('slow');
    });
    const fast = lock.run('k', async () => {
      order.push('fast');
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(['slow', 'fast']);
  });

  it('runs different keys in parallel', async () => {
    const lock = new KeyedLock();
    const order: string[] = [];
    const a = lock.run('a', async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push('a');
    });
    const b = lock.run('b', async () => {
      order.push('b');
    });
    await Promise.all([a, b]);
    expect(order).toEqual(['b', 'a']);
  });

  it('cleans up the map after success and rejection', async () => {
    const lock = new KeyedLock();
    await lock.run('k', async () => undefined);
    expect(lock.hasPending('k')).toBe(false);
    await expect(lock.run('k', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(lock.hasPending('k')).toBe(false);
    // 后续调用仍正常串行
    const val = await lock.run('k', async () => 42);
    expect(val).toBe(42);
  });

  it('does not let a rejection break the next queued call', async () => {
    const lock = new KeyedLock();
    const first = lock.run('k', async () => { throw new Error('first fails'); });
    const second = lock.run('k', async () => 'second ok');
    await expect(first).rejects.toThrow('first fails');
    await expect(second).resolves.toBe('second ok');
  });
});
