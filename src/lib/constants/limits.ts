/**
 * What one write may carry: how long a card's text may be, how long a name may be, and how many rows or parameters one statement will take.
 *
 * The batching helpers live here with the ceilings they batch against, since neither means
 * anything without the other.
 */
/**
 * How much text one card holds by default. The workspace may raise or lower it with
 * `ui.contentMax`, so this is the fallback rather than the limit — read the setting
 * through `lib/server/content-limit.ts` and pass it to {@link contentLimitIssue}.
 *
 * Counted in UTF-16 code units, which is what `String.length` counts: a CJK character is
 * one, an emoji past the BMP is two.
 *
 * The transport has to be able to carry what this accepts. A card of this length is far
 * larger than the HTTP body limit adapter-node defaults to, so `bin/server.js` sizes that
 * limit from this rather than leaving the browser refused at a ceiling no endpoint names.
 * See {@link bodySizeLimitFor}.
 */
export const CONTENT_MAX = 200_000;
/**
 * Why this card's text is past `contentMax`, or null when it is not, in the wording both
 * writers refuse it with. The HTTP routes turn it into a 400 and `kozane card add` into a
 * failed command: the two reach the same table through the same `addCard`, so the limit
 * held against a card has to be one limit rather than one each.
 *
 * The limit is a parameter rather than read here because it comes from the workspace
 * config, which this module cannot reach — `ui-config.ts` imports from it, not the other
 * way round. That is the same split `clampToBounds` and `canvasBounds` have.
 */
export function contentLimitIssue(content: string, contentMax: number): string | null {
  return content.length > contentMax
    ? `content must be a string under ${contentMax} characters`
    : null;
}
export const NAME_MAX = 255;
/**
 * How many ids one request may name. Every batch endpoint binds a parameter per id — SQLite
 * refuses a statement past its variable limit, and builds the whole thing in memory before
 * finding out. This sits far enough under that for a list of ids, and far enough above any
 * real selection that reaching it means something other than a user dragging cards.
 *
 * It is not what keeps the *writes* under that limit, and did not use to say so. The
 * position and stacking updates bind several parameters per id, so a request at this size
 * builds a statement several times as wide; they draw their own batch size from
 * {@link STATEMENT_PARAMS_MAX} instead, which is computed from how wide each row of the
 * statement actually is. This bounds what a request may *ask for*, and that is all.
 */
export const BATCH_MAX = 2_000;
/**
 * How many rows one multi-row INSERT carries. The same SQLite variable limit
 * {@link BATCH_MAX} answers for, from the other side: there a request names ids and each
 * binds one parameter or a few, while here every column of every row binds one, so a row
 * count SQLite is happy with is far lower than an id count. Kept next to `BATCH_MAX` so
 * a table that grows a column is one place to revisit rather than two — a caller may hand
 * an insert up to `BATCH_MAX` rows, and this is what splits them.
 *
 * Small enough to stay well clear of the limit, large enough that an ordinary squash is a
 * single statement.
 */
export const INSERT_CHUNK_MAX = 200;

/**
 * How many bound parameters one statement may carry. {@link INSERT_CHUNK_MAX} is a row
 * count, which only stands in for this while every caller writes a row of about the same
 * width — so this is the budget the row count was picked against, named so a wider table
 * shrinks its own batches instead of quietly spending more of it.
 *
 * SQLite's own ceiling is 32766 parameters per statement on any build Kozane runs against
 * (999 before 3.32, which predates the `node:sqlite` era entirely). Well under either, for
 * the reason {@link BATCH_MAX} gives: the statement is assembled in memory before SQLite
 * says whether it will take it.
 *
 * Named for the statement rather than for the INSERT it was introduced for, because the
 * widest statements this app builds are not inserts. `updateNamespaceCardPositions` and
 * `reassignCardsToLayer` write a column with a `CASE` per row, which binds the id and the
 * value in every CASE and the id again in the WHERE — several times an insert's cost per
 * row, on a list `BATCH_MAX` alone would let reach two thousand. They draw their batch size
 * from here through {@link chunked} for the same reason the inserts do: so the guarantee is
 * computed from the statement's actual width rather than asserted in a comment beside it and
 * quietly outgrown the next time a column joins the CASE.
 */
export const STATEMENT_PARAMS_MAX = 2_000;

/**
 * Splits rows into statement-sized batches. Here rather than beside any one caller because
 * several writers run the same insert — the board's squash endpoint and `kozane card
 * squash` among them — and a chunk size applied on one path only leaves the variable limit
 * still waiting on the other.
 *
 * `columnsPerRow` is what keeps the batch honest for a table wider than the one this was
 * sized against: the batch is the smaller of {@link INSERT_CHUNK_MAX} rows and whatever
 * {@link STATEMENT_PARAMS_MAX} affords at that width, so a table that grows a column narrows
 * its batches rather than widening its statements. Omitted, the row count stands alone, as
 * it did before — callers inserting a two-column relation row have nothing to gain from it.
 */
export function chunked<T>(
  rows: T[],
  { size = INSERT_CHUNK_MAX, columnsPerRow }: { size?: number; columnsPerRow?: number } = {},
): T[][] {
  const affordable = columnsPerRow
    ? Math.max(1, Math.floor(STATEMENT_PARAMS_MAX / columnsPerRow))
    : size;
  const batchSize = Math.min(size, affordable);
  const chunks: T[][] = [];
  for (let start = 0; start < rows.length; start += batchSize)
    chunks.push(rows.slice(start, start + batchSize));
  return chunks;
}
