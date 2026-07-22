# Provider 默认模型配置与模型列表查询实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `ai-devflow` 的每个 AI 服务商可配置默认模型与按 workload 覆盖模型，并对 OpenAI/Anthropic 兼容网关支持点击刷新获取可用模型列表，最终移除运行时对硬编码 `MODEL_TABLE` 的依赖。

**Architecture:** 在 `ProviderConfig`/`ProviderInput` 中新增 `defaultModel` 与 `workloadModels`；`ProviderRouter` 从用户配置解析模型；新增 `provider-models.ts` 负责兼容网关 `/v1/models` 查询；UI 在 provider 表单增加模型输入与“刷新模型列表”。

**Tech Stack:** TypeScript, Electron, Vitest, React, Tailwind CSS, pnpm monorepo.

## Global Constraints

- 所有 provider 密钥必须加密落盘，不得进入 Renderer/IPC 明文。
- 兼容网关查询仅允许 `openai_compatible` / `anthropic_compatible`。
- 未配置模型的服务商必须报告 `configuration_error`，不进入路由重试。
- 标准服务商（非兼容网关）不自动查询模型列表，仅支持手动输入。
- 所有变更需通过 `pnpm verify`（typecheck + lint + test + scripts）。
- 合并到 `main` 后手动触发 release workflow 部署 patch 版本 `0.2.1`。

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/core/src/provider.ts` | `ProviderConfig`/`ProviderInput` 增加模型字段；`normalizeProviderInput` 校验/归一化。 |
| `packages/core/src/__tests__/provider.test.ts` | 模型字段归一化与校验测试。 |
| `packages/agents/src/provider-router.ts` | 从用户配置解析 workload 模型；移除运行时 `MODEL_TABLE` 依赖。 |
| `packages/agents/src/__tests__/provider-router.test.ts` | 用户模型解析、无模型跳过、多 provider 路由测试。 |
| `apps/desktop/electron/provider-store.ts` | 无模型时报告 `configuration_error`；模型变化触发 revision 递增与健康清除。 |
| `apps/desktop/electron/__tests__/provider-store.test.ts` | 健康状态与 revision 测试。 |
| `apps/desktop/electron/provider-models.ts` | 兼容网关 `/v1/models` 查询实现。 |
| `apps/desktop/electron/__tests__/provider-models.test.ts` | 模型列表查询解析与错误处理测试。 |
| `apps/desktop/electron/pi-ai.ts` | `PiAiService.listModels` 接口与实现。 |
| `apps/desktop/electron/api.ts` | `DesktopApi.providers.listModels` 类型。 |
| `apps/desktop/electron/ipc.ts` | 注册 `providers.listModels` IPC handler。 |
| `apps/desktop/electron/preload.ts` | 暴露 `providers.listModels` 到 Renderer。 |
| `apps/desktop/src/pages/Settings.tsx` | provider 表单增加模型输入、workload 覆盖、刷新模型列表。 |
| `apps/desktop/src/i18n/zh.ts` / `en.ts` | 新增翻译键。 |

---

### Task 1: Extend core provider types and normalization

**Files:**
- Modify: `packages/core/src/provider.ts`
- Test: `packages/core/src/__tests__/provider.test.ts`

**Interfaces:**
- Consumes: existing `ProviderKind`, `AuthType`, `Workload`.
- Produces: `ModelRoleKey` type, `defaultModel?: string`, `workloadModels?: Partial<Record<ModelRoleKey, string>>` on `ProviderConfig`/`ProviderInput`, updated `normalizeProviderInput`.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/__tests__/provider.test.ts`:

