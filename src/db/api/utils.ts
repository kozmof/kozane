import { getTableColumns, type Table } from "drizzle-orm";
import { BATCH_MAX, NAME_MAX, chunked } from "../../lib/constants.js";

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
  | "foreign-scope";

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

/** The refusal every batch operation whose only precondition is card ownership can give. */
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

export class NotFoundError extends Error {
  constructor(label: string) {
    super(`${label} not found`);
    this.name = "NotFoundError";
  }
}

export class DefaultPartitionError extends Error {
  constructor() {
    super("Cannot delete the default partition");
    this.name = "DefaultPartitionError";
  }
}

export class DefaultLayerError extends Error {
  constructor() {
    super("Cannot delete the default layer");
    this.name = "DefaultLayerError";
  }
}

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

function messageInChain(e: unknown, text: string): boolean {
  if (!(e instanceof Error)) return false;
  if (e.message.includes(text)) return true;
  return messageInChain(e.cause, text);
}

export function isUniqueConstraintError(e: unknown): boolean {
  return messageInChain(e, "UNIQUE constraint failed");
}

export function isForeignKeyError(e: unknown): boolean {
  return messageInChain(e, "FOREIGN KEY constraint failed");
}
