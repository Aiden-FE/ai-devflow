#!/usr/bin/env node
// Fake Pi CLI（契约/集成测试夹具，设计 §16.2）。接受与真实 Pi 相同的调用形态，输出官方形状的 JSONL。
// 场景由 AI_DEVFLOW_FAKE_SCENARIO 指定；首次尝试（attempt-01）按场景失败，其后成功——用以驱动降级/接管。
const scenario = process.env.AI_DEVFLOW_FAKE_SCENARIO || 'success';
const attemptId = process.env.AI_DEVFLOW_ATTEMPT_ID || '';
const isFirst = attemptId.startsWith('attempt-01') || attemptId.includes('-attempt-01-');

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function reportResult(summary, extra = {}) {
  emit({ type: 'tool_execution_start', toolCallId: 'rc1', toolName: 'ai_devflow_report_result', args: {} });
  emit({
    type: 'tool_execution_end', toolCallId: 'rc1', toolName: 'ai_devflow_report_result', isError: false,
    result: { details: { aiDevflowResult: { summary, verification: ['ok'], changedFiles: [], unresolved: [], ...extra } } },
  });
}

function succeed(summary = 'done') {
  if (process.env.AI_DEVFLOW_ROLE === 'reviewer' && !summary.includes('REVIEW_VERDICT:')) {
    summary += '\nREVIEW_VERDICT: PASS';
  }
  reportResult(summary);
  emit({ type: 'agent_end', messages: [] });
  process.exit(0);
}

emit({ type: 'session', sessionId: 'fake-session', version: '0.80.10' });
emit({ type: 'message_update', delta: `fake pi scenario=${scenario} attempt=${attemptId}` });

switch (scenario) {
  case 'success':
    emit({ type: 'tool_execution_start', toolCallId: 'tc1', toolName: 'bash', args: { command: 'echo hi' } });
    emit({ type: 'tool_execution_end', toolCallId: 'tc1', toolName: 'bash', isError: false, result: { content: [{ type: 'text', text: 'hi' }] } });
    succeed('done');
    break;

  case 'mutate-then-provider-error':
    if (isFirst) {
      emit({ type: 'tool_execution_start', toolCallId: 'w1', toolName: 'write', args: { path: 'src/fixture.ts', content: 'x' } });
      emit({ type: 'tool_execution_end', toolCallId: 'w1', toolName: 'write', isError: false, result: { content: [] } });
      emit({ type: 'error', status: 503, message: 'provider unavailable' });
      process.exit(1);
    } else {
      succeed('recovered');
    }
    break;

  case 'authentication':
    if (isFirst) {
      emit({ type: 'error', status: 401, message: 'unauthorized' });
      process.exit(1);
    } else {
      succeed('done');
    }
    break;

  case 'rate-limit':
    if (isFirst) {
      emit({ type: 'error', status: 429, message: 'rate limited' });
      process.exit(1);
    } else {
      succeed('done');
    }
    break;

  case 'runtime-crash':
    if (isFirst) {
      process.exit(7);
    } else {
      succeed('done');
    }
    break;

  case 'protocol-corruption':
    if (isFirst) {
      process.stdout.write('THIS IS NOT JSONL\n');
      emit({ type: 'agent_end', messages: [] });
      process.exit(0);
    } else {
      succeed('done');
    }
    break;

  case 'interaction':
    emit({ type: 'tool_execution_start', toolCallId: 'i1', toolName: 'ai_devflow_interaction', args: { kind: 'clarification', title: 'need input', detail: 'please clarify' } });
    emit({ type: 'tool_execution_end', toolCallId: 'i1', toolName: 'ai_devflow_interaction', isError: false, result: { details: { aiDevflowInteraction: { kind: 'clarification', title: 'need input', detail: 'please clarify' } } } });
    // 不输出 report_result / agent_end；supervisor 在工具结果后终止进程，runner 识别为暂停（非降级）。
    process.exit(0);
    break;

  case 'task-result-failure':
    emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'pnpm test' } });
    emit({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', isError: true, result: { content: [{ type: 'text', text: 'test failed' }] } });
    reportResult('tests failed', { unresolved: ['failing test'] });
    emit({ type: 'agent_end', messages: [] });
    process.exit(0);
    break;

  case 'missing-verification':
    reportResult('unverified result', { verification: [] });
    emit({ type: 'agent_end', messages: [] });
    process.exit(0);
    break;

  case 'report-without-end':
    reportResult('report without end');
    process.exit(0);
    break;

  case 'malformed-then-report':
    process.stdout.write('MALFORMED BEFORE REPORT\n');
    succeed('report after malformed output');
    break;

  case 'provider-error-then-report':
    emit({ type: 'provider_error', status: 503, message: 'provider failed before report' });
    succeed('report after provider failure');
    break;

  case 'interaction-then-report':
    emit({ type: 'tool_execution_start', toolCallId: 'i1', toolName: 'ai_devflow_interaction', args: { kind: 'clarification', title: 'need input', detail: 'please clarify' } });
    emit({ type: 'tool_execution_end', toolCallId: 'i1', toolName: 'ai_devflow_interaction', isError: false, result: { details: {} } });
    succeed('report after unresolved interaction');
    break;

  default:
    succeed('done');
}
