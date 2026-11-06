import { ValidationError } from "../../../../src/services/errors.js";
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
