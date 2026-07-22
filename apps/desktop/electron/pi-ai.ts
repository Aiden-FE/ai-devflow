// AI 对话与结构化提案服务：Pi-only，无工具 workload（设计 §9.1 / §10）。
// 所有 AI 沟通（任务对话、需求对话、任务草稿、需求草稿）都通过 ProviderRouter 路由到内置 Pi，
// 在主进程内以 JSON 模式.spawn 一个独立 Pi attempt；不依赖 ai-sdk，不读取旧 ai_provider 凭证。
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AiChatMessage, AiRequirementProposal, AiTaskProposal, ProviderKind, ProviderTestResult } from '@ai-devflow/core';
import { validateProposalDag } from '@ai-devflow/core';
import { z } from 'zod';
import type {
  PiProcessSupervisor,
  ProviderRoute,
  ProviderRouter,
  RuntimeLocator,
} from '@ai-devflow/agents';
import {
  ACTIVE_API_KEY_ENV,
  buildCompatibleModelsJson,
  isCompatibleKind,
} from '@ai-devflow/agents';
import { CHAT_SYSTEM_REQ, CHAT_SYSTEM_TASK, PROPOSE_REQUIREMENT_SYSTEM, PROPOSE_TASK_SYSTEM } from './pi-ai-prompts.js';

export type ChatWorkload = 'task_chat' | 'requirement_chat' | 'task_proposal' | 'requirement_proposal';

export interface PiTextExecutor {
  (workload: ChatWorkload, messages: AiChatMessage[], onDelta?: (text: string) => void): Promise<string>;
}

export interface PiAiService {
  chat(messages: AiChatMessage[], onDelta: (text: string) => void, opts?: { mode?: 'task' | 'requirement'; context?: string }): Promise<string>;
  propose(messages: AiChatMessage[], context?: string): Promise<AiTaskProposal[]>;
  proposeRequirement(messages: AiChatMessage[]): Promise<AiRequirementProposal>;
  testConnection(providerId: string): Promise<ProviderTestResult>;
}

export interface ProductionExecutorDeps {
  locator: RuntimeLocator;
  router: ProviderRouter;
  supervisor: PiProcessSupervisor;
  sessionsBaseDir: string;
  projectToolPath: string;
}

const CHAT_SETTINGS_JSON = JSON.stringify({
  defaultProjectTrust: 'never',
  enableInstallTelemetry: false,
  retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
  enableSkillCommands: false,
  packages: [],
  extensions: [],
  skills: [],
  prompts: [],
  themes: [],
});

const STANDARD_KEY_ENV: Partial<Record<ProviderKind, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

const LOCALE_PASSTHROUGH = ['LANG', 'LC_ALL', 'LC_CTYPE'];
const WINDOWS_PASSTHROUGH = ['SystemRoot', 'ComSpec', 'PATHEXT'];

function systemPromptFor(workload: ChatWorkload): string {
  switch (workload) {
    case 'task_chat':
      return CHAT_SYSTEM_TASK;
    case 'requirement_chat':
      return CHAT_SYSTEM_REQ;
    case 'task_proposal':
      return PROPOSE_TASK_SYSTEM;
    case 'requirement_proposal':
      return PROPOSE_REQUIREMENT_SYSTEM;
  }
}

function workloadFromMode(mode: 'task' | 'requirement' = 'task'): 'task_chat' | 'requirement_chat' {
  return mode === 'requirement' ? 'requirement_chat' : 'task_chat';
}

function formatMessages(messages: AiChatMessage[]): string {
  return messages.map((m) => `${m.role}: ${m.content}`).join('\n\n');
}

