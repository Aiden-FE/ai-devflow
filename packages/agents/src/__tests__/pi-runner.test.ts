import { expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { validateExpertCompletion } from '../pi-runner.js';
import type { StructuredResult } from '../json-events.js';
import { createPiRunnerHarness } from './helpers/pi-runner-harness.js';

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const event of events) values.push(event);
  return values;
}

it('enforces the narrow expert-specific structured-result evidence contract', () => {
  const base: StructuredResult = { summary: 'done', verification: ['pnpm test: pass'], changedFiles: [], unresolved: [], knowledgeReads: [] };
  const execReq = (expert: import('@ai-devflow/core').ExpertKey) => ({ expert, resultKind: 'task_execution' as const });
  expect(validateExpertCompletion(execReq('dev_lead'), base)).toBeUndefined();
  expect(validateExpertCompletion(execReq('dev'), { ...base, verification: [] })).toMatch(/验证证据/);
  expect(validateExpertCompletion(execReq('test'), { ...base, verification: ['   '] })).toMatch(/验证证据/);
  expect(validateExpertCompletion(execReq('test'), { ...base, summary: 'reviewed' })).toMatch(/REVIEW_VERDICT/);
  expect(validateExpertCompletion(execReq('test'), {
    ...base,
    summary: 'reviewed\nREVIEW_VERDICT: PASS',
  })).toBeUndefined();
});

it('rejects task_review results missing the assessment payload', () => {
  const base: StructuredResult = { summary: 'reviewed\nREVIEW_VERDICT: PASS', verification: ['ok'], changedFiles: [], unresolved: [], knowledgeReads: [] };
  expect(validateExpertCompletion({ expert: 'test', resultKind: 'task_review' }, base)).toMatch(/缺少领域载荷/);
  const withPayload: StructuredResult = {
    ...base,
    payload: {
      kind: 'task_review',
      review: { pass: true, summary: 'REVIEW_VERDICT: PASS' },
      knowledgeAssessment: { verdict: 'none', reason: '无沉淀价值', evidence: ['x.ts'] },
    },
  };
  expect(validateExpertCompletion({ expert: 'test', resultKind: 'task_review' }, withPayload)).toBeUndefined();
});

it('surfaces malformed task_review payload diagnostics before the missing-payload fallback', () => {
  const result: StructuredResult = {
    summary: 'reviewed\nREVIEW_VERDICT: PASS',
    verification: ['ok'],
    changedFiles: [],
    unresolved: [],
    knowledgeReads: [],
    payloadError: 'payload.knowledgeAssessment.evidence 必须至少包含一项',
  };

  expect(validateExpertCompletion({ expert: 'test', resultKind: 'task_review' }, result)).toBe(
    'payload.knowledgeAssessment.evidence 必须至少包含一项',
  );
});

it.each([
  ['REVIEW_VERDICT: PASS', 'REVIEW_VERDICT: PASS', false],
  ['REVIEW_VERDICT: PASS', 'REVIEW_VERDICT: FAIL', true],
  ['REVIEW_VERDICT: FAIL', 'reviewed', false],
] as const)('requires summary, review summary, and review.pass to agree', (summary, reviewSummary, pass) => {
  const result: StructuredResult = {
    summary,
    verification: ['ok'],
    changedFiles: [],
    unresolved: [],
    knowledgeReads: [],
    payload: {
      kind: 'task_review',
      review: { pass, summary: reviewSummary },
      knowledgeAssessment: { verdict: 'none', reason: 'x', evidence: ['x.ts'] },
    },
  };

  expect(validateExpertCompletion({ expert: 'test', resultKind: 'task_review' }, result)).toMatch(/不一致|缺少 REVIEW_VERDICT/);
});

it('rejects task_execution results that carry a payload', () => {
  const base: StructuredResult = {
    summary: 'done', verification: ['ok'], changedFiles: [], unresolved: [], knowledgeReads: [],
    payload: { kind: 'task_review', review: { pass: true, summary: 'x' }, knowledgeAssessment: { verdict: 'none', reason: 'r', evidence: ['e'] } },
  };
  expect(validateExpertCompletion({ expert: 'dev', resultKind: 'task_execution' }, base)).toMatch(/不得携带领域载荷/);
});

