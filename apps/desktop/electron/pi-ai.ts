// AI 对话与结构化提案服务：Pi-only，无工具 workload（设计 §9.1 / §10）。
// 所有 AI 沟通（任务对话、需求对话、任务草稿、需求草稿）都通过 ProviderRouter 路由到内置 Pi，
// 在主进程内以 JSON 模式.spawn 一个独立 Pi attempt；不依赖 ai-sdk，不读取旧 ai_provider 凭证。
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AiChatMessage, AiRequirementProposal, AiTaskProposal, ProviderConfig, ProviderKind, ProviderTestResult } from '@ai-devflow/core';
import { redactText, validateProposalDag } from '@ai-devflow/core';
import { z } from 'zod';
import type {
  PiProcessSupervisor,
  ProviderRoute,
  ProviderRouter,
  RuntimeLocator,
} from '@ai-devflow/agents';
import {
  ACTIVE_API_KEY_ENV,
  ProviderExecutionError,
  buildCompatibleModelsJson,
  classifyProviderFailure,
  isCompatibleKind,
} from '@ai-devflow/agents';
import { CHAT_SYSTEM_REQ, CHAT_SYSTEM_TASK, PROPOSE_REQUIREMENT_SYSTEM, PROPOSE_TASK_SYSTEM } from './pi-ai-prompts.js';
import { fetchCompatibleModels } from './provider-models.js';

export type ChatWorkload = 'task_chat' | 'requirement_chat' | 'task_proposal' | 'requirement_proposal';

export interface PiTextExecutor {
  (
    workload: ChatWorkload,
    messages: AiChatMessage[],
    onDelta?: (text: string) => void,
    options?: { onlyProviderId?: string },
  ): Promise<string>;
}

