import { describe, it, expect } from 'vitest';
import { createPiAiService } from '../pi-ai.js';
import type { ChatWorkload, PiTextExecutor } from '../pi-ai.js';

function makeFakeExecutor(scenario: { texts?: string[]; error?: Error }): PiTextExecutor {
  const outputs = [...(scenario.texts ?? [])];
  return async (_workload, _messages, onDelta) => {
    if (scenario.error) throw scenario.error;
    const text = outputs.shift() ?? '';
    onDelta?.(text);
    return text;
  };
}

describe('PiAiService', () => {
  it('streams task_chat deltas and returns full text', async () => {
    const service = createPiAiService(makeFakeExecutor({ texts: ['hello'] }));
    const deltas: string[] = [];
    const full = await service.chat([{ role: 'user', content: 'hi' }], (d) => deltas.push(d), { mode: 'task' });
    expect(full).toBe('hello');
    expect(deltas).toEqual(['hello']);
  });

  it('uses requirement_chat workload for requirement mode', async () => {
    const workloads: ChatWorkload[] = [];
    const service = createPiAiService(async (workload, _messages, onDelta) => {
      workloads.push(workload);
      onDelta?.('ok');
      return 'ok';
    });
    await service.chat([{ role: 'user', content: 'hi' }], () => {}, { mode: 'requirement' });
    expect(workloads).toEqual(['requirement_chat']);
  });

  it('retries an invalid proposal response on the same workload', async () => {
    const service = createPiAiService(makeFakeExecutor({ texts: ['not-json', '{"tasks":[]}'] }));
    const result = await service.propose([{ role: 'user', content: 'split' }]);
    expect(result).toEqual([]);
  });

  it('parses a structured requirement proposal', async () => {
    const service = createPiAiService(
      makeFakeExecutor({ texts: ['{"title":"T","description":"D","acceptance":"A","priority":"high"}'] }),
    );
    const req = await service.proposeRequirement([{ role: 'user', content: 'x' }]);
    expect(req).toEqual({ title: 'T', description: 'D', acceptance: 'A', priority: 'high' });
  });

  it('validates task proposal DAG', async () => {
    const service = createPiAiService(
      makeFakeExecutor({ texts: ['{"tasks":[{"draftId":"a","title":"A","description":"","role":"coder","dependsOn":["b"]},{"draftId":"b","title":"B","description":"","role":"coder","dependsOn":["a"]}]}'] }),
    );
    await expect(service.propose([{ role: 'user', content: 'x' }])).rejects.toThrow(/依赖/);
  });

  it('reports test connection failure when executor throws', async () => {
    const service = createPiAiService(makeFakeExecutor({ error: new Error('offline') }));
    const r = await service.testConnection('p1');
    expect(r.ok).toBe(false);
    expect(r.providerId).toBe('p1');
    expect(r.error).toMatch(/offline/);
  });

  it('reports test connection success when executor returns', async () => {
    const service = createPiAiService(makeFakeExecutor({ texts: ['pong'] }));
    const r = await service.testConnection('p1');
    expect(r.ok).toBe(true);
    expect(r.providerId).toBe('p1');
  });
});
