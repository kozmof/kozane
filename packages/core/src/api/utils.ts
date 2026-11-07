import { ConflictError, NotFoundError } from "../errors.js";
import { getTableColumns, type Table } from "drizzle-orm";
import { BATCH_MAX, NAME_MAX, chunked } from "../constants/index.js";

/**
 * Derive the column count from the schema. Counting defaulted columns too gives a safe upper
 * bound.
 */
export function columnCount(table: Table): number {
  return Object.keys(getTableColumns(table)).length;
}

/**
 * Shared refusal reasons for card batch operations. Return the reason established inside the
 * transaction so routes can report it without a separate, potentially stale precheck.
 *
 * Each operation narrows this union to its possible failures. `foreign-*` covers both missing
 * rows and rows outside the namespace because callers handle them identically.
 */
export type BatchRejection =
  | "foreign-cards"
  | "foreign-partition"
  | "foreign-layer"
  | "foreign-scope"
  | "foreign-inventory"
  | "missing-namespace"
  | "inventory-full"
  | "stored-cards"
  | "unstored-cards";

/**
 * Failure result restricted to the reasons an operation can return. Constrain the type
 * parameter to {@link BatchRejection} to keep all result types within the shared vocabulary.
 */
export type BatchRefusal<R extends BatchRejection> = { ok: false; reason: R };

/**
 * Batch result with operation-specific refusal reasons and an optional success payload.
 * Require an object payload so intersecting it with `{ ok: true }` preserves a valid success
 * branch.
 */
export type BatchResult<R extends BatchRejection, Ok extends object = Record<never, never>> =
  | ({ ok: true } & Ok)
  | BatchRefusal<R>;

/** Failure result for batch operations that check only card ownership. */
export type CardBatchResult = BatchResult<"foreign-cards">;

/**
 * Read an ID list in bounded batches and concatenate the results. Use {@link BATCH_MAX}
 * because each ID binds one parameter, unlike a multi-column insert.
 *
 * Results follow batch order, with no overall row-order guarantee. Use namespace-wide queries
 * for recurring whole-board reads instead of passing every card ID.
 */
export async function readByIds<Id, Row>(
  ids: Id[],
  read: (batch: Id[]) => Promise<Row[]>,
): Promise<Row[]> {
  if (ids.length === 0) return [];
  const rows: Row[] = [];
  for (const batch of chunked(ids, { size: BATCH_MAX })) rows.push(...(await read(batch)));
  return rows;
}

export { NotFoundError, DefaultPartitionError, DefaultLayerError } from "../errors.js";

/**
 * Enforce the shared name length limit for database callers, including the CLI. HTTP routes
 * also validate names so they can return a 400 response.
 */
export function assertNameWithinLimit(name: string, label: string): void {
  if (name.length > NAME_MAX) throw new Error(`${label} must be ${NAME_MAX} characters or fewer`);
}

/** Throw if `rows` is empty to report a missing target after an update or delete. */
export function assertFound<T>(rows: T[], label: string): void {
  if (rows.length === 0) throw new NotFoundError(label);
}

/**
 * Walk an error and its `cause` chain, since Drizzle wraps the driver's error. Match libsql's
 * `extendedCode` first, and fall back to the message text for errors that carry no code.
 */
function constraintInChain(e: unknown, codes: readonly string[], text: string): boolean {
  // Remember visited errors so a `cause` chain that loops back cannot recurse forever.
  const seen = new Set<Error>();
  for (let current = e; current instanceof Error && !seen.has(current); current = current.cause) {
    seen.add(current);
    const { extendedCode } = current as { extendedCode?: unknown };
    if (typeof extendedCode === "string" && codes.includes(extendedCode)) return true;
    if (current.message.includes(text)) return true;
  }
  return false;
}

/** A duplicate primary key counts too: SQLite reports it as a UNIQUE failure. */
const UNIQUE_CODES = ["SQLITE_CONSTRAINT_UNIQUE", "SQLITE_CONSTRAINT_PRIMARYKEY"] as const;
const FOREIGN_KEY_CODES = ["SQLITE_CONSTRAINT_FOREIGNKEY"] as const;

export function isUniqueConstraintError(e: unknown): boolean {
  return (
    e instanceof ConflictError || constraintInChain(e, UNIQUE_CODES, "UNIQUE constraint failed")
  );
}

export function isForeignKeyError(e: unknown): boolean {
  return constraintInChain(e, FOREIGN_KEY_CODES, "FOREIGN KEY constraint failed");
}
