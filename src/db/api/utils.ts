import { getTableColumns, type Table } from "drizzle-orm";
import { NAME_MAX } from "../../lib/constants.js";

/**
 * How many columns a table has, for an insert sizing its batches by what it binds rather
 * than by a row count written down beside it (see `chunked`).
 *
 * Read off the Drizzle table, so a column added to the schema narrows the batches by
 * itself. An over-estimate where a caller omits a defaulted column, which is the safe
 * direction: the batch comes out smaller than it strictly had to be, never larger.
 */
export function columnCount(table: Table): number {
  return Object.keys(getTableColumns(table)).length;
}

export class NotFoundError extends Error {
  constructor(label: string) {
    super(`${label} not found`);
    this.name = "NotFoundError";
  }
}

export class DefaultBundleError extends Error {
  constructor() {
    super("Cannot delete the default bundle");
    this.name = "DefaultBundleError";
  }
}

export class DefaultLayerError extends Error {
  constructor() {
    super("Cannot delete the default layer");
    this.name = "DefaultLayerError";
  }
}

/**
 * Guards a user-supplied name against the shared length limit, for every named thing:
 * projects, bundles, layers, scopes, taskspaces. HTTP routes check the limit themselves so
 * they can answer with a 400 rather than a 500, which leaves this covering the callers that
 * never go through a route — the CLI above all.
 */
export function assertNameWithinLimit(name: string, label: string): void {
  if (name.length > NAME_MAX) throw new Error(`${label} must be ${NAME_MAX} characters or fewer`);
}

/** Throws if `rows` is empty — used to surface not-found errors from delete/update operations. */
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
