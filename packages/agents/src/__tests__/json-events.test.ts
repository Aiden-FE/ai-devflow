import { describe, expect, it } from 'vitest';
import { createPiEventTranslator } from '../json-events.js';

describe('createPiEventTranslator', () => {
  it('tracks a tool from start through completion and emits a file change', () => {
    const translator = createPiEventTranslator({ executionId: 'e1', attemptId: 'a1' });
    translator.push(JSON.stringify({ type: 'tool_execution_start', toolCallId: 'tc1', toolName: 'write', args: { path: 'src/a.ts', content: 'x' } }));
    const events = translator.push(JSON.stringify({ type: 'tool_execution_end', toolCallId: 'tc1', toolName: 'write', result: { content: [] }, isError: false }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'file_change', path: 'src/a.ts', action: 'modify' }));
    expect(translator.journal().toolCalls[0]?.state).toBe('completed');
    expect(translator.journal().changedFiles).toContainEqual({ path: 'src/a.ts', action: 'modify' });
    expect(translator.journal().mutationsObserved).toBe(true);
  });

  it('marks a failed tool as failed', () => {
    const translator = createPiEventTranslator({ executionId: 'e1', attemptId: 'a1' });
    translator.push(JSON.stringify({ type: 'tool_execution_start', toolCallId: 'tc1', toolName: 'bash', args: { command: 'pnpm test' } }));
    translator.push(JSON.stringify({ type: 'tool_execution_end', toolCallId: 'tc1', toolName: 'bash', result: { content: [] }, isError: true }));
    expect(translator.journal().toolCalls[0]?.state).toBe('failed');
  });

  it('marks a started tool uncertain when the stream ends', () => {
    const translator = createPiEventTranslator({ executionId: 'e1', attemptId: 'a1' });
    translator.push(JSON.stringify({ type: 'tool_execution_start', toolCallId: 'tc1', toolName: 'bash', args: { command: 'pnpm test' } }));
    expect(() => translator.finish()).toThrow(/缺少终态事件/);
    expect(translator.journal().toolCalls[0]?.state).toBe('uncertain');
  });

  it('emits a log event for message_update text deltas', () => {
    const translator = createPiEventTranslator({ executionId: 'e1', attemptId: 'a1' });
    const events = translator.push(JSON.stringify({ type: 'message_update', delta: 'hello world' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'log', text: 'hello world' }));
  });

  it('rejects success without a valid ai_devflow_report_result payload', () => {
    const translator = createPiEventTranslator({ executionId: 'e1', attemptId: 'a1' });
    translator.push(JSON.stringify({ type: 'agent_end', messages: [] }));
    expect(() => translator.finish()).toThrow(/结构化结果/);
  });

  it('accepts a valid ai_devflow_report_result but leaves done emission to the role gate', () => {
    const translator = createPiEventTranslator({ executionId: 'e1', attemptId: 'a1' });
    translator.push(JSON.stringify({ type: 'tool_execution_start', toolCallId: 'tc1', toolName: 'ai_devflow_report_result', args: {} }));
    const events = translator.push(JSON.stringify({
      type: 'tool_execution_end', toolCallId: 'tc1', toolName: 'ai_devflow_report_result',
      result: { details: { aiDevflowResult: { summary: 'done', verification: ['t pass'], changedFiles: ['src/a.ts'], unresolved: [] } } },
      isError: false,
    }));
    translator.push(JSON.stringify({ type: 'agent_end', messages: [] }));
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'done' }));
    expect(translator.hasStructuredResult()).toBe(true);
    expect(translator.structuredResult()?.verification).toEqual(['t pass']);
    expect(() => translator.finish()).not.toThrow();
  });

  it('rejects a report result when agent_end is missing', () => {
    const translator = createPiEventTranslator({ executionId: 'e1', attemptId: 'a1' });
    translator.push(JSON.stringify({
      type: 'tool_execution_end', toolCallId: 'tc1', toolName: 'ai_devflow_report_result', isError: false,
      result: { details: { aiDevflowResult: { summary: 'done', verification: ['ok'], changedFiles: [], unresolved: [] } } },
    }));
    expect(() => translator.finish()).toThrow(/agent_end/);
  });

  it('redacts the active route secret before emitting or journaling', () => {
    const translator = createPiEventTranslator({ executionId: 'e1', attemptId: 'a1', secrets: ['route-secret'] });
    const events = translator.push(JSON.stringify({ type: 'message_update', delta: 'never route-secret here' }));
    expect(JSON.stringify(events)).not.toContain('route-secret');
    expect(JSON.stringify(translator.journal())).not.toContain('route-secret');
  });

  it('records unknown event types as debug diagnostics without crashing', () => {
    const translator = createPiEventTranslator({ executionId: 'e1', attemptId: 'a1' });
    expect(() => translator.push(JSON.stringify({ type: 'some_future_event', x: 1 }))).not.toThrow();
  });

  it('fails closed at finish after malformed stdout JSON', () => {
    const translator = createPiEventTranslator({ executionId: 'e1', attemptId: 'a1' });
    expect(() => translator.push('not-json-at-all')).not.toThrow();
    expect(() => translator.finish()).toThrow(/protocol failure/);
  });
});
