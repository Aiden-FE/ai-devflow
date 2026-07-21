// FakeAgentRunner：调度器测试用的可控 AgentRunner（设计 §5 单一 Runner，测试注入）。
// 按脚本产出事件流（支持 delayMs 以驱动暂停/取消的时序）；reviewer 角色默认给出可配置的审查结论。
import type { AgentEvent } from '@ai-devflow/core';
import type { AgentRun, AgentRunner, RunnerAgentRunRequest as AgentRunRequest } from '@ai-devflow/agents';

export type TestEventSpec = AgentEvent & { delayMs?: number };

export function runFromEvents(specs: TestEventSpec[], opts: { ignoreCancel?: boolean } = {}): AgentRun {
  let cancelled = false;
  const events = (async function* (): AsyncIterable<AgentEvent> {
    for (const spec of specs) {
      if (spec.delayMs && spec.delayMs > 0) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, spec.delayMs);
          t.unref?.();
        });
      }
      if (cancelled && !opts.ignoreCancel) return;
      const { delayMs: _omit, ...ev } = spec;
      yield ev as AgentEvent;
    }
  })();
  return {
    pid: undefined,
    events,
    cancel: async () => {
      cancelled = true;
    },
    done: async () => {
      for await (const _ev of events) {
        /* drain */
      }
      return { exitCode: cancelled && !opts.ignoreCancel ? null : 0, ok: opts.ignoreCancel === true || !cancelled };
    },
  };
}

export interface FakeRunnerOptions {
  /** 审查结论（reviewer 角色）。默认 PASS。 */
  reviewerVerdict?: 'PASS' | 'FAIL';
  /** 审查产出前的延迟（驱动「审查中暂停/取消」时序）。 */
  reviewerDelayMs?: number;
  /** 忽略取消（晚到事件继续到达，用于验证停止后事件不落库）。 */
  ignoreCancel?: boolean;
  /** 自定义 reviewer 事件（覆盖默认）。 */
  reviewerEvents?: (req: AgentRunRequest) => TestEventSpec[];
}

export class FakeAgentRunner implements AgentRunner {
  requests: AgentRunRequest[] = [];
  constructor(private script: (req: AgentRunRequest) => TestEventSpec[], private opts: FakeRunnerOptions = {}) {}

  async verifyRuntime(): Promise<{ version: string; entry: string }> {
    return { version: 'fake', entry: 'fake' };
  }

  async run(req: AgentRunRequest): Promise<AgentRun> {
    this.requests.push(req);
    if (req.role === 'reviewer') {
      const specs = this.opts.reviewerEvents
        ? this.opts.reviewerEvents(req)
        : this.defaultReviewSpecs();
      return runFromEvents(specs, { ignoreCancel: this.opts.ignoreCancel });
    }
    return runFromEvents(this.script(req), { ignoreCancel: this.opts.ignoreCancel });
  }

  private defaultReviewSpecs(): TestEventSpec[] {
    const verdict = this.opts.reviewerVerdict ?? 'PASS';
    const line = verdict === 'PASS' ? 'REVIEW_VERDICT: PASS' : 'REVIEW_VERDICT: FAIL: 未覆盖验收标准第 2 条';
    const delay = this.opts.reviewerDelayMs ?? 0;
    return [
      { type: 'log', level: 'info', text: 'reviewing', t: 0, delayMs: delay > 0 ? Math.max(1, delay / 2) : undefined },
      { type: 'done', summary: `ok\n${line}`, t: 0, delayMs: delay > 0 ? delay : undefined },
    ];
  }
}

/** 审查执行记录判别：审查执行摘要含 [review: 或「审查已停止」。 */
export function isReviewExecution(summary: string | undefined): boolean {
  const s = summary ?? '';
  return s.includes('[review:') || s.includes('审查已停止');
}
