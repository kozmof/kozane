/** Finding and repairing inventories whose stored cards overlap or overflow. */
import { cardTable, glueRelTable, inventoryTable } from "../../schema.js";
import { eq } from "drizzle-orm";
import type { NeedsDB } from "../types.js";
import {
  cardSpan,
  overlappingCards,
  type Footprint,
  type InventoryPlacement,
} from "../../../lib/inventory.js";
import { halfPlaced, inventoryColumns, isStored } from "../card.js";
import { unglueCardsInTx } from "../glue.js";
import { withTx, type DB } from "../../tx.js";
import { SPAN_TEXT, settledFootprints, writePlacements } from "./slots.js";

/** What {@link repairInventories} changed. */
export type InventoryRepair = {
  /** Cards moved to resolve overlaps. */
  moved: InventoryPlacement[];
  /** Stored cards taken out of the glue groups they were still in. */
  unglued: string[];
  /** Cards with only one inventory column set, put back on the canvas. */
  cleared: string[];
};

/**
 * Repair every inventory using {@link planRepair} and remove stored cards from glue groups.
 * First put cards with only one inventory column set back on the canvas, which is where the
 * board already draws them. Return what changed.
 * After repair, {@link findInventoryConflicts} should find no conflicts.
 */
export async function repairInventories({ db }: { db: DB }): Promise<InventoryRepair> {
  return withTx(db, async (tx) => {
    const cleared = (
      await tx
        .update(cardTable)
        .set(inventoryColumns(null))
        .where(halfPlaced)
        .returning({ cardId: cardTable.id })
    ).map(({ cardId }) => cardId);
    const inventories = await tx.select({ id: inventoryTable.id }).from(inventoryTable);
    const moved: InventoryPlacement[] = [];
    for (const { id: inventoryId } of inventories) {
      const { repaired } = await settledFootprints(tx, inventoryId);
      if (repaired.length > 0) await writePlacements(tx, inventoryId, repaired);
      moved.push(...repaired.map((p) => ({ ...p, inventoryId })));
    }
    const glued = await tx
      .select({ cardId: glueRelTable.cardId })
      .from(glueRelTable)
      .innerJoin(cardTable, eq(cardTable.id, glueRelTable.cardId))
      .where(isStored);
    const stored = glued.map(({ cardId }) => cardId);
    // Ungluing can dissolve a group, which also frees partners left on the canvas. Only the
    // stored cards are reported, since those are what was wrong.
    await unglueCardsInTx({ db: tx, cardIds: stored });
    return { moved, unglued: stored, cleared };
  });
}

/** Stored cards that break an inventory rule, for `kozane doctor`. */
export type InventoryConflicts = {
  /** Cards covering a cell another card of their inventory covers. */
  overlapping: string[];
  /** Stored cards still in a glue group, which storing a card ends. */
  glued: string[];
  /** Cards with only one of `inventory_id` and `inventory_slot` set. See {@link halfPlaced}. */
  halfPlaced: string[];
};

/**
 * Find stored cards that overlap or belong to glue groups, and cards with only one inventory
 * column set, across the workspace.
 */
export async function findInventoryConflicts({ db }: NeedsDB): Promise<InventoryConflicts> {
  const half = await db.select({ cardId: cardTable.id }).from(cardTable).where(halfPlaced);
  const rows = await db
    .select({
      cardId: cardTable.id,
      inventoryId: cardTable.inventoryId,
      slot: cardTable.inventorySlot,
      text: SPAN_TEXT,
      glueId: glueRelTable.glueId,
    })
    .from(cardTable)
    .leftJoin(glueRelTable, eq(glueRelTable.cardId, cardTable.id))
    .where(isStored);
  const byInventory = new Map<string, Footprint[]>();
  for (const { cardId, inventoryId, slot, text } of rows) {
    if (inventoryId === null || slot === null) continue;
    const held = byInventory.get(inventoryId) ?? [];
    held.push({ cardId, slot, span: cardSpan(text) });
    byInventory.set(inventoryId, held);
  }
  return {
    overlapping: [...byInventory.values()].flatMap(overlappingCards),
    glued: rows.flatMap(({ cardId, glueId, slot }) =>
      glueId === null || slot === null ? [] : [cardId],
    ),
    halfPlaced: half.map(({ cardId }) => cardId),
  };
}
