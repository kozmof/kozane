export { migrations, schemaVersion } from "./generated/migrations.js";
export { validateMigrationHistory } from "./migrations/history.js";
export { MigrationHistoryError, type MigrationHistoryFailure } from "./migrations/errors.js";
export type {
  MigrationApplicationResult,
  MigrationRecord,
  MigrationHistoryRow,
  MigrationHistoryMode,
  MigrationHistoryValidation,
} from "./migration-types.js";

export { applyMigrations, validateDatabaseMigrationHistory } from "./migrations/apply.js";
