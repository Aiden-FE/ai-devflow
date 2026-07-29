# Provider Route Runtime Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make expert-specific provider/model routes fall back to default routes at runtime and preserve a safe final failure cause for knowledge initialization.

**Architecture:** `ProviderRouter` will produce an ordered route plan containing the expert override followed by deduplicated default routes. Override routes receive model-specific health IDs so a failed pinned model cannot poison or be cleared by the provider's default model. `PiRunner` will format a bounded, redacted `ProviderExecutionError.detail` into its terminal error event; the existing knowledge coordinator will then persist and surface that message unchanged.

**Tech Stack:** TypeScript, Vitest, Electron main process, `@ai-devflow/agents`, `@ai-devflow/scheduler`

## Global Constraints

- Preserve the existing `MAX_ATTEMPTS = 8` total provider-call limit.
- `task_result` and `interaction` errors must never trigger provider fallback.
- Authentication failures must skip every remaining route for the same provider.
- Default route IDs remain `providerId:expert` for compatibility; override route IDs include a stable model digest.
- `onlyProviderId` must never execute another provider.
- Error details must be redacted, non-duplicative, and capped before entering `AgentEvent.error`.
- Do not change Provider-level `workloadModels[expert] ?? defaultModel` resolution.

---

### Task 1: Runtime fallback route plan

**Files:**
- Modify: `packages/agents/src/provider-router.ts:100-251`
- Test: `packages/agents/src/__tests__/provider-router.test.ts:305-359`

**Interfaces:**
- Consumes: `ProviderRouterDeps.agentOverrideFor(expert): { providerId: string; model: string } | undefined`
- Produces: `ProviderRouter.routesFor(expert): ProviderRoute[]` ordered as override then deduplicated defaults
- Produces: model-specific override `ProviderRoute.routeId`

- [ ] **Step 1: Write failing route-plan tests**

Add tests that assert the override is first, defaults remain available, exact duplicates are removed, and route IDs are isolated:

```ts
it('orders a pinned route before deduplicated defaults with isolated health ids', () => {
  const { router } = overrideHarness([p1, p2], {
    agentOverrideFor: () => ({ providerId: 'p1', model: 'gpt-special' }),
  });

  const routes = router.routesFor('project_lead');
  expect(routes.map((route) => [route.providerId, route.model])).toEqual([
    ['p1', 'gpt-special'],
    ['p1', 'gpt-4o'],
    ['p2', 'claude-3-5-sonnet'],
  ]);
  expect(routes[0]!.routeId).not.toBe(routes[1]!.routeId);
});

it('deduplicates an override equal to the provider default model', () => {
  const { router } = overrideHarness([p1, p2], {
    agentOverrideFor: () => ({ providerId: 'p1', model: 'gpt-4o' }),
  });

  expect(router.routesFor('project_lead').filter((route) =>
    route.providerId === 'p1' && route.model === 'gpt-4o')).toHaveLength(1);
});
```

- [ ] **Step 2: Run the route-plan tests and verify RED**

Run:

```bash
pnpm --filter @ai-devflow/agents exec vitest run src/__tests__/provider-router.test.ts
```

Expected: the first test fails because only the override route is returned; the route-ID assertion also fails because override and default variants are not independently represented.

- [ ] **Step 3: Write failing execution-fallback tests**

Add tests that exercise actual `execute()` behavior rather than only route construction:

```ts
it('falls back from a failed pinned model to the same provider default and then other providers', async () => {
  const { router } = overrideHarness([p1, p2], {
    agentOverrideFor: () => ({ providerId: 'p1', model: 'gpt-special' }),
  });
  const visited: Array<[string, string]> = [];

  const result = await router.execute('project_lead', async (route) => {
    visited.push([route.providerId, route.model]);
    if (route.model === 'gpt-special') {
      throw new ProviderExecutionError('missing pinned model', 'model_unavailable', 404);
    }
    return 'ok';
  });

  expect(result).toBe('ok');
  expect(visited).toEqual([
    ['p1', 'gpt-special'],
    ['p1', 'gpt-4o'],
  ]);
});

it('skips the same provider default after pinned-route authentication failure', async () => {
  const { router } = overrideHarness([p1, p2], {
    agentOverrideFor: () => ({ providerId: 'p1', model: 'gpt-special' }),
  });
  const visited: string[] = [];

  await router.execute('project_lead', async (route) => {
    visited.push(route.providerId);
    if (route.providerId === 'p1') {
      throw new ProviderExecutionError('unauthorized', 'authentication', 401);
    }
    return 'ok';
  });

  expect(visited).toEqual(['p1', 'p2']);
});
```

Also add an `onlyProviderId` regression test where `chat` is pinned to `p2`, `execute(..., { onlyProviderId: 'p1' })` still visits only the `p1` default route.

- [ ] **Step 4: Run the execution tests and verify RED**

Run the same focused Vitest command. Expected: fallback tests fail because `routesFor()` supplies only the pinned route and the targeted provider can be filtered out entirely.

- [ ] **Step 5: Implement the minimal ordered route plan**

In `provider-router.ts`:

```ts
function overrideRouteId(providerId: string, expert: AgentKey, model: string): string {
  const digest = createHash('sha256').update(model).digest('hex').slice(0, 12);
  return `${providerId}:${expert}:override:${digest}`;
}
```

Extend `collectCandidates()` with a route-ID mode so override candidates use `overrideRouteId()` and defaults retain `${provider.id}:${expert}`. Extract the existing active/probe selection into a helper, then make `routesFor()` return:

