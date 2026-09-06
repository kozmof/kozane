import { getTableColumns, type Table } from "drizzle-orm";
import { BATCH_MAX, NAME_MAX, chunked } from "../../lib/constants.js";

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

/**
 * Why an operation over a batch of cards was refused, for the operations that refuse rather
 * than throw.
 *
 * One vocabulary rather than one per function, because the callers are all HTTP routes and
 * they all have the same job: turn the refusal into a message. It used to be a bare
 * `boolean`, which left them two ways out and both were paid for:
 *
 * - Pre-check the destination outside the transaction so a specific message could be
 *   written — `cards/bundle` and `cards/layer` each ran a `getBundle`/`getLayer` that the
 *   transaction then ran again, and ran it *outside* the transaction, so the answer it gave
 *   was already stale by the time the write took it.
 * - Or write one message for every way it could fail. `DELETE .../scopes/:id/members`
 *   answered "Some cards do not belong to this project" when what was missing was the
 *   *scope*, which is not a card and not the project's.
 *
 * A reason carried out of the transaction that decided it removes both. Each function
 * narrows this to the subset it can actually produce, so a route handling
 * {@link CardBatchResult} cannot be handed a `"foreign-layer"` it has no wording for.
 *
 * `foreign-*` throughout, because that is what these all are: a named row that exists or
 * does not, but either way is not this project's to act on. The distinction between the two
 * is deliberately not drawn — this workspace's own CLI lists and moves cards across
 * projects, so "it is elsewhere" and "it is nowhere" are the same answer to the only
 * question a route asks, and drawing it would cost a second query on every refusal to
 * produce a message no caller varies.
 */
export type BatchRejection = "foreign-cards" | "foreign-bundle" | "foreign-layer" | "foreign-scope";

/**
 * The refused half of a result, narrowed to the reasons one operation can actually produce.
 *
 * Every result type below spelled its subset as a bare literal union, which meant the shared
 * vocabulary above was shared only by convention: renaming a member — or adding a fifth and
 * mis-typing it at one call site — left {@link BatchRejection} and the six result types that
 * draw from it disagreeing, with nothing to say so. The parameter is constrained to the union,
 * so a reason that is no longer in it fails to compile everywhere it is named, which is the
 * property naming the union once was for.
 *
 * Deliberately not the whole result: `ok: true` carries something different in each of them —
 * nothing, a `glueId`, a `stacking`, a list of cleared cards — and a generic covering that too
 * would be a type parameter per member for no gain.
 */
export type BatchRefusal<R extends BatchRejection> = { ok: false; reason: R };

/** The refusal every batch operation whose only precondition is card ownership can give. */
export type CardBatchResult = { ok: true } | BatchRefusal<"foreign-cards">;

/**
 * Runs a read over an id list in statement-sized batches and concatenates the rows.
 *
 * The reads that take a list of ids were split on whether anyone had thought about the
 * limit: `getCardBundleNames` chunked, `loadCards` in the CLI chunked, and `cardsInProject`
 * and `getCardLayerNames` bound the whole list. Every one of them is safe at today's numbers
 * — an HTTP route caps a list at {@link BATCH_MAX}, sixteen times under the 32766 parameters
 * SQLite will take — but that is a fact about two constants far apart, not a property of
 * these functions, and the CLI reaches all three of the ones here without a route's cap in
 * between: `card glue --add` expands a selection to whole glue groups, which have no ceiling
 * short of the project — the same reason `loadCards` was already batching beside it.
 *
 * Not for every id-list read. `getGlueRelsByCards` is deliberately left unbatched, because
 * there the oversized call is a caller using the wrong function and the failure is how they
 * find out; see the note on it.
 *
 * So the batching goes in one place and the callers stop deciding. {@link BATCH_MAX} rather
 * than `chunked`'s row-count default, for the reason `getCardBundleNames` gave when it was
 * the only one doing this: the default is sized for a multi-row INSERT, where every column
 * of every row binds a parameter, and an id list binds one each.
 *
 * Order follows the batches, so a caller that needs a particular order still has to ask for
 * it — none of these do; they are all read into a map or a set.
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
