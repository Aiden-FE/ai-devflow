export { Orchestrator, type OrchestratorOptions, type TaskEvent } from './orchestrator.js';
export {
  createWorktree,
  removeWorktree,
  listWorktrees,
  isGitRepo,
  currentBranch,
  resolveProjectDefaultBranch,
  sprintBranchName,
  sanitizeBranchSegment,
  requireCanonicalBranchSegment,
  ensureSprintBranch,
  mergeBranchInto,
  mergeWorktreeBranch,
  branchExists,
  deleteBranch,
  listChangedPaths,
  WorktreeError,
  type WorktreeHandle,
} from './worktree.js';
export { Semaphore } from './semaphore.js';
export { KeyedLock } from './keyed-lock.js';
export {
  KnowledgeCoordinator,
  type KnowledgeCoordinatorOptions,
} from './knowledge-coordinator.js';
