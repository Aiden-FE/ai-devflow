import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from '../lib/unified-diff.js';

const MULTI_FILE_DIFF = `diff --git a/knowledges/context/project.md b/knowledges/context/project.md
index 1111111..2222222 100644
--- a/knowledges/context/project.md
+++ b/knowledges/context/project.md
@@ -1,3 +1,4 @@
 # Project
-Old summary
+Current summary
 Stable line
+New detail
diff --git a/knowledges/runbook/setup.md b/knowledges/runbook/setup.md
new file mode 100644
--- /dev/null
+++ b/knowledges/runbook/setup.md
@@ -0,0 +1,2 @@
+# Setup
+Run pnpm install
\\ No newline at end of file`;

describe('parseUnifiedDiff', () => {
  it('parses files, statuses, counts, hunks, and line numbers', () => {
    const files = parseUnifiedDiff(MULTI_FILE_DIFF);

    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({
      path: 'knowledges/context/project.md',
      oldPath: 'knowledges/context/project.md',
      newPath: 'knowledges/context/project.md',
      status: 'modified',
      additions: 2,
      deletions: 1,
    });
    expect(files[0].hunks[0].lines).toEqual([
      { kind: 'context', text: '# Project', oldLine: 1, newLine: 1 },
      { kind: 'deletion', text: 'Old summary', oldLine: 2 },
      { kind: 'addition', text: 'Current summary', newLine: 2 },
      { kind: 'context', text: 'Stable line', oldLine: 3, newLine: 3 },
      { kind: 'addition', text: 'New detail', newLine: 4 },
    ]);
    expect(files[1]).toMatchObject({
      path: 'knowledges/runbook/setup.md',
      status: 'added',
      additions: 2,
      deletions: 0,
    });
    expect(files[1].hunks[0].lines.at(-1)).toEqual({
      kind: 'meta',
      text: '\\ No newline at end of file',
    });
  });

  it('recognizes deleted and renamed files without requiring hunks', () => {
    const files = parseUnifiedDiff(`diff --git a/old.md b/old.md
deleted file mode 100644
--- a/old.md
+++ /dev/null
diff --git a/before.md b/after.md
similarity index 100%
rename from before.md
rename to after.md`);

    expect(files).toEqual([
      expect.objectContaining({ path: 'old.md', status: 'deleted' }),
      expect.objectContaining({ path: 'after.md', oldPath: 'before.md', newPath: 'after.md', status: 'renamed' }),
    ]);
  });

  it('decodes Git-quoted UTF-8 paths', () => {
    const files = parseUnifiedDiff(`diff --git "a/knowledges/\\344\\270\\255\\346\\226\\207.md" "b/knowledges/\\344\\270\\255\\346\\226\\207.md"
--- "a/knowledges/\\344\\270\\255\\346\\226\\207.md"
+++ "b/knowledges/\\344\\270\\255\\346\\226\\207.md"
@@ -1 +1 @@
-old
+new`);

    expect(files[0].path).toBe('knowledges/中文.md');
  });

  it('returns an empty list for missing or invalid input', () => {
    expect(parseUnifiedDiff()).toEqual([]);
    expect(parseUnifiedDiff('not a unified diff')).toEqual([]);
  });
});
