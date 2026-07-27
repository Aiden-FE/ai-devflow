import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPiAiService,
  createProductionTextExecutor,
  materializeChatProfile,
  materializeStepAgentProfile,
  buildChatPlan,
  REQUIREMENT_PROPOSAL_TOOL,
  TASK_PROPOSAL_TOOL,
} from '../pi-ai.js';
import { STEP_AGENTS, stepAgentForWorkload } from '@ai-devflow/agents';
import type {
  ChatWorkload,
  PiTextExecutor,
  ProductionExecutorDeps,
} from '../pi-ai.js';

const here = dirname(fileURLToPath(import.meta.url));
const ASSETS_ROOT = join(here, '..', '..', '..', '..', 'packages', 'agents', 'assets', 'profiles');
import type { ProviderRoute } from '@ai-devflow/agents';

function makeFakeExecutor(scenario: {
  texts?: string[];
  error?: Error;
  toolResults?: Array<{ tool: string; payload: unknown }>;
}): PiTextExecutor {
  const outputs = [...(scenario.texts ?? [])];
  const toolResultsQueue = [...(scenario.toolResults ?? [])];
  return async (_workload, _messages, onDelta, _options, onToolResult) => {
    if (scenario.error) throw scenario.error;
    const text = outputs.shift() ?? '';
    onDelta?.(text);
    // 步骤 Agent 的工具调用经 onToolResult 回传；propose 依赖此拿到结构化草稿。
    for (const r of toolResultsQueue) onToolResult?.(r.tool, r.payload);
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

  it('uses task_proposal workload for task_proposal mode', async () => {
    const workloads: ChatWorkload[] = [];
    const service = createPiAiService(async (workload, _messages, onDelta) => {
      workloads.push(workload);
      onDelta?.('ok');
      return 'ok';
    });
    await service.chat([{ role: 'user', content: 'hi' }], () => {}, { mode: 'task_proposal' });
    expect(workloads).toEqual(['task_proposal']);
  });

  it('passes projectPath as cwd to the executor for task_proposal mode (so AI can explore the repo)', async () => {
    const options: Array<{ cwd?: string; onlyProviderId?: string } | undefined> = [];
    const service = createPiAiService(async (_workload, _messages, _onDelta, opts) => {
      options.push(opts);
      return 'ok';
    });
    await service.chat([{ role: 'user', content: 'hi' }], () => {}, { mode: 'task_proposal', projectPath: '/repo/path' });
    expect(options).toEqual([{ cwd: '/repo/path' }]);
  });

  it('surfaces ai_devflow_propose_task tool result via onToolResult for task_proposal mode', async () => {
    const service = createPiAiService(
      makeFakeExecutor({
        texts: ['草稿已生成'],
        toolResults: [
          {
            tool: 'ai_devflow_propose_task',
            payload: {
              tasks: [
                { draftId: 't1', title: '实现登录', description: '实施计划：改 auth.ts…', role: 'coder', dependsOn: [] },
              ],
            },
          },
        ],
      }),
    );
    let captured: { name?: string; payload?: unknown } = {};
    await service.chat([{ role: 'user', content: '做一个登录' }], () => {}, {
      mode: 'task_proposal',
      onToolResult: (name, payload) => { captured = { name, payload }; },
    });
    expect(captured.name).toBe(TASK_PROPOSAL_TOOL);
    expect(captured.payload).toEqual({
      tasks: [
        { draftId: 't1', title: '实现登录', description: '实施计划：改 auth.ts…', role: 'coder', dependsOn: [] },
      ],
    });
  });

  it('parses a structured requirement proposal', async () => {
    const service = createPiAiService(
      makeFakeExecutor({ texts: ['{"title":"T","description":"D","acceptance":"A","priority":"high"}'] }),
    );
    const req = await service.proposeRequirement([{ role: 'user', content: 'x' }]);
    expect(req).toEqual({ title: 'T', description: 'D', acceptance: 'A', priority: 'high' });
  });

  it('reports test connection failure when executor throws', async () => {
    const service = createPiAiService(makeFakeExecutor({ error: new Error('offline') }));
    const r = await service.testConnection('p1');
    expect(r.ok).toBe(false);
    expect(r.providerId).toBe('p1');
    expect(r.error).toMatch(/offline/);
  });

  it('redacts secret-shaped error messages in test connection failures (§8.2)', async () => {
    const secret = 'sk-ant-api03-1234567890abcdefgh';
    const service = createPiAiService(makeFakeExecutor({ error: new Error(`auth failed for key ${secret}`) }));
    const r = await service.testConnection('p1');
    expect(r.ok).toBe(false);
    expect(r.error).not.toContain(secret);
    expect(r.error).toContain('sk-***');
  });

  it('reports test connection success when executor returns', async () => {
    const service = createPiAiService(makeFakeExecutor({ texts: ['pong'] }));
    const r = await service.testConnection('p1');
    expect(r.ok).toBe(true);
    expect(r.providerId).toBe('p1');
  });

  it('restricts connection testing to the selected provider', async () => {
    const options: Array<{ onlyProviderId?: string } | undefined> = [];
    const service = createPiAiService(async (_workload, _messages, _onDelta, routeOptions) => {
      options.push(routeOptions);
      return 'pong';
    });
    await expect(service.testConnection('selected-provider')).resolves.toMatchObject({ ok: true });
    expect(options).toEqual([{ onlyProviderId: 'selected-provider' }]);
  });
});

