import type { AgentType } from '@ai-devflow/core';
import type { AgentAdapter } from './types.js';
import { ClaudeCodeAdapter } from './adapters/claude-code.js';
import { CodexAdapter } from './adapters/codex.js';
import { PiAdapter } from './adapters/pi.js';
import { ControllableTestAdapter } from './adapters/test.js';

export class AgentRegistry {
  private map = new Map<AgentType, AgentAdapter>();

  register(adapter: AgentAdapter): void {
    this.map.set(adapter.id, adapter);
  }

  get(type: AgentType): AgentAdapter | undefined {
    return this.map.get(type);
  }

  require(type: AgentType): AgentAdapter {
    const a = this.map.get(type);
    if (!a) throw new Error(`未注册的 Agent 类型：${type}`);
    return a;
  }

  list(): AgentAdapter[] {
    return [...this.map.values()];
  }

  has(type: AgentType): boolean {
    return this.map.has(type);
  }
}

/** 默认注册表的可选项：可向各桥接器追加启动参数。 */
export interface AgentRegistryOptions {
  /** 透传给 ClaudeCodeAdapter 的 extraArgs（如权限模式）。 */
  claudeExtraArgs?: string[];
}

/** 默认注册表，预装三桥接器 + 可控测试适配器。 */
export function createDefaultRegistry(opts: AgentRegistryOptions = {}): AgentRegistry {
  const reg = new AgentRegistry();
  reg.register(new ClaudeCodeAdapter({ extraArgs: opts.claudeExtraArgs }));
  reg.register(new CodexAdapter());
  reg.register(new PiAdapter());
  reg.register(new ControllableTestAdapter());
  return reg;
}
