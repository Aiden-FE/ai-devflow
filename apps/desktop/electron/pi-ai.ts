// AI 对话与结构化提案服务：Pi-only。requirement_chat / task_proposal 走步骤 Agent（有工具/技能/扩展），
// task_chat / requirement_proposal 走无工具对话路径。所有 AI 沟通都通过 ProviderRouter 路由到内置 Pi，
// 在主进程内以 JSON 模式.spawn 一个独立 Pi attempt；不依赖 ai-sdk，不读取旧 ai_provider 凭证。
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AiChatMessage, AiRequirementProposal, AgentKey, ProviderConfig, ProviderKind, ProviderTestResult } from '@ai-devflow/core';
import { redactText } from '@ai-devflow/core';
import { z } from 'zod';
import { runUxConsultation } from './ux-consult.js';
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
  stepAgentForWorkload,
} from '@ai-devflow/agents';
import { CHAT_SYSTEM_REQ, CHAT_SYSTEM_TASK, PROPOSE_REQUIREMENT_SYSTEM } from './pi-ai-prompts.js';
import { fetchCompatibleModels } from './provider-models.js';

/**
 * 对话路径产出工具：仅 requirement_chat 由 AI 调用 ai_devflow_propose_requirement 生成需求草稿。
 * 调用结果经 tool_execution_end 事件回传，由 executeTextOnRoute 解析后经 onToolResult 上报。
 */
export const REQUIREMENT_PROPOSAL_TOOL = 'ai_devflow_propose_requirement';

/**
 * 任务草稿生成步骤 Agent 调用的工具：task_proposer 在需求澄清、代码探索、方案确定后调用产出任务草稿
 * （含依赖 DAG，每个 description 为切实可行的实施计划）。经 tool_execution_end 事件回传，由
 * executeTextOnRoute 捕获后经 onToolResult 上报给 UI 填草稿区。
 */
export const TASK_PROPOSAL_TOOL = 'ai_devflow_propose_task';

export type ChatWorkload = 'task_chat' | 'requirement_chat' | 'task_proposal' | 'requirement_proposal';

/** 对话 workload -> 专家 AgentKey（供 ProviderRouter 路由）。 */
export function chatWorkloadToExpert(workload: ChatWorkload): AgentKey {
  switch (workload) {
    case 'requirement_chat':
    case 'requirement_proposal':
      return 'product';
    case 'task_proposal':
      return 'dev_lead';
    case 'task_chat':
      return 'chat';
  }
}

export interface PiTextExecutor {
  (
    workload: ChatWorkload,
    messages: AiChatMessage[],
    onDelta?: (text: string) => void,
    options?: { onlyProviderId?: string; cwd?: string },
    onToolResult?: (toolName: string, payload: unknown) => void,
    onAsk?: (toolUseId: string, tabs: unknown, send: (msg: unknown) => boolean) => void,
    onConsultUx?: (requirementContext: string) => Promise<string>,
    systemPromptOverride?: string,
  ): Promise<string>;
}

export interface PiAiService {
  chat(messages: AiChatMessage[], onDelta: (text: string) => void, opts?: { mode?: 'task' | 'requirement' | 'task_proposal'; context?: string; projectPath?: string; onToolResult?: (toolName: string, payload: unknown) => void; onAsk?: (toolUseId: string, tabs: unknown, send: (msg: unknown) => boolean) => void; onConsultUx?: (requirementContext: string) => Promise<string> }): Promise<string>;
  proposeRequirement(messages: AiChatMessage[]): Promise<AiRequirementProposal>;
  testConnection(providerId: string): Promise<ProviderTestResult>;
  /**
   * UX 子咨询：产品专家经 ai_devflow_consult_ux 调用时，启动一次 UX专家 run 返回结构化建议。
   */
  consultUx(requirementContext: string): Promise<string>;
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
  /** 步骤 Agent 资源根（dev: packages/agents/assets/profiles；packaged: resources/pi-runtime/profiles）。 */
  assetsRoot: string;
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
    case 'requirement_proposal':
      return PROPOSE_REQUIREMENT_SYSTEM;
    // task_proposal 走 step agent（task_proposer），使用 materializeStepAgentProfile 物化的 SYSTEM.md，不取此处 prompt。
    case 'task_proposal':
      return CHAT_SYSTEM_TASK;
  }
}