it('uses the absolute fake Pi entry and emits done only after report_result', async () => {
  const harness = createPiRunnerHarness({ scenario: 'success' });
  const run = await harness.runner.run({
    scope: { kind: 'task', taskId: 't1' }, executionId: 'e1', expert: 'dev', resultKind: 'task_execution', prompt: 'change fixture', cwd: harness.cwd,
  });
  const events = await collect(run.events);
  expect(events).toContainEqual(expect.objectContaining({ type: 'done' }));
  expect(harness.spawnedCommands[0]?.args[0]).toBe(harness.fakePiEntry);
  const result = await run.done();
  expect(result.ok).toBe(true);
});

it('passes a mutation checkpoint to the next attempt', async () => {
  const harness = createPiRunnerHarness({ scenario: 'mutate-then-provider-error' });
  const run = await harness.runner.run({
    scope: { kind: 'task', taskId: 't1' }, executionId: 'e1', expert: 'dev', resultKind: 'task_execution', prompt: 'change fixture', cwd: harness.cwd,
  });
  const events = await collect(run.events);
  expect(events).toContainEqual(expect.objectContaining({ type: 'done' }));
  expect(harness.spawnedCommands).toHaveLength(2);
  expect(harness.spawnedCommands[1]?.initialMessage).toContain('先验证现状');
  expect(harness.spawnedCommands[1]?.initialMessage).toContain('src/fixture.ts');
  expect(harness.spawnedCommands[1]?.checkpoint).toMatchObject({
    completed: expect.any(Array),
    incomplete: expect.any(Array),
    uncertain: expect.any(Array),
    changedFiles: [expect.objectContaining({ path: 'src/fixture.ts' })],
    diffSummary: expect.any(String),
  });
});

it('injects bounded untrusted project instructions before the task request', async () => {
  const harness = createPiRunnerHarness({ scenario: 'success' });
  writeFileSync(`${harness.cwd}/AGENTS.md`, 'PROJECT-ONLY-INSTRUCTION');
  const run = await harness.runner.run({
    scope: { kind: 'task', taskId: 't1' }, executionId: 'instructions', expert: 'dev', resultKind: 'task_execution', prompt: 'TASK-REQUEST', cwd: harness.cwd,
  });
  await collect(run.events);
  expect((await run.done()).ok).toBe(true);
  const message = harness.spawnedCommands[0]?.initialMessage ?? '';
  expect(message).toContain('PROJECT-ONLY-INSTRUCTION');
  expect(message).toContain('不受信任');
  expect(message.indexOf('PROJECT-ONLY-INSTRUCTION')).toBeLessThan(message.indexOf('TASK-REQUEST'));
});

it('serializes a validated scheduler checkpoint into resume context', async () => {
  const harness = createPiRunnerHarness({ scenario: 'success' });
  const run = await harness.runner.run({
    scope: { kind: 'task', taskId: 't1' }, executionId: 'resume', expert: 'dev', resultKind: 'task_execution', prompt: 'continue', cwd: harness.cwd,
    resumeFrom: {
      id: 'cp-1', taskId: 't1', stageId: 'build', stageIndex: 2,
      context: 'validated prior context', createdAt: 123,
    },
  });
  await collect(run.events);
  expect((await run.done()).ok).toBe(true);
  expect(harness.spawnedCommands[0]?.initialMessage).toContain('validated prior context');
  expect(harness.spawnedCommands[0]?.checkpoint).toMatchObject({
    checkpoint: { id: 'cp-1', taskId: 't1', stageId: 'build', stageIndex: 2 },
  });
});

it('rejects malformed scheduler checkpoints before spawning Pi', async () => {
  const harness = createPiRunnerHarness({ scenario: 'success' });
  const run = await harness.runner.run({
    scope: { kind: 'task', taskId: 't1' }, executionId: 'invalid-resume', expert: 'dev', resultKind: 'task_execution', prompt: 'continue', cwd: harness.cwd,
    resumeFrom: {
      id: 'cp-1', taskId: 'other-task', stageId: 'build', stageIndex: -1,
      context: 'invalid', createdAt: 123,
    },
  });
  const events = await collect(run.events);
  expect(events).toContainEqual(expect.objectContaining({ type: 'error' }));
  expect((await run.done()).ok).toBe(false);
  expect(harness.spawnedCommands).toEqual([]);
});

it('fails over after an authentication error on the first attempt', async () => {
  const harness = createPiRunnerHarness({ scenario: 'authentication' });
  const run = await harness.runner.run({
    scope: { kind: 'task', taskId: 't1' }, executionId: 'e1', expert: 'dev', resultKind: 'task_execution', prompt: 'p', cwd: harness.cwd,
  });
  const events = await collect(run.events);
  expect(events).toContainEqual(expect.objectContaining({ type: 'done' }));
  expect(harness.spawnedCommands.length).toBeGreaterThanOrEqual(2);
});

