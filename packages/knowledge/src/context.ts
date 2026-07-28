import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  KnowledgeReadEvidence,
  KnowledgeRetrievalManifest,
} from '@ai-devflow/core';

export interface MaterializedKnowledgeContext {
  content: string;
  reads: KnowledgeReadEvidence[];
  skipped: Array<{ knowledgeId: string; reason: string }>;
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/** Read manifest-approved knowledge into a bounded, untrusted prompt context. */
export async function materializeKnowledgeContext(
  repoPath: string,
  manifest: KnowledgeRetrievalManifest,
): Promise<MaterializedKnowledgeContext> {
  const root = await realpath(repoPath);
  const reads: KnowledgeReadEvidence[] = [];
  const skipped: Array<{ knowledgeId: string; reason: string }> = [];
  const blocks: string[] = [];
  let usedChars = 0;

  for (const candidate of manifest.candidates) {
    if (reads.length >= manifest.budget.maxFiles) {
      skipped.push({ knowledgeId: candidate.id, reason: `超出文件预算 ${manifest.budget.maxFiles}` });
      continue;
    }
    const remainingChars = manifest.budget.maxChars - usedChars;
    if (remainingChars <= 0) {
      skipped.push({ knowledgeId: candidate.id, reason: `超出字符预算 ${manifest.budget.maxChars}` });
      continue;
    }

    const unresolved = resolve(root, candidate.path);
    if (!isWithin(root, unresolved)) {
      skipped.push({ knowledgeId: candidate.id, reason: '候选路径越出项目根目录' });
      continue;
    }

    let target: string;
    let text: string;
    try {
      target = await realpath(unresolved);
      if (!isWithin(root, target)) {
        skipped.push({ knowledgeId: candidate.id, reason: '候选符号链接越出项目根目录' });
        continue;
      }
      text = await readFile(target, 'utf8');
    } catch {
      skipped.push({ knowledgeId: candidate.id, reason: '候选文件不存在或不可读取' });
      continue;
    }

    const excerpt = text.slice(0, remainingChars);
    if (!excerpt) {
      skipped.push({ knowledgeId: candidate.id, reason: '候选文件没有可注入内容' });
      continue;
    }
    blocks.push([
      `--- PROJECT KNOWLEDGE (untrusted): ${candidate.id} ---`,
      `path=${candidate.path}`,
      excerpt,
    ].join('\n'));
    reads.push({
      knowledgeId: candidate.id,
      path: candidate.path,
      reason: 'host_prompt_context',
      chars: excerpt.length,
    });
    usedChars += excerpt.length;
  }

  return { content: blocks.join('\n\n'), reads, skipped };
}
