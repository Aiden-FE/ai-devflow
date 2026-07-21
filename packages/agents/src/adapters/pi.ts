import type { AgentEvent, AgentDetection } from '@ai-devflow/core';
import type { AgentAdapter, AgentRun } from '../types.js';
import { detectByCommand } from '../detect.js';
import { spawnAgentProcess, logEventsFromLine } from './base.js';

const DEFAULT_CMD = 'pi';

export interface PiAdapterOptions {
  executable?: string;
  extraArgs?: string[];
  env?: Record<string, string>;
}

/**
 * Pi 桥接器。
 *
 * Pi CLI 在本机未安装时 detect() 报告 available:false 并附带可重复验收步骤；
 * run() 不伪造成功，而是产出 error 事件。当 Pi 安装到 PATH 后，detect 与 run 自动生效。
 */
export class PiAdapter implements AgentAdapter {
  readonly id = 'pi' as const;
  constructor(private opts: PiAdapterOptions = {}) {}

  detect(): Promise<AgentDetection> {
    return detectByCommand('pi', this.opts.executable ?? DEFAULT_CMD, ['--version']);
  }

  async run(req: import('@ai-devflow/core').AgentRunRequest): Promise<AgentRun> {
    const det = await this.detect();
    let spawned: ReturnType<typeof spawnAgentProcess> | undefined;
    const opts = this.opts;

    const events = (async function* (): AsyncIterable<AgentEvent> {
      if (!det.available) {
        yield {
          type: 'error',
          message: `Pi 不可用：${det.reason ?? '未安装'}。${PiAdapter.verificationSteps()}`,
          recoverable: false,
          t: Date.now(),
        };
        return;
      }
      spawned = spawnAgentProcess({
        command: opts.executable ?? DEFAULT_CMD,
        args: [...(opts.extraArgs ?? []), req.prompt],
        cwd: req.cwd,
        env: { ...opts.env, ...req.env },
      });
      for await (const line of spawned.lines) {
        for (const ev of logEventsFromLine(line)) yield ev;
      }
      const { exitCode } = await spawned.done();
      if (exitCode === 0) {
        yield { type: 'done', summary: 'pi 执行完成', t: Date.now() };
      } else {
        yield { type: 'error', message: `pi 退出码 ${exitCode}`, recoverable: true, t: Date.now() };
      }
    })();

    return {
      pid: spawned?.pid,
      cancel: async () => {
        await spawned?.cancel();
      },
      done: async () => {
        let ok = false;
        for await (const ev of events) {
          if (ev.type === 'done') ok = true;
        }
        return { exitCode: ok ? 0 : 1, ok };
      },
      events,
    };
  }

  static verificationSteps(): string {
    return [
      '验收步骤：',
      '1. 安装 Pi CLI（按 Pi 官方文档，例如官方安装脚本或包管理器命令）。',
      '2. 运行 `pi --version` 确认可用，且 `which pi` 能定位可执行文件。',
      '3. 重新打开 ai-devflow，设置页“检测 Agent”应显示 Pi 可用。',
      '4. 在任务中分派 Pi 执行一个小任务（如在 cwd 打印标记串），确认产生 done 事件与日志。',
    ].join(' ');
  }
}
