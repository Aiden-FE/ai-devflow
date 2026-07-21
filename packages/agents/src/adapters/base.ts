import type { AgentEvent, AgentRunRequest } from '@ai-devflow/core';
import type { AgentRun } from '../types.js';
import { spawnAgentProcess, type RawLine, type SpawnedProcess } from '../process-runner.js';

/** 把子进程行流映射为 AgentEvent 流，并在退出时产出 done/error。 */
export function eventsFromProcess(
  spawned: SpawnedProcess,
  parseLine: (line: RawLine) => AgentEvent[],
  opts: { successSummary: (lines: string[]) => string },
): AsyncIterable<AgentEvent> {
  return (async function* () {
    const collected: string[] = [];
    for await (const line of spawned.lines) {
      collected.push(line.text);
      for (const ev of parseLine(line)) yield ev;
    }
    const { exitCode } = await spawned.done();
    if (exitCode === 0) {
      yield {
        type: 'done',
        summary: opts.successSummary(collected),
        t: Date.now(),
      };
    } else {
      yield {
        type: 'error',
        message: `进程退出码 ${exitCode}`,
        recoverable: exitCode !== null && exitCode > 0,
        t: Date.now(),
      };
    }
  })();
}

/** 把 stdout 文本行映射为 info 日志事件（默认行为，子类可覆盖关键行）。 */
export function logEventsFromLine(line: RawLine): AgentEvent[] {
  if (line.stream === 'stderr') {
    return [{ type: 'log', level: 'warn', text: line.text, t: Date.now() }];
  }
  return [{ type: 'log', level: 'info', text: line.text, t: Date.now() }];
}

export function buildRun(
  spawned: SpawnedProcess,
  parseLine: (line: RawLine) => AgentEvent[],
  successSummary: (lines: string[]) => string,
): AgentRun {
  return {
    pid: spawned.pid,
    cancel: () => spawned.cancel(),
    done: async () => {
      const { exitCode } = await spawned.done();
      return { exitCode, ok: exitCode === 0 };
    },
    events: eventsFromProcess(spawned, parseLine, { successSummary }),
  };
}

export { spawnAgentProcess };
export type { RawLine, AgentRunRequest };