```ts
it('preserves defaultModel and workloadModels after trimming empty values', () => {
  const result = normalizeProviderInput({
    id: 'p1', kind: 'openai', displayName: 'O', enabled: true,
    priority: 0, authType: 'api_key', apiKey: 'secret', revision: 1,
    defaultModel: 'gpt-custom',
    workloadModels: { coder: 'coder-model', chat: '  ' },
  });
  expect(result.config.defaultModel).toBe('gpt-custom');
  expect(result.config.workloadModels).toEqual({ coder: 'coder-model' });
});

it('rejects a provider with no models configured', () => {
  expect(() => normalizeProviderInput({
    id: 'p1', kind: 'openai', displayName: 'O', enabled: true,
    priority: 0, authType: 'api_key', apiKey: 'secret', revision: 1,
  })).toThrow(/模型/);
});

it('accepts workloadModels covering all roles without defaultModel', () => {
  const result = normalizeProviderInput({
    id: 'p1', kind: 'openai', displayName: 'O', enabled: true,
    priority: 0, authType: 'api_key', apiKey: 'secret', revision: 1,
    workloadModels: { planner: 'p', coder: 'c', reviewer: 'r', tester: 't', chat: 'ch', proposal: 'pr' },
  });
  expect(result.config.defaultModel).toBeUndefined();
  expect(result.config.workloadModels).toBeDefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ai-devflow/core test`
Expected: FAIL with `defaultModel` / `workloadModels` not recognized or missing validation.

- [ ] **Step 3: Write minimal implementation**

Modify `packages/core/src/provider.ts`:

```ts
export type ModelRoleKey = 'planner' | 'coder' | 'reviewer' | 'tester' | 'chat' | 'proposal';

export interface ProviderConfig {
  // ... existing fields ...
  /** 默认模型；未设置且对应 workload 无覆盖时，该服务商对此 workload 不可用。 */
  defaultModel?: string;
  /** 按 workload 覆盖默认模型。 */
  workloadModels?: Partial<Record<ModelRoleKey, string>>;
}
```

Add validation and normalization inside `normalizeProviderInput` after baseURL handling:

```ts
function trimModel(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function normalizeWorkloadModels(input?: Partial<Record<ModelRoleKey, string>>): Partial<Record<ModelRoleKey, string>> | undefined {
  if (!input) return undefined;
  const out: Partial<Record<ModelRoleKey, string>> = {};
  for (const [key, value] of Object.entries(input)) {
    const trimmed = trimModel(value);
    if (trimmed) out[key as ModelRoleKey] = trimmed;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const defaultModel = trimModel(input.defaultModel);
const workloadModels = normalizeWorkloadModels(input.workloadModels);
if (!defaultModel && !workloadModels) {
  throw new Error('至少配置一个默认模型或全部 workload 模型');
}
```

Include `defaultModel` and `workloadModels` in the returned `config` object.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ai-devflow/core test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/provider.ts packages/core/src/__tests__/provider.test.ts
git commit -m "feat(core): provider model config fields and validation"
```

---

### Task 2: Update ProviderRouter to resolve models from user config

**Files:**
- Modify: `packages/agents/src/provider-router.ts`
- Test: `packages/agents/src/__tests__/provider-router.test.ts`

**Interfaces:**
- Consumes: `ProviderConfig.defaultModel`, `ProviderConfig.workloadModels`, `Workload`.
- Produces: `resolveModelFor(provider, workload): string | undefined`; `routesFor` now yields one route per provider/workload (no fallback tier).

- [ ] **Step 1: Write the failing test**

Replace the existing chat/proposal mapping test and add a missing-model test in `packages/agents/src/__tests__/provider-router.test.ts`:

```ts
it('uses user-configured default model for all workloads', () => {
  const harness = makeRouterHarness(['p1']);
  harness.providers[0]!.defaultModel = 'my-default';
  const routes = harness.router.routesFor('coder');
  expect(routes[0]?.model).toBe('my-default');
  expect(routes[0]?.models).toEqual(['my-default']);
});

it('uses workload-specific override when set', () => {
  const harness = makeRouterHarness(['p1']);
  harness.providers[0]!.defaultModel = 'my-default';
  harness.providers[0]!.workloadModels = { tester: 'chat-override' };
  const chat = harness.router.routesFor('task_chat');
  expect(chat[0]?.model).toBe('chat-override');
  const coder = harness.router.routesFor('coder');
  expect(coder[0]?.model).toBe('my-default');
});

