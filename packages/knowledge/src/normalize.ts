import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { parseDocument } from 'yaml';

const KNOWLEDGE_ROOT = 'docs/knowledge';

function normalizedSourcePath(source: string): string {
  if (source.trim() !== source || source.includes('\0') || source.includes('\\')) return source;
  if (/^[A-Za-z]:\//.test(source) || source.startsWith('/')) return source;
  const candidate = source.replace(/\/+$/, '');
  if (!candidate || candidate === source) return source;
  if (candidate.split('/').some((segment) => segment === '..' || segment === '.' || segment.length === 0)) {
    return source;
  }
  return candidate;
}

function normalizeMarkdown(content: string): string | undefined {
  if (!content.startsWith('---\n')) return undefined;
  const close = content.indexOf('\n---\n', 4);
  if (close < 0) return undefined;
  const document = parseDocument(content.slice(4, close), { prettyErrors: true, uniqueKeys: true });
  if (document.errors.length > 0) return undefined;
  const value = document.toJS({ mapAsMap: false }) as Record<string, unknown> | null;
  if (!value || typeof value !== 'object') return undefined;

  let changed = false;
  if (value.type === 'adr' && value.status === 'accepted') {
    document.set('status', 'active');
    changed = true;
  }
  if (Array.isArray(value.sources)) {
    value.sources.forEach((source, index) => {
      if (typeof source !== 'string') return;
      const normalized = normalizedSourcePath(source);
      if (normalized !== source) {
        document.setIn(['sources', index], normalized);
        changed = true;
      }
    });
  }
  if (!changed) return undefined;
  return `---\n${document.toString().trimEnd()}\n---\n${content.slice(close + 5)}`;
}

async function markdownFiles(repoPath: string): Promise<string[]> {
  const root = join(repoPath, KNOWLEDGE_ROOT);
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile() && entry.name.endsWith('.md')) files.push(absolute);
    }
  }
  await walk(root);
  return files.sort();
}

/** Apply narrow, deterministic repairs for known Agent metadata aliases. */
export async function normalizeKnowledgeDraftMetadata(repoPath: string): Promise<{ changed: string[] }> {
  const changed: string[] = [];
  for (const absolute of await markdownFiles(repoPath)) {
    const content = await readFile(absolute, 'utf8');
    const normalized = normalizeMarkdown(content);
    if (normalized === undefined || normalized === content) continue;
    await writeFile(absolute, normalized, 'utf8');
    changed.push(relative(repoPath, absolute).split(sep).join('/'));
  }
  return { changed };
}
