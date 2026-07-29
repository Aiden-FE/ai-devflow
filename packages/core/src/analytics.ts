import type { FailureKind } from './provider.js';

export interface TokenUsage {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  total: number | null;
}

export const EMPTY_TOKEN_USAGE: TokenUsage = {
  input: null,
  output: null,
  cacheRead: null,
  cacheWrite: null,
  total: null,
};

export type ProviderCallStatus = 'running' | 'succeeded' | 'failed' | 'canceled' | 'interrupted';
export type TerminalProviderCallStatus = Exclude<ProviderCallStatus, 'running'>;
export type ProviderCallSource =
  | 'task_agent'
  | 'review_agent'
  | 'knowledge_agent'
  | 'requirement_chat'
  | 'task_chat'
  | 'requirement_proposal'
  | 'task_proposal'
  | 'ux_consultation'
  | 'connection_test';

export interface ProviderCallStart {
  logicalRequestId: string;
  providerId: string;
  providerName: string;
  routeId: string;
  model: string | null;
  workload: string;
  source: ProviderCallSource;
  attemptOrdinal: number;
  startedAt: number;
  executionId?: string;
  taskId?: string;
  projectId?: string;
}

export interface ProviderCallFinish {
  status: TerminalProviderCallStatus;
  endedAt: number;
  failureKind?: FailureKind;
  usage: TokenUsage;
}

export interface ProviderCallRecord extends ProviderCallStart {
  id: string;
  status: ProviderCallStatus;
  endedAt?: number;
  durationMs?: number;
  failureKind?: FailureKind;
  usage: TokenUsage;
}

export interface UsageFilters {
  startAt: number;
  endAt: number;
  projectId?: string;
  providerId?: string;
  model?: string;
  workload?: string;
  source?: ProviderCallSource;
  status?: ProviderCallStatus;
}

export interface UsageMetric {
  providerCalls: number;
  logicalRequests: number;
  succeeded: number;
  failed: number;
  canceled: number;
  interrupted: number;
  averageDurationMs: number | null;
  tokens: TokenUsage;
  tokenKnownCalls: number;
  tokenCoverage: number;
}

export interface UsageBreakdown extends UsageMetric {
  key: string;
  label: string;
  latestFailure?: string;
}

export interface UsageTimeBucket extends UsageMetric {
  day: string;
}

export interface UsageFailure {
  id: string;
  providerId: string;
  providerName: string;
  model: string | null;
  failureKind: string;
  startedAt: number;
}

export interface UsageAnalytics {
  filters: UsageFilters;
  summary: UsageMetric;
  timeBuckets: UsageTimeBucket[];
  providers: UsageBreakdown[];
  models: UsageBreakdown[];
  projects: UsageBreakdown[];
  workloads: UsageBreakdown[];
  sources: UsageBreakdown[];
  failures: UsageBreakdown[];
  latestFailures: UsageFailure[];
}

export interface RetentionPolicy {
  executionDetailDays: number;
  archivedConversationDays: number;
  providerRawDays: number;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  executionDetailDays: 90,
  archivedConversationDays: 180,
  providerRawDays: 365,
};
