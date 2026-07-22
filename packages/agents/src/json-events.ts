// Pi JSONL 事件桥接（设计 §11）与尝试日志（设计 §10）。
//
// 解析 Pi `--mode json` 的 JSON Lines 流（非 stdout 正则），映射为 AgentEvent 并维护 AttemptJournal。
// 未知事件按向前兼容原则记为诊断，不崩溃；缺少必需事件或 schema 非法属 protocol failure。
// 完成条件：Pi 正常结束（agent_end）∧ 收到合法 ai_devflow_report_result。出口前 redact 活跃路线密钥。
import type { AgentEvent } from '@ai-devflow/core';
import { now, redactText } from '@ai-devflow/core';
import type { AttemptJournal } from './attempt-journal.js';

export interface PiEventTranslatorOptions {
  executionId: string;
  attemptId: string;
  routeId?: string;
  /** 需在输出/日志/ journal 中脱敏的活跃/备用路线密钥。 */
  secrets?: string[];
}

export interface StructuredResult {
  summary: string;
  verification: string[];
  changedFiles: string[];
  unresolved: string[];
}

export interface PiEventTranslator {
  /** 推入一行 JSONL，返回本行映射出的 AgentEvent（可能为空）。 */
  push(line: string): AgentEvent[];
  /** 当前尝试日志快照。 */
  journal(): AttemptJournal;
  /** 流结束：要求 report_result 与 agent_end 成对出现；纯 interaction 是唯一非完成终态。 */
  finish(): void;
  hasStructuredResult(): boolean;
  structuredResult(): StructuredResult | undefined;
  /** Pi 报告的最后一次提供商侧错误（用于故障分类与降级）；无则 undefined。 */
  lastProviderError(): { status: number; message: string } | undefined;
  /** 本次尝试是否触发了 ai_devflow_interaction（澄清/确认）——应暂停而非降级。 */
  hadInteraction(): boolean;
}

const FILE_TOOLS = new Set(['write', 'edit']);
const INTERACTION_TOOL = 'ai_devflow_interaction';
const REPORT_TOOL = 'ai_devflow_report_result';

function makeRedactor(secrets: string[]): (text: string) => string {
  return (text: string): string => {
    let out = text;
    for (const s of secrets) {
      if (s) out = out.split(s).join('***');
    }
    return redactText(out);
  };
}

