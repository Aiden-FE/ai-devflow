// AI 后端：基于 ai-sdk，在主进程内对流式对话与结构化提议。
// 网络请求在主进程（Node）发起，不经过 Renderer，绕开 CSP。
// 若未配置服务商或密钥/网络不可用，抛出清晰错误供 UI 诊断。
//
// 兼容性要点：结构化提议（任务/需求草稿）使用 generateText + JSON 解析 + Zod 校验（单次重试），
// 而非 generateObject。原因：generateObject 对 Anthropic 默认走 tool 模式、对 OpenAI 走
// response_format 模式，许多"兼容 endpoint"并不支持工具调用或 JSON 响应格式，导致"配置正确却无法生成"。
// generateText 仅依赖文本生成能力（与流式对话同路径），对各类兼容 endpoint 普遍可用。
import { streamText, generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import type { AiProviderConfig, AiChatMessage, AiTaskProposal, AiRequirementProposal } from '@ai-devflow/core';
import type { AiStreamEvent } from './api.js';

// ---- 系统提示 ----

const CHAT_SYSTEM_TASK = `你是 ai-devflow 的需求协作助手，帮助用户把模糊的产品想法细化为可执行的开发任务。
- 用中文沟通，简洁、聚焦。
- 主动澄清边界、验收标准与拆分粒度。
- 当需求足够清晰时，提示用户点击"生成任务草稿"以自动创建任务。`;

const CHAT_SYSTEM_REQ = `你是 ai-devflow 的需求分析助手，帮助用户把模糊的产品想法完善为准确、清晰、可验收的需求。
- 用中文沟通，简洁、聚焦，多问澄清性问题（边界、用户、异常路径、完成定义）。
- 重点帮助用户明确"完成定义"与可检验的验收标准（门禁条件）：怎样才算做完了？
- 当需求足够清晰时，提示用户点击"生成需求草稿"以填充表单。`;

const PROPOSE_TASK_SYSTEM = `根据对话内容，提炼出 1 到 N 个可执行的开发任务。
- 每个任务包含：标题（动宾结构，简洁）、描述（实现要点与边界）、角色。
- 角色 role 仅限：planner（规划）、coder（开发）、reviewer（审查）、tester（测试）。
- 不要编造未提及的功能；不确定时给出最保守的拆分。
- 输出格式：仅输出一个 JSON 对象，形如 {"tasks":[{"title":"","description":"","role":"coder"}]}，不要包含 markdown 代码块或任何额外说明。`;

const PROPOSE_REQ_SYSTEM = `根据对话内容，提炼为一个结构化的需求。
- title：简洁的需求标题（名词短语）。
- description：需求描述（背景、目标、范围）。
- acceptance：验收标准 / 门禁条件（可检验的完成定义，多条用分号或换行分隔）。
- priority：low / medium / high。
- 不要编造未提及的功能；不确定时给出最保守的描述。
- 输出格式：仅输出一个 JSON 对象，形如 {"title":"","description":"","acceptance":"","priority":"medium"}，不要包含 markdown 代码块或任何额外说明。`;

// ---- 模型 ----

function getModel(cfg: AiProviderConfig) {
  if (!cfg.apiKey?.trim()) {
    throw new Error('未配置 AI 服务商 API Key，请在“设置 -> AI 服务商”中填写。');
  }
  if (cfg.provider === 'anthropic') {
    const anthropic = createAnthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseURL || undefined });
    return anthropic(cfg.model || 'claude-sonnet-5');
  }
  const openai = createOpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL || undefined });
  return openai(cfg.model || 'gpt-4o');
}

function buildSystem(base: string, context?: string): string {
  return context ? `${base}\n\n【上下文】\n${context}` : base;
}

// ---- JSON 解析辅助 ----

/** 从模型输出中提取首个 JSON 对象（容忍前后说明与 markdown 代码块）。 */
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

/**
 * 生成结构化对象：generateText -> 提取 JSON -> Zod 校验，失败重试一次（附错误提示）。
 * 不依赖 generateObject 的 tool/json 模式，兼容各类 Anthropic/OpenAI 兼容 endpoint。
 */
async function generateStructured<T>(
  cfg: AiProviderConfig,
  system: string,
  messages: AiChatMessage[],
  schema: z.ZodType<T>,
  label: string,
): Promise<T> {
  const model = getModel(cfg);
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const sys =
      attempt === 0
        ? system
        : `${system}\n\n你上一次的输出无法解析（${lastError}）。请严格仅输出符合上述格式的纯 JSON 对象，不要包含任何额外文字或代码块。`;
    const { text } = await generateText({ model, system: sys, messages });
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

const taskSchema = z.object({
  tasks: z.array(
    z.object({
      title: z.string().min(1),
      description: z.string(),
      role: z.enum(['planner', 'coder', 'reviewer', 'tester']),
    }),
  ),
});

const requirementSchema = z.object({
  title: z.string().min(1),
  description: z.string(),
  acceptance: z.string(),
  priority: z.enum(['low', 'medium', 'high']),
});

// ---- 对外 API ----

/** 流式对话：把增量文本通过 send 回传给 Renderer。 */
export async function chatStream(
  cfg: AiProviderConfig,
  sessionId: string,
  messages: AiChatMessage[],
  send: (ev: AiStreamEvent) => void,
  opts?: { mode?: 'task' | 'requirement'; context?: string },
): Promise<void> {
  const base = opts?.mode === 'requirement' ? CHAT_SYSTEM_REQ : CHAT_SYSTEM_TASK;
  const system = buildSystem(base, opts?.context);
  let model;
  try {
    model = getModel(cfg);
  } catch (e) {
    send({ type: 'error', sessionId, error: (e as Error).message });
    return;
  }
  try {
    const result = streamText({ model, system, messages });
    let full = '';
    for await (const delta of result.textStream) {
      full += delta;
      send({ type: 'delta', sessionId, text: delta });
    }
    send({ type: 'done', sessionId, fullText: full });
  } catch (e) {
    const msg = (e as Error).message || String(e);
    send({
      type: 'error',
      sessionId,
      error: msg.includes('API key')
        ? `AI 调用失败：API Key 无效或未授权。${msg}`
        : `AI 调用失败（请检查网络与配置）：${msg}`,
    });
  }
}

/** 结构化任务提议：返回可落库的任务草稿列表。context 可带入当前需求内容。 */
export async function proposeTasks(
  cfg: AiProviderConfig,
  messages: AiChatMessage[],
  context?: string,
): Promise<AiTaskProposal[]> {
  const system = buildSystem(PROPOSE_TASK_SYSTEM, context);
  const data = await generateStructured(cfg, system, messages, taskSchema, '任务列表');
  return data.tasks;
}

/** 结构化需求提议：返回可落库的需求草稿（标题/描述/验收标准/优先级）。 */
export async function proposeRequirement(
  cfg: AiProviderConfig,
  messages: AiChatMessage[],
): Promise<AiRequirementProposal> {
  return generateStructured(cfg, PROPOSE_REQ_SYSTEM, messages, requirementSchema, '需求');
}
