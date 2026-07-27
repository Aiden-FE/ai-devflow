import { mkdtemp, mkdir, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';

const created: string[] = [];

afterEach(async () => {
  for (const dir of created.splice(0)) {
    await rmrf(dir).catch(() => undefined);
  }
});

async function rmrf(target: string): Promise<void> {
  const { rm } = await import('node:fs/promises');
  await rm(target, { recursive: true, force: true });
}

/** 创建空临时仓库目录。 */
export async function emptyFixtureRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kb-'));
  created.push(dir);
  return dir;
}

/** 创建临时仓库并按相对路径写入文件（自动创建子目录）。 */
export async function fixtureRepo(files: Record<string, string>): Promise<string> {
  const repo = await emptyFixtureRepo();
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(repo, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
  return repo;
}

/** 排序后的相对文件列表（仅文件，不含目录）。 */
export async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else {
        out.push(abs.slice(root.length + 1).split(/[\\/]/).join('/'));
      }
    }
  }
  await walk(root);
  return out.sort();
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 生成一份最小合法知识文档 Markdown。 */
export function document(input: {
  id: string;
  type?: string;
  status?: string;
  owner?: string;
  updated?: string;
  confidence?: number;
  sources?: string[];
  related: string[];
  title?: string;
  summary?: string;
}): string {
  const type = input.type ?? input.id.split(':')[0] ?? 'feature';
  const sources = input.sources ?? ['packages/core/src/types.ts'];
  const sourcesYaml = sources.length > 0
    ? `sources:\n${sources.map((s) => `  - ${JSON.stringify(s)}`).join('\n')}`
    : 'sources: []';
  const relatedYaml = input.related.length > 0
    ? `related:\n${input.related.map((r) => `  - ${JSON.stringify(r)}`).join('\n')}`
    : 'related: []';
  return `---
id: ${input.id}
type: ${type}
status: ${input.status ?? 'active'}
owner: ${input.owner ?? 'project'}
updated: ${input.updated ?? '2026-07-27'}
confidence: ${input.confidence ?? 0.8}
${sourcesYaml}
${relatedYaml}
---

# ${input.title ?? input.id}

${input.summary ?? 'A knowledge document.'}
`;
}

export const ROOT_INDEX = `---
id: context:root
type: context
status: active
owner: project
updated: 2026-07-27
confidence: 0.9
sources: []
related: []
---

# Project Knowledge

Root knowledge index.
`;

export const FEATURE_INDEX = `---
id: feature:index
type: feature
status: active
owner: project
updated: 2026-07-27
confidence: 0.9
sources: []
related: []
---

# Feature Knowledge

Feature index.
`;
