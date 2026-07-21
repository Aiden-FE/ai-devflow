import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentDetection, AgentType } from '@ai-devflow/core';

const execFileP = promisify(execFile);

/** 运行 `<cmd> --version`，解析首行作为版本。返回检测结果。 */
export async function detectByCommand(
  agentType: AgentType,
  command: string,
  versionArgs = ['--version'],
): Promise<AgentDetection> {
  try {
    const { stdout, stderr } = await execFileP(command, versionArgs, {
      timeout: 10_000,
      env: process.env,
    });
    const out = (stdout || stderr).trim();
    const firstLine = out.split('\n')[0] ?? '';
    return {
      agentType,
      available: true,
      version: firstLine || out || undefined,
      path: command,
    };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      return {
        agentType,
        available: false,
        reason: `未找到可执行文件 "${command}"（ENOENT）。请确认已安装并位于 PATH 中。`,
      };
    }
    return {
      agentType,
      available: false,
      reason: `检测失败：${e.message}`,
    };
  }
}
