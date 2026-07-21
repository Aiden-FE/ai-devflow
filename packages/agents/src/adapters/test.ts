import type { AgentEvent, AgentDetection, AgentRunRequest, AgentCapabilitySupport } from '@ai-devflow/core';
import type { AgentAdapter, AgentRun } from '../types.js';

/** 带可选延迟的事件规格，用于可控测试。 */
export type TestEventSpec = AgentEvent & { delayMs?: number };

export interface ControllableTestOptions {
  /**
   * 程序化脚本：根据请求返回事件序列。用于自动化测试异常/超时/协议边界。
   * 可根据 req.resumeFrom / req.userInput / req.interactionResponse 区分首次执行与恢复。
   */
  script?: (req: AgentRunRequest) => TestEventSpec[];
  /** 环境变量名，指向一段 JSON 事件规格数组（覆盖 script）。 */
  envVar?: string;
  /** 默认每事件延迟（ms）。 */
  defaultDelayMs?: number;
}

/**
 * 可控测试适配器：不调用真实 CLI，按脚本产出事件。
 * 仅用于自动化测试协议边界（异常/超时/提问/授权/恢复/取消），不可替代真实 Agent 验收。
 */
export class ControllableTestAdapter implements AgentAdapter {
  readonly id = 'test' as const;
  constructor(private opts: ControllableTestOptions = {}) {}

  async detect(): Promise<AgentDetection> {
    return { agentType: 'test', available: true, version: 'test-1.0', path: 'builtin' };
  }

  /** 测试适配器声明支持全部能力，便于在测试中驱动工具/插件/Skills/授权协议边界。 */
  capabilities(): AgentCapabilitySupport {
    return { tools: true, plugins: true, skills: 'all-or-none', approval: true };
  }

  async run(req: AgentRunRequest): Promise<AgentRun> {
    const specs = this.resolveScript(req);
    let cancelled = false;
    let exhausted = false;

    const events = (async function* (): AsyncIterable<AgentEvent> {
      for (const spec of specs) {
        if (cancelled) return;
        if (spec.delayMs && spec.delayMs > 0) {
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, spec.delayMs);
            t.unref?.();
          });
        }
        if (cancelled) return;
        const { delayMs: _omit, ...ev } = spec;
        yield ev as AgentEvent;
      }
      exhausted = true;
    })();

    return {
      pid: undefined,
      cancel: async () => {
        cancelled = true;
      },
      done: async () => {
        for await (const _ev of events) {
          // drain
        }
        return { exitCode: cancelled ? null : 0, ok: !cancelled && exhausted };
      },
      events,
    };
  }

  private resolveScript(req: AgentRunRequest): TestEventSpec[] {
    // 恢复运行（带 userInput 或 interactionResponse）时优先读 RESUME 控制变量，
    // 便于 E2E 驱动“待沟通/待授权 -> 回答/批准 -> 完成”。
    const envVar = req.userInput || req.interactionResponse
      ? this.opts.envVar ?? 'AI_DEVFLOW_TEST_RESUME_CONTROL'
      : this.opts.envVar ?? 'AI_DEVFLOW_TEST_CONTROL';
    const raw = process.env[envVar];
    if (raw) {
      try {
        return JSON.parse(raw) as TestEventSpec[];
      } catch {
        // 解析失败回退到 script
      }
    }
    if (this.opts.script) return this.opts.script(req);
    // 恢复且无显式脚本时默认完成
    if (req.userInput || req.interactionResponse) return [{ type: 'done', summary: 'resumed', t: 0 }];
    // 无脚本、无环境变量（如手动 `pnpm dev` 测试）：产出一条日志并完成，
    // 避免空事件导致编排器判定“阶段未完成”进入重试。
    return [
      { type: 'log', level: 'info', text: '测试适配器：未配置脚本（AI_DEVFLOW_TEST_CONTROL），模拟完成', t: 0 },
      { type: 'done', summary: 'test adapter no-op done', t: 0 },
    ];
  }
}
