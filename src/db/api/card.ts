import { bundleTable, cardTable, layerTable } from "../schema.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { AnyColumn, SQL } from "drizzle-orm";
import type { AnyDB } from "../client.js";
import type { NeedsDB, NeedsBundle, Card } from "./types.js";
import type { CardData } from "../../lib/types.js";
import { WARP_HINT_MAX_CHARS } from "../../lib/warp-list.js";
import { BATCH_MAX, chunked } from "../../lib/constants.js";
import { compareIds } from "../../lib/order.js";
import { assertFound, columnCount } from "./utils.js";
import { withTx, type DB } from "../tx.js";

// ── Simple operations (no ownership check) ────────────────────────────────────

export async function cardsInProject(
  db: AnyDB,
  projectId: string,
  cardIds: string[],
): Promise<string[]> {
  if (cardIds.length === 0) return [];
  const rows = await db
    .select({ id: cardTable.id })
    .from(cardTable)
    .innerJoin(
      bundleTable,
      and(eq(cardTable.bundleId, bundleTable.id), eq(bundleTable.projectId, projectId)),
    )
    .where(inArray(cardTable.id, cardIds));
  return rows.map((r) => r.id);
}

export async function getAllCards({ db, bundleId }: NeedsBundle): Promise<Card[]> {
  return db.select().from(cardTable).where(eq(cardTable.bundleId, bundleId));
}

/**
 * The ids of every card in a project, and nothing else about them.
 *
 * For the callers that want a project's cards only in order to number them —
 * {@link shortIdMap} draws its short ids against the whole project, so the id printed for a
 * card is the one `kozane card show` takes whichever command printed it. That is the entire
 * requirement, and reading the rows to meet it read every card's `content` as well.
 *
 * One statement, in place of the `getAllBundles` then `getAllCards`-per-bundle that
 * `kozane tag show` was doing: a project of thirty bundles cost thirty-one round trips and
 * came back with the text of every card in it, to build a map of ids.
 */
export async function getProjectCardIds(db: AnyDB, projectId: string): Promise<string[]> {
  const rows = await db
    .select({ id: cardTable.id })
    .from(cardTable)
    .innerJoin(bundleTable, eq(cardTable.bundleId, bundleTable.id))
    .where(eq(bundleTable.projectId, projectId));
  return rows.map(({ id }) => id);
}

type GetCardsByBundles = NeedsDB & { bundleIds: string[] };
export async function getCardsByBundles({ db, bundleIds }: GetCardsByBundles): Promise<Card[]> {
  if (bundleIds.length === 0) return [];
  return db.select().from(cardTable).where(inArray(cardTable.bundleId, bundleIds));
}

/**
 * The card columns the browser is sent, and only those.
 *
 * `CardData` names them once as a type; this names them once as a query. The two are held
 * together by the `satisfies` below rather than by anyone remembering: a key added to
 * `CardData` is missing here and a key removed from it is excess here, and both are compile
 * errors. `readCard` in `snapshot-reader.ts` is the third member of that set, and breaks the
 * same way — so a column reaches the board only when all three have been changed to admit it.
 *
 * The board is what makes this worth spelling out rather than selecting the row and letting
 * the extra columns ride along. Precisely: drizzle's `select()` enumerates the columns the
 * *schema* declares, so a column that exists only in the database never arrives here anyway
 * — but one added to `cardTable` did, by the act of adding it. `CardData` is a hand-written
 * `Pick`, so it would not gain the column and nothing on the path would object, and the
 * board is a published surface: served to every browser on page load, and baked into
 * `kozane net ssg generate` output, whose exact contents `docs/security-matrix.md`
 * enumerates. Opting a column in is one line here; opting one out after it has been
 * exported is not a thing that can be done.
 */
const CARD_DATA_SELECTION = {
  id: cardTable.id,
  content: cardTable.content,
  bundleId: cardTable.bundleId,
  layerId: cardTable.layerId,
  posX: cardTable.posX,
  posY: cardTable.posY,
  taskspaceId: cardTable.taskspaceId,
  zIndex: cardTable.zIndex,
  width: cardTable.width,
} satisfies Record<keyof CardData, AnyColumn>;

