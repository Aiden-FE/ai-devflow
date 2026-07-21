import type { AgentEvent, AgentDetection } from '@ai-devflow/core';
import type { AgentAdapter, AgentRun } from '../types.js';
import { detectByCommand } from '../detect.js';
import { buildRun, logEventsFromLine, spawnAgentProcess, type RawLine } from './base.js';

const DEFAULT_CMD = 'claude';

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = 'claude_code' as const;
  constructor(private opts: { executable?: string; extraArgs?: string[]; env?: Record<string, string> } = {}) {}

  detect(): Promise<AgentDetection> {
    return detectByCommand('claude_code', this.opts.executable ?? DEFAULT_CMD, ['--version']);
  }

  async run(req: import('@ai-devflow/core').AgentRunRequest): Promise<AgentRun> {
    let prompt = req.prompt;
    if (req.resumeFrom || req.userInput) {
      // 待沟通恢复：把用户回答与原上下文前置拼入单一 prompt（claude -p 接受一个 prompt 参数）。
      prompt = `[用户回答] ${req.userInput ?? ''}\n[原上下文] ${req.resumeFrom?.context ?? ''}\n\n${req.prompt}`;
    }
    const args = [
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      ...(this.opts.extraArgs ?? []),
    ];
    const spawned = spawnAgentProcess({
      command: this.opts.executable ?? DEFAULT_CMD,
      args,
      cwd: req.cwd,
      env: { ...this.opts.env, ...req.env },
    });
    return buildRun(spawned, (line) => parseClaudeLine(line), (lines) =>
      summarizeClaude(lines),
    );
  }
}

export function parseClaudeLine(line: RawLine): AgentEvent[] {
  if (line.stream === 'stderr') {
    return [{ type: 'log', level: 'warn', text: line.text, t: Date.now() }];
  }
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line.text);
  } catch {
    return logEventsFromLine(line);
  }
  const t = Date.now();
  const type = obj.type as string | undefined;
  if (type === 'assistant') {
    const content = (obj as { message?: { content?: Array<Record<string, unknown>> } }).message?.content;
    if (!Array.isArray(content)) return [];
    // Claude Code stream-json 把 tool_use 作为 assistant 消息的 content block 下发（而非顶层 type），
    // 需在此提取，才能产生 file_change 事件并在日志中显示工具调用。
    const events: AgentEvent[] = [];
    for (const c of content) {
      const ctype = c.type as string | undefined;
      if (ctype === 'text') {
        const text = (c as { text?: string }).text;
        if (text) events.push({ type: 'log', level: 'info', text, t });
      } else if (ctype === 'tool_use') {
        const name = (c as { name?: string }).name ?? '';
        const input = (c as { input?: Record<string, unknown> }).input ?? {};
        const path = (input.file_path as string) ?? (input.path as string);
        if (path) {
          const action: 'create' | 'modify' | 'delete' =
            name === 'Write' ? 'create' : name === 'Edit' || name === 'MultiEdit' ? 'modify' : 'modify';
          events.push({ type: 'file_change', path, action, t });
          events.push({ type: 'log', level: 'info', text: `${name} ${path}`, t });
        } else {
          events.push({ type: 'log', level: 'info', text: `tool: ${name || 'unknown'}`, t });
        }
      }
    }
    return events;
  }
  if (type === 'tool_use') {
    const input = (obj as { input?: Record<string, unknown> }).input ?? {};
    const path = (input.file_path as string) ?? (input.path as string);
    if (path) {
      const name = (obj as { name?: string }).name ?? '';
      const action: 'create' | 'modify' | 'delete' =
        name === 'Write' ? 'create' : name === 'Edit' || name === 'MultiEdit' ? 'modify' : 'modify';
      return [
        { type: 'file_change', path, action, t },
        { type: 'log', level: 'info', text: `${name} ${path}`, t },
      ];
    }
    return [{ type: 'log', level: 'info', text: `tool: ${(obj as { name?: string }).name ?? 'unknown'}`, t }];
  }
  if (type === 'result') {
    const text = (obj as { result?: string }).result ?? JSON.stringify(obj);
    return [{ type: 'log', level: 'info', text: `result: ${text.slice(0, 500)}`, t }];
  }
  if (type === 'system') {
    const subtype = (obj as { subtype?: string }).subtype;
    // thinking_tokens 在扩展思考期间高频发射（每个 token 估算增量一条），全记录会刷屏且无信息量，静默丢弃。
    if (subtype === 'thinking_tokens') return [];
    return [{ type: 'log', level: 'info', text: `system: ${subtype ?? ''}`, t }];
  }
  return [{ type: 'log', level: 'info', text: line.text, t }];
}

function summarizeClaude(lines: string[]): string {
  const last = lines.filter((l) => !l.startsWith('{')).slice(-1)[0];
  return last ?? `claude 执行完成，共 ${lines.length} 行输出`;
}
