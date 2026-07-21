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
import type { AiProviderConfig, AiChatMessage, AiTaskProposal, AiRequirementProposal, TestConnectionResult } from '@ai-devflow/core';
import { validateProposalDag, redactText } from '@ai-devflow/core';
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

const PROPOSE_TASK_SYSTEM = `根据对话内容，提炼出 1 到 N 个可执行的开发任务，并分析任务之间的真实依赖关系（输出 DAG）。
- 每个任务包含：draftId（稳定的草稿标识，如 t1、t2）、标题（动宾结构，简洁）、描述（实现要点与边界）、角色、dependsOn（依赖的其它 draftId 列表，无依赖则为空数组）。
- 仅当任务 B 真实需要任务 A 的产出作为输入时，才把 A 放入 B.dependsOn；相互独立的任务保持并行（dependsOn 为空数组），不要机械地串成一条链。
- 角色 role 仅限：planner（规划）、coder（开发）、reviewer（审查）、tester（测试）。
- dependsOn 不得自引用、不得成环、引用的 draftId 必须在本批任务中存在。
- 不要编造未提及的功能；不确定时给出最保守的拆分。
- 输出格式：仅输出一个 JSON 对象，形如 {"tasks":[{"draftId":"t1","title":"","description":"","role":"coder","dependsOn":[]}]}，不要包含 markdown 代码块或任何额外说明。`;

const PROPOSE_REQ_SYSTEM = `根据对话内容，提炼为一个结构化的需求。
- title：简洁的需求标题（名词短语）。
- description：需求描述（背景、目标、范围）。
- acceptance：验收标准 / 门禁条件（可检验的完成定义，多条用分号或换行分隔）。
- priority：low / medium / high。
- 不要编造未提及的功能；不确定时给出最保守的描述。
- 输出格式：仅输出一个 JSON 对象，形如 {"title":"","description":"","acceptance":"","priority":"medium"}，不要包含 markdown 代码块或任何额外说明。`;

// ---- 模型 ----

// ---- baseURL 规范化 ----

/**
 * 规范化 Anthropic 兼容服务的 baseURL。
 * @ai-sdk/anthropic 会在 baseURL 之后追加 `/messages`，因此这里统一把用户输入归一到「以 /v1 结尾」：
 * - 主机根地址 `https://host`        -> `https://host/v1`
 * - `/v1` 前缀  `https://host/v1`     -> `https://host/v1`（保持）
 * - 完整地址    `https://host/v1/messages` -> `https://host/v1`（去掉 /messages，避免重复拼接）
 * 从而避免「漏加 /v1」或「重复拼接 /v1/messages」导致的 404 Not Found。
 */
export function normalizeAnthropicBaseURL(input: string | undefined): string | undefined {
  if (!input) return undefined;
  let u = input.trim().replace(/\/+$/, '');
  if (!u) return undefined;
  if (/\/messages$/i.test(u)) u = u.slice(0, -'/messages'.length).replace(/\/+$/, '');
  if (/\/v1$/i.test(u)) return u;
  return `${u}/v1`;
}

/** 脱敏 URL：移除可能内嵌的凭据（user:pass@）。请求地址本身不含 API Key（密钥走请求头）。 */
export function sanitizeUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = '';
      u.password = '';
    }
    return u.toString();
  } catch {
    return url.replace(/\/\/[^@/]+@/, '//');
  }
}

