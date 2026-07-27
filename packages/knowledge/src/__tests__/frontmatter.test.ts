import { describe, it, expect } from 'vitest';
import { parseKnowledgeMarkdown } from '../frontmatter.js';

describe('parseKnowledgeMarkdown', () => {
  const valid = `---
id: feature:task-review-gate
type: feature
status: active
owner: project
updated: 2026-07-27
confidence: 0.85
sources:
  - packages/scheduler/src/orchestrator.ts
related:
  - adr:iteration-branching
---

# Task Review Gate

The review transition requires a knowledge assessment.
`;

  it('parses frontmatter, title, summary, and body', () => {
    const parsed = parseKnowledgeMarkdown('docs/knowledge/feature/a.md', valid);
    expect(parsed.frontmatter.id).toBe('feature:task-review-gate');
    expect(parsed.frontmatter.type).toBe('feature');
    expect(parsed.title).toBe('Task Review Gate');
    expect(parsed.summary).toContain('The review transition');
    expect(parsed.body).toContain('# Task Review Gate');
  });

  it('rejects missing frontmatter', () => {
    expect(() => parseKnowledgeMarkdown('a.md', '# No frontmatter')).toThrow(/missing YAML frontmatter/);
  });

  it('rejects unterminated frontmatter', () => {
    expect(() => parseKnowledgeMarkdown('a.md', '---\nid: x\n')).toThrow(/unterminated YAML frontmatter/);
  });

  it('rejects invalid YAML via parseDocument errors', () => {
    expect(() =>
      parseKnowledgeMarkdown(
        'a.md',
        '---\nid: feature:a\n  - broken\n---\n\n# T\n',
      ),
    ).toThrow();
  });

  it('rejects invalid knowledge metadata', () => {
    expect(() =>
      parseKnowledgeMarkdown(
        'a.md',
        '---\nid: feature:a\ntype: feature\nstatus: bogus\nowner: project\nupdated: 2026-07-27\nconfidence: 0.8\nsources: []\nrelated: []\n---\n\n# T\n',
      ),
    ).toThrow(/invalid knowledge metadata/);
  });

  it('rejects missing H1 title', () => {
    expect(() =>
      parseKnowledgeMarkdown(
        'a.md',
        '---\nid: feature:a\ntype: feature\nstatus: active\nowner: project\nupdated: 2026-07-27\nconfidence: 0.8\nsources: []\nrelated: []\n---\n\nbody only\n',
      ),
    ).toThrow(/missing H1 title/);
  });

  it('deduplicates duplicate YAML keys (uniqueKeys)', () => {
    expect(() =>
      parseKnowledgeMarkdown(
        'a.md',
        '---\nid: feature:a\nid: feature:b\ntype: feature\nstatus: active\nowner: project\nupdated: 2026-07-27\nconfidence: 0.8\nsources: []\nrelated: []\n---\n\n# T\n',
      ),
    ).toThrow();
  });
});
