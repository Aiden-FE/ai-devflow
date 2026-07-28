# Project-Grounded AI Creation Design

## Goal

Make both AI requirement creation and AI task creation reason from the selected project's knowledge base and its current repository state, while preserving complete multi-turn conversations.

## Scope

- `requirement_refiner` and `task_proposer` both run from the selected project root.
- Both agents receive the same read-only repository exploration tools: `read`, `grep`, `find`, and `ls`.
- Both agents receive bounded project knowledge content selected by the existing knowledge retrieval planner.
- The `ai_devflow_ask` tool remains general-purpose. This change does not add content restrictions or host-side relevance validation to questions.
- Existing structured proposal tools and user confirmation gates remain unchanged.

## Context Data Flow

1. The renderer sends `projectPath`, conversation messages, and any requirement/task-specific context to the main process.
2. The main process resolves `projectPath` to a registered project and asks `KnowledgeCoordinator` for a retrieval manifest.
3. The host safely materializes the manifest's candidate documents into bounded excerpts:
   - paths must resolve inside the registered project root;
   - only manifest candidates may be read;
   - total files and characters must remain within the manifest budget;
   - successful reads produce `KnowledgeReadEvidence` for retrieval completion.
4. The AI service prepends one project-context message containing manifest metadata and the bounded excerpts, then retains every original conversation message in its original order.
5. The step agent may use read-only tools from the project root to verify current implementation details that are missing, stale, or ambiguous in the knowledge base.
6. The retrieval record is completed with actual host read evidence instead of an empty read list.

When the knowledge base is not initialized or has no relevant candidates, the context explicitly reports that state and the agents can still inspect the repository directly.

## Agent Behavior

### Requirement Creation

`requirement_refiner` first reviews injected project knowledge, then explores relevant project documentation, configuration, interfaces, and source code as needed. It uses those findings together with the user's product intent to refine a requirement and produce the existing structured requirement proposal.

The agent remains read-only and cannot modify project files. Product clarification and UX consultation behavior remain available.

### Task Creation

`task_proposer` continues to receive the current requirement, acceptance criteria, and existing sibling tasks. It also consumes injected knowledge excerpts and inspects the current repository before proposing an implementation breakdown.

The agent remains read-only and produces tasks only through the existing structured task proposal tool.

## Conversation Handling

Additional context must not replace conversation history. The AI service constructs prompts as:

1. one leading user message containing clearly delimited host project context;
2. all original user and assistant messages, unchanged and in order.

This preserves earlier questions, answers, and decisions across every turn.

## Safety And Failure Handling

- Reject knowledge paths that escape the project root, including traversal and absolute-path mismatches.
- Treat unreadable or missing candidate files as skipped evidence and continue with remaining candidates.
- Never inject credentials or files outside manifest candidates.
- Keep repository tools read-only for both step agents.
- If knowledge preparation fails, report the AI request error through the existing stream error path rather than silently claiming grounded context.

## Tests

- AI service test proving context is prepended without dropping any conversation message.
- Step profile tests proving both creation agents expose the same read-only exploration tools.
- IPC or knowledge-context tests proving candidate document content, not only paths, reaches requirement and task requests.
- Tests for path containment, character/file budgets, missing files, and read evidence persistence.
- Regression tests for knowledge-not-initialized behavior, where repository exploration remains available.

## Non-Goals

- No restrictions on the wording, grouping, or subject matter of `ai_devflow_ask` questions.
- No write-capable tools for either creation agent.
- No changes to proposal schemas, task dependency semantics, or UI confirmation flows.
