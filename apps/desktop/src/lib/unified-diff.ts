export type DiffFileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface DiffLine {
  kind: 'context' | 'addition' | 'deletion' | 'meta';
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface DiffFile {
  oldPath: string;
  newPath: string;
  path: string;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

interface MutableDiffFile extends DiffFile {
  sawDiffHeader: boolean;
}

function decodeGitQuotedPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  const bytes: number[] = [];
  const content = value.slice(1, -1);
  const escapes: Record<string, number> = {
    a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92,
  };
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (character === '\\') {
      const octal = /^[0-7]{1,3}/.exec(content.slice(index + 1));
      if (octal) {
        bytes.push(Number.parseInt(octal[0], 8));
        index += octal[0].length;
        continue;
      }
      const escaped = content[index + 1];
      if (escaped !== undefined) {
        bytes.push(escapes[escaped] ?? escaped.charCodeAt(0));
        index += 1;
        continue;
      }
    }
    bytes.push(...new TextEncoder().encode(character));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function normalizePath(value: string): string {
  const withoutTimestamp = value.split('\t', 1)[0];
  if (withoutTimestamp === '/dev/null') return withoutTimestamp;
  return decodeGitQuotedPath(withoutTimestamp).replace(/^[ab]\//, '');
}

function quotedToken(value: string, start: number): [string, number] {
  let index = start + 1;
  while (index < value.length) {
    if (value[index] === '\\') index += 2;
    else if (value[index] === '"') return [value.slice(start, index + 1), index + 1];
    else index += 1;
  }
  return [value.slice(start), value.length];
}

function pathsFromDiffHeader(line: string): [string, string] {
  const value = line.slice('diff --git '.length);
  if (value.startsWith('"')) {
    const [oldPath, nextIndex] = quotedToken(value, 0);
    const newStart = value.indexOf('"', nextIndex);
    if (newStart < 0) return ['', ''];
    const [newPath] = quotedToken(value, newStart);
    return [normalizePath(oldPath), normalizePath(newPath)];
  }
  const separator = value.indexOf(' b/');
  if (!value.startsWith('a/') || separator < 0) return ['', ''];
  return [normalizePath(value.slice(0, separator)), normalizePath(value.slice(separator + 1))];
}

function createFile(oldPath = '', newPath = '', sawDiffHeader = false): MutableDiffFile {
  return {
    oldPath,
    newPath,
    path: newPath || oldPath,
    status: 'modified',
    additions: 0,
    deletions: 0,
    hunks: [],
    sawDiffHeader,
  };
}

function finalizeFile(file: MutableDiffFile): DiffFile {
  const oldPath = file.oldPath === '/dev/null' ? '' : file.oldPath;
  const newPath = file.newPath === '/dev/null' ? '' : file.newPath;
  const status = !oldPath
    ? 'added'
    : !newPath
      ? 'deleted'
      : file.status;
  return {
    oldPath,
    newPath,
    path: status === 'deleted' ? oldPath : newPath || oldPath,
    status,
    additions: file.additions,
    deletions: file.deletions,
    hunks: file.hunks,
  };
}

/** Parse the subset of Git unified-diff syntax needed by the draft reviewer. */
export function parseUnifiedDiff(input?: string): DiffFile[] {
  if (!input) return [];

  const files: DiffFile[] = [];
  let file: MutableDiffFile | undefined;
  let hunk: DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;

  const pushFile = () => {
    if (file?.sawDiffHeader) files.push(finalizeFile(file));
  };

  for (const line of input.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('diff --git ')) {
      pushFile();
      const [oldPath, newPath] = pathsFromDiffHeader(line);
      file = createFile(oldPath, newPath, true);
      hunk = undefined;
      continue;
    }
    if (!file) continue;

    if (line.startsWith('new file mode ')) {
      file.status = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode ')) {
      file.status = 'deleted';
      continue;
    }
    if (line.startsWith('rename from ')) {
      file.status = 'renamed';
      file.oldPath = normalizePath(line.slice('rename from '.length));
      continue;
    }
    if (line.startsWith('rename to ')) {
      file.status = 'renamed';
      file.newPath = normalizePath(line.slice('rename to '.length));
      continue;
    }
    if (line.startsWith('--- ')) {
      file.oldPath = normalizePath(line.slice(4));
      continue;
    }
    if (line.startsWith('+++ ')) {
      file.newPath = normalizePath(line.slice(4));
      continue;
    }

    const hunkMatch = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunkMatch) {
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[2]);
      hunk = { header: line, oldStart: oldLine, newStart: newLine, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;

    if (line.startsWith('\\')) {
      hunk.lines.push({ kind: 'meta', text: line });
    } else if (line.startsWith('+')) {
      hunk.lines.push({ kind: 'addition', text: line.slice(1), newLine });
      file.additions += 1;
      newLine += 1;
    } else if (line.startsWith('-')) {
      hunk.lines.push({ kind: 'deletion', text: line.slice(1), oldLine });
      file.deletions += 1;
      oldLine += 1;
    } else if (line.startsWith(' ')) {
      hunk.lines.push({ kind: 'context', text: line.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }
  pushFile();
  return files;
}