/**
 * The cards of a project's bundles, narrowed to what a board draws.
 *
 * The read behind both halves of the snapshot — the page load and the once-a-second poll —
 * which is the pair `loadProjectSnapshot` exists to keep identical. It used to select the
 * whole row: the poll's reader rebuilt each card from the fields it knows, so the two paths
 * already agreed on what the *client* kept, and disagreed on what crossed the wire.
 */
export async function getCardDataByBundles({
  db,
  bundleIds,
}: GetCardsByBundles): Promise<CardData[]> {
  if (bundleIds.length === 0) return [];
  return db
    .select(CARD_DATA_SELECTION)
    .from(cardTable)
    .where(inArray(cardTable.bundleId, bundleIds));
}

export type CardMarker = {
  projectId: string;
  posX: number;
  posY: number;
  zIndex: number;
  /** The opening of the card's text — enough to name it, not the whole of it. */
  content: string;
  /**
   * How many characters the whole card holds, which is what says how far past `content` it
   * goes. Without it a long card would be measured as the short one it arrives as: the
   * hint names the card nearest the warp, and how near a card is depends on how tall it is.
   */
  contentChars: number;
  /**
   * The card's own drawn width, or null where it follows `ui.defaultCardWidth`. Read for
   * the same reason `contentChars` is: the hint names the card nearest the warp, and how
   * near a card is depends on the box it is drawn in — which a resized card sets itself.
   */
  width: number | null;
};
type GetCardMarkers = NeedsDB & { projectIds: string[] };

/**
 * How much of a card's text this reads. A hint is at most {@link WARP_HINT_MAX_CHARS}
 * characters once its whitespace is collapsed, so several times that is more than enough
 * to build one, while a card may hold ten thousand — and every card of every
 * project with a warp is read to place one palette row.
 *
 * The single case this changes: a card whose first {@link HINT_SOURCE_MAX_CHARS}
 * characters are all whitespace reads as blank here, and a blank card lends no hint. How
 * tall the card is drawn does not depend on the cut, because `contentChars` carries the
 * length the text goes on to.
 */
const HINT_SOURCE_MAX_CHARS = WARP_HINT_MAX_CHARS * 5;

/**
 * Just enough of every card in `projectIds` to say what is near a point: the warp palette
 * names a warp after the card closest to it, and pulling whole rows for several projects
 * to read three columns is not worth it.
 *
 * Bounded by width of row, not by count of rows. Three of the four edges could be narrowed
 * here — a card is drawn no wider than the largest of `ui.defaultCardWidth` and the widths
 * cards pin for themselves, and one starting further below a warp than `WARP_HINT_RADIUS`
 * can never reach it — but the fourth cannot: a card's drawn height comes from how much
 * text it holds, so an arbitrarily tall card sitting well above a warp still reaches it.
 * Filtering on the three sound edges alone would drop exactly the cards the remaining one
 * is there to keep, so the narrowing has to be all four or none, and all four means the
 * height model in SQL.
 *
 * What is filtered is the one thing that costs nothing to be sure of: a card whose text is
 * blank lends no hint (`nearestCardHint` skips it), so it need not be sent. `trim` here
 * runs on the whole column rather than the opening below, which only ever discards rows
 * the caller would have discarded anyway.
 */
export async function getCardMarkersByProjects({
  db,
  projectIds,
}: GetCardMarkers): Promise<CardMarker[]> {
  if (projectIds.length === 0) return [];
  return db
    .select({
      projectId: bundleTable.projectId,
      posX: cardTable.posX,
      posY: cardTable.posY,
      zIndex: cardTable.zIndex,
      content: sql<string>`substr(${cardTable.content}, 1, ${HINT_SOURCE_MAX_CHARS})`,
      // `length()` counts characters rather than bytes for text, so this is the same
      // count the opening above is cut by.
      contentChars: sql<number>`length(${cardTable.content})`,
      width: cardTable.width,
    })
    .from(cardTable)
    .innerJoin(bundleTable, eq(cardTable.bundleId, bundleTable.id))
    .where(and(inArray(bundleTable.projectId, projectIds), sql`trim(${cardTable.content}) <> ''`));
}

