import type { AgentEvent, AgentDetection, AgentRunRequest, AgentCapabilitySupport } from '@ai-devflow/core';
import type { AgentAdapter, AgentRun } from '../types.js';
import { detectByCommand } from '../detect.js';
import { buildRun, logEventsFromLine, spawnAgentProcess, type RawLine } from './base.js';

const DEFAULT_CMD = 'claude';

/** 把统一能力配置转换为 Claude Code CLI 真实参数（均来自 `claude --help`，未臆造）。 */
export function claudeCapabilityArgs(caps: AgentRunRequest['capabilities']): string[] {
  if (!caps) return [];
  const args: string[] = [];
  // 工具白名单：--allowedTools（逗号/空格分隔的工具名列表）。
  if (caps.tools && caps.tools.length > 0) {
    args.push('--allowedTools', caps.tools.join(','));
  }
  // 工具黑名单：--disallowedTools。
  if (caps.disallowedTools && caps.disallowedTools.length > 0) {
    args.push('--disallowedTools', caps.disallowedTools.join(','));
  }
  // 插件：路径 -> --plugin-dir；URL -> --plugin-url（均 repeatable）。
  if (caps.plugins) {
    for (const p of caps.plugins) {
      if (!p) continue;
      if (/^(https?:|file:)/i.test(p)) args.push('--plugin-url', p);
      else args.push('--plugin-dir', p);
    }
  }
  // Skills：Claude Code 仅支持“全开 / 全关”。空数组=关闭全部 skills。
  if (caps.skills && caps.skills.length === 0) {
    args.push('--disable-slash-commands');
  }
  return args;
}

/** 权限模式：requireApproval=true 用 manual（每个工具调用暂停等待人工授权）；否则 acceptEdits（自动接受文件编辑，非全量绕过）。 */
export function claudePermissionMode(caps: AgentRunRequest['capabilities']): string {
  return caps?.requireApproval ? 'manual' : 'acceptEdits';
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = 'claude_code' as const;
  constructor(private opts: { executable?: string; extraArgs?: string[]; env?: Record<string, string> } = {}) {}

  detect(): Promise<AgentDetection> {
    return detectByCommand('claude_code', this.opts.executable ?? DEFAULT_CMD, ['--version']);
  }

  capabilities(): AgentCapabilitySupport {
    // 均来自 `claude --help`：--allowedTools/--disallowedTools（工具）、--plugin-dir/--plugin-url（插件）、
    // --disable-slash-commands（Skills 全开/全关）、--permission-mode manual（授权）。
    return { tools: true, plugins: true, skills: 'all-or-none', approval: true };
  }

  async run(req: AgentRunRequest): Promise<AgentRun> {
    let prompt = req.prompt;
    if (req.resumeFrom || req.userInput) {
      // 待沟通/授权恢复：把用户回答与原上下文前置拼入单一 prompt（claude -p 接受一个 prompt 参数）。
      prompt = `[用户回答] ${req.userInput ?? ''}\n[原上下文] ${req.resumeFrom?.context ?? ''}\n\n${req.prompt}`;
    }
    const caps = req.capabilities;
    // 授权恢复：orchestrator 已把“已批准工具”并入 caps.tools、“已拒绝工具”并入 caps.disallowedTools，
    // 故恢复运行通过 --allowedTools/--disallowedTools 放行或拒绝对应工具（无需臆造 stdin 权限协议）。
    const args = [
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      claudePermissionMode(caps),
      ...claudeCapabilityArgs(caps),
      ...(this.opts.extraArgs ?? []),
    ];
    const requireApproval = !!caps?.requireApproval;
    const spawned = spawnAgentProcess({
      command: this.opts.executable ?? DEFAULT_CMD,
      args,
      cwd: req.cwd,
      env: { ...this.opts.env, ...req.env },
    });
    return buildRun(
      spawned,
      (line) => parseClaudeLine(line, { requireApproval }),
      (lines) => summarizeClaude(lines),
    );
  }
}

export function parseClaudeLine(line: RawLine, opts: { requireApproval?: boolean } = {}): AgentEvent[] {
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
    const events: AgentEvent[] = [];
    for (const c of content) {
      const ctype = c.type as string | undefined;
      if (ctype === 'text') {
        const text = (c as { text?: string }).text;
        if (text) events.push({ type: 'log', level: 'info', text, t });
      } else if (ctype === 'tool_use') {
        const name = (c as { name?: string }).name ?? '';
        const input = (c as { input?: Record<string, unknown> }).input ?? {};
        const toolUseId = (c as { id?: string }).id ?? '';
        const path = (input.file_path as string) ?? (input.path as string);
        if (path) {
          const action: 'create' | 'modify' | 'delete' =
            name === 'Write' ? 'create' : name === 'Edit' || name === 'MultiEdit' ? 'modify' : 'modify';
          events.push({ type: 'file_change', path, action, t });
          events.push({ type: 'log', level: 'info', text: `${name} ${path}`, t });
        } else {
          events.push({ type: 'log', level: 'info', text: `tool: ${name || 'unknown'}`, t });
        }
        // 授权模式：把工具调用转为 approval_request，暂停等待用户批准/拒绝。
        if (opts.requireApproval && name) {
          events.push({
            type: 'approval_request',
            toolName: name,
            toolUseId,
            description: path ? `${name} ${path}` : name,
            input: safeStringify(input),
            t,
          });
        }
      }
    }
    return events;
  }
  if (type === 'tool_use') {
    const input = (obj as { input?: Record<string, unknown> }).input ?? {};
    const path = (input.file_path as string) ?? (input.path as string);
    const name = (obj as { name?: string }).name ?? '';
    if (path) {
      const action: 'create' | 'modify' | 'delete' =
        name === 'Write' ? 'create' : name === 'Edit' || name === 'MultiEdit' ? 'modify' : 'modify';
      return [
        { type: 'file_change', path, action, t },
        { type: 'log', level: 'info', text: `${name} ${path}`, t },
      ];
    }
    return [{ type: 'log', level: 'info', text: `tool: ${name || 'unknown'}`, t }];
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

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}

function summarizeClaude(lines: string[]): string {
  const last = lines.filter((l) => !l.startsWith('{')).slice(-1)[0];
  return last ?? `claude 执行完成，共 ${lines.length} 行输出`;
}