function getModel(cfg: AiProviderConfig) {
  if (!cfg.apiKey?.trim()) {
    throw new Error('未配置 AI 服务商 API Key，请在“设置 -> AI 服务商”中填写。');
  }
  if (cfg.provider === 'anthropic') {
    // 规范化 baseURL；同时携带 x-api-key（SDK 默认，来自 apiKey）与 Authorization: Bearer，
    // 兼容两类 Anthropic 网关的鉴权约定（不降级为 OpenAI 协议）。
    const anthropic = createAnthropic({
      apiKey: cfg.apiKey,
      baseURL: normalizeAnthropicBaseURL(cfg.baseURL),
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
    });
    return anthropic(cfg.model || 'claude-sonnet-5');
  }
  // OpenAI 路径保持原样（baseURL 直接透传，SDK 追加 /chat/completions）。
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

/** 结构化任务提议：返回可落库的任务草稿列表（含依赖 DAG）。context 可带入当前需求内容。 */
export async function proposeTasks(
  cfg: AiProviderConfig,
  messages: AiChatMessage[],
  context?: string,
): Promise<AiTaskProposal[]> {
  const system = buildSystem(PROPOSE_TASK_SYSTEM, context);
  const data = await generateStructured(cfg, system, messages, taskSchema, '任务列表');
  // 规范化 draftId（模型若遗漏则按序补齐 t1..tN），保证 dependsOn 引用可解析。
  const tasks: AiTaskProposal[] = data.tasks.map((t, i) => ({
    draftId: (t.draftId ?? '').trim() || `t${i + 1}`,
    title: t.title,
    description: t.description,
    role: t.role,
    dependsOn: t.dependsOn ?? [],
  }));
  // 校验依赖 DAG（引用存在、无自依赖、无环）；不合法则报错，避免落库脏数据。
  const v = validateProposalDag(tasks);
  if (!v.ok) throw new Error(`AI 任务依赖不合法：${v.reasons.join('；')}`);
  return tasks;
}

/** 结构化需求提议：返回可落库的需求草稿（标题/描述/验收标准/优先级）。 */
export async function proposeRequirement(
  cfg: AiProviderConfig,
  messages: AiChatMessage[],
): Promise<AiRequirementProposal> {
  return generateStructured(cfg, PROPOSE_REQ_SYSTEM, messages, requirementSchema, '需求');
}

// ---- 测试连接（设置页「测试连接」） ----

/** 构造一次最小化的连通性探测请求（最终 URL + 头 + 体）。API Key 只进入请求头，绝不进入 URL。 */
export function buildTestRequest(cfg: AiProviderConfig): {
  url: string;
  headers: Record<string, string>;
  body: unknown;
} {
  if (cfg.provider === 'anthropic') {
    const base = normalizeAnthropicBaseURL(cfg.baseURL) ?? 'https://api.anthropic.com/v1';
    return {
      url: `${base}/messages`,
      headers: {
        'content-type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: { model: cfg.model || 'claude-sonnet-5', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] },
    };
  }
  const base = cfg.baseURL?.trim().replace(/\/+$/, '') || 'https://api.openai.com/v1';
  return {
    url: `${base}/chat/completions`,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: { model: cfg.model || 'gpt-4o', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] },
  };
}

/**
 * 测试 AI 服务商连通性：用最小请求探测最终地址，返回 HTTP 状态与脱敏后的服务端摘要。
 * 错误信息包含脱敏后的最终请求地址、HTTP 状态与服务端摘要；绝不记录/返回 API Key。
 */
export async function testConnection(cfg: AiProviderConfig): Promise<TestConnectionResult> {
  if (!cfg.apiKey?.trim()) {
    return { ok: false, status: 0, url: '', error: '未配置 API Key，无法测试连接。' };
  }
  const { url, headers, body } = buildTestRequest(cfg);
  const safeUrl = sanitizeUrl(url);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(15_000) : undefined,
    });
    const text = await res.text().catch(() => '');
    const serverSummary = text ? redactText(text).slice(0, 300) : undefined;
    return {
      ok: res.ok,
      status: res.status,
      url: safeUrl,
      serverSummary,
      error: res.ok ? undefined : `请求失败：HTTP ${res.status}（${safeUrl}）${serverSummary ? '，服务端：' + serverSummary : ''}`,
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      url: safeUrl,
      error: `网络错误（${safeUrl}）：${redactText((e as Error).message || String(e))}`,
    };
  }
}