it('surfaces a bounded redacted final provider detail', async () => {
  const harness = createPiRunnerHarness({ scenario: 'always-provider-error' });
  const run = await harness.runner.run({
    scope: { kind: 'project', projectId: 'p1' },
    executionId: 'knowledge-init-failure',
    expert: 'project_lead',
    resultKind: 'knowledge_initialization',
    prompt: 'initialize knowledge',
    cwd: harness.cwd,
  });

  const events = await collect(run.events);
  const error = events.find((event) => event.type === 'error');
  expect(error).toEqual(expect.objectContaining({
    type: 'error',
    message: expect.stringContaining('model unavailable'),
  }));
  const message = error && error.type === 'error' ? error.message : '';
  expect(message).not.toContain('fake-secret');
  expect(message.length).toBeLessThan(2_050);
  expect((await run.done()).ok).toBe(false);
});

it('retries a runtime crash once then recovers', async () => {
  const harness = createPiRunnerHarness({ scenario: 'runtime-crash' });
  const run = await harness.runner.run({
    scope: { kind: 'task', taskId: 't1' }, executionId: 'e1', expert: 'dev', resultKind: 'task_execution', prompt: 'p', cwd: harness.cwd,
  });
  const events = await collect(run.events);
  expect(events).toContainEqual(expect.objectContaining({ type: 'done' }));
  expect(harness.spawnedCommands.length).toBeGreaterThanOrEqual(2);
});

it('treats protocol corruption as recoverable and fails over', async () => {
  const harness = createPiRunnerHarness({ scenario: 'protocol-corruption' });
  const run = await harness.runner.run({
    scope: { kind: 'task', taskId: 't1' }, executionId: 'e1', expert: 'dev', resultKind: 'task_execution', prompt: 'p', cwd: harness.cwd,
  });
  const events = await collect(run.events);
  expect(events).toContainEqual(expect.objectContaining({ type: 'done' }));
  expect(harness.spawnedCommands.length).toBeGreaterThanOrEqual(2);
});

it('stops without failover on an interaction and surfaces ask_user', async () => {
  const harness = createPiRunnerHarness({ scenario: 'interaction' });
  const run = await harness.runner.run({
    scope: { kind: 'task', taskId: 't1' }, executionId: 'e1', expert: 'dev', resultKind: 'task_execution', prompt: 'p', cwd: harness.cwd,
  });
  const events = await collect(run.events);
  expect(events).toContainEqual(expect.objectContaining({ type: 'ask_user' }));
  expect(harness.spawnedCommands).toHaveLength(1);
  const result = await run.done();
  expect(result.ok).toBe(true);
});

it('actively terminates the Pi process group after an interaction tool ends (§7.4)', async () => {
  const harness = createPiRunnerHarness({ scenario: 'interaction-then-hang' });
  const run = await harness.runner.run({
    scope: { kind: 'task', taskId: 't1' }, executionId: 'hang', expert: 'dev', resultKind: 'task_execution', prompt: 'p', cwd: harness.cwd,
  });
  const events = await collect(run.events);
  expect(events).toContainEqual(expect.objectContaining({ type: 'ask_user' }));
  const result = await run.done();
  expect(result.ok).toBe(true);
  expect(harness.spawnedCommands).toHaveLength(1);
  // Fake Pi hangs after the interaction tool and self-exits with code 99 only at 10s.
  // A signal exit proves the runner actively terminated the process group instead of waiting.
  const exit = harness.spawnExits[0]!;
  expect(exit.signal).toMatch(/SIGTERM|SIGKILL/);
  expect(exit.code).not.toBe(99);
}, 15_000);

it('actively terminates Pi after a complete result terminal instead of timing out and retrying', async () => {
  const harness = createPiRunnerHarness({ scenario: 'report-then-hang' });
  const run = await harness.runner.run({
    scope: { kind: 'task', taskId: 'completed-hang' }, executionId: 'completed-hang', expert: 'dev', resultKind: 'task_execution', prompt: 'p', cwd: harness.cwd,
  });
  const events = await collect(run.events);

  expect(events).toContainEqual(expect.objectContaining({ type: 'done' }));
  expect((await run.done()).ok).toBe(true);
  expect(harness.spawnedCommands).toHaveLength(1);
  const exit = harness.spawnExits[0]!;
  expect(exit.signal).toMatch(/SIGTERM|SIGKILL/);
  expect(exit.code).not.toBe(99);
}, 5_000);