function workloadFromMode(mode: 'task' | 'requirement' | 'task_proposal' = 'task'): 'task_chat' | 'requirement_chat' | 'task_proposal' {
  if (mode === 'requirement') return 'requirement_chat';
  if (mode === 'task_proposal') return 'task_proposal';
  return 'task_chat';
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

export function buildChatPlan(
  entry: string,
  route: ProviderRoute,
  sessionDir: string,
  profileDir: string,
  _workload: ChatWorkload,
  messagesText: string,
  projectToolPath: string,
  step?: { tools: readonly string[]; skills: readonly string[]; extensions: readonly string[] },
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
  ];
  if (step) {
    // 步骤 Agent：显式启用 step 声明的工具（取代 --no-tools），加载 step 扩展与技能。
    args.push('--tools', step.tools.join(','));
    for (const ext of step.extensions) args.push('--extension', join(profileDir, 'extensions', `${ext}.ts`));
    for (const skill of step.skills) args.push('--skill', join(profileDir, 'skills', skill, 'SKILL.md'));
  } else {
    // 非步骤 workload（task_chat/task_proposal/requirement_proposal）：无工具、无技能、无扩展。
    args.push('--no-tools');
  }
  args.push(
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
  );

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

export function materializeChatProfile(sessionDir: string, systemPrompt: string): string {
  const profileDir = join(sessionDir, 'pi-config');
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, 'settings.json'), CHAT_SETTINGS_JSON);
  writeFileSync(join(profileDir, 'SYSTEM.md'), systemPrompt);
  return profileDir;
}

/**
 * 物化专用步骤 Agent 配置快照：<profileDir>/SYSTEM.md + skills/<name>/ + extensions/<name>.ts。
 * step agent 资源统一在 packages/agents/assets/profiles/{steps/<step>/, shared/skills/, shared/extensions/}。
 */
export function materializeStepAgentProfile(
  sessionDir: string,
  step: { step: string; systemPromptFile: string; skills: readonly string[]; extensions: readonly string[] },
  assetsRoot: string,
): string {
  const profileDir = join(sessionDir, 'pi-config');
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, 'settings.json'), CHAT_SETTINGS_JSON);
  cpSync(join(assetsRoot, 'steps', step.step, step.systemPromptFile), join(profileDir, 'SYSTEM.md'));
  for (const name of step.skills) {
    cpSync(join(assetsRoot, 'shared', 'skills', name), join(profileDir, 'skills', name), { recursive: true });
  }
  const extDir = join(profileDir, 'extensions');
  mkdirSync(extDir, { recursive: true });
  for (const name of step.extensions) {
    cpSync(join(assetsRoot, 'shared', 'extensions', `${name}.ts`), join(extDir, `${name}.ts`));
  }
  return profileDir;
}

