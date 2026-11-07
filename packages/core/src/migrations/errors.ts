import { ValidationError } from "../errors.js";
export type MigrationHistoryFailure =
  | "invalid"
  | "duplicate"
  | "gap"
  | "unknown"
  | "mismatch"
  | "pending";
export class MigrationHistoryError extends ValidationError {
  override readonly name = "MigrationHistoryError";
  constructor(
    readonly reason: MigrationHistoryFailure,
    message: string,
  ) {
    super(message);
    Object.freeze(this);
  }
}

import type { SchemaComparison } from "../schema-types.js";
export class SchemaMismatchError extends ValidationError {
  override readonly name = "SchemaMismatchError";
  readonly reason = "schema_mismatch";
  constructor(readonly comparison: SchemaComparison) {
    super("Database schema does not match the required schema");
    Object.freeze(this);
  }
}
