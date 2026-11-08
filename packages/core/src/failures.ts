import { ConflictError, NotFoundError, UnavailableError } from "./errors.js";
import { DefaultLayerError, DefaultPartitionError, ValidationError, LimitError } from "./errors.js";

export type DatabaseFailureKind = "database_content" | "transient" | "unknown";
export type DatabaseConstraint = "unique" | "foreign_key" | "other";
export interface DatabaseFailure {
  kind: DatabaseFailureKind;
  constraint: DatabaseConstraint;
}
const classifications = new WeakMap<Error, DatabaseFailureKind>();

export function databaseFailureKind(error: unknown): DatabaseFailureKind {
  return error instanceof Error ? (classifications.get(error) ?? "unknown") : "unknown";
}
export function isDomainError(error: unknown): error is Error {
  return (
    error instanceof ValidationError ||
    error instanceof NotFoundError ||
    error instanceof ConflictError ||
    error instanceof DefaultLayerError ||
    error instanceof DefaultPartitionError ||
    error instanceof LimitError ||
    error instanceof UnavailableError
  );
}

/** Call after rollback. Classification comes from driver codes, never UI messages. */
export function normalizeDatabaseFailure(
  cause: unknown,
  failure: DatabaseFailure,
  rollbackFailure?: { cause: unknown },
): Error {
  if (!rollbackFailure && isDomainError(cause)) return cause;
  let error: Error;
  if (rollbackFailure) {
    error = new UnavailableError("Database connection is unavailable", {
      cause: new AggregateError(
        [cause, rollbackFailure.cause],
        "Database operation and rollback failed",
      ),
    });
  } else if (failure.constraint === "unique") {
    error = new ConflictError("That record already exists", { cause });
  } else if (failure.constraint === "foreign_key") {
    error = new NotFoundError("A referenced record");
    Object.defineProperty(error, "cause", { value: cause, configurable: true });
  } else {
    error = new UnavailableError("Database operation failed", { cause });
  }
  classifications.set(error, rollbackFailure ? "unknown" : failure.kind);
  return error;
}
