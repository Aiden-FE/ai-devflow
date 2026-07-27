// 确定性结构巡检：缺失索引、非法元数据、重复 ID、断链、孤立、非法路径、Git 跟踪。
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  KNOWLEDGE_TYPES,
  type KnowledgeDocumentRef,
  type KnowledgeFinding,
  type KnowledgeHealthSnapshot,
  type KnowledgeSeverity,
} from '@ai-devflow/core';
import { loadAllDocuments } from './catalog.js';

export interface KnowledgeGitProbe {
  isTracked(repoPath: string, relativePath: string): Promise<boolean>;
  isIgnored(repoPath: string, relativePath: string): Promise<boolean>;
}

const SEVERITY_ORDER: Record<KnowledgeSeverity, number> = { error: 0, warn: 1, info: 2 };

let findingCounter = 0;
function makeFinding(
  severity: KnowledgeSeverity,
  code: string,
  message: string,
  opts: { path?: string; knowledgeId?: string; evidence?: string[] } = {},
): KnowledgeFinding {
  findingCounter += 1;
  return {
    id: `${code}-${findingCounter}`,
    severity,
    code,
    path: opts.path,
    knowledgeId: opts.knowledgeId,
    message,
    evidence: opts.evidence ?? [],
  };
}

function isInvalidSourcePath(source: string): boolean {
  return source.includes('..') || source.includes('\0') || /^[A-Za-z]:[\\/]/.test(source) || source.startsWith('/');
}

function sortFindings(findings: KnowledgeFinding[]): KnowledgeFinding[] {
  return [...findings].sort((a, b) => {
    const sev = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (sev !== 0) return sev;
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    const pa = a.path ?? '';
    const pb = b.path ?? '';
    if (pa !== pb) return pa < pb ? -1 : 1;
    const ia = a.knowledgeId ?? '';
    const ib = b.knowledgeId ?? '';
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });
}

export interface AuditInput {
  projectId: string;
  repoPath: string;
  git?: KnowledgeGitProbe;
}

/** 执行结构巡检并返回健康快照。 */
export async function auditKnowledgeLayout(input: AuditInput): Promise<KnowledgeHealthSnapshot> {
  const findings: KnowledgeFinding[] = [];
  const { refs, errors } = await loadAllDocuments(input.repoPath);
  findings.push(...errors);

  // 根索引存在性
  let rootIndexExists = false;
  try {
    await stat(join(input.repoPath, 'docs/knowledge/index.md'));
    rootIndexExists = true;
  } catch {
    findings.push(
      makeFinding('error', 'not_initialized', '知识库未初始化：docs/knowledge/index.md 缺失', {
        path: 'docs/knowledge/index.md',
      }),
    );
  }

  // 根索引文档存在性（context:root）
  const hasRootDoc = refs.some((r) => r.id === 'context:root');
  if (rootIndexExists && !hasRootDoc) {
    findings.push(
      makeFinding('error', 'missing_root_index', '根索引文档缺失或元数据非法（context:root）', {
        path: 'docs/knowledge/index.md',
      }),
    );
  }

  // 分类索引
  for (const type of KNOWLEDGE_TYPES) {
    const hasIndex = refs.some((r) => r.id === `${type}:index`);
    if (!hasIndex) {
      findings.push(
        makeFinding('error', 'missing_category_index', `分类索引缺失：${type}:index`, {
          path: `docs/knowledge/${type}/index.md`,
        }),
      );
    }
  }

  // 重复 ID
  const idCounts = new Map<string, KnowledgeDocumentRef[]>();
  for (const ref of refs) {
    const list = idCounts.get(ref.id) ?? [];
    list.push(ref);
    idCounts.set(ref.id, list);
  }
  for (const [id, list] of idCounts) {
    if (list.length > 1) {
      for (let i = 1; i < list.length; i += 1) {
        findings.push(
          makeFinding('error', 'duplicate_id', `稳定 ID 重复：${id}（出现 ${list.length} 次）`, {
            path: list[i]!.path,
            knowledgeId: id,
            evidence: list.map((r) => r.path),
          }),
        );
      }
    }
  }

  // 断链引用
  const idSet = new Set(refs.map((r) => r.id));
  for (const ref of refs) {
    for (const related of ref.related) {
      if (!idSet.has(related)) {
        findings.push(
          makeFinding('error', 'broken_reference', `引用目标不存在：${related}`, {
            path: ref.path,
            knowledgeId: ref.id,
            evidence: [related],
          }),
        );
      }
    }
  }

  // 孤立文档：非索引文档且未被任何其它文档引用
  const referenced = new Set<string>();
  for (const ref of refs) {
    for (const related of ref.related) referenced.add(related);
  }
  for (const ref of refs) {
    if (ref.id.endsWith(':index') || ref.id === 'context:root') continue;
    if (!referenced.has(ref.id)) {
      findings.push(
        makeFinding('warn', 'orphan_document', `孤立文档未被任何索引引用：${ref.id}`, {
          path: ref.path,
          knowledgeId: ref.id,
        }),
      );
    }
  }

  // 非法来源路径
  for (const ref of refs) {
    for (const source of ref.sources) {
      if (isInvalidSourcePath(source)) {
        findings.push(
          makeFinding('error', 'invalid_source_path', `来源路径非法：${source}`, {
            path: ref.path,
            knowledgeId: ref.id,
            evidence: [source],
          }),
        );
      }
    }
  }

  // Git 跟踪 / 忽略
  if (input.git) {
    for (const ref of refs) {
      const tracked = await input.git.isTracked(input.repoPath, ref.path);
      if (!tracked) {
        findings.push(
          makeFinding('error', 'untracked_markdown', `知识文档未被 Git 跟踪：${ref.path}`, {
            path: ref.path,
            knowledgeId: ref.id,
            evidence: [ref.path],
          }),
        );
      }
      const ignored = await input.git.isIgnored(input.repoPath, ref.path);
      if (ignored) {
        findings.push(
          makeFinding('warn', 'ignored_markdown', `知识文档被 .gitignore 忽略：${ref.path}`, {
            path: ref.path,
            knowledgeId: ref.id,
            evidence: [ref.path],
          }),
        );
      }
    }
  }

  // 计数
  const counts: Record<string, number> = {};
  for (const type of KNOWLEDGE_TYPES) counts[type] = 0;
  for (const ref of refs) {
    counts[ref.type] = (counts[ref.type] ?? 0) + 1;
  }

  const sorted = sortFindings(findings);
  const hasError = sorted.some((f) => f.severity === 'error');
  const hasWarn = sorted.some((f) => f.severity === 'warn');
  const state: KnowledgeHealthSnapshot['state'] = !rootIndexExists
    ? 'not_initialized'
    : hasError
      ? 'blocked'
      : hasWarn
        ? 'warning'
        : 'healthy';

  return {
    projectId: input.projectId,
    state,
    checkedAt: Date.now(),
    counts: counts as Record<(typeof KNOWLEDGE_TYPES)[number], number>,
    findings: sorted,
  };
}
