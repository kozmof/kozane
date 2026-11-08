import { MigrationHistoryError } from "./errors.js";
import { migrations } from "../generated/migrations.js";
import type { MigrationHistoryMode, MigrationHistoryValidation } from "../migration-types.js";
function timestamp(value: unknown): number | undefined {
  if (
    typeof value !== "number" &&
    typeof value !== "bigint" &&
    !(typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value))
  )
    return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}
/** Validate actual database rows in their supplied order. Never sort, apply or repair history. */
export function validateMigrationHistory(
  history: unknown,
  mode: MigrationHistoryMode,
): MigrationHistoryValidation {
  if (mode !== "prefix" && mode !== "complete")
    throw new MigrationHistoryError("invalid", "Migration history mode must be prefix or complete");
  if (!Array.isArray(history))
    throw new MigrationHistoryError("invalid", "Migration history must be an array");
  const seen = new Set<number>();
  for (let index = 0; index < history.length; index++) {
    const row = history[index];
    if (row === null || typeof row !== "object" || typeof row.hash !== "string")
      throw new MigrationHistoryError("invalid", `Invalid migration history row at index ${index}`);
    const when = timestamp(row.created_at);
    if (when === undefined)
      throw new MigrationHistoryError("invalid", `Invalid migration timestamp at index ${index}`);
    if (seen.has(when))
      throw new MigrationHistoryError(
        "duplicate",
        `Duplicate migration history row at index ${index}`,
      );
    seen.add(when);
    const expected = migrations[index];
    if (!expected || !migrations.some((record) => record.when === when))
      throw new MigrationHistoryError("unknown", `Unknown migration history row at index ${index}`);
    if (when !== expected.when)
      throw new MigrationHistoryError(
        "gap",
        `Migration history is not a contiguous ordered prefix at index ${index}`,
      );
    if (row.hash !== expected.hash)
      throw new MigrationHistoryError("mismatch", `Migration hash mismatch at index ${index}`);
  }
  if (mode === "complete" && history.length !== migrations.length)
    throw new MigrationHistoryError("pending", "Migration history has pending migrations");
  return Object.freeze({
    appliedCount: history.length,
    complete: history.length === migrations.length,
    pending: Object.freeze(migrations.slice(history.length)),
  });
}