const ROUTE: ProviderRoute = {
  providerId: 'p1',
  providerRevision: 3,
  providerKind: 'openai',
  providerName: 'openai',
  routeId: 'p1:task_chat',
  model: 'gpt-5.6-luna',
  models: ['gpt-5.6-luna'],
  thinking: 'medium',
  secret: 'route-secret',
};

function productionHarness(input: {
  stdout: string[];
  exitCode: number | null;
}) {
  const routerOptions: Array<{ onlyProviderId?: string } | undefined> = [];
  const router = {
    async execute<T>(
      _workload: string,
      operation: (route: ProviderRoute, ordinal: number) => Promise<T>,
      options?: { onlyProviderId?: string },
    ): Promise<T> {
      routerOptions.push(options);
      return operation(ROUTE, 1);
    },
  };
  const supervisor = {
    spawn() {
      return {
        lines: (async function* () {
          for (const text of input.stdout) yield { stream: 'stdout' as const, text };
        })(),
        cancel: async () => undefined,
        done: async () => ({ exitCode: input.exitCode, signal: null }),
        send: () => false,
        onMessage: () => {},
      };
    },
  };
  const deps = {
    locator: { verify: async () => ({ version: '0.80.10', entry: '/verified/pi.js' }) },
    router,
    supervisor,
    sessionsBaseDir: mkdtempSync(join(tmpdir(), 'pi-ai-production-')),
    projectToolPath: '/usr/bin:/bin',
    assetsRoot: ASSETS_ROOT,
  } as unknown as ProductionExecutorDeps;
  return { executor: createProductionTextExecutor(deps), routerOptions };
}

describe('production Pi text executor', () => {
  it('commits buffered deltas only after exit 0 and agent_end', async () => {
    const harness = productionHarness({
      stdout: [
        JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hello' } }),
        JSON.stringify({ type: 'agent_end', messages: [] }),
      ],
      exitCode: 0,
    });
    const deltas: string[] = [];
    await expect(harness.executor('task_chat', [{ role: 'user', content: 'hi' }], (d) => deltas.push(d)))
      .resolves.toBe('hello');
    expect(deltas).toEqual(['hello']);
  });

  it('surfaces ai_devflow_propose_requirement tool result via onToolResult for requirement_chat', async () => {
    const harness = productionHarness({
      stdout: [
        JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '草稿已生成' } }),
        JSON.stringify({
          type: 'tool_execution_end',
          toolName: REQUIREMENT_PROPOSAL_TOOL,
          result: { details: { aiDevflowRequirementProposal: { title: 'T', description: 'D', acceptance: 'A', priority: 'high' } } },
        }),
        JSON.stringify({ type: 'agent_end', messages: [] }),
      ],
      exitCode: 0,
    });
    let captured: { name?: string; payload?: unknown } = {};
    await harness.executor(
      'requirement_chat',
      [{ role: 'user', content: '做一个登录页' }],
      undefined,
      undefined,
      (name, payload) => { captured = { name, payload }; },
    );
    expect(captured.name).toBe(REQUIREMENT_PROPOSAL_TOOL);
    expect(captured.payload).toEqual({ title: 'T', description: 'D', acceptance: 'A', priority: 'high' });
  });

  it('classifies nonzero exit as runtime and discards partial deltas', async () => {
    const harness = productionHarness({
      stdout: [JSON.stringify({ type: 'message_update', delta: 'partial' })],
      exitCode: 7,
    });
    const deltas: string[] = [];
    await expect(harness.executor('task_chat', [{ role: 'user', content: 'hi' }], (d) => deltas.push(d)))
      .rejects.toMatchObject({ kind: 'runtime' });
    expect(deltas).toEqual([]);
  });

  it.each([
    {
      label: 'malformed stdout',
      stdout: ['not-json', JSON.stringify({ type: 'message_update', delta: 'partial' }), JSON.stringify({ type: 'agent_end' })],
    },
    {
      label: 'missing agent_end',
      stdout: [JSON.stringify({ type: 'message_update', delta: 'partial' })],
    },
  ])('classifies $label as protocol and discards partial deltas', async ({ stdout }) => {
    const harness = productionHarness({ stdout, exitCode: 0 });
    const deltas: string[] = [];
    await expect(harness.executor('task_chat', [{ role: 'user', content: 'hi' }], (d) => deltas.push(d)))
      .rejects.toMatchObject({ kind: 'protocol' });
    expect(deltas).toEqual([]);
  });

  it('classifies provider terminal errors for router failover', async () => {
    const harness = productionHarness({
      stdout: [JSON.stringify({ type: 'provider_error', status: 401, message: 'unauthorized' })],
      exitCode: 1,
    });
    await expect(harness.executor('task_chat', [{ role: 'user', content: 'hi' }]))
      .rejects.toMatchObject({ kind: 'authentication', status: 401 });
  });

  it('passes onlyProviderId through to ProviderRouter', async () => {
    const harness = productionHarness({
      stdout: [JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'pong' } }), JSON.stringify({ type: 'agent_end' })],
      exitCode: 0,
    });
    await harness.executor(
      'task_chat',
      [{ role: 'user', content: 'ping' }],
      undefined,
      { onlyProviderId: 'p1' },
    );
    expect(harness.routerOptions).toEqual([{ onlyProviderId: 'p1' }]);
  });
});

