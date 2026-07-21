import { describe, it, expect } from 'vitest';
import {
  AgentRegistry,
  createDefaultRegistry,
  ControllableTestAdapter,
  detectByCommand,
  parseClaudeLine,
  parseCodexLine,
  ClaudeCodeAdapter,
  CodexAdapter,
  PiAdapter,
  claudeCapabilityArgs,
  claudePermissionMode,
} from '../index.js';
import type { AgentRunRequest, AgentCapabilities } from '@ai-devflow/core';

describe('registry', () => {
  it('createDefaultRegistry registers all four adapters', () => {
    const reg = createDefaultRegistry();
    expect(reg.has('claude_code')).toBe(true);
    expect(reg.has('codex')).toBe(true);
    expect(reg.has('pi')).toBe(true);
    expect(reg.has('test')).toBe(true);
    expect(reg.list().length).toBe(4);
  });

  it('require throws for unknown type', () => {
    const reg = new AgentRegistry();
    expect(() => reg.require('codex' as never)).toThrow(/未注册/);
  });

  it('register/get works', () => {
    const reg = new AgentRegistry();
    const a = new ControllableTestAdapter({ script: () => [] });
    reg.register(a);
    expect(reg.get('test')).toBe(a);
  });
});

describe('detect', () => {
  it('detectByCommand reports unavailable for missing binary', async () => {
    const d = await detectByCommand('pi', 'pi-definitely-not-on-path-xyz', ['--version']);
    expect(d.available).toBe(false);
    expect(d.reason).toMatch(/ENOENT|未找到/);
  });

  it('detectByCommand succeeds for node', async () => {
    const d = await detectByCommand('test', process.execPath, ['--version']);
    expect(d.available).toBe(true);
    expect(d.version).toBeTruthy();
  });
});

describe('ControllableTestAdapter', () => {
  const req: AgentRunRequest = { taskId: 't1', prompt: 'p', cwd: '/tmp' };

  it('emits scripted events in order', async () => {
    const a = new ControllableTestAdapter({
      script: () => [
        { type: 'log', level: 'info', text: 'start', t: 0 },
        { type: 'status', stage: 's1', t: 0 },
        { type: 'done', summary: 'ok', t: 0 },
      ],
    });
    const run = await a.run(req);
    const out = [];
    for await (const ev of run.events) out.push(ev);
    expect(out.map((e) => e.type)).toEqual(['log', 'status', 'done']);
    const d = await run.done();
    expect(d.ok).toBe(true);
  });

  it('cancel stops emission', async () => {
    const a = new ControllableTestAdapter({
      script: () => [
        { type: 'log', level: 'info', text: 'a', t: 0 },
        { type: 'log', level: 'info', text: 'b', t: 0, delayMs: 100 },
        { type: 'done', summary: 'ok', t: 0, delayMs: 100 },
      ],
    });
    const run = await a.run(req);
    const out: string[] = [];
    let n = 0;
    for await (const ev of run.events) {
      out.push(ev.type);
      n++;
      if (n === 1) {
        await run.cancel();
      }
    }
    expect(out).toContain('log');
    expect(out).not.toContain('done');
  });

  it('ask_user then resume via different script', async () => {
    let call = 0;
    const a = new ControllableTestAdapter({
      script: (r) => {
        call++;
        if (!r.userInput) {
          return [
            { type: 'log', level: 'info', text: 'need input', t: 0 },
            { type: 'ask_user', question: 'which?', context: 'ctx', t: 0 },
          ];
        }
        return [
          { type: 'log', level: 'info', text: `got ${r.userInput}`, t: 0 },
          { type: 'done', summary: 'resumed', t: 0 },
        ];
      },
    });
    const r1 = await a.run(req);
    const e1 = [];
    for await (const ev of r1.events) e1.push(ev);
    expect(e1.at(-1)!.type).toBe('ask_user');

    const r2 = await a.run({ ...req, userInput: 'use vitest', resumeFrom: { id: 'c', taskId: 't1', stageId: 's', stageIndex: 0, context: 'ctx', createdAt: 0 } });
    const e2 = [];
    for await (const ev of r2.events) e2.push(ev);
    expect(e2.at(-1)!.type).toBe('done');
    expect(call).toBe(2);
  });

  it('emits error for failure script', async () => {
    const a = new ControllableTestAdapter({
      script: () => [{ type: 'error', message: 'boom', recoverable: false, t: 0 }],
    });
    const run = await a.run(req);
    const out = [];
    for await (const ev of run.events) out.push(ev);
    expect(out[0]!.type).toBe('error');
  });

  it('default (no script, no env) emits log + done so manual dev is not a no-op', async () => {
    const a = new ControllableTestAdapter();
    const run = await a.run(req);
    const out = [];
    for await (const ev of run.events) out.push(ev);
    expect(out.some((e) => e.type === 'log')).toBe(true);
    expect(out.some((e) => e.type === 'done')).toBe(true);
  });
});

