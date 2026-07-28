---
id: context:runtime
type: context
status: active
owner: project
updated: 2026-07-27
confidence: 0.85
sources:
  - AGENTS.md
related: []
---

# Runtime architecture

The runtime uses a single Pi agent runtime. The dev expert is mapped to the `coder` asset directory via EXPERT_ASSETS_DIR. Knowledge documents are Markdown files under docs/knowledge with YAML frontmatter.