export async function executeTextOnRoute(
  route: ProviderRoute,
  messages: AiChatMessage[],
  onDelta: ((text: string) => void) | undefined,
  deps: ProductionExecutorDeps,
  workload: ChatWorkload,
  onToolResult?: (toolName: string, payload: unknown) => void,
  cwdOverride?: string,
  onAsk?: (toolUseId: string, tabs: unknown, send: (msg: unknown) => boolean) => void,
  onConsultUx?: (requirementContext: string) => Promise<string>,
  systemPromptOverride?: string,
): Promise<string> {
  const { entry } = await deps.locator.verify();
  const sessionDir = join(deps.sessionsBaseDir, 'chat', randomUUID());
  mkdirSync(sessionDir, { recursive: true });
  const step = stepAgentForWorkload(workload);
  const profileDir = step
    ? materializeStepAgentProfile(sessionDir, step, deps.assetsRoot)
    : materializeChatProfile(sessionDir, systemPromptOverride ?? systemPromptFor(workload));
  const messagesText = formatMessages(messages);
  const plan = buildChatPlan(entry, route, sessionDir, profileDir, workload, messagesText, deps.projectToolPath, step);
  if (plan.modelsJson) {
    writeFileSync(join(profileDir, 'models.json'), plan.modelsJson);
  }

  // task_proposal 需探索真实仓库代码：spawn 的 cwd 指向项目仓库根（cwdOverride），
  // 令 read/grep/find/ls 看到真实工程。其余 workload 保持 cwd=sessionDir（隔离临时目录）。
  const spawned = deps.supervisor.spawn(plan, {
    cwd: cwdOverride ?? sessionDir,
    timeoutMs: 120_000,
    secrets: [route.secret],
  });
  // 问答工具桥接：子进程 ai_devflow_ask.execute 经 IPC 发 { kind:'ask', toolUseId, payload }，
  // onMessage 捕获后经 onAsk 上报（携带 send 回调，供 answer 回灌 { kind:'ask_answer', ... }）。
  spawned.onMessage((msg) => {
    const m = msg as { kind?: string; toolUseId?: string; payload?: unknown };
    if (m?.kind === 'ask' && m.toolUseId) {
      onAsk?.(m.toolUseId, m.payload, (reply: unknown) => spawned.send(reply));
    } else if (m?.kind === 'consult_ux' && m.toolUseId && onConsultUx && m.payload && typeof (m.payload as { requirementContext?: unknown }).requirementContext === 'string') {
      // UX 子咨询：产品专家调用 ai_devflow_consult_ux。主进程启动一次 UX专家 run，把建议回灌。
      const ctx = (m.payload as { requirementContext: string }).requirementContext;
      void onConsultUx(ctx).then((advice) => {
        spawned.send({ kind: 'consult_ux_result', toolUseId: m.toolUseId, advice });
      }).catch((err) => {
        spawned.send({ kind: 'consult_ux_result', toolUseId: m.toolUseId, advice: `UX 子咨询失败：${(err as Error).message}` });
      });
    }
  });

  let full = '';
  let sawAgentEnd = false;
  let malformedStdout = false;
  let streamError: unknown;
  let providerError: { status: number; message: string } | undefined;
  // 步骤 Agent 的结构化草稿工具被调用过：task_proposal / requirement_chat 可能仅调用工具而不输出正文文本，
  // 此时 full 为空是预期的，不应判为「终止协议无效」。只有既无文本又未捕获草稿时才视为异常。
  let capturedProposal = false;
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
          toolName?: string;
          result?: { details?: unknown; content?: Array<{ text?: string }> };
        };
        try {
          event = JSON.parse(line.text) as typeof event;
        } catch {
          malformedStdout = true;
          continue;
        }
        if (event.type === 'message_update') {
          // 流式输出：仅转发 text_delta（正文增量），丢弃 thinking_delta（思维链抑制）。
          // 早期实现缓冲到末尾才 flush，体验差；改为立即转发 onDelta。
          const ame = event.assistantMessageEvent;
          if (ame?.type === 'text_delta') {
            const delta = typeof ame.delta === 'string' ? ame.delta : '';
            if (delta) {
              full += delta;
              onDelta?.(delta);
            }
          }
        } else if (event.type === 'agent_end') {
          sawAgentEnd = true;
        } else if (event.type === 'error' || event.type === 'provider_error') {
          providerError = {
            status: typeof event.status === 'number' ? event.status : 0,
            message: typeof event.message === 'string' ? event.message : '',
          };
        } else if (event.type === 'tool_execution_end' && (event.toolName === REQUIREMENT_PROPOSAL_TOOL || event.toolName === TASK_PROPOSAL_TOOL)) {
          // 需求 / 任务草稿步骤 Agent 调用专用工具产出草稿：execute 回调返回 details=input，
          // 提取后经 onToolResult 上报给 UI 填表单（requirement_chat）或填草稿区（task_proposal）。
          const details = event.result?.details;
          const payload = (details as { aiDevflowRequirementProposal?: unknown; aiDevflowTaskProposal?: unknown } | undefined)?.aiDevflowRequirementProposal ?? details;
          if (payload && typeof payload === 'object') {
            capturedProposal = true;
            onToolResult?.(event.toolName!, payload);
          }
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
  if (streamError || malformedStdout || !sawAgentEnd || (full.length === 0 && !capturedProposal)) {
    const reasons: string[] = [];
    if (streamError) reasons.push(`流错误：${(streamError as Error).message ?? String(streamError)}`);
    if (malformedStdout) reasons.push('stdout 含非法 JSON');
    if (!sawAgentEnd) reasons.push('缺少 agent_end 终态事件');
    if (full.length === 0 && !capturedProposal) reasons.push('未收到任何文本输出且未生成草稿');
    throw new ProviderExecutionError(
      'Pi 返回的终止协议无效',
      'protocol',
      0,
      undefined,
      buildPiFailureDetail(reasons, stderrLines, unknownEventTypes),
    );
  }
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
  return async (workload, messages, onDelta, options, onToolResult, onAsk, onConsultUx, systemPromptOverride) => {
    // cwd 仅用于 task_proposal spawn 的工作目录，不属于路由选项；从 options 中取出后不透传给 router。
    const { cwd, ...routerOptions } = options ?? {};
    const result = await deps.router.execute(
      chatWorkloadToExpert(workload),
      async (route) => {
        try {
          return await executeTextOnRoute(route, messages, onDelta, deps, workload, onToolResult, cwd, onAsk, onConsultUx, systemPromptOverride);
        } catch (err) {
          // 把非 ProviderExecutionError 包装成 runtime 错误，让路由决定是否降级。
          if ((err as Error).message?.includes('应用运行组件损坏')) {
            throw new ProviderExecutionError('应用运行组件损坏', 'runtime');
          }
          throw err;
        }
      },
      routerOptions,
    );
    return result;
  };
}

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
      // task_proposal（mode='task_proposal'）需要探索真实仓库代码：以项目仓库根作为 spawn cwd，
      // 令 task_proposer 的 read/grep/find/ls 能读到实际工程。其余 workload 不传 cwd，保持隔离临时目录。
      return executeText(workload, promptMessages, onDelta, opts?.projectPath ? { cwd: opts.projectPath } : undefined, opts?.onToolResult, opts?.onAsk, opts?.onConsultUx);
    },

    proposeRequirement(messages) {
      return generateStructured('requirement_proposal', messages, requirementSchema, '需求');
    },

    testConnection(providerId) {
      return testConnectionWithRouter(executeText, providerId);
    },

    consultUx(requirementContext) {
      return runUxConsultation(requirementContext, { executeText });
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