describe('claude stream-json parsing', () => {
  const L = (text: string) => parseClaudeLine({ stream: 'stdout', text });

  it('maps assistant text to log', () => {
    const ev = L(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } }));
    expect(ev[0]!.type).toBe('log');
    expect((ev[0] as { text: string }).text).toBe('hello');
  });

  it('maps Write tool_use to file_change create', () => {
    const ev = L(JSON.stringify({ type: 'tool_use', name: 'Write', input: { file_path: '/a/b.txt' } }));
    expect(ev[0]!.type).toBe('file_change');
    expect((ev[0] as { path: string; action: string }).path).toBe('/a/b.txt');
    expect((ev[0] as { action: string }).action).toBe('create');
  });

  it('extracts nested tool_use from assistant content (Write -> create)', () => {
    const ev = L(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/a/b.ts' } }] },
    }));
    expect(ev.some((e) => e.type === 'file_change' && (e as { path: string }).path === '/a/b.ts' && (e as { action: string }).action === 'create')).toBe(true);
    expect(ev.some((e) => e.type === 'log' && (e as { text: string }).text === 'Write /a/b.ts')).toBe(true);
  });

  it('extracts nested tool_use from assistant content (Bash -> tool log)', () => {
    const ev = L(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm install' } }] },
    }));
    expect(ev.some((e) => e.type === 'log' && (e as { text: string }).text === 'tool: Bash')).toBe(true);
    expect(ev.some((e) => e.type === 'file_change')).toBe(false);
  });

  it('assistant message with both text and tool_use emits both', () => {
    const ev = L(JSON.stringify({
      type: 'assistant',
      message: { content: [
        { type: 'text', text: 'creating file' },
        { type: 'tool_use', name: 'Write', input: { file_path: '/x.txt' } },
      ] },
    }));
    expect(ev.some((e) => e.type === 'log' && (e as { text: string }).text === 'creating file')).toBe(true);
    expect(ev.some((e) => e.type === 'file_change')).toBe(true);
  });

  it('maps Edit tool_use to file_change modify', () => {
    const ev = L(JSON.stringify({ type: 'tool_use', name: 'Edit', input: { file_path: '/a/b.txt' } }));
    expect((ev[0] as { action: string }).action).toBe('modify');
  });

  it('maps result to log', () => {
    const ev = L(JSON.stringify({ type: 'result', result: 'done' }));
    expect(ev[0]!.type).toBe('log');
    expect((ev[0] as { text: string }).text).toMatch(/result: done/);
  });

  it('suppresses high-frequency thinking_tokens system events', () => {
    const ev = L(JSON.stringify({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 42 }));
    expect(ev).toHaveLength(0);
  });

  it('keeps other system events (e.g. init)', () => {
    const ev = L(JSON.stringify({ type: 'system', subtype: 'init' }));
    expect(ev[0]!.type).toBe('log');
    expect((ev[0] as { text: string }).text).toBe('system: init');
  });

  it('non-JSON line falls back to log', () => {
    const ev = L('plain text line');
    expect(ev[0]!.type).toBe('log');
  });

  it('stderr maps to warn', () => {
    const ev = parseClaudeLine({ stream: 'stderr', text: 'warn x' });
    expect((ev[0] as { level: string }).level).toBe('warn');
  });
});

describe('codex line parsing', () => {
  const L = (text: string, stream: 'stdout' | 'stderr' = 'stdout') =>
    parseCodexLine({ stream, text });

  it('detects file change hints', () => {
    const ev = L('editing src/foo.ts');
    expect(ev.some((e) => e.type === 'file_change')).toBe(true);
  });

  it('stderr or error keywords map to error level', () => {
    expect((L('something failed', 'stderr')[0] as { level: string }).level).toBe('error');
    expect((L('ERROR: boom')[0] as { level: string }).level).toBe('error');
  });

  it('plain info line maps to info', () => {
    expect((L('all good')[0] as { level: string }).level).toBe('info');
  });
});

