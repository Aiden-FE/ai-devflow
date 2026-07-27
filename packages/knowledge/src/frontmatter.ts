// 知识 Markdown 解析：仅 frontmatter 边界用字符串定位，YAML 语义全部交给 yaml.parseDocument。
import { parseDocument } from 'yaml';
import { isKnowledgeFrontmatter, type KnowledgeFrontmatter } from '@ai-devflow/core';

export interface ParsedKnowledgeMarkdown {
  frontmatter: KnowledgeFrontmatter;
  title: string;
  summary: string;
  body: string;
}

/** 解析知识文档 Markdown：校验 frontmatter、H1 标题与摘要。 */
export function parseKnowledgeMarkdown(path: string, markdown: string): ParsedKnowledgeMarkdown {
  if (!markdown.startsWith('---\n')) throw new Error(`${path}: missing YAML frontmatter`);
  const close = markdown.indexOf('\n---\n', 4);
  if (close < 0) throw new Error(`${path}: unterminated YAML frontmatter`);
  const yaml = markdown.slice(4, close);
  const doc = parseDocument(yaml, { prettyErrors: true, uniqueKeys: true });
  if (doc.errors.length > 0) throw new Error(`${path}: ${doc.errors[0]!.message}`);
  const value = doc.toJS({ mapAsMap: false });
  if (!isKnowledgeFrontmatter(value)) throw new Error(`${path}: invalid knowledge metadata`);
  const body = markdown.slice(close + 5).trim();
  const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? '';
  if (!title) throw new Error(`${path}: missing H1 title`);
  const summary =
    body
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('#')) ?? '';
  return { frontmatter: value, title, summary, body };
}
