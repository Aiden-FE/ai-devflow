import { describe, expect, it } from 'vitest';
import type { TaskRole } from '@ai-devflow/core';
import type { ProviderRoute } from '../provider-router.js';
import { buildPiRunPlan, type PiRunPlanInput } from '../run-plan.js';
import { ROLE_PROFILES, roleToolsArg } from '../profiles.js';

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function makeRunPlanFixture(ids: { role: TaskRole; executionId: string; attemptId: string }): PiRunPlanInput {
  const route: ProviderRoute = {
    providerId: 'p1', providerKind: 'openai', providerName: 'openai', routeId: `p1:${ids.role}:primary`,
    model: 'gpt-5.6-sol', thinking: 'high', secret: 'route-secret',
  };
  return {
    runtimeEntry: '/app/resources/pi-runtime/cli.js',
    profileDir: `/userData/pi-runtime/profiles/digest/${ids.role}`,
    sessionDir: `/userData/pi-runtime/sessions/${ids.executionId}/${ids.attemptId}`,
    isolatedHome: `/userData/pi-runtime/sessions/${ids.executionId}/${ids.attemptId}/home`,
    tempDir: `/userData/pi-runtime/sessions/${ids.executionId}/${ids.attemptId}/tmp`,
    executionId: ids.executionId,
    attemptId: ids.attemptId,
    role: ids.role,
    initialMessage: 'fixture prompt',
    route,
    projectToolPath: '/usr/local/bin:/usr/bin:/bin',
  };
}

describe('buildPiRunPlan', () => {
  it('builds coder args from an explicit profile and clean environment', () => {
    const plan = buildPiRunPlan(makeRunPlanFixture({ role: 'coder', executionId: 'e1', attemptId: 'a1' }));
    expect(plan.command).toBe(process.execPath);
    expect(plan.args).toContain('--mode');
    expect(plan.args).toContain('json');
    expect(plan.args).toContain('--no-extensions');
    expect(plan.args).toContain('--no-skills');
    expect(plan.args).toContain('--no-prompt-templates');
    expect(plan.args).toContain('--no-themes');
    expect(plan.args).toContain('--no-context-files');
    expect(plan.args).toContain('--no-approve');
    expect(valueAfter(plan.args, '--tools')).toBe('read,bash,edit,write,grep,find,ls,ai_devflow_interaction,ai_devflow_report_result');
    expect(valueAfter(plan.args, '--provider')).toBe('openai');
    expect(valueAfter(plan.args, '--model')).toBe('gpt-5.6-sol');
    expect(valueAfter(plan.args, '--thinking')).toBe('high');
    expect(plan.env.PI_CODING_AGENT_DIR).toMatch(/coder/);
    expect(plan.env.PI_CODING_AGENT_SESSION_DIR).toMatch(/e1.*a1/);
    expect(plan.env.OPENAI_API_KEY).toBe('route-secret');
    expect(plan.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(plan.env.DEV_API_KEY).toBeUndefined();
    expect(plan.env.NODE_OPTIONS).toBeUndefined();
    expect(plan.env.NODE_PATH).toBeUndefined();
    expect(plan.env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(plan.env.PI_OFFLINE).toBe('1');
    expect(plan.env.PI_SKIP_VERSION_CHECK).toBe('1');
    expect(plan.env.PI_TELEMETRY).toBe('0');
  });

  it('gives concurrent attempts different session directories', () => {
    const one = buildPiRunPlan(makeRunPlanFixture({ role: 'tester', executionId: 'e1', attemptId: 'a1' }));
    const two = buildPiRunPlan(makeRunPlanFixture({ role: 'tester', executionId: 'e1', attemptId: 'a2' }));
    expect(one.env.PI_CODING_AGENT_SESSION_DIR).not.toBe(two.env.PI_CODING_AGENT_SESSION_DIR);
  });

  it('writes a compatible snapshot that references an environment variable only', () => {
    const fixture = makeRunPlanFixture({ role: 'coder', executionId: 'e1', attemptId: 'a1' });
    fixture.route = {
      ...fixture.route,
      providerKind: 'openai_compatible', providerName: 'ai-devflow-0123456789ab',
      baseURL: 'https://gateway.example/v1',
    };
    const plan = buildPiRunPlan(fixture);
    expect(plan.env.AI_DEVFLOW_ACTIVE_API_KEY).toBe('route-secret');
    expect(plan.modelsJson).toContain('AI_DEVFLOW_ACTIVE_API_KEY');
    expect(plan.modelsJson).toContain('openai-completions');
    expect(plan.modelsJson).not.toContain('route-secret');
    expect(valueAfter(plan.args, '--provider')).toBe('ai-devflow-0123456789ab');
  });

  it('anthropic_compatible uses the anthropic-messages api', () => {
    const fixture = makeRunPlanFixture({ role: 'planner', executionId: 'e1', attemptId: 'a1' });
    fixture.route = {
      ...fixture.route, providerKind: 'anthropic_compatible', providerName: 'ai-devflow-abcdef012345',
      baseURL: 'https://gw.example', model: 'claude-sonnet-5',
    };
    const plan = buildPiRunPlan(fixture);
    expect(plan.modelsJson).toContain('anthropic-messages');
    expect(plan.env.AI_DEVFLOW_ACTIVE_API_KEY).toBe('route-secret');
  });

  it('reviewer excludes edit/write tools and never sets a write-capable extra tool', () => {
    const plan = buildPiRunPlan(makeRunPlanFixture({ role: 'reviewer', executionId: 'e1', attemptId: 'a1' }));
    expect(valueAfter(plan.args, '--exclude-tools')).toBe('edit,write');
    expect(valueAfter(plan.args, '--tools')).toBe('read,bash,grep,find,ls,ai_devflow_interaction,ai_devflow_report_result');
  });

  it('omits --exclude-tools when a role has no exclusions', () => {
    const plan = buildPiRunPlan(makeRunPlanFixture({ role: 'coder', executionId: 'e1', attemptId: 'a1' }));
    expect(plan.args).not.toContain('--exclude-tools');
  });
});

describe('role tool table', () => {
  it('appends the two internal tools to every role', () => {
    for (const role of ['planner', 'coder', 'reviewer', 'tester'] as TaskRole[]) {
      const tools = roleToolsArg(role).split(',');
      expect(tools).toContain('ai_devflow_interaction');
      expect(tools).toContain('ai_devflow_report_result');
      // internal tools are last and unique
      expect(new Set(tools).size).toBe(tools.length);
    }
  });

  it('matches the design role capability table', () => {
    expect(ROLE_PROFILES.planner.tools).toEqual(['read', 'grep', 'find', 'ls', 'write', 'edit']);
    expect(ROLE_PROFILES.coder.tools).toEqual(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']);
    expect(ROLE_PROFILES.reviewer.tools).toEqual(['read', 'bash', 'grep', 'find', 'ls']);
    expect(ROLE_PROFILES.tester.tools).toEqual(['read', 'bash', 'grep', 'find', 'ls', 'write', 'edit']);
  });
});