export interface PiAiService {
  chat(messages: AiChatMessage[], onDelta: (text: string) => void, opts?: { mode?: 'task' | 'requirement'; context?: string }): Promise<string>;
  propose(messages: AiChatMessage[], context?: string): Promise<AiTaskProposal[]>;
  proposeRequirement(messages: AiChatMessage[]): Promise<AiRequirementProposal>;
  testConnection(providerId: string): Promise<ProviderTestResult>;
  /**
   * 列出兼容网关可用模型；标准提供商返回空数组（不发起网络请求）。
   * `provider` / `secret` 由调用方（IPC 层）从 ProviderStore 解析；密钥不进入 Renderer。
   */
  listModels(provider: ProviderConfig, secret: string): Promise<{ id: string }[]>;
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

/**
 * 从 Pi 的 errorMessage（如 "401: {...}" 或 "404 status code (no body)"）解析 HTTP 状态码。
 * Pi 对提供商 HTTP 错误不发射 error/provider_error 事件，而是把状态前缀写入 message 事件的 errorMessage。
 */
function parseHttpStatus(errorMessage: string): number {
  const m = /^(\d{3})\b/.exec(errorMessage);
  return m ? Number(m[1]) : 0;
}

/** Pi 助手消息（terminal 事件 message_end/turn_end/agent_end 携带）。 */
interface AssistantMessage {
  role?: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
}

/**
 * 从 Pi 助手消息提取纯文本。Pi 的 message.content 是内容块数组（如 [{type:"text",text:"..."}]），
 * 也可能含 thinking/tool_use 等非文本块；此处仅拼接 text 块。
 */
function extractAssistantText(message: AssistantMessage | undefined): string {
  if (!message || message.role !== 'assistant') return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (b): b is { type: 'text'; text: string } =>
        !!b &&
        typeof b === 'object' &&
        (b as { type?: unknown }).type === 'text' &&
        typeof (b as { text?: unknown }).text === 'string',
    )
    .map((b) => b.text)
    .join('');
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
    modelsJson = buildCompatibleModelsJson(route.providerName, route.providerKind, route.baseURL, route.models);
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

export async function executeTextOnRoute(
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
  let malformedStdout = false;
  let streamError: unknown;
  let providerError: { status: number; message: string } | undefined;
  const deltas: string[] = [];
  // Pi 在配置/模型/网络类失败时（如模型不在网关列表、Base URL 错误、DNS/TLS 失败、未知 provider 名）
  // 通常把人类可读诊断写到 stderr 并以 exit 0 结束——既不产 message_update 文本，也不发 agent_end，
  // 更不会在 message 事件上带 stopReason:"error"。若不捕获 stderr，会落到「终止协议无效」分支而丢失根因。
  // supervisor 已对 stderr 脱敏（makeLineRedactor），这里仅保留尾部用于失败时还原原因。
  const stderrLines: string[] = [];
  const unknownEventTypes: string[] = [];
  let exitInfo: { exitCode: number | null; signal: NodeJS.Signals | null } | undefined;
  let doneError: unknown;
  try {
    try {
      for await (const line of spawned.lines) {
        if (line.stream === 'stderr') {
          if (stderrLines.length >= 64) stderrLines.shift();
          stderrLines.push(line.text);
          continue;
        }
        let event: {
          type?: string;
          status?: number;
          message?: string | AssistantMessage;
          assistantMessageEvent?: { type?: string; delta?: string; content?: string };
        };
        try {
          event = JSON.parse(line.text) as typeof event;
        } catch {
          malformedStdout = true;
          continue;
        }
        if (event.type === 'message_update') {
          // Pi 的文本增量在 assistantMessageEvent.delta（text_delta 事件）；顶层无 delta/text 字段。
          // 早期实现误读 event.delta，导致任何能正常返回的提供商都被判为「未收到任何文本输出」。
          const ame = event.assistantMessageEvent;
          const delta = typeof ame?.delta === 'string' ? ame.delta : '';
          if (delta) {
            full += delta;
            deltas.push(delta);
          }
        } else if (event.type === 'agent_end') {
          sawAgentEnd = true;
        } else if (event.type === 'error' || event.type === 'provider_error') {
          providerError = {
            status: typeof event.status === 'number' ? event.status : 0,
            message: typeof event.message === 'string' ? event.message : '',
          };
        } else if (event.type === 'message_start' || event.type === 'message_end' || event.type === 'turn_end') {
          // Pi 对提供商 HTTP 错误（401/404/5xx 等）不发射 error/provider_error 事件，而是把
          // stopReason:"error" + errorMessage 放在 message 事件上。捕获之以还原根因，否则会被
          // 误判为「终止协议无效」而丢失真实原因（如密钥无效、模型不存在、Base URL 错误）。
          const msg = typeof event.message === 'object' ? event.message : undefined;
          if (msg && msg.stopReason === 'error' && typeof msg.errorMessage === 'string' && msg.errorMessage) {
            providerError ??= { status: parseHttpStatus(msg.errorMessage), message: msg.errorMessage };
          }
          // 权威最终文本：terminal 事件携带完整的助手消息 content，即使流式增量因字段差异遗漏，
          // 也能还原完整回复，避免把正常返回误判为空输出。
          const text = extractAssistantText(msg);
          if (text) full = text;
        } else {
          // 记录未处理的事件类型，供 protocol 失败时还原根因（Pi 可能以新事件形态报告错误）。
          const eventType = typeof event.type === 'string' && event.type ? event.type : '<unknown>';
          if (unknownEventTypes.length < 32) unknownEventTypes.push(eventType);
        }
      }
    } catch (error) {
      streamError = error;
    }
    try {
      exitInfo = await spawned.done();
    } catch (error) {
      doneError = error;
    }
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }

  if (providerError) {
    throw new ProviderExecutionError(
      `AI 服务请求失败：${providerError.message}`,
      classifyProviderFailure({ status: providerError.status, message: providerError.message }),
      providerError.status,
    );
  }
  if (doneError || !exitInfo || exitInfo.exitCode !== 0) {
    const exitCode = exitInfo?.exitCode ?? 0;
    const reason = doneError
      ? `进程异常：${(doneError as Error).message ?? String(doneError)}`
      : `exit=${exitCode}`;
    throw new ProviderExecutionError(
      'Pi 运行进程异常退出',
      'runtime',
      exitCode,
      undefined,
      buildPiFailureDetail([reason], stderrLines, unknownEventTypes),
    );
  }
  if (streamError || malformedStdout || !sawAgentEnd || full.length === 0) {
    const reasons: string[] = [];
    if (streamError) reasons.push(`流错误：${(streamError as Error).message ?? String(streamError)}`);
    if (malformedStdout) reasons.push('stdout 含非法 JSON');
    if (!sawAgentEnd) reasons.push('缺少 agent_end 终态事件');
    if (full.length === 0) reasons.push('未收到任何文本输出');
    throw new ProviderExecutionError(
      'Pi 返回的终止协议无效',
      'protocol',
      0,
      undefined,
      buildPiFailureDetail(reasons, stderrLines, unknownEventTypes),
    );
  }
  for (const delta of deltas) onDelta?.(delta);
  return full;
}

/**
 * 组装 Pi 执行失败时的根因详情：原因 + 未处理事件 + stderr 尾部。
 * 各部分均已由 PiProcessSupervisor 脱敏；此处仅做长度裁剪，testConnectionWithRouter 会再过一次 redactText。
 */
function buildPiFailureDetail(
  reasons: string[],
  stderrLines: string[],
  unknownEventTypes: string[],
): string {
  const parts: string[] = [];
  if (reasons.length) parts.push(reasons.join('；'));
  if (unknownEventTypes.length) parts.push(`收到未处理事件：${unknownEventTypes.join(', ')}`);
  const stderrTail = stderrLines.join('\n').trimEnd();
  if (stderrTail) {
    const trimmed = stderrTail.length > 4000 ? `…${stderrTail.slice(-4000)}` : stderrTail;
    parts.push(`Pi stderr：\n${trimmed}`);
  }
  return parts.join('\n');
}

export function createProductionTextExecutor(deps: ProductionExecutorDeps): PiTextExecutor {
  return async (workload, messages, onDelta, options) => {
    const result = await deps.router.execute(
      workload,
      async (route) => {
        try {
          return await executeTextOnRoute(route, messages, onDelta, deps, workload);
        } catch (err) {
          // 把非 ProviderExecutionError 包装成 runtime 错误，让路由决定是否降级。
          if ((err as Error).message?.includes('应用运行组件损坏')) {
            throw new ProviderExecutionError('应用运行组件损坏', 'runtime');
          }
          throw err;
        }
      },
      options,
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

    async listModels(provider, secret) {
      const ids = await fetchCompatibleModels(provider, secret);
      return ids.map((id) => ({ id }));
    },
  };
}

async function testConnectionWithRouter(
  executeText: PiTextExecutor,
  providerId: string,
): Promise<ProviderTestResult> {
  try {
    // 用一次极短对话探测路线；成功即认为可用。
    await executeText('task_chat', [{ role: 'user', content: 'ping' }], undefined, { onlyProviderId: providerId });
    return { ok: true, providerId, status: 200 };
  } catch (err) {
    // §8.2：保存、测试、运行和错误记录都使用统一脱敏函数；错误消息可能含 URL/状态/密钥形态片段。
    // 路由器在所有路线失败后抛出泛化「所有已配置 AI 服务暂时不可用」，其 detail 携带最近一次底层错误
    // （如「AI 服务请求失败：401: ...」）。优先用 detail 还原根因，避免测试结果只显示无信息的泛化文案。
    const detail = err instanceof ProviderExecutionError ? err.detail : undefined;
    const message = redactText(detail || (err as Error).message || String(err));
    return { ok: false, providerId, status: 0, error: message };
  }
}
