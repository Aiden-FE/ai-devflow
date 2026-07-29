import type { TaskStatus } from './types.js';

export type BoardDropAction =
  | { kind: 'start' }
  | { kind: 'accept' }
  | { kind: 'reject'; target: 'ready' | 'in_progress' };

export function boardDropAction(
  source: TaskStatus,
  target: TaskStatus,
): BoardDropAction | undefined {
  if (source === 'ready' && target === 'in_progress') return { kind: 'start' };
  if (source === 'in_review' && target === 'archived') return { kind: 'accept' };
  if (source === 'in_review' && (target === 'ready' || target === 'in_progress')) {
    return { kind: 'reject', target };
  }
  return undefined;
}

export function isBoardDraggable(status: TaskStatus): boolean {
  return status === 'ready' || status === 'in_review';
}