```ts
const overrideRoutes = selectAvailableRoutes(overrideCandidates);
const defaultRoutes = selectAvailableRoutes(defaultCandidates);
if (overrideRoutes.length === 0) return defaultRoutes;
const preferred = overrideRoutes[0]!;
return [
  preferred,
  ...defaultRoutes.filter((route) =>
    route.providerId !== preferred.providerId || route.model !== preferred.model),
];
```

Keep `execute()` filtering `onlyProviderId` after this full route plan is built. Do not change its authentication, result, interaction, retry, or attempt-limit branches.

- [ ] **Step 6: Run ProviderRouter tests and verify GREEN**

Run the focused test file. Expected: all route ordering, fallback, health, authentication, result, interaction, attempt-limit, and targeted-provider tests pass.

- [ ] **Step 7: Commit the route fallback**

```bash
git add packages/agents/src/provider-router.ts packages/agents/src/__tests__/provider-router.test.ts
git commit -m "fix(agents): restore runtime fallback for expert routes"
```

---

### Task 2: Preserve the final provider failure detail

**Files:**
- Modify: `packages/agents/src/pi-runner.ts:120-150`
- Modify: `packages/agents/src/__tests__/fixtures/fake-pi.mjs:1-210`
- Modify: `packages/agents/src/__tests__/helpers/pi-runner-harness.ts:12-34`
- Test: `packages/agents/src/__tests__/pi-runner.test.ts`

**Interfaces:**
- Consumes: `ProviderExecutionError.message` and optional `ProviderExecutionError.detail`
- Produces: `AgentEvent.error.message` containing a stable summary plus bounded redacted detail

- [ ] **Step 1: Add an always-failing fake provider scenario**

Add `'always-provider-error'` to `FakeScenario` and emit a provider error on every attempt:

```js
case 'always-provider-error':
  emit({
    type: 'error',
    status: 404,
    message: 'model unavailable for fake-secret',
  });
  process.exit(1);
  break;
```

The real translator receives `fake-secret` in its secret list, so the regression test exercises actual redaction rather than a mocked formatter.

- [ ] **Step 2: Write the failing PiRunner diagnostic test**

```ts
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
  expect(error && error.type === 'error' ? error.message : '').not.toContain('fake-secret');
  expect((await run.done()).ok).toBe(false);
});
```

- [ ] **Step 3: Run the PiRunner test and verify RED**

Run:

```bash
pnpm --filter @ai-devflow/agents exec vitest run src/__tests__/pi-runner.test.ts
```

Expected: the event contains only “所有已配置 AI 服务暂时不可用，请稍后重试” and does not contain the model failure cause.

- [ ] **Step 4: Implement bounded diagnostic formatting**

Import the shared redactor from `@ai-devflow/core` and add a private formatter near `PiRunner.run()`:

```ts
const MAX_PROVIDER_ERROR_DETAIL = 2_000;

function providerErrorMessage(error: unknown): string {
  if (!(error instanceof ProviderExecutionError) || !error.detail?.trim()) {
    return error instanceof Error ? error.message : String(error);
  }
  const detail = redactText(error.detail).trim();
  if (!detail || detail === error.message) return error.message;
  const bounded = detail.length > MAX_PROVIDER_ERROR_DETAIL
    ? `...${detail.slice(-MAX_PROVIDER_ERROR_DETAIL)}`
    : detail;
  return `${error.message}: ${bounded}`;
}
```

Use this helper for the terminal error event while retaining `failureKind` from the original error. Do not alter route classification or analytics status.

- [ ] **Step 5: Run PiRunner tests and verify GREEN**

Run the focused test file. Expected: the diagnostic test passes, the raw fake secret is absent, and all existing failover/interaction/result tests remain green.

- [ ] **Step 6: Commit provider diagnostics**

```bash
git add packages/agents/src/pi-runner.ts packages/agents/src/__tests__/pi-runner.test.ts packages/agents/src/__tests__/helpers/pi-runner-harness.ts packages/agents/src/__tests__/fixtures/fake-pi.mjs
git commit -m "fix(agents): expose redacted provider failure detail"
```

---

### Task 3: Cross-package regression verification

**Files:**
- Verify: `packages/agents/src/provider-router.ts`
- Verify: `packages/agents/src/pi-runner.ts`
- Verify: `packages/scheduler/src/knowledge-coordinator.ts`
- Verify: `apps/desktop/electron/ipc.ts`

**Interfaces:**
- Consumes: `AgentEvent.error.message` from `PiRunner`
- Confirms: `KnowledgeCoordinator.startInitialization()` persists and rethrows that message through its existing catch path

- [ ] **Step 1: Run all Agents tests**

```bash
pnpm --filter @ai-devflow/agents test
```

Expected: all non-real tests pass; the five explicitly gated real-Pi tests remain skipped.

- [ ] **Step 2: Run Scheduler and Desktop knowledge tests**

```bash
pnpm --filter @ai-devflow/scheduler test
pnpm --filter @ai-devflow/desktop exec vitest run electron/__tests__/knowledge-ipc.test.ts electron/__tests__/services-knowledge-wiring.test.ts
```

Expected: knowledge initialization, confirmation, cancellation, cleanup, workflow wiring, and diagnostics tests pass.

- [ ] **Step 3: Run full workspace type checking**

```bash
pnpm -r typecheck
```

Expected: every workspace TypeScript package exits successfully.

- [ ] **Step 4: Check patch hygiene and review the final diff**

```bash
git diff --check
git diff -- packages/agents/src/provider-router.ts packages/agents/src/pi-runner.ts packages/agents/src/__tests__/provider-router.test.ts packages/agents/src/__tests__/pi-runner.test.ts packages/agents/src/__tests__/helpers/pi-runner-harness.ts packages/agents/src/__tests__/fixtures/fake-pi.mjs
```

Expected: no whitespace errors and no changes outside the approved route fallback and diagnostic scope.
