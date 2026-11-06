export { migrations, schemaVersion } from "./generated/migrations.js";
export { validateMigrationHistory } from "./migrations/history.js";
export {
  MigrationHistoryError,
  SchemaMismatchError,
  type MigrationHistoryFailure,
} from "./migrations/errors.js";
export type {
  MigrationApplicationResult,
  MigrationRecord,
  MigrationHistoryRow,
  MigrationHistoryMode,
  MigrationHistoryValidation,
} from "./migration-types.js";

export { applyMigrations, validateDatabaseMigrationHistory } from "./migrations/apply.js";

export { canonicalSchemaManifest } from "./generated/schema-manifest.js";
export { readSchemaManifest, normalizeSchemaSql } from "./migrations/schema-reader.js";
export { compareSchemaManifests, validateDatabaseSchema } from "./migrations/schema.js";
export type * from "./schema-types.js";
