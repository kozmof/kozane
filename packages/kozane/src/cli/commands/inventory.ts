import * as service from "../../services/inventories.js";
import { createServiceContext } from "../../services/context.js";
import { getUiConfigForRoot } from "../../db/internal/config.js";
import { composeWrite, type AnyDB } from "../../db/database.js";
import { BatchValidationError } from "../../services/rejection.js";
import {
  getAllInventories,
  getInventoryCardCounts,
  getInventoryCards,
  type InventoryRepair,
  type StowResult,
  type TakeResult,
} from "../../db/api/inventory.js";
import type { Inventory } from "../../db/api/types.js";
import { INVENTORY_COLUMNS, NAME_MAX } from "../../lib/constants.js";
import { cardSpan, slotCell } from "../../lib/inventory.js";
import { canvasBoundsForRoot, clampToBounds } from "../../lib/server/canvas.js";
import { allCardIds, resolveCardGroup } from "../lib/card-refs.js";
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

/** What `inventory put` says for each refusal. */
const PUT_REFUSAL: Record<Extract<StowResult, { ok: false }>["reason"], string> = {
  "foreign-cards": "Cards must belong to the same namespace as the inventory.",
  "foreign-inventory": "Inventory does not belong to the cards' namespace.",
  "inventory-full": "Those cards do not fit from that slot.",
};

/** What `inventory take` says for each refusal. */
const TAKE_REFUSAL: Record<Extract<TakeResult, { ok: false }>["reason"], string> = {
  "foreign-cards": "Cards must belong to the same namespace.",
  "unstored-cards": "Only stored cards can be taken out. One of these is already on the canvas.",
};

/** A namespace's inventories and the requested one among them, by full or short ID. */
async function resolveInventory(
  db: AnyDB,
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
    const context = createServiceContext(getUiConfigForRoot(root));
    const { namespaceId, inventory } = await composeWrite(db, async (tx) => {
      const namespaceId = await resolveNamespaceId(tx, namespace);
      const inventory = await service.createInTx(tx, context, namespaceId, {
        name: name === undefined ? undefined : checkedName(name),
        posX: x,
        posY: y,
      });
      return { namespaceId, inventory };
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
  await runWorkspaceCommand(async ({ db, root }) => {
    const context = createServiceContext(getUiConfigForRoot(root));
    const { renamed, ids } = await composeWrite(db, async (tx) => {
      const namespaceId = await resolveNamespaceId(tx, options.namespace);
      const { inventory, ids } = await resolveInventory(tx, namespaceId, requestedId);
      const renamed = await service.updateInTx(tx, context, namespaceId, inventory.id, {
        name: checkedName(name),
      });
      return { renamed, ids };
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
  await runWorkspaceCommand(async ({ db, root }) => {
    const context = createServiceContext(getUiConfigForRoot(root));
    const { inventory, ids, releasedCardIds } = await composeWrite(db, async (tx) => {
      const namespaceId = await resolveNamespaceId(tx, options.namespace);
      const { inventory, ids } = await resolveInventory(tx, namespaceId, requestedId);
      const { releasedCardIds } = await service.removeInTx(tx, context, namespaceId, inventory.id);
      return { inventory, ids, releasedCardIds };
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
  await runWorkspaceCommand(async ({ db, root }) => {
    const context = createServiceContext(getUiConfigForRoot(root));
    const { allIds, cardIds, inventory, ids, result } = await composeWrite(db, async (tx) => {
      const { allIds, cardIds, namespaceId } = await resolveCardGroup(tx, requestedCardIds);
      const { inventory, ids } = await resolveInventory(tx, namespaceId, requestedId);
      try {
        const result = await service.stowInTx(tx, context, namespaceId, inventory.id, {
          cardIds,
          slot,
        });
        return { allIds, cardIds, inventory, ids, result };
      } catch (error) {
        if (error instanceof BatchValidationError && error.reason in PUT_REFUSAL)
          throw new Error(PUT_REFUSAL[error.reason as keyof typeof PUT_REFUSAL], { cause: error });
        throw error;
      }
    });
    console.log(`${plural(cardIds.length, "card")} stored.`);
    console.log(`  inventory: ${shortId(inventory.id, ids)}`);
    for (const { cardId, slot: at } of result.placements) {
      const { row, column } = slotCell(at, INVENTORY_COLUMNS);
      console.log(`  ${shortId(cardId, allIds)}  slot ${at} (r${row + 1} c${column + 1})`);
    }
  });
}

/**
 * Print each repaired card on its own line. Print nothing when no cards changed.
 * `allIds` is every card ID in the workspace, for short IDs.
 */
/** Whether a repair changed any card. */
export function repairChanged({ moved, unglued, cleared }: InventoryRepair): boolean {
  return moved.length > 0 || unglued.length > 0 || cleared.length > 0;
}

export function printInventoryRepair(repair: InventoryRepair, allIds: string[]): void {
  for (const { cardId, slot } of repair.moved)
    console.log(`  ${shortId(cardId, allIds)}  moved to slot ${slot}`);
  for (const cardId of repair.unglued) console.log(`  ${shortId(cardId, allIds)}  unglued`);
  for (const cardId of repair.cleared)
    console.log(`  ${shortId(cardId, allIds)}  put back on the canvas`);
}

/**
 * Repair overlaps and remove stored cards from glue groups across the workspace.
 * Use this to resolve `kozane doctor` findings before the next inventory write.
 */
export async function inventoryRepair(): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
    const repair = await service.repair(db, createServiceContext());
    if (!repairChanged(repair)) {
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
    const context = createServiceContext(getUiConfigForRoot(root));
    const { allIds, cardIds, position } = await composeWrite(db, async (tx) => {
      const { allIds, cardIds, namespaceId } = await resolveCardGroup(tx, requestedCardIds);
      const position =
        x === undefined || y === undefined
          ? undefined
          : clampToBounds(x, y, canvasBoundsForRoot(root));
      try {
        await service.takeInTx(tx, context, namespaceId, {
          cards: cardIds.map((cardId) => ({ cardId, ...position })),
        });
      } catch (error) {
        if (error instanceof BatchValidationError && error.reason in TAKE_REFUSAL)
          throw new Error(TAKE_REFUSAL[error.reason as keyof typeof TAKE_REFUSAL], {
            cause: error,
          });
        throw error;
      }
      return { allIds, cardIds, position };
    });
    console.log(`${plural(cardIds.length, "card")} returned to the canvas.`);
    for (const cardId of cardIds) console.log(`  id: ${shortId(cardId, allIds)}`);
    if (position) console.log(`  position: (${position.posX}, ${position.posY})`);
  });
}