it.each([
  'report-end-provider-error',
  'report-end-delayed-code-7',
] as const)('does not accept an invalid terminal sequence: %s', async (scenario) => {
  const harness = createPiRunnerHarness({ scenario });
  const run = await harness.runner.run({
    scope: { kind: 'task', taskId: scenario }, executionId: scenario, expert: 'dev', resultKind: 'task_execution', prompt: 'p', cwd: harness.cwd,
  });
  const events = await collect(run.events);

  expect(events).not.toContainEqual(expect.objectContaining({ type: 'done' }));
  expect(events).toContainEqual(expect.objectContaining({ type: 'error' }));
  expect((await run.done()).ok).toBe(false);
}, 5_000);

it('fails a reviewer latch-blocked interaction terminal without pausing', async () => {
  const harness = createPiRunnerHarness({ scenario: 'reviewer-latch-blocked-interaction' });
  const run = await harness.runner.run({
    scope: { kind: 'task', taskId: 'reviewer-blocked' }, executionId: 'reviewer-blocked', expert: 'test', resultKind: 'task_review', prompt: 'p', cwd: harness.cwd,
  });
  const events = await collect(run.events);

  expect(events).not.toContainEqual(expect.objectContaining({ type: 'ask_user' }));
  expect(events).not.toContainEqual(expect.objectContaining({ type: 'done' }));
  expect(events).toContainEqual(expect.objectContaining({ type: 'error' }));
  expect((await run.done()).ok).toBe(false);
});

it('classifies a completed review turn without a structured result as task_result', async () => {
  const harness = createPiRunnerHarness({ scenario: 'review-missing-result' });
  const run = await harness.runner.run({
    scope: { kind: 'task', taskId: 'review-missing-result' },
    executionId: 'review-missing-result',
    expert: 'test',
    resultKind: 'task_review',
    prompt: 'review',
    cwd: harness.cwd,
  });
  const events = await collect(run.events);

  expect(events).toContainEqual(expect.objectContaining({ type: 'error', failureKind: 'task_result' }));
  expect(events).not.toContainEqual(expect.objectContaining({ type: 'done' }));
  expect(harness.spawnedCommands).toHaveLength(1);
  expect((await run.done()).ok).toBe(false);
});

it('does not fail over on a task-result failure (structured result received)', async () => {
  const harness = createPiRunnerHarness({ scenario: 'task-result-failure' });
  const run = await harness.runner.run({
    scope: { kind: 'task', taskId: 't1' }, executionId: 'e1', expert: 'dev', resultKind: 'task_execution', prompt: 'p', cwd: harness.cwd,
  });
  const events = await collect(run.events);
  expect(events).toContainEqual(expect.objectContaining({ type: 'done' }));
  expect(harness.spawnedCommands).toHaveLength(1);
});

it('rejects an expert result without verification evidence and does not fail over', async () => {
  const harness = createPiRunnerHarness({ scenario: 'missing-verification' });
  const run = await harness.runner.run({
    scope: { kind: 'task', taskId: 't1' }, executionId: 'e1', expert: 'dev', resultKind: 'task_execution', prompt: 'p', cwd: harness.cwd,
  });
  const events = await collect(run.events);
  expect(events).not.toContainEqual(expect.objectContaining({ type: 'done' }));
  expect(events).toContainEqual(expect.objectContaining({ type: 'error' }));
  expect(harness.spawnedCommands).toHaveLength(1);
  expect((await run.done()).ok).toBe(false);
});

it.each([
  'report-without-end',
  'malformed-then-report',
  'provider-error-then-report',
  'interaction-then-report',
] as const)('fails closed for invalid terminal protocol: %s', async (scenario) => {
  const harness = createPiRunnerHarness({ scenario });
  const run = await harness.runner.run({
    scope: { kind: 'task', taskId: 'terminal' }, executionId: `terminal-${scenario}`, expert: 'dev', resultKind: 'task_execution', prompt: 'p', cwd: harness.cwd,
  });
  const events = await collect(run.events);
  expect(events).not.toContainEqual(expect.objectContaining({ type: 'done' }));
  expect(events).toContainEqual(expect.objectContaining({ type: 'error' }));
  expect((await run.done()).ok).toBe(false);
});

it('verifies the runtime via the locator', async () => {
  const harness = createPiRunnerHarness({ scenario: 'success' });
  const verified = await harness.runner.verifyRuntime();
  expect(verified.version).toBe('0.80.10');
  expect(verified.entry).toBe(harness.fakePiEntry);
});

