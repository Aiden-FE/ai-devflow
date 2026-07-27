export { Orchestrator, type OrchestratorOptions, type TaskEvent } from './orchestrator.js';
export {
  createWorktree,
  removeWorktree,
  listWorktrees,
  isGitRepo,
  currentBranch,
  sprintBranchName,
  sanitizeBranchSegment,
  ensureSprintBranch,
  mergeBranchInto,
  mergeWorktreeBranch,
  branchExists,
  WorktreeError,
  type WorktreeHandle,
} from './worktree.js';
export { Semaphore } from './semaphore.js';
