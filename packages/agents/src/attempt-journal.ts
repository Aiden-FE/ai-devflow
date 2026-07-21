// AttemptJournal：单个执行尝试的可恢复状态（设计 §10）。
//
// 记录工具调用生命周期（started/completed/failed/uncertain）、已观察副作用与文件变化，
// 作为跨模型/跨提供商接管的事实输入。文件系统与 Git diff 是最终事实源，前一模型的自然语言
// 声明不作为完成证据；tool_execution_start 后无对应 end 的调用标为 uncertain，接替方必须先
// 检查工作区/进程/测试状态。
export interface AttemptJournalToolCall {
  id: string;
  name: string;
  state: 'started' | 'completed' | 'failed' | 'uncertain';
  summary: string;
}

export interface AttemptJournalFileChange {
  path: string;
  action: 'create' | 'modify' | 'delete';
}

export interface AttemptJournal {
  executionId: string;
  attemptId: string;
  routeId: string;
  /** 是否已观察到文件/命令副作用（决定下一路线接收「原始任务」还是「接管上下文」）。 */
  mutationsObserved: boolean;
  toolCalls: AttemptJournalToolCall[];
  changedFiles: AttemptJournalFileChange[];
  lastCheckpointId?: string;
}

/** 持久化端口（结构化满足 persistence 的 ExecutionAttemptsRepo 窄接口，Task 9 注入）。 */
export interface ExecutionAttemptStore {
  create(value: {
    id: string; executionId: string; ordinal: number; routeId: string;
    state: 'running' | 'succeeded' | 'failed' | 'canceled';
    mutationsObserved: boolean; journalJson: string; startedAt: number;
  }): void;
  updateJournal(id: string, journalJson: string, mutationsObserved: boolean): void;
  finish(id: string, state: 'succeeded' | 'failed' | 'canceled', endedAt: number): void;
}
