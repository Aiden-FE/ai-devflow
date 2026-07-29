import type { TaskMessage } from '@ai-devflow/core';

export function upsertTaskMessage(messages: TaskMessage[], incoming: TaskMessage): TaskMessage[] {
  const index = messages.findIndex((message) => message.id === incoming.id);
  if (index < 0) return [...messages, incoming];
  const next = [...messages];
  next[index] = incoming;
  return next;
}
