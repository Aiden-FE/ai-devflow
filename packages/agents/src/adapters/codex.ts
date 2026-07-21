import type { AgentEvent, AgentDetection, AgentCapabilitySupport } from '@ai-devflow/core';
import type { AgentAdapter, AgentRun } from '../types.js';
import { detectByCommand } from '../detect.js';
import { buildRun, logEventsFromLine, spawnAgentProcess, type RawLine } from './base.js';

const DEFAULT_CMD = 'codex';

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex' as const;
  constructor(
    private opts: {
      executable?: string;
      extraArgs?: string[];
      env?: Record<string, string>;
      sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
    } = {},
  ) {}

  detect(): Promise<AgentDetection> {
    return detectByCommand('codex', this.opts.executable ?? DEFAULT_CMD, ['--version']);
  }

  /**
   * Codex exec 的权限模型是沙箱（--sandbox read-only/workspace-write/danger-full-access），
   * 非交互 exec 不支持逐工具人工授权，也无插件/Skills 概念。故如实声明均不支持：
   * 这些字段在 UI 禁用并说明，不静默忽略。
   */
  capabilities(): AgentCapabilitySupport {
    return { tools: false, plugins: false, skills: false, approval: false };
  }

  async run(req: import('@ai-devflow/core').AgentRunRequest): Promise<AgentRun> {
    let prompt = req.prompt;
    if (req.resumeFrom || req.userInput) {
      prompt = `[用户回答] ${req.userInput ?? ''}\n[原上下文] ${req.resumeFrom?.context ?? ''}\n\n${req.prompt}`;
    }
    const args = [
      'exec',
      '--sandbox',
      this.opts.sandbox ?? 'workspace-write',
      ...(this.opts.extraArgs ?? []),
      prompt,
    ];
    const spawned = spawnAgentProcess({
      command: this.opts.executable ?? DEFAULT_CMD,
      args,
      cwd: req.cwd,
      env: { ...this.opts.env, ...req.env },
    });
    return buildRun(spawned, (line) => parseCodexLine(line), (lines) =>
      lines.slice(-1)[0] ?? `codex 执行完成，共 ${lines.length} 行`,
    );
  }
}

// 简单启发式：识别 codex 输出中的文件改动与错误。
export function parseCodexLine(line: RawLine): AgentEvent[] {
  const text = line.text;
  const t = Date.now();
  if (line.stream === 'stderr' || /\b(error|failed|panic)\b/i.test(text)) {
    return [{ type: 'log', level: 'error', text, t }];
  }
  // codex exec 在应用补丁时常输出 "applying patch to <path>" 或 "Editing <path>"
  const m = /(?:applying patch to|editing|wrote|created|updated)\s+(?:file\s+)?([^\s].+)/i.exec(text);
  if (m && m[1]) {
    return [
      { type: 'file_change', path: m[1].replace(/['"`]/g, ''), action: 'modify', t },
      { type: 'log', level: 'info', text, t },
    ];
  }
  return logEventsFromLine(line);
}
