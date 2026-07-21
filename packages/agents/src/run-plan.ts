// Pi 运行计划构造（设计 §7.5 精确资源加载 + §14 子进程安全）。
//
// 「关闭发现，再显式加载」：--no-extensions/--no-skills/--no-prompt-templates/--no-themes/
// --no-context-files 关闭一切自动发现，再用绝对路径显式加载内置 extensions/skills。系统提示词在
// 角色 SYSTEM.md（Pi 从 PI_CODING_AGENT_DIR 读取），动态任务内容作为初始 message。
//
// 子进程 env 从空白白名单构造，绝不展开 process.env：隔离 HOME/临时目录、受控 PATH、PI_* 隔离、
// 唯一候选凭证（标准提供商对应 *_API_KEY；兼容网关用 AI_DEVFLOW_ACTIVE_API_KEY + models.json 引用）。
import { dirname } from 'node:path';
import type { ProviderKind, TaskRole } from '@ai-devflow/core';
import type { ProviderRoute } from './provider-router.js';
import {
  ACTIVE_API_KEY_ENV,
  BUILTIN_EXTENSIONS,
  ROLE_PROFILES,
  buildCompatibleModelsJson,
  isCompatibleKind,
  roleToolsArg,
} from './profiles.js';

/** 标准提供商 → 子进程凭证环境变量名。 */
const STANDARD_KEY_ENV: Partial<Record<ProviderKind, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

export interface PiRunPlanInput {
  runtimeEntry: string;
  profileDir: string;
  sessionDir: string;
  isolatedHome: string;
  tempDir: string;
  executionId: string;
  attemptId: string;
  role: TaskRole;
  initialMessage: string;
  route: ProviderRoute;
  /** 角色工具执行所需的受控 PATH（不参与 Pi 入口解析）。 */
  projectToolPath: string;
  /** 任务 worktree（execution-policy 据此限定写入范围）。 */
  worktree?: string;
  /** 恢复上下文 JSON 路径（checkpoint-context 据此注入；须在 attempt session 内）。 */
  checkpointPath?: string;
}

export interface PiRunPlan {
  command: string;
  args: string[];
  env: Record<string, string>;
  initialMessage: string;
  /** 仅测试检视用；生产经 ProfileMaterializer 写入 profile 目录，不随 argv 传递。 */
  modelsJson?: string;
}

/** 非敏感的 locale/平台变量白名单透传（不含密钥、NODE_*、PI_*、供应商 key）。 */
const LOCALE_PASSTHROUGH = ['LANG', 'LC_ALL', 'LC_CTYPE'];
const WINDOWS_PASSTHROUGH = ['SystemRoot', 'ComSpec', 'PATHEXT'];

export function buildPiRunPlan(input: PiRunPlanInput): PiRunPlan {
  const profile = ROLE_PROFILES[input.role];
  const name = `${input.executionId}-${input.attemptId}`;

  // §6.3：command=process.execPath，args=[absolutePiEntry, ...piArgs]。
  const args: string[] = [input.runtimeEntry, '--mode', 'json', '--no-extensions'];
  for (const ext of BUILTIN_EXTENSIONS) {
    args.push('--extension', `${input.profileDir}/extensions/${ext}.ts`);
  }
  args.push('--no-skills');
  for (const skill of profile.skills) {
    args.push('--skill', `${input.profileDir}/skills/${skill}/SKILL.md`);
  }
  args.push(
    '--no-prompt-templates',
    '--no-themes',
    '--no-context-files',
    '--no-approve',
    '--tools',
    roleToolsArg(input.role),
  );
  if (profile.excludedTools.length > 0) {
    args.push('--exclude-tools', profile.excludedTools.join(','));
  }
  args.push(
    '--provider', input.route.providerName,
    '--model', input.route.model,
    '--thinking', input.route.thinking,
    '--session-dir', input.sessionDir,
    '--name', name,
    input.initialMessage,
  );

  // 空白白名单 env（绝不展开 process.env）。
  const env: Record<string, string> = {
    ELECTRON_RUN_AS_NODE: '1',
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    PI_CODING_AGENT_DIR: input.profileDir,
    PI_CODING_AGENT_SESSION_DIR: input.sessionDir,
    PI_PACKAGE_DIR: dirname(input.runtimeEntry),
    PATH: input.projectToolPath,
    HOME: input.isolatedHome,
    USERPROFILE: input.isolatedHome,
    TMPDIR: input.tempDir,
    TEMP: input.tempDir,
    TMP: input.tempDir,
    AI_DEVFLOW_ROLE: input.role,
    AI_DEVFLOW_EXECUTION_ID: input.executionId,
    AI_DEVFLOW_ATTEMPT_ID: input.attemptId,
  };
  if (input.worktree) env.AI_DEVFLOW_WORKTREE = input.worktree;
  if (input.checkpointPath) env.AI_DEVFLOW_CHECKPOINT_PATH = input.checkpointPath;
  for (const key of [...LOCALE_PASSTHROUGH, ...WINDOWS_PASSTHROUGH]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }

  let modelsJson: string | undefined;
  if (isCompatibleKind(input.route.providerKind)) {
    env[ACTIVE_API_KEY_ENV] = input.route.secret;
    modelsJson = buildCompatibleModelsJson(
      input.route.providerName,
      input.route.providerKind,
      input.route.baseURL,
      [input.route.model],
    );
  } else {
    const keyEnv = STANDARD_KEY_ENV[input.route.providerKind];
    if (keyEnv) env[keyEnv] = input.route.secret;
  }

  return { command: process.execPath, args, env, initialMessage: input.initialMessage, modelsJson };
}
