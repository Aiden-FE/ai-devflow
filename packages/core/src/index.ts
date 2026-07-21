export * from './types.js';
export * from './state-machine.js';
export * from './gates.js';
export * from './timeout.js';
export * from './webhook.js';
export * from './cli.js';
export * from './retry.js';
export * from './sanitize.js';
export * from './audit.js';

/** 生成 ID（crypto.randomUUID，Node 22+ 与浏览器均可用）。 */
export function randomId(): string {
  return globalThis.crypto.randomUUID();
}

/** 当前时间戳（毫秒）。集中入口便于测试注入。 */
export function now(): number {
  return Date.now();
}

/** 角色 -> 默认 AgentType 映射（可被项目设置覆盖）。 */
export function defaultAgentForRole(
  role: import('./types.js').TaskRole,
): import('./types.js').AgentType {
  switch (role) {
    case 'planner':
      return 'claude_code';
    case 'coder':
      return 'claude_code';
    case 'reviewer':
      return 'codex';
    case 'tester':
      return 'codex';
  }
}
