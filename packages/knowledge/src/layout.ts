// 幂等的知识库与迭代文档目录骨架生成。
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { KNOWLEDGE_TYPES } from '@ai-devflow/core';

/** 一次初始化调用创建的与已存在的文件相对路径集合。 */
export interface LayoutChangeSet {
  created: string[];
  existing: string[];
}

/** 路径段归一化：仅允许 ASCII 字母、数字、.、_、-；拒绝空串与路径分隔符。 */
export function sanitizePathSegment(name: string, field: string): string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`${field} 不能为空`);
  }
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new Error(`${field} 含非法路径分隔符：${name}`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`${field} 含非法字符：${name}`);
  }
  return name;
}

async function ensureFile(
  repoPath: string,
  rel: string,
  content: string,
  set: LayoutChangeSet,
): Promise<void> {
  const abs = join(repoPath, rel);
  const dir = join(abs, '..');
  await mkdir(dir, { recursive: true });
  try {
    await access(abs);
    set.existing.push(rel);
    return;
  } catch {
    // 不存在则创建
  }
  await writeFile(abs, content, 'utf8');
  set.created.push(rel);
}

function rootIndexContent(date: string): string {
  return `---
id: context:root
type: context
status: active
owner: project
updated: ${date}
confidence: 0.9
sources: []
related:
  - context:index
  - adr:index
  - feature:index
  - runbook:index
  - product:index
  - ux:index
---

# Project Knowledge

项目知识库根索引。六类知识：context、adr、feature、runbook、product、ux。
`;
}

const TYPE_LABELS: Record<string, string> = {
  context: 'Context',
  adr: 'ADR',
  feature: 'Feature',
  runbook: 'Runbook',
  product: 'Product',
  ux: 'UX',
};

function categoryIndexContent(type: string, date: string): string {
  const title = TYPE_LABELS[type] ?? type;
  return `---
id: ${type}:index
type: ${type}
status: active
owner: project
updated: ${date}
confidence: 0.9
sources: []
related: []
---

# ${title} Knowledge

${type} 知识索引。
`;
}

/** 初始化 docs/knowledge 根索引与六类分类索引（幂等，不覆盖已有文件）。 */
export async function initializeKnowledgeLayout(input: {
  repoPath: string;
  date: string;
}): Promise<LayoutChangeSet> {
  const set: LayoutChangeSet = { created: [], existing: [] };
  await ensureFile(input.repoPath, 'docs/knowledge/index.md', rootIndexContent(input.date), set);
  for (const type of KNOWLEDGE_TYPES) {
    await ensureFile(
      input.repoPath,
      `docs/knowledge/${type}/index.md`,
      categoryIndexContent(type, input.date),
      set,
    );
  }
  return set;
}

/** 初始化迭代文档目录（index.md 与 CHANGELOG.md，幂等）。 */
export async function initializeIterationLayout(input: {
  repoPath: string;
  version: string;
  iterationId: string;
  date: string;
}): Promise<LayoutChangeSet> {
  const versionSeg = sanitizePathSegment(input.version, 'version');
  const base = `docs/iterations/${versionSeg}`;
  const set: LayoutChangeSet = { created: [], existing: [] };
  await ensureFile(
    input.repoPath,
    `${base}/index.md`,
    `# Iteration ${input.iterationId}\n\n迭代文档入口。\n`,
    set,
  );
  await ensureFile(
    input.repoPath,
    `${base}/CHANGELOG.md`,
    `# Changelog\n\n迭代变更记录。\n`,
    set,
  );
  return set;
}

/** 初始化任务文档目录与任务级 index.md（幂等）。 */
export async function initializeTaskLayout(input: {
  repoPath: string;
  version: string;
  taskId: string;
  title: string;
  date: string;
}): Promise<LayoutChangeSet> {
  const versionSeg = sanitizePathSegment(input.version, 'version');
  const taskSeg = sanitizePathSegment(input.taskId, 'taskId');
  const base = `docs/iterations/${versionSeg}/tasks/${taskSeg}`;
  const set: LayoutChangeSet = { created: [], existing: [] };
  await ensureFile(
    input.repoPath,
    `${base}/index.md`,
    `# ${input.title}\n\n任务文档索引。\n`,
    set,
  );
  return set;
}