it('materializes with the real provider revision and resolved model set', async () => {
  const harness = createPiRunnerHarness({ scenario: 'success' });
  const run = await harness.runner.run({
    scope: { kind: 'task', taskId: 't1' }, executionId: 'profile-identity', expert: 'dev', resultKind: 'task_execution', prompt: 'p', cwd: harness.cwd,
  });
  await collect(run.events);
  expect((await run.done()).ok).toBe(true);
  expect(harness.materializedProfiles).toEqual([
    expect.objectContaining({
      providerId: 'p1',
      providerRevision: 7,
      models: ['gpt-default'],
    }),
  ]);
});

it('uses globally unique attempt ids for repeated same-expert executions', async () => {
  const harness = createPiRunnerHarness({ scenario: 'success' });
  for (const executionId of ['execution-a', 'execution-b']) {
    const run = await harness.runner.run({
      scope: { kind: 'task', taskId: executionId }, executionId, expert: 'dev', resultKind: 'task_execution', prompt: 'review', cwd: harness.cwd,
    });
    await collect(run.events);
    expect((await run.done()).ok).toBe(true);
  }
  expect(harness.attemptCollisions).toEqual([]);
  expect(harness.spawnedCommands).toHaveLength(2);
  expect(new Set(harness.attemptIds).size).toBe(2);
  expect(harness.attemptIds).toEqual(expect.arrayContaining([
    expect.stringContaining('execution-a'),
    expect.stringContaining('execution-b'),
  ]));
});

it('gives concurrent attempts distinct writable config and session roots', async () => {
  const harness = createPiRunnerHarness({ scenario: 'success' });
  const runs = await Promise.all(['one', 'two'].map((executionId) => harness.runner.run({
    scope: { kind: 'task', taskId: executionId }, executionId, expert: 'dev', resultKind: 'task_execution', prompt: 'verify', cwd: harness.cwd,
  })));
  await Promise.all(runs.map(async (run) => {
    await collect(run.events);
    expect((await run.done()).ok).toBe(true);
  }));
  expect(new Set(harness.spawnedCommands.map((command) => command.configDir)).size).toBe(2);
  expect(new Set(harness.spawnedCommands.map((command) => command.sessionDir)).size).toBe(2);
});

it('records every provider route attempt with shared logical request and deduplicated usage', async () => {
  const starts: Array<import('@ai-devflow/core').ProviderCallStart> = [];
  const finishes: Array<{ id: string; value: import('@ai-devflow/core').ProviderCallFinish }> = [];
  const harness = createPiRunnerHarness({
    scenario: 'mutate-then-provider-error',
    usage: {
      start: (value) => {
        starts.push(value);
        return `usage-${starts.length}`;
      },
      finish: (id, value) => finishes.push({ id, value }),
    },
  });
  const run = await harness.runner.run({
    scope: { kind: 'task', taskId: 't1' }, executionId: 'usage-execution', expert: 'dev',
    resultKind: 'task_execution', prompt: 'p', cwd: harness.cwd,
  });
  await collect(run.events);
  expect((await run.done()).ok).toBe(true);

  expect(starts).toHaveLength(2);
  expect(starts.map((value) => value.logicalRequestId)).toEqual(['usage-execution', 'usage-execution']);
  expect(starts.map((value) => value.providerId)).toEqual(['p1', 'p1']);
  expect(starts[0]).toMatchObject({ source: 'task_agent', taskId: 't1', attemptOrdinal: 1, model: 'gpt-default' });
  expect(finishes).toEqual([
    expect.objectContaining({ id: 'usage-1', value: expect.objectContaining({ status: 'failed', failureKind: 'transient_provider' }) }),
    expect.objectContaining({
      id: 'usage-2',
      value: expect.objectContaining({
        status: 'succeeded',
        usage: { input: 100, output: 40, cacheRead: 20, cacheWrite: 5, total: 165 },
      }),
    }),
  ]);
});

it('keeps task execution successful when usage persistence throws', async () => {
  const harness = createPiRunnerHarness({
    scenario: 'success',
    usage: { start: vi.fn(() => { throw new Error('analytics unavailable'); }), finish: vi.fn() },
  });
  const run = await harness.runner.run({
    scope: { kind: 'task', taskId: 't1' }, executionId: 'usage-best-effort', expert: 'dev',
    resultKind: 'task_execution', prompt: 'p', cwd: harness.cwd,
  });
  await collect(run.events);
  expect((await run.done()).ok).toBe(true);
});
