// 知识目录加载：扫描 docs/knowledge，解析所有 Markdown 为稳定 ID 引用。
import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { KnowledgeDocumentRef, KnowledgeFinding } from '@ai-devflow/core';
import { parseKnowledgeMarkdown } from './frontmatter.js';

export interface KnowledgeCatalog {
  initialized: boolean;
  documents: Map<string, KnowledgeDocumentRef>;
  findings: KnowledgeFinding[];
}

export interface LoadedCatalog {
  refs: KnowledgeDocumentRef[];
  errors: KnowledgeFinding[];
}

const KNOWLEDGE_ROOT = 'docs/knowledge';

async function walkMarkdown(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        out.push(abs);
      }
    }
  }
  try {
    await stat(join(root, KNOWLEDGE_ROOT));
  } catch {
    return out;
  }
  await walk(join(root, KNOWLEDGE_ROOT));
  return out;
}

/** 加载所有知识文档引用（含重复 ID）与解析错误。 */
export async function loadAllDocuments(repoPath: string): Promise<LoadedCatalog> {
  const files = await walkMarkdown(repoPath);
  const refs: KnowledgeDocumentRef[] = [];
  const errors: KnowledgeFinding[] = [];
  const { readFile } = await import('node:fs/promises');
  for (const abs of files) {
    const rel = relative(repoPath, abs).split(sep).join('/');
    let content: string;
    try {
      content = await readFile(abs, 'utf8');
    } catch {
      errors.push(finding('invalid_frontmatter', rel, undefined, `无法读取文件：${rel}`, []));
      continue;
    }
    try {
      const parsed = parseKnowledgeMarkdown(rel, content);
      refs.push({
        ...parsed.frontmatter,
        title: parsed.title,
        summary: parsed.summary,
        path: rel,
      });
    } catch (err) {
      errors.push(
        finding('invalid_frontmatter', rel, undefined, (err as Error).message, [rel]),
      );
    }
  }
  return { refs, errors };
}

function finding(
  code: string,
  path: string | undefined,
  knowledgeId: string | undefined,
  message: string,
  evidence: string[],
  severity: 'info' | 'warn' | 'error' = 'error',
): KnowledgeFinding {
  return {
    id: `${code}:${path ?? knowledgeId ?? Math.random().toString(36).slice(2)}`,
    severity,
    code,
    path,
    knowledgeId,
    message,
    evidence,
  };
}

/** 加载知识目录：documents 以稳定 ID 为键（首现优先），findings 仅含解析错误。 */
export async function loadKnowledgeCatalog(repoPath: string): Promise<KnowledgeCatalog> {
  const { refs, errors } = await loadAllDocuments(repoPath);
  const documents = new Map<string, KnowledgeDocumentRef>();
  for (const ref of refs) {
    if (!documents.has(ref.id)) {
      documents.set(ref.id, ref);
    }
  }
  let initialized = false;
  try {
    await stat(join(repoPath, KNOWLEDGE_ROOT, 'index.md'));
    initialized = true;
  } catch {
    initialized = false;
  }
  return { initialized, documents, findings: errors };
}