type GetCard = NeedsBundle & { cardId: string };
export async function getCard({ db, bundleId, cardId }: GetCard): Promise<Card | undefined> {
  return db
    .select()
    .from(cardTable)
    .where(and(eq(cardTable.bundleId, bundleId), eq(cardTable.id, cardId)))
    .get();
}

/**
 * The default layer of the project the bundle belongs to. Every project has one
 * (created alongside its default bundle, and backfilled by migration 0005), so a
 * caller that does not care about layers still writes a valid `card.layer_id`.
 */
export async function defaultLayerIdForBundle(db: AnyDB, bundleId: string): Promise<string> {
  const row = await db
    .select({ id: layerTable.id })
    .from(layerTable)
    .innerJoin(bundleTable, eq(bundleTable.projectId, layerTable.projectId))
    .where(and(eq(bundleTable.id, bundleId), eq(layerTable.isDefault, true)))
    .get();
  if (!row) throw new Error(`No default layer found for bundle bundleId=${bundleId}`);
  return row.id;
}

type AddCard = NeedsBundle & {
  content: string;
  layerId?: string;
  taskspaceId?: string;
  posX?: number;
  posY?: number;
  zIndex?: number;
};
export async function addCard({
  db,
  bundleId,
  content,
  layerId,
  taskspaceId,
  posX,
  posY,
  zIndex,
}: AddCard): Promise<string> {
  const [row] = await db
    .insert(cardTable)
    .values({
      bundleId,
      layerId: layerId ?? (await defaultLayerIdForBundle(db, bundleId)),
      content,
      taskspaceId,
      ...(posX !== undefined && { posX }),
      ...(posY !== undefined && { posY }),
      ...(zIndex !== undefined && { zIndex }),
    })
    .returning({ id: cardTable.id });
  return row.id;
}

type AddCards = NeedsBundle & {
  layerId: string;
  cards: { content: string; posX: number; posY: number }[];
};

/**
 * Inserts many cards onto one bundle and layer, in {@link chunked} statements rather than
 * one round trip each. `kozane card squash` turns a pasted file into a card per sentence,
 * which is the one CLI path that writes cards by the hundred; the board's squash endpoint
 * batches the same way (see `squashProjectCard`).
 *
 * Returns the new ids in the order the rows were given, which is the order the text reads.
 * `layerId` is required rather than defaulted: every caller here has already resolved one,
 * and looking it up per chunk is the round trip this exists to avoid.
 */
export async function addCards({ db, bundleId, layerId, cards }: AddCards): Promise<string[]> {
  if (cards.length === 0) return [];
  const ids: string[] = [];
  for (const batch of chunked(cards, { columnsPerRow: columnCount(cardTable) })) {
    const rows = await db
      .insert(cardTable)
      .values(batch.map((card) => ({ bundleId, layerId, ...card })))
      .returning({ id: cardTable.id });
    ids.push(...rows.map(({ id }) => id));
  }
  return ids;
}

// Card deletion lives in composite.ts: removing a card cascades its glue_rel rows
// away, so the delete has to be paired with glue-group cleanup, and glue.ts cannot
// be imported from here without a cycle. See `deleteProjectCards`.

// ── Project-scoped transactional operations (verify ownership before mutating) ─

type GetCardBundleNames = NeedsDB & { cardIds: string[] };
/**
 * The bundle each of `cardIds` is in.
 *
 * In {@link chunked} statements, because an `IN` list is subject to the same SQLite variable
 * ceiling an `INSERT` is. Every caller but one hands this a handful of ids; the one that does
 * not is the tag index's static export, which is built before anyone has chosen a tag and so
 * asks about every tagged card in the workspace at once.
 *
 * Batched at {@link BATCH_MAX} rather than at `chunked`'s default, and the difference is a
 * factor of ten in round trips. That default is `INSERT_CHUNK_MAX`, which is a *row*
 * count for a multi-row `INSERT`, where every column of every row binds a parameter — here
 * each id binds one, which is the case `BATCH_MAX` is the budget for.
 */
