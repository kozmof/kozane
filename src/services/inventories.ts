import type { DB } from "../db/database.js";
import type { ServiceContext } from "./context.js";
import { ValidationError } from "./errors.js";
import { clamp } from "../lib/constants.js";
function clampPosition(posX: number, posY: number, context: ServiceContext) {
  return {
    posX: Math.round(clamp(posX, 0, context.canvasWidth)),
    posY: Math.round(clamp(posY, 0, context.canvasHeight)),
  };
}
import {
  addInventory,
  updateInventory,
  deleteInventory,
  stowCards,
  takeCards,
} from "../db/api/inventory.js";
import {
  optionalBoundedName,
  optionalNumber,
  requireStringArray,
  requireObjectArray,
  requireString,
  requireUniqueStrings,
} from "./validation.js";
import { INVENTORY_SLOT_MAX } from "../lib/constants.js";
import type { TakenCard } from "../lib/inventory.js";
import { rejectBatch } from "./rejection.js";

export async function create(
  db: DB,
  context: ServiceContext,
  namespaceId: string,
  body: Record<string, unknown>,
) {
  const posX = optionalNumber(body, "posX");
  const posY = optionalNumber(body, "posY");
  if (posX === undefined || posY === undefined)
    throw new ValidationError("posX and posY are required");
  const name = optionalBoundedName(body);
  // The whole stored row, with the position clamped to the canvas as a warp's is.
  return await addInventory({ db, namespaceId, name, ...clampPosition(posX, posY, context) });
}

export async function update(
  db: DB,
  context: ServiceContext,
  namespaceId: string,
  inventoryId: string,
  body: Record<string, unknown>,
) {
  const posX = optionalNumber(body, "posX");
  const posY = optionalNumber(body, "posY");
  if ((posX === undefined) !== (posY === undefined))
    throw new ValidationError("posX and posY must be sent together");
  const name = optionalBoundedName(body);
  if (posX === undefined && name === undefined)
    throw new ValidationError("Send posX and posY, name, or both");
  return await updateInventory({
    db,
    namespaceId,
    inventoryId,
    name,
    ...(posX !== undefined &&
      posY !== undefined && { position: clampPosition(posX, posY, context) }),
  });
}

export async function remove(
  db: DB,
  context: ServiceContext,
  namespaceId: string,
  inventoryId: string,
) {
  // Its cards go back where they were on the canvas. Their IDs let the board draw them
  // there without waiting for the next poll.
  return await deleteInventory({ db, namespaceId, inventoryId });
}

export async function stow(
  db: DB,
  context: ServiceContext,
  namespaceId: string,
  inventoryId: string,
  body: Record<string, unknown>,
) {
  const cardIds = requireStringArray(body, "cardIds");
  const slot = optionalNumber(body, "slot");
  if (slot !== undefined && (!Number.isInteger(slot) || slot < 0 || slot > INVENTORY_SLOT_MAX))
    throw new ValidationError(`slot must be an integer from 0 to ${INVENTORY_SLOT_MAX}`);
  const result = await stowCards({ db, namespaceId, inventoryId, cardIds, slot: slot ?? null });
  if (!result.ok) rejectBatch(result.reason);
  return { placements: result.placements, clearedCardIds: result.clearedCardIds };
}

export async function take(
  db: DB,
  context: ServiceContext,
  namespaceId: string,
  body: Record<string, unknown>,
) {
  const cards = requireObjectArray(body, "cards", (item): TakenCard => {
    const cardId = requireString(item, "cardId");
    const posX = optionalNumber(item, "posX");
    const posY = optionalNumber(item, "posY");
    if ((posX === undefined) !== (posY === undefined))
      throw new ValidationError("posX and posY must be sent together");
    return posX === undefined || posY === undefined
      ? { cardId }
      : { cardId, position: clampPosition(posX, posY, context) };
  });
  requireUniqueStrings(
    cards.map(({ cardId }) => cardId),
    "cards",
  );
  const result = await takeCards({ db, namespaceId, cards });
  if (!result.ok) rejectBatch(result.reason);
  // The stored positions, so a board that sent a fractional drop point can draw what was kept.
  return { cards: cards.map(({ cardId, position }) => ({ cardId, ...position })) };
}
