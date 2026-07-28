# Project-Grounded AI Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ground both requirement and task creation in bounded project knowledge content and read-only repository exploration without losing multi-turn conversation history.

**Architecture:** Add a pure knowledge-context materializer in `@ai-devflow/knowledge` that securely reads only manifest candidates and returns prompt text plus read evidence. The desktop IPC layer injects that content and completes retrievals with the returned evidence, while `PiAiService` prepends context without replacing chat history. Both creation step agents receive the same read-only repository tools and explicit project-exploration instructions.

**Tech Stack:** TypeScript, Node.js filesystem/path APIs, Electron IPC, Vitest, pnpm workspaces.

## Global Constraints

- Both `requirement_refiner` and `task_proposer` run from the selected project root.
- Both agents receive `read`, `grep`, `find`, and `ls`; neither receives write-capable tools.
- Knowledge content is limited to manifest candidates and the manifest file/character budgets.
- Resolved candidate paths must remain inside the registered project root, including through symbolic links.
- `ai_devflow_ask` behavior and schema are unchanged.
- Structured proposal schemas and UI confirmation flows are unchanged.
- Existing uncommitted worktree changes must be preserved and must not be included in task commits accidentally.

---

### Task 1: Preserve Conversation History When Injecting Context

**Files:**
- Modify: `apps/desktop/electron/pi-ai.ts:574-584`
- Test: `apps/desktop/electron/__tests__/ai.test.ts`

**Interfaces:**
- Consumes: `PiAiService.chat(messages, onDelta, opts)` and `opts.context?: string`.
- Produces: executor messages shaped as one leading context message followed by every original `AiChatMessage` unchanged and in order.

- [ ] **Step 1: Write the failing conversation-preservation test**

```typescript
it('prepends context without dropping multi-turn conversation history', async () => {
  let captured: AiChatMessage[] = [];
  const service = createPiAiService(async (_workload, messages) => {
    captured = messages;
    return 'ok';
  });
  const history: AiChatMessage[] = [
    { role: 'user', content: '新增登录能力' },
    { role: 'assistant', content: '需要兼容现有会话吗？' },
    { role: 'user', content: '需要兼容' },
  ];

  await service.chat(history, () => {}, { mode: 'task_proposal', context: 'project knowledge' });

  expect(captured).toEqual([
    { role: 'user', content: '【上下文】\nproject knowledge' },
    ...history,
  ]);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter @ai-devflow/desktop exec vitest run electron/__tests__/ai.test.ts`

Expected: FAIL because the current implementation replaces history with a single context-plus-last-message entry.

- [ ] **Step 3: Implement the minimal prompt construction fix**

```typescript
const promptMessages: AiChatMessage[] = opts?.context
  ? [{ role: 'user', content: `【上下文】\n${opts.context}` }, ...messages]
  : messages;
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm --filter @ai-devflow/desktop exec vitest run electron/__tests__/ai.test.ts`

Expected: PASS with all existing `pi-ai` tests green.

- [ ] **Step 5: Record the task boundary**

Do not commit `pi-ai.ts` if its pre-existing ask-bridge hunk cannot be staged separately. Record the exact files changed for the final report instead of committing unrelated work.

### Task 2: Materialize Bounded Knowledge Content Securely

**Files:**
- Create: `packages/knowledge/src/context.ts`
- Modify: `packages/knowledge/src/index.ts`
- Test: `packages/knowledge/src/__tests__/context.test.ts`

**Interfaces:**
- Consumes: `materializeKnowledgeContext(repoPath: string, manifest: KnowledgeRetrievalManifest)`.
- Produces: `Promise<{ content: string; reads: KnowledgeReadEvidence[]; skipped: Array<{ knowledgeId: string; reason: string }> }>`.

- [ ] **Step 1: Write failing tests for content, budgets, missing files, and path containment**