function extractStructuredResult(result: unknown): StructuredResult | undefined {
  const r = result as { details?: { aiDevflowResult?: unknown }; content?: Array<{ text?: string }> } | undefined;
  const candidate = (r?.details?.aiDevflowResult ?? r?.details) as StructuredResult | undefined;
  if (candidate && typeof candidate.summary === 'string') return normalize(candidate);
  const text = r?.content?.[0]?.text;
  if (typeof text === 'string') {
    try {
      const parsed = JSON.parse(text) as { aiDevflowResult?: StructuredResult };
      if (parsed?.aiDevflowResult && typeof parsed.aiDevflowResult.summary === 'string') return normalize(parsed.aiDevflowResult);
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

function normalize(r: StructuredResult): StructuredResult {
  return {
    summary: r.summary,
    verification: Array.isArray(r.verification) ? r.verification : [],
    changedFiles: Array.isArray(r.changedFiles) ? r.changedFiles : [],
    unresolved: Array.isArray(r.unresolved) ? r.unresolved : [],
  };
}

function interactionInput(value: unknown): { kind: 'clarification' | 'confirmation'; title: string; detail: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as { kind?: unknown; title?: unknown; detail?: unknown };
  if (input.kind !== 'clarification' && input.kind !== 'confirmation') return undefined;
  if (typeof input.title !== 'string' || typeof input.detail !== 'string') return undefined;
  return { kind: input.kind, title: input.title, detail: input.detail };
}

function interactionResult(value: unknown): ReturnType<typeof interactionInput> {
  const result = value as { details?: unknown; content?: Array<{ text?: string }> } | undefined;
  const details = result?.details as { aiDevflowInteraction?: unknown } | undefined;
  const direct = interactionInput(details?.aiDevflowInteraction ?? details);
  if (direct) return direct;
  const text = result?.content?.[0]?.text;
  if (typeof text !== 'string') return undefined;
  try {
    return interactionInput((JSON.parse(text) as { aiDevflowInteraction?: unknown }).aiDevflowInteraction);
  } catch {
    return undefined;
  }
}

export function createPiEventTranslator(opts: PiEventTranslatorOptions): PiEventTranslator {
  const redact = makeRedactor(opts.secrets ?? []);
  const journal: AttemptJournal = {
    executionId: opts.executionId,
    attemptId: opts.attemptId,
    routeId: opts.routeId ?? '',
    mutationsObserved: false,
    toolCalls: [],
    changedFiles: [],
  };
  const pendingArgs = new Map<string, Record<string, unknown>>();
  let agentEnded = false;
  let result: StructuredResult | undefined;
  let providerError: { status: number; message: string } | undefined;
  let interactionOccurred = false;
  let protocolFailure: string | undefined;

  const t = () => now();

  return {
    push(line: string): AgentEvent[] {
      const events: AgentEvent[] = [];
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(line) as Record<string, unknown>;
      } catch {
        protocolFailure ??= 'Pi stdout 包含非法 JSON';
        return events;
      }
      const type = ev.type as string | undefined;
      switch (type) {
        case 'session':
          // 记录 Pi session 元数据（不暴露内部路径）。
          break;
        case 'message_update': {
          const delta = typeof ev.delta === 'string' ? ev.delta : '';
          if (delta) events.push({ type: 'log', level: 'info', text: redact(delta), t: t() });
          break;
        }
        case 'tool_execution_start': {
          const id = String(ev.toolCallId ?? '');
          const name = String(ev.toolName ?? '');
          journal.toolCalls.push({ id, name, state: 'started', summary: redact(shortSummary(name, ev.args)) });
          if (ev.args && typeof ev.args === 'object') pendingArgs.set(id, ev.args as Record<string, unknown>);
          break;
        }
        case 'tool_execution_update':
          // 仅更新可折叠工具消息，不判定完成。
          break;
        case 'tool_execution_end': {
          const id = String(ev.toolCallId ?? '');
          const name = String(ev.toolName ?? '');
          const isError = ev.isError === true;
          const call = journal.toolCalls.find((c) => c.id === id);
          const matchedStart = call?.name === name && call.state === 'started';
          if (call) call.state = isError ? 'failed' : 'completed';
          const args = pendingArgs.get(id) ?? {};
          if (name === REPORT_TOOL) {
            const structured = extractStructuredResult(ev.result);
            if (structured) {
              result = {
                summary: redact(structured.summary),
                verification: structured.verification.map(redact),
                changedFiles: structured.changedFiles.map(redact),
                unresolved: structured.unresolved.map(redact),
              };
            }
          } else if (name === INTERACTION_TOOL) {
            const input = interactionInput(args);
            const completed = interactionResult(ev.result);
            const payloadMatches = input && completed
              && input.kind === completed.kind
              && input.title === completed.title
              && input.detail === completed.detail;
            if (!matchedStart || ev.isError !== false || !payloadMatches) {
              protocolFailure ??= 'interaction 工具生命周期无效';
              if (call) call.state = 'failed';
            } else {
              interactionOccurred = true;
              events.push({ type: 'ask_user', question: redact(input.title), context: redact(input.detail), t: t() });
            }
          } else if (FILE_TOOLS.has(name)) {
            const path = typeof args.path === 'string' ? args.path : undefined;
            if (path) {
              journal.changedFiles.push({ path, action: 'modify' });
              journal.mutationsObserved = true;
              events.push({ type: 'file_change', path, action: 'modify', t: t() });
            }
          } else if (name === 'bash') {
            journal.mutationsObserved = true;
          }
          break;
        }
        case 'agent_end':
          agentEnded = true;
          break;
        case 'error':
        case 'provider_error': {
          const status = typeof ev.status === 'number' ? ev.status : 0;
          const message = typeof ev.message === 'string' ? ev.message : '';
          providerError = { status, message: redact(message) };
          break;
        }
        default:
          // auto_retry_* 或未知事件：诊断，向前兼容，不崩溃。
          break;
      }
      return events;
    },
    journal(): AttemptJournal {
      return journal;
    },
    finish(): void {
      for (const call of journal.toolCalls) {
        if (call.state === 'started') call.state = 'uncertain';
      }
      if (protocolFailure) {
        throw new Error(`protocol failure：${protocolFailure}`);
      }
      if (interactionOccurred) {
        if (result) {
          throw new Error('protocol failure：未解决的 interaction 不得同时报告任务完成');
        }
        // Real Pi may close the turn with agent_end after the interaction tool. Without a
        // structured result this is still a pause terminal, never task completion.
        return;
      }
      if (!agentEnded && result) {
        throw new Error('protocol failure：收到结构化结果但缺少 agent_end');
      }
      if (agentEnded && !result) {
        throw new Error('protocol failure：Pi 已结束但缺少有效的结构化结果（ai_devflow_report_result）');
      }
      if (!agentEnded && !result && !providerError) {
        throw new Error('protocol failure：Pi 缺少终态事件');
      }
    },
    hasStructuredResult(): boolean {
      return result !== undefined;
    },
    structuredResult(): StructuredResult | undefined {
      return result;
    },
    lastProviderError(): { status: number; message: string } | undefined {
      return providerError;
    },
    hadInteraction(): boolean {
      return interactionOccurred;
    },
  };
}

function shortSummary(name: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  if (name === 'bash' && typeof a.command === 'string') return `bash: ${a.command}`;
  if (typeof a.path === 'string') return `${name}: ${a.path}`;
  return name;
}