it('skips provider when no model can be resolved for workload', () => {
  const harness = makeRouterHarness(['p1']);
  harness.providers[0]!.workloadModels = { tester: 'chat-only' };
  expect(harness.router.routesFor('coder')).toHaveLength(0);
  expect(harness.router.routesFor('task_chat')).toHaveLength(1);
});
```

Update the harness helper to include models so existing tests still pass:

```ts
function makeRouterHarness(ids: string[]) {
  const providers: ProviderConfig[] = ids.map((id, priority) => ({
    id, kind: 'openai' as const, displayName: id, enabled: true, priority,
    authType: 'api_key' as const, credentialRef: `provider:${id}`, revision: 1,
    defaultModel: 'gpt-default',
  }));
  // ... rest unchanged
}
```

Remove or update tests that rely on fallback routes (e.g., "tries same-provider fallback before the next provider" should now test next-provider fallback only).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ai-devflow/agents test`
Expected: FAIL with `defaultModel` not used / fallback routes not found.

- [ ] **Step 3: Write minimal implementation**

Modify `packages/agents/src/provider-router.ts`:

Add helper:

```ts
function workloadRoleKey(workload: Workload): ModelRoleKey {
  switch (workload) {
    case 'planner': return 'planner';
    case 'coder': return 'coder';
    case 'reviewer': return 'reviewer';
    case 'tester': return 'tester';
    case 'task_chat':
    case 'requirement_chat': return 'chat';
    case 'task_proposal':
    case 'requirement_proposal': return 'proposal';
  }
}

function resolveModelFor(provider: ProviderConfig, workload: Workload): string | undefined {
  const role = workloadRoleKey(workload);
  return provider.workloadModels?.[role] ?? provider.defaultModel;
}
```

Update `routesFor`:
- Remove `MODEL_TABLE` lookup.
- Replace model resolution with `resolveModelFor(provider, workload)`.
- Generate only one route per provider/workload (remove primary/fallback tier loop).
- `models` array contains only the resolved model.
- `routeId` becomes `${provider.id}:${workload}`.
- Remove `ModelRoute` and `ModelChoice` references if no longer needed (keep interface if used elsewhere).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ai-devflow/agents test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/provider-router.ts packages/agents/src/__tests__/provider-router.test.ts
git commit -m "feat(agents): resolve provider models from user config"
```

---

### Task 3: ProviderStore reports configuration_error for missing models

**Files:**
- Modify: `apps/desktop/electron/provider-store.ts`
- Test: `apps/desktop/electron/__tests__/provider-store.test.ts`

**Interfaces:**
- Consumes: `ProviderConfig.defaultModel`, `ProviderConfig.workloadModels`.
- Produces: `ProviderStore.list()` returns `health: 'configuration_error'` when provider has no models; `save()` treats model changes as revisions changes.

- [ ] **Step 1: Write the failing test**

Add to `apps/desktop/electron/__tests__/provider-store.test.ts`:

```ts
it('lists provider without models as configuration_error', () => {
  const harness = makeProviderStoreHarness();
  harness.store.save({
    id: 'p1', kind: 'openai', displayName: 'O', enabled: true,
    priority: 0, authType: 'api_key', apiKey: 'k', revision: 1,
    defaultModel: 'm',
  });
  // simulate legacy provider with no models by directly editing config
  const config = harness.store.listConfigs()[0]!;
  delete (config as Partial<typeof config>).defaultModel;
  harness.store.save({ ...config, apiKey: 'k2' });
  expect(harness.store.list()[0]!.health).toBe('configuration_error');
});

