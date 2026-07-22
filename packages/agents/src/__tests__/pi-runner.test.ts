import { expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { validateRoleCompletion } from '../pi-runner.js';
import { createPiRunnerHarness } from './helpers/pi-runner-harness.js';

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const event of events) values.push(event);
  return values;
}

it('enforces the narrow role-specific structured-result evidence contract', () => {
  const base = { summary: 'done', verification: ['pnpm test: pass'], changedFiles: [], unresolved: [] };
  expect(validateRoleCompletion('planner', base)).toBeUndefined();
  expect(validateRoleCompletion('coder', { ...base, verification: [] })).toMatch(/验证证据/);
  expect(validateRoleCompletion('tester', { ...base, verification: ['   '] })).toMatch(/验证证据/);
  expect(validateRoleCompletion('reviewer', { ...base, summary: 'reviewed' })).toMatch(/REVIEW_VERDICT/);
  expect(validateRoleCompletion('reviewer', {
    ...base,
    summary: 'reviewed\nREVIEW_VERDICT: PASS',
    changedFiles: ['src/changed.ts'],
  })).toMatch(/不得报告变更文件/);
  expect(validateRoleCompletion('reviewer', {
    ...base,
    summary: 'reviewed\nREVIEW_VERDICT: PASS',
  })).toBeUndefined();
});

it('uses the absolute fake Pi entry and emits done only after report_result', async () => {
  const harness = createPiRunnerHarness({ scenario: 'success' });
  const run = await harness.runner.run({
    taskId: 't1', executionId: 'e1', role: 'coder', prompt: 'change fixture', cwd: harness.cwd,
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
    taskId: 't1', executionId: 'e1', role: 'coder', prompt: 'change fixture', cwd: harness.cwd,
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
    taskId: 't1', executionId: 'instructions', role: 'coder', prompt: 'TASK-REQUEST', cwd: harness.cwd,
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
    taskId: 't1', executionId: 'resume', role: 'coder', prompt: 'continue', cwd: harness.cwd,
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
    taskId: 't1', executionId: 'invalid-resume', role: 'coder', prompt: 'continue', cwd: harness.cwd,
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
    taskId: 't1', executionId: 'e1', role: 'tester', prompt: 'p', cwd: harness.cwd,
  });
  const events = await collect(run.events);
  expect(events).toContainEqual(expect.objectContaining({ type: 'done' }));
  expect(harness.spawnedCommands.length).toBeGreaterThanOrEqual(2);
});

it('retries a runtime crash once then recovers', async () => {
  const harness = createPiRunnerHarness({ scenario: 'runtime-crash' });
  const run = await harness.runner.run({
    taskId: 't1', executionId: 'e1', role: 'coder', prompt: 'p', cwd: harness.cwd,
  });
  const events = await collect(run.events);
  expect(events).toContainEqual(expect.objectContaining({ type: 'done' }));
  expect(harness.spawnedCommands.length).toBeGreaterThanOrEqual(2);
});

it('treats protocol corruption as recoverable and fails over', async () => {
  const harness = createPiRunnerHarness({ scenario: 'protocol-corruption' });
  const run = await harness.runner.run({
    taskId: 't1', executionId: 'e1', role: 'coder', prompt: 'p', cwd: harness.cwd,
  });
  const events = await collect(run.events);
  expect(events).toContainEqual(expect.objectContaining({ type: 'done' }));
  expect(harness.spawnedCommands.length).toBeGreaterThanOrEqual(2);
});

it('stops without failover on an interaction and surfaces ask_user', async () => {
  const harness = createPiRunnerHarness({ scenario: 'interaction' });
  const run = await harness.runner.run({
    taskId: 't1', executionId: 'e1', role: 'coder', prompt: 'p', cwd: harness.cwd,
  });
  const events = await collect(run.events);
  expect(events).toContainEqual(expect.objectContaining({ type: 'ask_user' }));
  expect(harness.spawnedCommands).toHaveLength(1);
  const result = await run.done();
  expect(result.ok).toBe(true);
});

it('fails a reviewer latch-blocked interaction terminal without pausing', async () => {
  const harness = createPiRunnerHarness({ scenario: 'reviewer-latch-blocked-interaction' });
  const run = await harness.runner.run({
    taskId: 'reviewer-blocked', executionId: 'reviewer-blocked', role: 'reviewer', prompt: 'p', cwd: harness.cwd,
  });
  const events = await collect(run.events);

  expect(events).not.toContainEqual(expect.objectContaining({ type: 'ask_user' }));
  expect(events).not.toContainEqual(expect.objectContaining({ type: 'done' }));
  expect(events).toContainEqual(expect.objectContaining({ type: 'error' }));
  expect((await run.done()).ok).toBe(false);
});

it('does not fail over on a task-result failure (structured result received)', async () => {
  const harness = createPiRunnerHarness({ scenario: 'task-result-failure' });
  const run = await harness.runner.run({
    taskId: 't1', executionId: 'e1', role: 'tester', prompt: 'p', cwd: harness.cwd,
  });
  const events = await collect(run.events);
  expect(events).toContainEqual(expect.objectContaining({ type: 'done' }));
  expect(harness.spawnedCommands).toHaveLength(1);
});

it('rejects a role result without verification evidence and does not fail over', async () => {
  const harness = createPiRunnerHarness({ scenario: 'missing-verification' });
  const run = await harness.runner.run({
    taskId: 't1', executionId: 'e1', role: 'coder', prompt: 'p', cwd: harness.cwd,
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
    taskId: 'terminal', executionId: `terminal-${scenario}`, role: 'coder', prompt: 'p', cwd: harness.cwd,
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

it('materializes with the real provider revision and complete primary/fallback model set', async () => {
  const harness = createPiRunnerHarness({ scenario: 'success' });
  const run = await harness.runner.run({
    taskId: 't1', executionId: 'profile-identity', role: 'coder', prompt: 'p', cwd: harness.cwd,
  });
  await collect(run.events);
  expect((await run.done()).ok).toBe(true);
  expect(harness.materializedProfiles).toEqual([
    expect.objectContaining({
      providerId: 'p1',
      providerRevision: 7,
      models: ['gpt-5.6-sol', 'gpt-5.6-terra'],
    }),
  ]);
});

it('uses globally unique attempt ids for repeated same-role executions', async () => {
  const harness = createPiRunnerHarness({ scenario: 'success' });
  for (const executionId of ['execution-a', 'execution-b']) {
    const run = await harness.runner.run({
      taskId: executionId, executionId, role: 'reviewer', prompt: 'review', cwd: harness.cwd,
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
    taskId: executionId, executionId, role: 'tester', prompt: 'verify', cwd: harness.cwd,
  })));
  await Promise.all(runs.map(async (run) => {
    await collect(run.events);
    expect((await run.done()).ok).toBe(true);
  }));
  expect(new Set(harness.spawnedCommands.map((command) => command.configDir)).size).toBe(2);
  expect(new Set(harness.spawnedCommands.map((command) => command.sessionDir)).size).toBe(2);
});