```typescript
it('reads only manifest candidates and returns bounded evidence', async () => {
  const repo = await fixtureRepo({
    'docs/knowledge/context/index.md': 'project context body',
    'docs/knowledge/feature/login.md': 'login implementation body',
  });
  const result = await materializeKnowledgeContext(repo, manifest({
    maxFiles: 1,
    maxChars: 12,
    candidates: [candidate('context:root', 'docs/knowledge/context/index.md'), candidate('feature:login', 'docs/knowledge/feature/login.md')],
  }));

  expect(result.content).toContain('project cont');
  expect(result.content).not.toContain('login implementation body');
  expect(result.reads).toEqual([{ knowledgeId: 'context:root', path: 'docs/knowledge/context/index.md', reason: 'host_prompt_context', chars: 12 }]);
});

it('skips missing and repository-escaping candidates', async () => {
  const repo = await fixtureRepo({ 'docs/knowledge/context/index.md': 'safe' });
  const result = await materializeKnowledgeContext(repo, manifest({
    candidates: [candidate('missing', 'docs/knowledge/missing.md'), candidate('escape', '../outside.md')],
  }));

  expect(result.content).toBe('');
  expect(result.reads).toEqual([]);
  expect(result.skipped.map((item) => item.knowledgeId)).toEqual(['missing', 'escape']);
});
```

The test fixture constructs complete `KnowledgeDocumentRef` and `KnowledgeRetrievalManifest` values rather than mocking filesystem behavior.

- [ ] **Step 2: Run the knowledge tests and verify RED**

Run: `pnpm --filter @ai-devflow/knowledge exec vitest run src/__tests__/context.test.ts`

Expected: FAIL because `materializeKnowledgeContext` and `context.ts` do not exist.

- [ ] **Step 3: Implement secure bounded reads**

Implement `materializeKnowledgeContext` using `realpath`, `resolve`, `relative`, and `readFile` from Node APIs:

```typescript
export interface MaterializedKnowledgeContext {
  content: string;
  reads: KnowledgeReadEvidence[];
  skipped: Array<{ knowledgeId: string; reason: string }>;
}

export async function materializeKnowledgeContext(
  repoPath: string,
  manifest: KnowledgeRetrievalManifest,
): Promise<MaterializedKnowledgeContext>;
```

For each candidate, resolve and realpath the file, reject any relative result beginning with `..` or absolute after `relative`, stop after `maxFiles` successful reads, slice text to the remaining `maxChars`, and append a labeled untrusted-document block. Add one `KnowledgeReadEvidence` per included candidate with `reason: 'host_prompt_context'` and the exact injected character count. Missing, unreadable, escaping, and exhausted candidates are returned in `skipped` without aborting other reads.

- [ ] **Step 4: Export the helper and verify GREEN**

Add `export * from './context.js';` to `packages/knowledge/src/index.ts`.

Run: `pnpm --filter @ai-devflow/knowledge exec vitest run src/__tests__/context.test.ts`

Expected: PASS.

- [ ] **Step 5: Run the whole knowledge package suite**

Run: `pnpm --filter @ai-devflow/knowledge test`

Expected: PASS with no regressions.

### Task 3: Wire Knowledge Content And Repository Exploration Into Both Creation Agents

**Files:**
- Modify: `apps/desktop/electron/ipc.ts:25-43,624-717`
- Modify: `packages/agents/src/profiles.ts:153-173`
- Modify: `packages/agents/assets/profiles/steps/requirement_refiner/SYSTEM.md`
- Modify: `packages/agents/assets/profiles/steps/task_proposer/SYSTEM.md`
- Test: `apps/desktop/electron/__tests__/ipc.test.ts`
- Test: `apps/desktop/electron/__tests__/ai.test.ts`
- Test: `packages/agents/src/__tests__/profiles.test.ts`

**Interfaces:**
- Consumes: `materializeKnowledgeContext(project.path, manifest)` from Task 2.
- Produces: AI prompt context containing manifest metadata plus knowledge document bodies; `KnowledgeCoordinator.completeRetrieval` receives actual read evidence.
- Produces: both step profiles list `read,grep,find,ls` before their structured tools.

- [ ] **Step 1: Write failing profile and IPC tests**

Update the step-profile test to require:

```typescript
expect(STEP_AGENTS.requirement_refiner.tools).toEqual([
  'read', 'grep', 'find', 'ls',
  'ai_devflow_propose_requirement', 'ai_devflow_ask', 'ai_devflow_consult_ux',
]);
expect(STEP_AGENTS.task_proposer.tools).toEqual([
  'read', 'grep', 'find', 'ls', 'ai_devflow_propose_task', 'ai_devflow_ask',
]);
```

Extend the desktop IPC knowledge test with a real initialized knowledge document and assert that the captured AI request contains its body, not only its path. Query `knowledge_retrievals.read_evidence_json` and assert it records the document ID, path, reason, and injected character count. Execute the assertion once with `mode: 'requirement'` and once with `mode: 'task_proposal'`.