it('bumps revision and clears health when model config changes', () => {
  const harness = makeProviderStoreHarness();
  harness.store.save({
    id: 'p1', kind: 'openai', displayName: 'O', enabled: true,
    priority: 0, authType: 'api_key', apiKey: 'k', revision: 1,
    defaultModel: 'm1',
  });
  expect(harness.store.list()[0]!.revision).toBe(1);
  harness.store.save({
    id: 'p1', kind: 'openai', displayName: 'O', enabled: true,
    priority: 0, authType: 'api_key', apiKey: 'k', revision: 1,
    defaultModel: 'm2',
  });
  expect(harness.store.list()[0]!.revision).toBe(2);
  expect(harness.cleared).toContain('p1');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ai-devflow/desktop test`
Expected: FAIL (health stays `untested`, revision not bumped on model change).

- [ ] **Step 3: Write minimal implementation**

Modify `apps/desktop/electron/provider-store.ts`:

Add helper:

```ts
function hasModelConfig(config: ProviderConfig): boolean {
  if (config.defaultModel?.trim()) return true;
  if (!config.workloadModels) return false;
  return Object.values(config.workloadModels).some((v) => v?.trim());
}
```

Update `list()`:

```ts
health: hasModelConfig(c) ? 'untested' : 'configuration_error',
```

Update `save()` `changed` check to include model changes:

```ts
changed =
  existing.kind !== config.kind ||
  (existing.baseURL ?? '') !== (config.baseURL ?? '') ||
  existing.enabled !== config.enabled ||
  existing.defaultModel !== config.defaultModel ||
  JSON.stringify(existing.workloadModels ?? {}) !== JSON.stringify(config.workloadModels ?? {}) ||
  secret !== undefined;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ai-devflow/desktop test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/provider-store.ts apps/desktop/electron/__tests__/provider-store.test.ts
git commit -m "feat(desktop): configuration_error for providers without models"
```

---

### Task 4: Add compatible-gateway model list fetcher

**Files:**
- Create: `apps/desktop/electron/provider-models.ts`
- Test: `apps/desktop/electron/__tests__/provider-models.test.ts`

**Interfaces:**
- Consumes: `ProviderConfig` (kind, baseURL), secret string.
- Produces: `fetchCompatibleModels(provider, secret): Promise<string[]>`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/electron/__tests__/provider-models.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { ProviderConfig } from '@ai-devflow/core';
import { fetchCompatibleModels } from '../provider-models.js';

const baseConfig: ProviderConfig = {
  id: 'p1', kind: 'openai_compatible', displayName: 'G', enabled: true,
  priority: 0, authType: 'api_key', credentialRef: 'provider:p1', revision: 1,
  baseURL: 'https://gateway.example/v1', defaultModel: 'm',
};

describe('fetchCompatibleModels', () => {
  it('returns empty for non-compatible kinds', async () => {
    const result = await fetchCompatibleModels({ ...baseConfig, kind: 'openai' } as ProviderConfig, 'secret');
    expect(result).toEqual([]);
  });

  it('parses OpenAI-compatible /v1/models response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'b' }, { id: 'a' }] }),
    });
    const result = await fetchCompatibleModels(baseConfig, 'sk-test');
    expect(result).toEqual(['a', 'b']);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://gateway.example/v1/models',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer sk-test' }) }),
    );
  });

  it('parses Anthropic-compatible /v1/models response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'claude-x' }] }),
    });
    const result = await fetchCompatibleModels({ ...baseConfig, kind: 'anthropic_compatible' } as ProviderConfig, 'sk-test');
    expect(result).toEqual(['claude-x']);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://gateway.example/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-api-key': 'sk-test',
          'anthropic-version': '2023-06-01',
        }),
      }),
    );
  });

  it('returns empty on fetch error', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network'));
    const result = await fetchCompatibleModels(baseConfig, 'sk-test');
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ai-devflow/desktop test`
Expected: FAIL with `fetchCompatibleModels` not defined.

- [ ] **Step 3: Write minimal implementation**

Create `apps/desktop/electron/provider-models.ts`:

```ts
import type { ProviderConfig, ProviderKind } from '@ai-devflow/core';
import { isCompatibleKind } from '@ai-devflow/agents';

const MODEL_LIST_TIMEOUT_MS = 15_000;

function authHeaders(kind: ProviderKind, secret: string): Record<string, string> {
  if (kind === 'anthropic_compatible') {
    return { 'x-api-key': secret, 'anthropic-version': '2023-06-01' };
  }
  return { Authorization: `Bearer ${secret}` };
}

export async function fetchCompatibleModels(provider: ProviderConfig, secret: string): Promise<string[]> {
  if (!isCompatibleKind(provider.kind) || !provider.baseURL) return [];
  const url = `${provider.baseURL.replace(/\/$/, '')}/models`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MODEL_LIST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { ...authHeaders(provider.kind, secret) },
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    const ids = (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string');
    return [...new Set(ids)].sort();
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ai-devflow/desktop test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/provider-models.ts apps/desktop/electron/__tests__/provider-models.test.ts
git commit -m "feat(desktop): fetch compatible gateway model lists"
```

---

### Task 5: Wire IPC for `providers.listModels`

**Files:**
- Modify: `apps/desktop/electron/api.ts`
- Modify: `apps/desktop/electron/ipc.ts`
- Modify: `apps/desktop/electron/preload.ts`
- Modify: `apps/desktop/electron/pi-ai.ts`
- Test: `apps/desktop/electron/__tests__/ipc.test.ts`

**Interfaces:**
- Consumes: `fetchCompatibleModels`, `ProviderStore.resolveSecret`.
- Produces: `DesktopApi.providers.listModels(providerId): Promise<{ id: string }[]>`, IPC channel `providers.listModels`.

- [ ] **Step 1: Write the failing test**

Add to `apps/desktop/electron/__tests__/ipc.test.ts`:

```ts
it('providers.listModels returns empty for standard providers', async () => {
  await call('providers', 'save', {
    id: 'p1', kind: 'openai', displayName: 'O', enabled: true,
    priority: 0, authType: 'api_key', apiKey: 'k', revision: 1,
    defaultModel: 'm',
  });
  const models = await call('providers', 'listModels', 'p1') as unknown[];
  expect(models).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ai-devflow/desktop test`
Expected: FAIL with handler not found.

- [ ] **Step 3: Write minimal implementation**

Add to `DesktopApi` interface in `apps/desktop/electron/api.ts`:

```ts
providers: {
  // ... existing methods ...
  listModels(providerId: string): Promise<{ id: string }[]>;
}
```

Add to `PiAiService` interface in `apps/desktop/electron/pi-ai.ts`:

```ts
listModels(providerId: string): Promise<{ id: string }[]>;
```

Implement in `createPiAiService` return object:

```ts
async listModels(providerId) {
  const configs = ??? // see note below
}
```

Actually, `createPiAiService` only receives `executeText`. It has no access to `ProviderStore`. Better to implement `listModels` in `ipc.ts` directly using `services.providerStore` and `fetchCompatibleModels`, or add a factory function in `services.ts`.

Simpler: add a method to `PiAiService` that takes `provider` and `secret`, and call it from `ipc.ts` after resolving provider/secret.

In `pi-ai.ts`:

```ts
import { fetchCompatibleModels } from './provider-models.js';

export interface PiAiService {
  // ... existing methods ...
  listModels(provider: ProviderConfig, secret: string): Promise<{ id: string }[]>;
}
```

Implementation:

```ts
async listModels(provider, secret) {
  const ids = await fetchCompatibleModels(provider, secret);
  return ids.map((id) => ({ id }));
}
```

In `ipc.ts`, add handler:

```ts
ipcMain.handle(channel('providers', 'listModels'), async (_e, id: string) => {
  if (!providerStore) throw new Error('provider store 不可用');
  const config = providerStore.listConfigs().find((p) => p.id === id);
  if (!config) throw new Error('提供商不存在');
  const secret = providerStore.resolveSecret(id);
  if (!services.piAi) throw new Error('AI 服务未就绪');
  return services.piAi.listModels(config, secret ?? '');
});
```

In `preload.ts`, add to `providers` object:

```ts
listModels: (id) => invoke('providers', 'listModels')(id),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ai-devflow/desktop test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/api.ts apps/desktop/electron/ipc.ts apps/desktop/electron/preload.ts apps/desktop/electron/pi-ai.ts apps/desktop/electron/__tests__/ipc.test.ts
git commit -m "feat(desktop): providers.listModels IPC"
```

---

### Task 6: Update Settings UI for model configuration

**Files:**
- Modify: `apps/desktop/src/pages/Settings.tsx`
- Modify: `apps/desktop/src/i18n/zh.ts` / `en.ts`

**Interfaces:**
- Consumes: `api.providers.listModels`, `ProviderInput.defaultModel`, `ProviderInput.workloadModels`.
- Produces: provider form with model inputs and refresh button.

- [ ] **Step 1: Add translation keys**

In `apps/desktop/src/i18n/zh.ts` add:

```ts
'settings.providers.model.default': '默认模型',
'settings.providers.model.default.hint': '用于所有未单独覆盖的 workload',
'settings.providers.model.workloads': '按 workload 覆盖',
'settings.providers.model.refresh': '刷新模型列表',
'settings.providers.model.refreshing': '刷新中…',
'settings.providers.model.empty': '未获取到可用模型',
'settings.providers.model.required': '请配置默认模型或所有 workload 模型',
'settings.providers.configuration_error': '请编辑并设置模型',
```

In `apps/desktop/src/i18n/en.ts` add corresponding English keys.

- [ ] **Step 2: Update Settings.tsx state and form**

Add state in `ProviderSection`:

```ts
const [defaultModel, setDefaultModel] = useState('');
const [workloadModels, setWorkloadModels] = useState<Partial<Record<ModelRoleKey, string>>>({});
const [availableModels, setAvailableModels] = useState<string[]>([]);
const [modelLoading, setModelLoading] = useState(false);
```

Update `startAdd`, `startEdit`, `startReentry` to reset/fill these fields. For edit, read from `editing.defaultModel` and `editing.workloadModels`.

Update `save`:

```ts
const workloadEntries = Object.entries(workloadModels).filter(([, v]) => v?.trim());
const hasWorkload = workloadEntries.length === 6;
if (!defaultModel.trim() && !hasWorkload) {
  setError(t('settings.providers.model.required'));
  return;
}
const input: ProviderInput = {
  // ... existing fields ...
  defaultModel: defaultModel.trim() || undefined,
  workloadModels: workloadEntries.length > 0 ? Object.fromEntries(workloadEntries) as Record<ModelRoleKey, string> : undefined,
};
```

Add refresh handler:

```ts
const refreshModels = async () => {
  if (!COMPATIBLE_PROVIDER_KINDS.includes(kind)) return;
  setModelLoading(true);
  try {
    const models = await api.providers.listModels(editing?.id ?? '');
    setAvailableModels(models.map((m) => m.id));
  } finally {
    setModelLoading(false);
  }
};
```

Add form fields in the Dialog:

```tsx
<div className="flex flex-col gap-1.5">
  <Label>{t('settings.providers.model.default')}</Label>
  <div className="flex gap-2">
    <Input
      list={editing ? undefined : 'model-suggestions'}
      value={defaultModel}
      onChange={(e) => setDefaultModel(e.target.value)}
      placeholder={t('settings.providers.model.default.hint')}
      className="flex-1"
    />
    {COMPATIBLE_PROVIDER_KINDS.includes(kind) && editing && (
      <Button
        size="sm"
        variant="outline"
        disabled={modelLoading}
        onClick={refreshModels}
      >
        {modelLoading ? t('settings.providers.model.refreshing') : t('settings.providers.model.refresh')}
      </Button>
    )}
  </div>
  {availableModels.length > 0 && (
    <datalist id="model-suggestions">
      {availableModels.map((m) => <option key={m} value={m} />)}
    </datalist>
  )}
</div>
<details className="text-xs">
  <summary>{t('settings.providers.model.workloads')}</summary>
  <div className="mt-2 flex flex-col gap-2">
    {(['planner', 'coder', 'reviewer', 'tester', 'chat', 'proposal'] as const).map((role) => (
      <div key={role} className="flex flex-col gap-1">
        <Label className="text-[11px]">{role}</Label>
        <Input
          value={workloadModels[role] ?? ''}
          onChange={(e) => setWorkloadModels({ ...workloadModels, [role]: e.target.value })}
        />
      </div>
    ))}
  </div>
</details>
```

Show configuration_error banner in provider list item:

```tsx
{p.health === 'configuration_error' && (
  <span className="text-[11px] text-warn">{t('settings.providers.configuration_error')}</span>
)}
```

- [ ] **Step 3: Verify UI typechecks**

Run: `pnpm --filter @ai-devflow/desktop typecheck`
Expected: PASS (may need to import `ModelRoleKey` from core).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/pages/Settings.tsx apps/desktop/src/i18n/zh.ts apps/desktop/src/i18n/en.ts
git commit -m "feat(desktop): provider model config UI and model list refresh"
```

---

### Task 7: Update remaining consumers and integration tests

**Files:**
- Modify: `apps/desktop/scripts/capture-screenshots.mjs`
- Modify: `apps/desktop/scripts/run-e2e.mjs` (optional smoke)
- Modify: `packages/agents/src/__tests__/helpers/pi-runner-harness.ts` if it constructs providers without models.
- Modify: `packages/agents/src/__tests__/real-pi.test.ts` if it constructs providers without models.

- [ ] **Step 1: Fix screenshot script provider seed**

In `apps/desktop/scripts/capture-screenshots.mjs`, the seeded provider needs `defaultModel`:

```js
await window.api.providers.save({
  id: 'shot-provider', kind: 'openai_compatible', displayName: 'OpenAI',
  enabled: true, priority: 0, authType: 'api_key',
  baseURL: 'https://api.openai.com/v1', revision: 0,
  apiKey: 'sk-shot-demo-key-do-not-use', allowInsecureLocal: false,
  defaultModel: 'gpt-4',
});
```

- [ ] **Step 2: Fix any harness/test that builds ProviderConfig without models**

Run: `pnpm -r typecheck`
Fix all TypeScript errors where `ProviderConfig` is constructed without `defaultModel`/`workloadModels`.

- [ ] **Step 3: Run full test suite**

Run: `pnpm verify`
Expected: PASS (fix any failures before proceeding).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/scripts/capture-screenshots.mjs # plus any test harness fixes
git commit -m "chore: update consumers for required provider models"
```

---

### Task 8: Final verification and PR

- [ ] **Step 1: Run verify one last time**

```bash
pnpm verify
```

Expected: PASS

- [ ] **Step 2: Push branch and create PR**

```bash
git push -u origin feat/provider-model-config
gh pr create --base main --title "feat: configurable provider models with compatible gateway model list" --body "Closes provider model mismatch issue. Allows per-provider default model and per-workload overrides; supports fetching /v1/models from OpenAI/Anthropic compatible gateways."
```

- [ ] **Step 3: Merge PR to main**

```bash
gh pr merge --squash --delete-branch
```

- [ ] **Step 4: Trigger patch release**

```bash
gh workflow run release.yml --ref main -f version=0.2.1
```

Verify the workflow starts:

```bash
gh run list --workflow=release.yml --limit 5
```

- [ ] **Step 5: Commit plan document**

The plan itself should already be committed in Task 0 (done before execution). If not:

```bash
git add docs/superpowers/plans/2026-07-22-provider-model-config.md
git commit -m "docs: provider model config implementation plan"
```

---

## Self-Review Checklist

- [ ] Spec coverage: every design section has at least one implementing task.
- [ ] Placeholder scan: no `TODO`, `TBD`, or vague steps remain.
- [ ] Type consistency: `ModelRoleKey`, `defaultModel`, `workloadModels` names match across core, agents, desktop, UI.
- [ ] No runtime dependency on `MODEL_TABLE` after Task 2.
- [ ] Release version `0.2.1` matches patch bump from current `0.2.0`.