describe('requirement brainstorming skill loading', () => {
  it('stepAgentForWorkload returns requirement_refiner only for requirement_chat', () => {
    expect(stepAgentForWorkload('requirement_chat')?.step).toBe('requirement_refiner');
    expect(stepAgentForWorkload('task_proposal')?.step).toBe('task_proposer');
    expect(stepAgentForWorkload('task_chat')).toBeUndefined();
    expect(stepAgentForWorkload('requirement_proposal')).toBeUndefined();
  });

  it('materializeStepAgentProfile copies SYSTEM.md, brainstorming skill, and requirement-bridge extension', () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'pi-ai-skill-'));
    const step = STEP_AGENTS['requirement_refiner'];
    const profileDir = materializeStepAgentProfile(sessionDir, step, ASSETS_ROOT);
    expect(existsSync(join(profileDir, 'SYSTEM.md'))).toBe(true);
    expect(existsSync(join(profileDir, 'skills', 'brainstorming', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(profileDir, 'extensions', 'requirement-bridge.ts'))).toBe(true);
    expect(existsSync(join(profileDir, 'extensions', 'ask-bridge.ts'))).toBe(true);
    expect(existsSync(join(profileDir, 'extensions', 'ux-bridge.ts'))).toBe(true);
    // 非步骤 profile 不含技能/扩展
    const chatDir = materializeChatProfile(mkdtempSync(join(tmpdir(), 'pi-ai-skill-')), 'sys');
    expect(existsSync(join(chatDir, 'skills', 'brainstorming', 'SKILL.md'))).toBe(false);
  });

  it('buildChatPlan adds --tools/--extension/--skill for requirement_chat and --no-tools for task_chat', () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'pi-ai-plan-'));
    const step = STEP_AGENTS['requirement_refiner'];
    const assetsRoot = ASSETS_ROOT;
    const reqProfileDir = materializeStepAgentProfile(sessionDir, step, assetsRoot);
    const reqPlan = buildChatPlan('/pi.js', ROUTE, sessionDir, reqProfileDir, 'requirement_chat', 'hi', '/usr/bin', step);
    expect(reqPlan.args).toContain('--tools');
    expect(reqPlan.args[reqPlan.args.indexOf('--tools') + 1]).toBe(`${REQUIREMENT_PROPOSAL_TOOL},ai_devflow_ask,ai_devflow_consult_ux`);
    expect(reqPlan.args).toContain('--extension');
    expect(reqPlan.args[reqPlan.args.indexOf('--extension') + 1]).toMatch(/requirement-bridge\.ts$/);
    expect(reqPlan.args).toContain('--skill');
    expect(reqPlan.args[reqPlan.args.indexOf('--skill') + 1]).toMatch(/brainstorming[\\/]SKILL\.md$/);
    expect(reqPlan.args).not.toContain('--no-tools');

    const taskProfileDir = materializeChatProfile(mkdtempSync(join(tmpdir(), 'pi-ai-plan-')), 'sys');
    const taskPlan = buildChatPlan('/pi.js', ROUTE, sessionDir, taskProfileDir, 'task_chat', 'hi', '/usr/bin');
    expect(taskPlan.args).toContain('--no-tools');
    expect(taskPlan.args).not.toContain('--skill');
    expect(taskPlan.args).not.toContain('--extension');
  });

  it('buildChatPlan adds read-only exploration tools + brainstorming skill + task-bridge for task_proposal', () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'pi-ai-plan-'));
    const step = STEP_AGENTS['task_proposer'];
    const profileDir = materializeStepAgentProfile(sessionDir, step, ASSETS_ROOT);
    const plan = buildChatPlan('/pi.js', ROUTE, sessionDir, profileDir, 'task_proposal', 'hi', '/usr/bin', step);
    // 研发视角：read/grep/find/ls 探索仓库 + ai_devflow_propose_task 产出草稿 + ai_devflow_ask 问答工具。
    expect(plan.args).toContain('--tools');
    expect(plan.args[plan.args.indexOf('--tools') + 1]).toBe('read,grep,find,ls,ai_devflow_propose_task,ai_devflow_ask');
    expect(plan.args).toContain('--extension');
    expect(plan.args[plan.args.indexOf('--extension') + 1]).toMatch(/task-bridge\.ts$/);
    // brainstorming 技能：一次一问澄清研发问题。
    expect(plan.args).toContain('--skill');
    expect(plan.args[plan.args.indexOf('--skill') + 1]).toMatch(/brainstorming[\\/]SKILL\.md$/);
    expect(plan.args).not.toContain('--no-tools');
  });
});