function buildChatPlan(
  entry: string,
  route: ProviderRoute,
  sessionDir: string,
  profileDir: string,
  _workload: ChatWorkload,
  messagesText: string,
  projectToolPath: string,
) {
  const name = `chat-${randomUUID()}`;
  const args: string[] = [
    entry,
    '--print',
    '--mode',
    'json',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--no-context-files',
    '--no-approve',
    '--no-tools',
    '--provider',
    route.providerName,
    '--model',
    route.model,
    '--thinking',
    route.thinking,
    '--session-dir',
    sessionDir,
    '--name',
    name,
    messagesText,
  ];

  const isolatedHome = join(sessionDir, 'home');
  const tempDir = join(sessionDir, 'tmp');
  mkdirSync(isolatedHome, { recursive: true });
  mkdirSync(tempDir, { recursive: true });

  const env: Record<string, string> = {
    ELECTRON_RUN_AS_NODE: '1',
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    PI_CODING_AGENT_DIR: profileDir,
    PI_CODING_AGENT_SESSION_DIR: sessionDir,
    PI_PACKAGE_DIR: dirname(dirname(entry)),
    PATH: projectToolPath,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    TMPDIR: tempDir,
    TEMP: tempDir,
    TMP: tempDir,
  };
  for (const key of [...LOCALE_PASSTHROUGH, ...WINDOWS_PASSTHROUGH]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }

  let modelsJson: string | undefined;
  if (isCompatibleKind(route.providerKind)) {
    env[ACTIVE_API_KEY_ENV] = route.secret;
    modelsJson = buildCompatibleModelsJson(route.providerName, route.providerKind, route.baseURL, [route.model]);
  } else {
    const keyEnv = STANDARD_KEY_ENV[route.providerKind];
    if (keyEnv) env[keyEnv] = route.secret;
  }

  return { command: process.execPath, args, env, initialMessage: messagesText, modelsJson };
}

function materializeChatProfile(sessionDir: string, systemPrompt: string): string {
  const profileDir = join(sessionDir, 'pi-config');
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, 'settings.json'), CHAT_SETTINGS_JSON);
  writeFileSync(join(profileDir, 'SYSTEM.md'), systemPrompt);
  return profileDir;
}

async function executeTextOnRoute(
  route: ProviderRoute,
  messages: AiChatMessage[],
  onDelta: ((text: string) => void) | undefined,
  deps: ProductionExecutorDeps,
  workload: ChatWorkload,
): Promise<string> {
  const { entry } = await deps.locator.verify();
  const sessionDir = join(deps.sessionsBaseDir, 'chat', randomUUID());
  mkdirSync(sessionDir, { recursive: true });
  const systemPrompt = systemPromptFor(workload);
  const profileDir = materializeChatProfile(sessionDir, systemPrompt);
  const messagesText = formatMessages(messages);
  const plan = buildChatPlan(entry, route, sessionDir, profileDir, workload, messagesText, deps.projectToolPath);
  if (plan.modelsJson) {
    writeFileSync(join(profileDir, 'models.json'), plan.modelsJson);
  }

  const spawned = deps.supervisor.spawn(plan, {
    cwd: sessionDir,
    timeoutMs: 120_000,
    secrets: [route.secret],
  });

  let full = '';
  let sawAgentEnd = false;
  try {
    for await (const line of spawned.lines) {
      if (line.stream !== 'stdout') continue;
      let event: { type?: string; delta?: string; text?: string } | undefined;
      try {
        event = JSON.parse(line.text) as { type?: string; delta?: string; text?: string };
      } catch {
        continue;
      }
      if (event?.type === 'message_update') {
        const delta = typeof event.delta === 'string' ? event.delta : typeof event.text === 'string' ? event.text : '';
        full += delta;
        onDelta?.(delta);
      } else if (event?.type === 'agent_end') {
        sawAgentEnd = true;
      }
    }
  } finally {
    await spawned.done().catch(() => ({}));
    rmSync(sessionDir, { recursive: true, force: true });
  }

  if (!sawAgentEnd && full === '') {
    throw new Error('Pi 未返回有效文本');
  }
  return full;
}

