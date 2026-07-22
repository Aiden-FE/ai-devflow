import { expect, it } from 'vitest';
import { createPiRunnerHarness } from './helpers/pi-runner-harness.js';

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const event of events) values.push(event);
  return values;
}

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

it('does not fail over on a task-result failure (structured result received)', async () => {
  const harness = createPiRunnerHarness({ scenario: 'task-result-failure' });
  const run = await harness.runner.run({
    taskId: 't1', executionId: 'e1', role: 'tester', prompt: 'p', cwd: harness.cwd,
  });
  const events = await collect(run.events);
  expect(events).toContainEqual(expect.objectContaining({ type: 'done' }));
  expect(harness.spawnedCommands).toHaveLength(1);
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
