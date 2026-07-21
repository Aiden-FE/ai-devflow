import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import type { AgentDetection, AgentType } from '@ai-devflow/core';
import { envWithCliPriority, resolveCommand } from './resolve-path.js';

const execFileP = promisify(execFile);

/**
 * 探测当前（CLI 优先）PATH 下的 Node 运行时：绝对路径、版本、是否支持 `??=`。
 * 用特性探测（实际执行 `x ??= 1`）而非版本号解析，更可靠地判定语法兼容性。
 */
async function detectNodeRuntime(env: NodeJS.ProcessEnv): Promise<{
  nodePath?: string;
  nodeVersion?: string;
  supportsNullish?: boolean;
}> {
  const pathStr = typeof env.PATH === 'string' ? env.PATH : '';
  const nodePath = resolveCommand('node', pathStr);
  const result: { nodePath?: string; nodeVersion?: string; supportsNullish?: boolean } = {};
  if (nodePath.includes('/')) result.nodePath = nodePath;
  try {
    const { stdout } = await execFileP(nodePath, ['--version'], { timeout: 5_000, env });
    result.nodeVersion = stdout.trim() || undefined;
  } catch {
    /* node 不可用：保持 undefined */
  }
  try {
    await execFileP(nodePath, ['-e', 'let x = null; x ??= 1;'], { timeout: 5_000, env });
    result.supportsNullish = true;
  } catch {
    result.supportsNullish = false;
  }
  return result;
}

/**
 * 运行 `<cli> --version` 检测 CLI 可用性。
 *
 * 关键：先把命令解析为绝对路径，并让其所在 bin 目录优先进入 PATH，再执行——
 * 这样以 `#!/usr/bin/env node` 为 shebang 的 CLI（如 pi）会命中与自身同目录的 Node，
 * 避免「找到了 pi 却因 shebang 命中旧 Node（不支持 ??=）而启动失败」。
 *
 * 检测结果区分：
 * - 可用：返回 version、CLI 绝对路径与 Node 路径/版本（诊断用）。
 * - errorKind='not-found'：未找到 CLI（ENOENT）。
 * - errorKind='incompatible-node'：CLI 已找到，但 PATH 命中的 Node 运行时过旧。
 * - errorKind='other'：其它失败。
 */
export async function detectByCommand(
  agentType: AgentType,
  command: string,
  versionArgs = ['--version'],
): Promise<AgentDetection> {
  const cliPath = resolveCommand(command);
  const env = envWithCliPriority(cliPath);
  try {
    const { stdout, stderr } = await execFileP(cliPath, versionArgs, { timeout: 10_000, env });
    const out = (stdout || stderr).trim();
    const firstLine = out.split('\n')[0] ?? '';
    const node = await detectNodeRuntime(env);
    return {
      agentType,
      available: true,
      version: firstLine || out || undefined,
      path: cliPath,
      nodePath: node.nodePath,
      nodeVersion: node.nodeVersion,
    };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      return {
        agentType,
        available: false,
        errorKind: 'not-found',
        path: cliPath,
        reason: `未找到可执行文件 "${command}"（ENOENT）。请确认已安装并位于 PATH 中。`,
      };
    }
    // CLI 文件存在但执行失败：判定是否为 Node 运行时不兼容（shebang 命中旧 Node）。
    const node = await detectNodeRuntime(env);
    const cliExists = cliPath.includes('/') && existsSync(cliPath);
    if (cliExists && node.supportsNullish === false) {
      return {
        agentType,
        available: false,
        errorKind: 'incompatible-node',
        path: cliPath,
        nodePath: node.nodePath,
        nodeVersion: node.nodeVersion,
        reason:
          `已找到 CLI "${cliPath}"，但其 shebang/PATH 命中的 Node 运行时` +
          `${node.nodeVersion ? ' ' + node.nodeVersion : ''}（${node.nodePath ?? 'node'}）过旧，` +
          `不支持所需语法（如 ??=）。请升级该 Node，或确保 CLI 所在 bin 目录的 Node 优先于 PATH。`,
      };
    }
    return {
      agentType,
      available: false,
      errorKind: 'other',
      path: cliPath,
      nodePath: node.nodePath,
      nodeVersion: node.nodeVersion,
      reason: `检测失败：${e.message}`,
    };
  }
}
