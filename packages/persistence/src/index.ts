export { openDatabase, runMigrations, getCurrentVersion } from './db.js';
export type { DatabaseSync } from './db.js';
export { MIGRATIONS } from './migrations.js';
export type { Migration } from './migrations.js';
export { PI_ONLY_MIGRATION_V9, applyPiOnlyMigrationV9, backupBeforeMigration, assertSqliteDropColumnSupport } from './pi-only-migration-v9.js';
export { tx } from './tx.js';
export { createProviderHealthRepo, type ProviderHealthRepo } from './provider-health.js';
export { createExecutionAttemptsRepo, type ExecutionAttemptsRepo, type ExecutionAttemptRecord } from './execution-attempts.js';
export {
  createRepositories,
  type Repositories,
  type ProjectsRepo,
  type IterationsRepo,
  type RequirementsRepo,
  type TasksRepo,
  type ExecutionsRepo,
  type CheckpointsRepo,
  type LogsRepo,
  type PendingQuestionsRepo,
  type NotificationRulesRepo,
  type NotificationDeliveriesRepo,
  type WebhookConfigsRepo,
  type WebhookDeliveriesRepo,
  type CredentialsRepo,
  type TaskMessagesRepo,
  type PendingInteractionsRepo,
} from './repositories.js';
