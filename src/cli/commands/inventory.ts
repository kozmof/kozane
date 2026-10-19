import {
  addInventory,
  deleteInventory,
  getAllInventories,
  getInventoryCardCounts,
  getInventoryCards,
  repairInventories,
  stowCards,
  takeCards,
  updateInventory,
  type InventoryRepair,
} from "../../db/api/inventory.js";
import type { Inventory } from "../../db/api/types.js";
import { cardTable } from "../../db/schema.js";
import type { DB } from "../../db/tx.js";
import { INVENTORY_COLUMNS, NAME_MAX } from "../../lib/constants.js";
import { cardSpan, slotCell } from "../../lib/inventory.js";
import { canvasBoundsForRoot, clampToBounds } from "../../lib/server/canvas.js";
import { resolveCardGroup } from "../lib/card-refs.js";
import { resolveNamespaceId } from "../lib/namespace-selection.js";
import { plural } from "../lib/plural.js";
import { resolveShortId, shortId } from "../lib/short-id.js";
import { runWorkspaceCommand } from "../lib/workspace-command.js";

type InventoryOptions = { namespace?: string };
type InventoryAddOptions = InventoryOptions & { name?: string; x: number; y: number };
type InventoryPutOptions = { slot?: number };
type InventoryTakeOptions = { x?: number; y?: number };

/** The longest card text `inventory show` prints on one line. */
const PREVIEW_CHARS = 60;

/** A namespace's inventories and the requested one among them, by full or short ID. */
async function resolveInventory(
  db: DB,
  namespaceId: string,
  requestedId: string,
): Promise<{ inventory: Inventory; ids: string[] }> {
  const inventories = await getAllInventories({ db, namespaceId });
  const ids = inventories.map(({ id }) => id);
  const inventoryId = resolveShortId(requestedId, ids, "Inventory");
  return { inventory: inventories.find(({ id }) => id === inventoryId)!, ids };
}

function nameOf(inventory: Inventory): string {
  return inventory.name || "(unnamed)";
}

function checkedName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length > NAME_MAX)
    throw new Error(`Inventory name must be ${NAME_MAX} characters or fewer.`);
  return trimmed;
}