export function createProductionTextExecutor(deps: ProductionExecutorDeps): PiTextExecutor {
  return async (workload, messages, onDelta) => {
    const result = await deps.router.execute(
      workload,
      async (route) => {
        try {
          return await executeTextOnRoute(route, messages, onDelta, deps, workload);
        } catch (err) {
          // 把非 ProviderExecutionError 包装成 runtime 错误，让路由决定是否降级。
          if ((err as Error).message?.includes('应用运行组件损坏')) {
            throw Object.assign(new Error((err as Error).message), { kind: 'runtime' });
          }
          throw err;
        }
      },
    );
    return result;
  };
}

const taskSchema = z.object({
  tasks: z.array(
    z.object({
      draftId: z.string().min(1).optional(),
      title: z.string().min(1),
      description: z.string(),
      role: z.enum(['planner', 'coder', 'reviewer', 'tester']),
      dependsOn: z.array(z.string()).optional(),
    }),
  ),
});

const requirementSchema = z.object({
  title: z.string().min(1),
  description: z.string(),
  acceptance: z.string(),
  priority: z.enum(['low', 'medium', 'high']),
});

/** 从模型输出中提取首个 JSON 对象（容忍 markdown 代码块与前后说明）。 */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('未找到 JSON 对象');
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

export function createPiAiService(executeText: PiTextExecutor): PiAiService {
  async function generateStructured<T>(
    workload: ChatWorkload,
    messages: AiChatMessage[],
    schema: z.ZodType<T>,
    label: string,
  ): Promise<T> {
    let lastError = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const prompt: AiChatMessage[] =
        attempt === 0
          ? messages
          : [
              ...messages,
              {
                role: 'user',
                content: `你上一次的输出无法解析（${lastError}）。请严格仅输出符合上述格式的纯 JSON 对象，不要包含任何额外文字或代码块。`,
              },
            ];
      const text = await executeText(workload, prompt);
      let parsed: unknown;
      try {
        parsed = extractJson(text);
      } catch (e) {
        lastError = `JSON 解析失败：${(e as Error).message}`;
        continue;
      }
      const result = schema.safeParse(parsed);
      if (result.success) return result.data;
      lastError = result.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    }
    throw new Error(`AI 输出无法解析为${label}：${lastError}`);
  }

  return {
    chat(messages, onDelta, opts) {
      const workload = workloadFromMode(opts?.mode);
      const promptMessages: AiChatMessage[] =
        opts?.context && messages.length > 0
          ? [{ role: 'user', content: `【上下文】\n${opts.context}\n\n${messages[messages.length - 1]!.content}` }]
          : messages;
      return executeText(workload, promptMessages, onDelta);
    },

    async propose(messages, context) {
      const prompt = context ? [{ role: 'user', content: `【上下文】\n${context}` } as AiChatMessage, ...messages] : messages;
      const data = await generateStructured('task_proposal', prompt, taskSchema, '任务列表');
      const tasks: AiTaskProposal[] = data.tasks.map((t, i) => ({
        draftId: (t.draftId ?? '').trim() || `t${i + 1}`,
        title: t.title,
        description: t.description,
        role: t.role,
        dependsOn: t.dependsOn ?? [],
      }));
      if (tasks.length === 0) return [];
      const v = validateProposalDag(tasks);
      if (!v.ok) throw new Error(`AI 任务依赖不合法：${v.reasons.join('；')}`);
      return tasks;
    },

    proposeRequirement(messages) {
      return generateStructured('requirement_proposal', messages, requirementSchema, '需求');
    },

    testConnection(providerId) {
      return testConnectionWithRouter(executeText, providerId);
    },
  };
}

async function testConnectionWithRouter(
  executeText: PiTextExecutor,
  providerId: string,
): Promise<ProviderTestResult> {
  try {
    // 用一次极短对话探测路线；成功即认为可用。
    await executeText('task_chat', [{ role: 'user', content: 'ping' }]);
    return { ok: true, providerId, status: 200 };
  } catch (err) {
    const message = (err as Error).message || String(err);
    return { ok: false, providerId, status: 0, error: message };
  }
}