export async function getCardBundleNames({
  db,
  cardIds,
}: GetCardBundleNames): Promise<{ cardId: string; bundleId: string; bundleName: string }[]> {
  const rows: { cardId: string; bundleId: string; bundleName: string }[] = [];
  for (const batch of chunked(cardIds, { size: BATCH_MAX })) {
    rows.push(
      ...(await db
        .select({
          cardId: cardTable.id,
          bundleId: bundleTable.id,
          bundleName: bundleTable.name,
        })
        .from(cardTable)
        .innerJoin(bundleTable, eq(cardTable.bundleId, bundleTable.id))
        .where(inArray(cardTable.id, batch))),
    );
  }
  return rows;
}

type GetCardLayerNames = NeedsDB & { cardIds: string[] };
export async function getCardLayerNames({
  db,
  cardIds,
}: GetCardLayerNames): Promise<{ cardId: string; layerId: string; layerName: string }[]> {
  if (cardIds.length === 0) return [];
  return db
    .select({
      cardId: cardTable.id,
      layerId: layerTable.id,
      layerName: layerTable.name,
    })
    .from(cardTable)
    .innerJoin(layerTable, eq(cardTable.layerId, layerTable.id))
    .where(inArray(cardTable.id, cardIds));
}

type ReassignBundleCards = NeedsDB & { fromBundleId: string; toBundleId: string };
export async function reassignBundleCards({
  db,
  fromBundleId,
  toBundleId,
}: ReassignBundleCards): Promise<void> {
  await db
    .update(cardTable)
    .set({ bundleId: toBundleId })
    .where(eq(cardTable.bundleId, fromBundleId));
}

type ReassignLayerCards = NeedsDB & { fromLayerId: string; toLayerId: string };
export async function reassignLayerCards({
  db,
  fromLayerId,
  toLayerId,
}: ReassignLayerCards): Promise<void> {
  await db.update(cardTable).set({ layerId: toLayerId }).where(eq(cardTable.layerId, fromLayerId));
}

type UpdateCard = NeedsDB & {
  cardId: string;
  bundleId: string;
  newBundleId?: string;
  layerId?: string;
  content?: string;
  posX?: number;
  posY?: number;
  zIndex?: number;
  /**
   * `null` clears the card's own width, putting it back under `ui.defaultCardWidth`.
   * Undefined leaves whichever of the two it is on now alone.
   */
  width?: number | null;
};
type CardUpdate = Partial<
  Pick<
    typeof cardTable.$inferInsert,
    "content" | "posX" | "posY" | "zIndex" | "width" | "bundleId" | "layerId"
  >
> & {
  /**
   * An expression rather than a `Date`, because whether this column moves at all is decided
   * by the row being written — see {@link contentUpdatedAt}.
   */
  updatedAt?: SQL;
};

/**
 * What to write to `updated_at` alongside a new `content`: the moment, but only if the text
 * actually changes, and otherwise the value the row already holds.
 *
 * The comparison is in the statement rather than in a read before it. Text that arrives
 * unchanged is not a revision — the board's composer sends the textarea's contents on every
 * save, edited or not, and a card re-saved untouched must not lengthen the interval `kozane
 * card list --sort gap` reports — so something has to compare it. Comparing in the `SET`
 * clause makes the compare and the write one statement: no transaction to wrap them in, no
 * second round trip on a path the board takes on every save, and no window in which a
 * competing writer can leave the timestamp decided on text neither statement stored.
 *
 * SQLite evaluates a `SET` expression against the pre-update row, so `card.content` here is
 * the text being replaced. `<>` needs no null guard: the column is NOT NULL. `unixepoch()`
 * returns seconds, which is what `integer({ mode: "timestamp" })` stores and what migration
 * 0011 wrote.
 */
