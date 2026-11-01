/** Replace a canvas card with text segments stored in a new inventory. */
import { withTx, type DB } from "../../tx.js";
import {
  newCardStamps,
  onCanvas,
  inventoryColumns,
  cardInventory,
  type CardStacking,
} from "../card.js";
import { getScopeRelsByCards } from "../scope-rel.js";
import { unglueCardsInTx } from "../glue.js";
import { addSquashInventoryInTx } from "../inventory.js";
import { columnCount } from "../utils.js";
import { and, eq, gt, gte, sql } from "drizzle-orm";
import { partitionTable, cardTable, scopeRelTable } from "../../schema.js";
import type { Card, Inventory } from "../types.js";
import { BATCH_MAX, chunked, clamp } from "../../../lib/constants.js";
import {
  splitCardContent,
  squashCardPositions,
  squashInventorySlots,
} from "../../../lib/squash.js";

type SquashNamespaceCard = {
  db: DB;
  namespaceId: string;
  cardId: string;
  canvasWidth: number;
  canvasHeight: number;
};

export type SquashCardResult =
  | { ok: false; reason: "not-found" | "stored" | "indivisible" | "too-many" | "inventory-full" }
  | {
      ok: true;
      /** The new inventory holding the pieces, placed where the source card was. */
      inventory: Inventory;
      /** The pieces, stored in `inventory` in text order. */
      cards: Card[];
      /** Cards on the source's layer raised to make room for the pieces. */
      stacking: CardStacking[];
    };

/**
 * Replace a card with one card per text segment in a single transaction, and store the pieces
 * in a new inventory named "Squash N" at the original position. Pieces inherit the partition,
 * layer, taskspace, width, and scope memberships. The positions they go back to are laid out
 * from the original position.
 *
 * Reject a single segment to avoid replacing a card without changing its text. Reject a stored
 * card, since the new inventory goes where the card sits on the canvas. Reject pieces that
 * would pass the inventory's last slot. Remove the source from its glue group. Stored pieces
 * start unglued.
 *
 * The pieces take consecutive zIndex values from the source's. Cards above the source on its
 * layer are raised by the extra count so no piece ties with, or rises past, a card that sat
 * above the source.
 */
export async function squashNamespaceCard({
  db,
  namespaceId,
  cardId,
  canvasWidth,
  canvasHeight,
}: SquashNamespaceCard): Promise<SquashCardResult> {
  return withTx(db, async (tx) => {
    const inNamespace = and(
      eq(cardTable.partitionId, partitionTable.id),
      eq(partitionTable.namespaceId, namespaceId),
    );
    const source = await tx
      .select({
        id: cardTable.id,
        partitionId: cardTable.partitionId,
        layerId: cardTable.layerId,
        taskspaceId: cardTable.taskspaceId,
        content: cardTable.content,
        posX: cardTable.posX,
        posY: cardTable.posY,
        zIndex: cardTable.zIndex,
        width: cardTable.width,
        inventoryId: cardTable.inventoryId,
        inventorySlot: cardTable.inventorySlot,
      })
      .from(cardTable)
      .innerJoin(partitionTable, inNamespace)
      .where(eq(cardTable.id, cardId))
      .get();
    if (!source) return { ok: false, reason: "not-found" };
    // The same test the board uses, so a card with only one inventory column set, which it
    // draws on the canvas, can be squashed like any other card there.
    if (cardInventory(source.inventoryId, source.inventorySlot) !== null)
      return { ok: false, reason: "stored" };

    const contents = splitCardContent(source.content);
    if (contents.length < 2) return { ok: false, reason: "indivisible" };
    if (contents.length > BATCH_MAX) return { ok: false, reason: "too-many" };
    const slots = squashInventorySlots(contents);
    if (!slots) return { ok: false, reason: "inventory-full" };

    // Layout slots only extend right of and below the origin, so cards elsewhere can never
    // block one. Skip reading them rather than scanning the whole board inside the write.
    const occupied = await tx
      .select({ id: cardTable.id, posX: cardTable.posX, posY: cardTable.posY })
      .from(cardTable)
      .innerJoin(partitionTable, inNamespace)
      .where(
        and(
          gte(cardTable.posX, source.posX),
          gte(cardTable.posY, source.posY),
          // A stored card's position is where it goes back to, not space it takes up now.
          onCanvas,
        ),
      );
    const positions = squashCardPositions(
      // Reuse the original slot for the first piece.
      occupied.filter(({ id }) => id !== cardId),
      contents.length,
      { origin: { posX: source.posX, posY: source.posY }, canvasWidth },
    );

    const extra = contents.length - 1;
    const stacking = await tx
      .update(cardTable)
      .set({ zIndex: sql`${cardTable.zIndex} + ${extra}` })
      .where(and(eq(cardTable.layerId, source.layerId), gt(cardTable.zIndex, source.zIndex)))
      .returning({ cardId: cardTable.id, zIndex: cardTable.zIndex });

    const inventory = await addSquashInventoryInTx({
      db: tx,
      namespaceId,
      posX: source.posX,
      posY: source.posY,
    });

    const cards: Card[] = [];
    // Use one timestamp for every piece, as `addCards` does for CLI squash. See {@link
    // newCardStamps}.
    const stamps = newCardStamps();
    const rows = contents.map((content, index) => ({
      ...stamps,
      partitionId: source.partitionId,
      layerId: source.layerId,
      taskspaceId: source.taskspaceId,
      content,
      // The layout runs off the board once the origin is near enough to an edge, and a
      // stored position outside it is one the viewport can never reach.
      posX: clamp(positions[index].posX, 0, canvasWidth),
      posY: clamp(positions[index].posY, 0, canvasHeight),
      // Above whatever the source sat above, and in the order the text reads.
      zIndex: source.zIndex + index,
      width: source.width,
      ...inventoryColumns({ id: inventory.id, slot: slots[index] }),
    }));
    for (const batch of chunked(rows, { columnsPerRow: columnCount(cardTable) }))
      cards.push(...(await tx.insert(cardTable).values(batch).returning()));

    // Pieces inherit the source card's scopes.
    const scopeIds = (await getScopeRelsByCards({ db: tx, cardIds: [cardId] })).map(
      ({ scopeId }) => scopeId,
    );
    const scopeRels = scopeIds.flatMap((scopeId) =>
      cards.map(({ id }) => ({ scopeId, cardId: id })),
    );
    for (const batch of chunked(scopeRels))
      await tx.insert(scopeRelTable).values(batch).onConflictDoNothing();

    await unglueCardsInTx({ db: tx, cardIds: [cardId] });
    await tx.delete(cardTable).where(eq(cardTable.id, cardId));

    return { ok: true, inventory, cards, stacking };
  });
}
