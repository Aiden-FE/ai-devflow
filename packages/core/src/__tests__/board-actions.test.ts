import { describe, expect, it } from 'vitest';
import { ALL_STATUSES } from '../state-machine.js';
import { boardDropAction, isBoardDraggable } from '../board-actions.js';

describe('board drop actions', () => {
  it('allows exactly the four explicit workflow actions', () => {
    const allowed = new Map([
      ['ready:in_progress', { kind: 'start' }],
      ['in_review:archived', { kind: 'accept' }],
      ['in_review:ready', { kind: 'reject', target: 'ready' }],
      ['in_review:in_progress', { kind: 'reject', target: 'in_progress' }],
    ]);

    for (const source of ALL_STATUSES) {
      for (const target of ALL_STATUSES) {
        expect(boardDropAction(source, target), `${source} -> ${target}`).toEqual(
          allowed.get(`${source}:${target}`),
        );
      }
    }
  });

  it('makes only ready and in-review cards draggable', () => {
    expect(ALL_STATUSES.filter(isBoardDraggable)).toEqual(['ready', 'in_review']);
  });
});