- [ ] **Step 2: Run profile and IPC tests and verify RED**

Run:

```bash
pnpm --filter @ai-devflow/agents exec vitest run src/__tests__/profiles.test.ts
pnpm --filter @ai-devflow/desktop exec vitest run electron/__tests__/ai.test.ts electron/__tests__/ipc.test.ts
```

Expected: profile test fails because `requirement_refiner` lacks read-only tools; IPC test fails because only manifest references are injected and retrievals complete with empty reads.

- [ ] **Step 3: Wire materialized content and evidence in IPC**

Import `materializeKnowledgeContext` and replace reference-only serialization with metadata plus `materialized.content`. Track `knowledgeReads` beside `knowledgeManifest`, pass it to `completeRetrieval` on success and failure, and apply the same behavior to UX consultation. Preserve the existing project lookup, expert selection, proposal events, ask bridge, and stream error handling.

```typescript
import { materializeKnowledgeContext } from '@ai-devflow/knowledge';
import type { KnowledgeReadEvidence, KnowledgeRetrievalManifest } from '@ai-devflow/core';

let knowledgeManifest: KnowledgeRetrievalManifest | undefined;
let knowledgeReads: KnowledgeReadEvidence[] = [];

const materialized = knowledgeManifest && knowledgeProject
  ? await materializeKnowledgeContext(knowledgeProject.path, knowledgeManifest)
  : undefined;
knowledgeReads = materialized?.reads ?? [];
const knowledgeContext = knowledgeManifest
  ? serializeChatKnowledgeManifest(knowledgeManifest, materialized?.content)
  : undefined;

services.knowledge?.completeRetrieval(knowledgeManifest, knowledgeReads, 'completed');
```

`serializeChatKnowledgeManifest` keeps the current untrusted-context header and candidate metadata, then appends `materialized.content` when non-empty. The catch path calls `completeRetrieval(knowledgeManifest, knowledgeReads, 'failed')`.

- [ ] **Step 4: Enable project exploration for both step agents**

Prepend `read`, `grep`, `find`, and `ls` to `requirement_refiner.tools`, retain the same set for `task_proposer`, and bump both profile versions from `3` to `4`.

```typescript
requirement_refiner: {
  step: 'requirement_refiner',
  version: 4,
  systemPromptFile: 'SYSTEM.md',
  skills: ['brainstorming'],
  tools: ['read', 'grep', 'find', 'ls', 'ai_devflow_propose_requirement', 'ai_devflow_ask', 'ai_devflow_consult_ux'],
  extensions: ['requirement-bridge', 'ask-bridge', 'ux-bridge'],
  timeoutMs: 10 * 60_000,
},
task_proposer: {
  step: 'task_proposer',
  version: 4,
  systemPromptFile: 'SYSTEM.md',
  skills: ['brainstorming'],
  tools: ['read', 'grep', 'find', 'ls', 'ai_devflow_propose_task', 'ai_devflow_ask'],
  extensions: ['task-bridge', 'ask-bridge'],
  timeoutMs: 15 * 60_000,
},
```

Update `requirement_refiner/SYSTEM.md` to require reviewing injected knowledge and inspecting relevant repository documentation, configuration, interfaces, and code before refining the requirement. Replace the existing source-read prohibition with a read-only exploration rule. Update `task_proposer/SYSTEM.md` to explicitly compare injected knowledge with current repository state. Do not modify the `ai_devflow_ask` section or extension.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
pnpm --filter @ai-devflow/agents exec vitest run src/__tests__/profiles.test.ts
pnpm --filter @ai-devflow/desktop exec vitest run electron/__tests__/ai.test.ts electron/__tests__/ipc.test.ts
```

Expected: PASS.

- [ ] **Step 6: Typecheck affected packages**

Run:

```bash
pnpm --filter @ai-devflow/knowledge typecheck
pnpm --filter @ai-devflow/agents typecheck
pnpm --filter @ai-devflow/desktop typecheck
```

Expected: PASS.

- [ ] **Step 7: Verify the integrated workspace**

Run: `pnpm verify:unit`

Expected: all package and script unit tests pass. If unrelated pre-existing failures occur, record their exact command and output separately without changing unrelated code.

- [ ] **Step 8: Review the final diff**

Run `git diff --check` and inspect only the files listed in this plan. Confirm that `ask-bridge.ts`, ask schemas, proposal schemas, and write-tool permissions are unchanged.