function contentUpdatedAt(content: string): SQL {
  return sql`CASE WHEN ${cardTable.content} <> ${content} THEN unixepoch() ELSE ${cardTable.updatedAt} END`;
}

export async function updateCard({
  db,
  cardId,
  bundleId,
  newBundleId,
  layerId,
  content,
  posX,
  posY,
  zIndex,
  width,
}: UpdateCard): Promise<void> {
  const fields: CardUpdate = {};
  // `updatedAt` follows a card's text and nothing else. The rest of what this function can
  // change — where the card sits, how wide it is drawn, which bundle or layer holds it — is
  // arrangement rather than revision, and leaves the timestamp alone. See the column's own
  // note in `schema.ts`, and `updateProjectCardPositions` below, which writes positions by
  // the hundred and likewise does not bump it.
  if (content !== undefined) {
    fields.content = content;
    fields.updatedAt = contentUpdatedAt(content);
  }
  if (posX !== undefined) fields.posX = posX;
  if (posY !== undefined) fields.posY = posY;
  if (zIndex !== undefined) fields.zIndex = zIndex;
  if (width !== undefined) fields.width = width;
  if (newBundleId !== undefined) fields.bundleId = newBundleId;
  if (layerId !== undefined) fields.layerId = layerId;
  if (Object.keys(fields).length === 0) throw new Error("updateCard: no fields to update");

  const updated = await db
    .update(cardTable)
    .set(fields)
    .where(and(eq(cardTable.id, cardId), eq(cardTable.bundleId, bundleId)))
    .returning({ id: cardTable.id });
  assertFound(updated, `Card cardId=${cardId}`);
}

export type CardPositionUpdate = {
  cardId: string;
  posX: number;
  posY: number;
};

// Each CASE ends in an ELSE that writes the column back to itself, so a row matched by
// the WHERE without a matching WHEN is left as it was. The two are built from the same
// list and cannot diverge today; the ELSE is what keeps the failure mode of a future
// divergence "this row was not moved" rather than "NULL into a NOT NULL column", which
// aborts the whole statement. The row-count assertion in `updateProjectCardPositions`
// still fails the transaction if it ever happens, so it cannot pass silently either.
function buildPositionCaseWhen(positions: CardPositionUpdate[]): { posX: SQL; posY: SQL } {
  const whenX = positions.map((p) => sql`WHEN ${p.cardId} THEN ${p.posX}`);
  const whenY = positions.map((p) => sql`WHEN ${p.cardId} THEN ${p.posY}`);
  return {
    posX: sql`CASE ${cardTable.id} ${sql.join(whenX, sql` `)} ELSE ${cardTable.posX} END`,
    posY: sql`CASE ${cardTable.id} ${sql.join(whenY, sql` `)} ELSE ${cardTable.posY} END`,
  };
}

/** Last write wins, so a repeated cardId resolves the same way it would in sequence. */
function dedupePositions(positions: CardPositionUpdate[]): CardPositionUpdate[] {
  return [...new Map(positions.map((p) => [p.cardId, p])).values()];
}

type UpdateProjectCardPositions = {
  db: DB;
  projectId: string;
  positions: CardPositionUpdate[];
};

export async function updateProjectCardPositions({
  db,
  projectId,
  positions,
}: UpdateProjectCardPositions): Promise<boolean> {
  if (positions.length === 0) return true;
  const unique = dedupePositions(positions);

  return withTx(db, async (tx) => {
    const cardIds = unique.map((p) => p.cardId);
    const owned = await cardsInProject(tx, projectId, cardIds);
    if (owned.length !== cardIds.length) return false;

    const updated = await tx
      .update(cardTable)
      .set(buildPositionCaseWhen(unique))
      .where(inArray(cardTable.id, cardIds))
      .returning({ id: cardTable.id });
    if (updated.length !== unique.length)
      throw new Error(
        `updateProjectCardPositions: expected ${unique.length} updates, got ${updated.length}`,
      );

    return true;
  });
}

type ReassignCardsToLayer = {
  db: DB;
  projectId: string;
  cardIds: string[];
  layerId: string;
};