function preview(content: string): string {
  const line = content.split("\n", 1)[0].trim();
  if (!line) return content.trim() ? "…" : "(empty)";
  return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS - 1)}…` : line;
}

export async function inventoryList(options: InventoryOptions = {}): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
    const namespaceId = await resolveNamespaceId(db, options.namespace);
    const inventories = await getAllInventories({ db, namespaceId });
    if (inventories.length === 0) {
      console.log("No inventories found.");
      return;
    }
    const ids = inventories.map(({ id }) => id);
    const counts = await getInventoryCardCounts({ db, namespaceId });
    for (const inventory of inventories) {
      const count = counts.get(inventory.id) ?? 0;
      console.log(
        `${shortId(inventory.id, ids)}  ${nameOf(inventory)}  (${inventory.posX}, ${inventory.posY})  ${plural(count, "card")}`,
      );
    }
  });
}

export async function inventoryAdd({ namespace, name, x, y }: InventoryAddOptions): Promise<void> {
  await runWorkspaceCommand(async ({ db, root }) => {
    const namespaceId = await resolveNamespaceId(db, namespace);
    const position = clampToBounds(x, y, canvasBoundsForRoot(root));
    const inventory = await addInventory({
      db,
      namespaceId,
      name: name === undefined ? undefined : checkedName(name),
      ...position,
    });
    const ids = (await getAllInventories({ db, namespaceId })).map(({ id }) => id);
    console.log("Inventory added.");
    console.log(`  id      : ${shortId(inventory.id, ids)}`);
    console.log(`  name    : ${nameOf(inventory)}`);
    console.log(`  position: (${inventory.posX}, ${inventory.posY})`);
  });
}

export async function inventoryRename(
  requestedId: string,
  name: string,
  options: InventoryOptions = {},
): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
    const namespaceId = await resolveNamespaceId(db, options.namespace);
    const { inventory, ids } = await resolveInventory(db, namespaceId, requestedId);
    const renamed = await updateInventory({
      db,
      namespaceId,
      inventoryId: inventory.id,
      name: checkedName(name),
    });
    console.log("Inventory renamed.");
    console.log(`  id  : ${shortId(renamed.id, ids)}`);
    console.log(`  name: ${nameOf(renamed)}`);
  });
}

export async function inventoryDelete(
  requestedId: string,
  options: InventoryOptions = {},
): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
    const namespaceId = await resolveNamespaceId(db, options.namespace);
    const { inventory, ids } = await resolveInventory(db, namespaceId, requestedId);
    const { releasedCardIds } = await deleteInventory({
      db,
      namespaceId,
      inventoryId: inventory.id,
    });
    console.log("Inventory deleted.");
    console.log(`  id: ${shortId(inventory.id, ids)}`);
    if (releasedCardIds.length > 0)
      console.log(`  ${plural(releasedCardIds.length, "card")} returned to the canvas.`);
  });
}

export async function inventoryShow(
  requestedId: string,
  options: InventoryOptions = {},
): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
    const namespaceId = await resolveNamespaceId(db, options.namespace);
    const { inventory, ids } = await resolveInventory(db, namespaceId, requestedId);
    const cards = await getInventoryCards({ db, inventoryId: inventory.id });
    console.log(
      `${shortId(inventory.id, ids)}  ${nameOf(inventory)}  ${plural(cards.length, "card")}`,
    );
    if (cards.length === 0) return;
    // Card prefixes are workspace-wide, matching `card list` and every command that takes one.
    const { allIds } = await resolveCardGroup(db, [cards[0].id]);
    for (const card of cards) {
      const { row, column } = slotCell(card.slot);
      // A card covers as many rows as its text needs, shown as the range it spans.
      const span = cardSpan(card.content);
      const rows = span === 1 ? `r${row + 1}` : `r${row + 1}-${row + span}`;
      console.log(
        `  ${String(card.slot).padStart(3)}  ${rows.padEnd(7)} c${column + 1}  ${shortId(card.id, allIds)}  ${preview(card.content)}`,
      );
    }
  });
}

export async function inventoryPut(
  requestedId: string,
  requestedCardIds: string[],
  { slot }: InventoryPutOptions = {},
): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
    const { allIds, cardIds, namespaceId } = await resolveCardGroup(db, requestedCardIds);
    const { inventory, ids } = await resolveInventory(db, namespaceId, requestedId);
    const result = await stowCards({
      db,
      namespaceId,
      inventoryId: inventory.id,
      cardIds,
      slot: slot ?? null,
    });
    if (!result.ok)
      throw new Error(
        result.reason === "foreign-cards"
          ? "Cards must belong to the same namespace as the inventory."
          : result.reason === "inventory-full"
            ? "Those cards do not fit from that slot."
            : "Inventory does not belong to the cards' namespace.",
      );
    console.log(`${plural(cardIds.length, "card")} stored.`);
    console.log(`  inventory: ${shortId(inventory.id, ids)}`);
    for (const { cardId, slot: at } of result.placements) {
      const { row, column } = slotCell(at, INVENTORY_COLUMNS);
      console.log(`  ${shortId(cardId, allIds)}  slot ${at} (r${row + 1} c${column + 1})`);
    }
  });
}

/**
 * Prints what a repair changed, one card per line, or nothing when it changed nothing.
 * `allIds` is every card ID in the workspace, for short IDs.
 */
export function printInventoryRepair(repair: InventoryRepair, allIds: string[]): void {
  for (const { cardId, slot } of repair.moved)
    console.log(`  ${shortId(cardId, allIds)}  moved to slot ${slot}`);
  for (const cardId of repair.unglued) console.log(`  ${shortId(cardId, allIds)}  unglued`);
}

/**
 * Moves overlapping stored cards apart and takes stored cards out of glue groups, in every
 * inventory of the workspace. Writers repair an inventory on its next write anyway, so this
 * is for clearing what `kozane doctor` reports without waiting for one.
 */
export async function inventoryRepair(): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
    const repair = await repairInventories({ db });
    if (repair.moved.length === 0 && repair.unglued.length === 0) {
      console.log("Inventories already consistent.");
      return;
    }
    console.log("Inventories repaired.");
    printInventoryRepair(repair, await allCardIds(db));
  });
}

export async function inventoryTake(
  requestedCardIds: string[],
  { x, y }: InventoryTakeOptions = {},
): Promise<void> {
  await runWorkspaceCommand(async ({ db, root }) => {
    if ((x === undefined) !== (y === undefined))
      throw new Error("inventory take needs both --x and --y, or neither.");
    if (x !== undefined && requestedCardIds.length > 1)
      throw new Error("--x and --y place one card. Take several without them.");
    const { allIds, cardIds, namespaceId } = await resolveCardGroup(db, requestedCardIds);
    const position =
      x === undefined || y === undefined
        ? undefined
        : clampToBounds(x, y, canvasBoundsForRoot(root));
    const result = await takeCards({
      db,
      namespaceId,
      cards: cardIds.map((cardId) => ({ cardId, ...position })),
    });
    if (!result.ok)
      throw new Error(
        result.reason === "unstored-cards"
          ? "Only stored cards can be taken out. One of these is already on the canvas."
          : "Cards must belong to the same namespace.",
      );
    console.log(`${plural(cardIds.length, "card")} returned to the canvas.`);
    for (const cardId of cardIds) console.log(`  id: ${shortId(cardId, allIds)}`);
    if (position) console.log(`  position: (${position.posX}, ${position.posY})`);
  });
}

/** Every card ID in the workspace, which short IDs are chosen against. */
async function allCardIds(db: DB): Promise<string[]> {
  return (await db.select({ id: cardTable.id }).from(cardTable)).map(({ id }) => id);
}