describe('adapter capability declarations', () => {
  it('claude supports tools/plugins/skills(all-or-none)/approval', () => {
    const c = new ClaudeCodeAdapter().capabilities();
    expect(c.tools).toBe(true);
    expect(c.plugins).toBe(true);
    expect(c.skills).toBe('all-or-none');
    expect(c.approval).toBe(true);
  });
  it('codex declares unsupported (sandbox is its model, not per-tool)', () => {
    const c = new CodexAdapter().capabilities();
    expect(c.tools).toBe(false);
    expect(c.plugins).toBe(false);
    expect(c.approval).toBe(false);
  });
  it('pi declares unsupported (not installed / unverified)', () => {
    const c = new PiAdapter().capabilities();
    expect(c.tools).toBe(false);
    expect(c.approval).toBe(false);
  });
  it('test adapter declares full support for protocol testing', () => {
    const c = new ControllableTestAdapter().capabilities();
    expect(c.tools).toBe(true);
    expect(c.approval).toBe(true);
  });
});

describe('claude capability -> CLI args (no fabricated flags)', () => {
  it('permission mode: manual when requireApproval, else acceptEdits (never bypass)', () => {
    expect(claudePermissionMode({ agentType: 'claude_code', requireApproval: true } as AgentCapabilities)).toBe('manual');
    expect(claudePermissionMode({ agentType: 'claude_code' } as AgentCapabilities)).toBe('acceptEdits');
    expect(claudePermissionMode(undefined)).toBe('acceptEdits');
  });
  it('maps tools/disallowedTools/plugins/skills to real flags', () => {
    const args = claudeCapabilityArgs({
      agentType: 'claude_code',
      tools: ['Bash', 'Edit'],
      disallowedTools: ['WebFetch'],
      plugins: ['/local/plugin', 'https://example.com/p.zip'],
      skills: [],
    } as AgentCapabilities);
    expect(args).toEqual([
      '--allowedTools', 'Bash,Edit',
      '--disallowedTools', 'WebFetch',
      '--plugin-dir', '/local/plugin',
      '--plugin-url', 'https://example.com/p.zip',
      '--disable-slash-commands',
    ]);
  });
  it('non-empty skills list is left enabled (all-or-none, no per-skill)', () => {
    const args = claudeCapabilityArgs({ agentType: 'claude_code', skills: ['summarize'] } as AgentCapabilities);
    expect(args.some((a) => a === '--disable-slash-commands')).toBe(false);
  });
});

describe('claude approval surfacing', () => {
  it('emits approval_request for tool_use when requireApproval', () => {
    const ev = parseClaudeLine(
      { stream: 'stdout', text: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'rm -rf /' } }] } }) },
      { requireApproval: true },
    );
    const ar = ev.find((e) => e.type === 'approval_request') as Extract<import('@ai-devflow/core').AgentEvent, { type: 'approval_request' }> | undefined;
    expect(ar).toBeDefined();
    expect(ar!.toolName).toBe('Bash');
    expect(ar!.toolUseId).toBe('tu1');
    expect(ar!.input).toContain('rm -rf');
  });
  it('does not emit approval_request when requireApproval is false', () => {
    const ev = parseClaudeLine(
      { stream: 'stdout', text: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }] } }) },
      { requireApproval: false },
    );
    expect(ev.some((e) => e.type === 'approval_request')).toBe(false);
  });
});

describe('test adapter approval + interactionResponse resume', () => {
  const req: AgentRunRequest = { taskId: 't1', prompt: 'p', cwd: '/tmp' };
  it('emits approval_request then resumes done on allow', async () => {
    const a = new ControllableTestAdapter({
      script: (r) => {
        if (r.interactionResponse?.kind === 'approval') {
          return r.interactionResponse.value === 'allow'
            ? [{ type: 'log', level: 'info', text: 'approved', t: 0 }, { type: 'done', summary: 'ok', t: 0 }]
            : [{ type: 'error', message: 'denied', recoverable: false, t: 0 }];
        }
        return [
          { type: 'log', level: 'info', text: 'want bash', t: 0 },
          { type: 'approval_request', toolName: 'Bash', toolUseId: 'tu1', description: 'rm', t: 0 },
        ];
      },
    });
    const r1 = await a.run(req);
    const e1 = [];
    for await (const ev of r1.events) e1.push(ev);
    expect(e1.at(-1)!.type).toBe('approval_request');
    const r2 = await a.run({ ...req, interactionResponse: { kind: 'approval', value: 'allow' } });
    const e2 = [];
    for await (const ev of r2.events) e2.push(ev);
    expect(e2.at(-1)!.type).toBe('done');
  });
});