export type CardStacking = { cardId: string; zIndex: number };
export type ReassignLayerResult = { ok: false } | { ok: true; stacking: CardStacking[] };

// Same shape as buildPositionCaseWhen, including the ELSE, and for the same reason.
function buildZIndexCaseWhen(stacking: CardStacking[]): SQL {
  const whens = stacking.map((s) => sql`WHEN ${s.cardId} THEN ${s.zIndex}`);
  return sql`CASE ${cardTable.id} ${sql.join(whens, sql` `)} ELSE ${cardTable.zIndex} END`;
}

/**
 * Moves cards onto another layer of their own project. Refuses when a card is not in the
 * project or the layer is not either — a card must never end up on a layer its project
 * cannot see.
 *
 * A card arriving from elsewhere is restacked above what the target layer already holds.
 * zIndex only ever orders cards within one layer, so a value chosen against a different
 * set of neighbours means nothing here: carried over, a card that had been brought to the
 * front of a crowded layer would land on top of a quiet one for no reason the user gave.
 * Cards already on the target layer are left alone, so re-picking the layer they are on
 * changes nothing. `stacking` reports what each moved card ended up with, so a caller
 * holding its own copy of the cards can follow.
 */
export async function reassignCardsToLayer({
  db,
  projectId,
  cardIds,
  layerId,
}: ReassignCardsToLayer): Promise<ReassignLayerResult> {
  if (cardIds.length === 0) return { ok: true, stacking: [] };

  return withTx(db, async (tx) => {
    const owned = await cardsInProject(tx, projectId, cardIds);
    if (owned.length !== cardIds.length) return { ok: false };

    const layer = await tx
      .select({ id: layerTable.id })
      .from(layerTable)
      .where(and(eq(layerTable.id, layerId), eq(layerTable.projectId, projectId)))
      .get();
    if (!layer) return { ok: false };

    const requested = await tx
      .select({ id: cardTable.id, layerId: cardTable.layerId, zIndex: cardTable.zIndex })
      .from(cardTable)
      .where(inArray(cardTable.id, [...new Set(cardIds)]));
    const arriving = requested.filter((card) => card.layerId !== layerId);
    if (arriving.length === 0) return { ok: true, stacking: [] };

    const resident = await tx
      .select({ zIndex: cardTable.zIndex })
      .from(cardTable)
      .where(eq(cardTable.layerId, layerId));
    // Folded rather than spread into Math.max, which throws on a large enough layer, and
    // seeded at 0 so an empty layer starts where a first card would.
    const top = resident.reduce((highest, { zIndex }) => (zIndex > highest ? zIndex : highest), 0);

    // Their order relative to each other is what the user arranged, so it is kept; the id
    // breaks ties the same way the rest of the app does.
    const stacking = [...arriving]
      .sort((a, b) => a.zIndex - b.zIndex || compareIds(a.id, b.id))
      .map((card, index) => ({ cardId: card.id, zIndex: top + 1 + index }));

    await tx
      .update(cardTable)
      .set({ layerId, zIndex: buildZIndexCaseWhen(stacking) })
      .where(
        inArray(
          cardTable.id,
          stacking.map(({ cardId }) => cardId),
        ),
      );

    return { ok: true, stacking };
  });
}

type ReassignCardsToBundle = {
  db: DB;
  projectId: string;
  cardIds: string[];
  bundleId: string;
};

export async function reassignCardsToBundle({
  db,
  projectId,
  cardIds,
  bundleId,
}: ReassignCardsToBundle): Promise<boolean> {
  if (cardIds.length === 0) return true;

  return withTx(db, async (tx) => {
    const owned = await cardsInProject(tx, projectId, cardIds);
    if (owned.length !== cardIds.length) return false;

    const bundle = await tx
      .select({ id: bundleTable.id })
      .from(bundleTable)
      .where(and(eq(bundleTable.id, bundleId), eq(bundleTable.projectId, projectId)))
      .get();
    if (!bundle) return false;

    await tx.update(cardTable).set({ bundleId }).where(inArray(cardTable.id, cardIds));

    return true;
  });
}
