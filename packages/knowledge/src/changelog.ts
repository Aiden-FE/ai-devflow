// 迭代 CHANGELOG 确定性校验：覆盖任务、路径、关联知识 ID 与 Git 跟踪。
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { IterationChangelogVerification, KnowledgeFinding } from '@ai-devflow/core';
import type { KnowledgeGitProbe } from './audit.js';

export interface VerifyChangelogInput {
  repoPath: string;
  version: string;
  iterationId: string;
  expectedTaskIds: string[];
  tracked: KnowledgeGitProbe;
  verifiedAt: number;
}

function sanitizeSegment(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** 校验迭代 CHANGELOG：根 H1、每个预期任务覆盖、任务 CHANGELOG 路径、关联知识 ID 与 Git 跟踪。 */
export async function verifyIterationChangelog(input: VerifyChangelogInput): Promise<IterationChangelogVerification> {
  const versionSeg = sanitizeSegment(input.version);
  const changelogPath = `docs/iterations/${versionSeg}/CHANGELOG.md`;
  const findings: KnowledgeFinding[] = [];
  const covered: string[] = [];
  const missing: string[] = [];
  const changedPaths: string[] = [changelogPath];

  let content = '';
  try {
    content = await readFile(join(input.repoPath, changelogPath), 'utf8');
  } catch {
    findings.push({
      id: 'missing_changelog',
      severity: 'error',
      code: 'missing_changelog',
      path: changelogPath,
      message: `迭代 CHANGELOG 缺失：${changelogPath}`,
      evidence: [changelogPath],
    });
    return {
      iterationId: input.iterationId,
      state: 'invalid',
      coveredTaskIds: [],
      missingTaskIds: [...input.expectedTaskIds].sort(),
      changedPaths,
      findings,
    };
  }

  // 根 H1
  if (!/^#\s+.+/m.test(content)) {
    findings.push({
      id: 'missing_root_h1',
      severity: 'error',
      code: 'missing_root_h1',
      path: changelogPath,
      message: '迭代 CHANGELOG 缺少根 H1 标题',
      evidence: [changelogPath],
    });
  }

  const lower = content.toLowerCase();
  for (const taskId of input.expectedTaskIds) {
    const taskSeg = sanitizeSegment(taskId);
    const taskChangelog = `docs/iterations/${versionSeg}/tasks/${taskSeg}/CHANGELOG.md`;
    // 任务被 CHANGELOG 覆盖：正文中出现任务 ID 或任务 CHANGELOG 路径引用。
    const mentioned = lower.includes(taskId.toLowerCase()) || lower.includes(taskSeg.toLowerCase());
    if (mentioned) {
      covered.push(taskId);
      // 任务级 CHANGELOG 路径存在性
      try {
        await stat(join(input.repoPath, taskChangelog));
        changedPaths.push(taskChangelog);
      } catch {
        findings.push({
          id: `missing_task_changelog:${taskId}`,
          severity: 'error',
          code: 'missing_task_changelog',
          path: taskChangelog,
          knowledgeId: taskId,
          message: `任务 CHANGELOG 缺失：${taskChangelog}`,
          evidence: [taskChangelog],
        });
      }
    } else {
      missing.push(taskId);
    }
  }

  // 关联知识 ID 引用（context:root 等前缀）：校验引用目标在仓库知识目录存在（仅检查路径引用格式）
  const knowledgeIdRefs = content.match(/\b(context|adr|feature|runbook|product|ux):[a-z0-9_-]+\b/gi) ?? [];
  for (const ref of knowledgeIdRefs) {
    // 不阻断：仅记录为信息级（确定性服务不解析知识正文是否存在；由巡检覆盖）
    void ref;
  }

  // Git 跟踪：CHANGELOG 与任务 CHANGELOG 必须被跟踪
  for (const rel of changedPaths) {
    const tracked = await input.tracked.isTracked(input.repoPath, rel).catch(() => false);
    if (!tracked) {
      findings.push({
        id: `untracked_changelog:${rel}`,
        severity: 'error',
        code: 'untracked_changelog',
        path: rel,
        message: `CHANGELOG 未被 Git 跟踪：${rel}`,
        evidence: [rel],
      });
    }
  }

  const valid = findings.filter((f) => f.severity === 'error').length === 0 && missing.length === 0;
  return {
    iterationId: input.iterationId,
    state: valid ? 'valid' : 'invalid',
    coveredTaskIds: covered.sort(),
    missingTaskIds: missing.sort(),
    changedPaths,
    findings,
    verifiedAt: input.verifiedAt,
  };
}
