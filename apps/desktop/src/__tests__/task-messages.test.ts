import { describe, expect, it } from 'vitest';
import type { TaskMessage } from '@ai-devflow/core';
import { upsertTaskMessage } from '../task-messages.js';

const first: TaskMessage = {
  id: 'm1',
  taskId: 't',
  role: 'assistant',
  kind: 'text',
  text: 'files',
  t: 1,
};

describe('upsertTaskMessage', () => {
  it('replaces a streamed message with the same id without growing the list', () => {
    expect(upsertTaskMessage([first], { ...first, text: 'files changed' })).toEqual([
      { ...first, text: 'files changed' },
    ]);
  });

  it('appends a new message id in arrival order', () => {
    const second = { ...first, id: 'm2', text: 'done', t: 2 };
    expect(upsertTaskMessage([first], second)).toEqual([first, second]);
  });
});
