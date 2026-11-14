import {
  deleteNamespaceCardsInTx,
  moveCardsToNamespaceInTx,
  squashNamespaceCard,
  type SquashCardResult,
} from "../api/composite.js";
import {
  reassignCardsToPartitionInTx,
  reassignCardsToLayerInTx,
  updateCardInTx,
  withCardInventory,
  type CardStacking,
  reassignCardsStackOrder,
  updateNamespaceCardPositionsInTx,
  addCardInTx,
} from "../api/card.js";
import { prepareInput } from "./prepare-input.js";
import {
  optionalNullableNumber,
  optionalString,
  requireObjectArray,
  requireFiniteNumber,
  requireUniqueStrings,
  requireStringArray,
  optionalNumber,
  optionalId,
  requireString,
} from "./validation.js";
import { refitStoredCardInTx, type Refit, stowCardsInTx } from "../api/inventory.js";
import { BATCH_MAX, CARD_WIDTH_RANGE, checkCardContent, clamp } from "../constants/index.js";
import { requireCardInNamespace } from "./guards.js";
import { NotFoundError, ValidationError } from "./errors.js";
import { getPartition } from "../api/partition.js";
import { getDefaultLayer, getLayer } from "../api/layer.js";
import { getScope } from "../api/scope.js";
import { addScopeRel } from "../api/scope-rel.js";
import { withTx } from "../database.js";
import { rejectBatch } from "./rejection.js";
export type {
  CardCreateInput,
  CardUpdateFields,
  CardUpdateInput,
  CardUpdatePositionsInput,
  CardRemoveInput,
  CardMoveInput,
  CardSetLayerInput,
  CardSetPartitionInput,
  CardSetStackingInput,
  CardSquashInput,
} from "./inputs.js";
import type { CardWithGlue } from "../types.js";

import type { DB, Tx } from "../database.js";
import type { ServiceContext } from "./context.js";
/** Accepts untrusted input; CardCreateInput describes the valid caller shape. */
export async function create(
  db: DB,
  context: ServiceContext,
  namespaceId: string,
  body: Record<string, unknown>,
) {
  const prepared = prepareInput(body);
  return withTx(db, (tx) => createPreparedInTx(tx, context, namespaceId, prepared));
}

export async function createInTx(
  tx: Tx,
  context: ServiceContext,
  namespaceId: string,
  body: Record<string, unknown>,
) {
  return createPreparedInTx(tx, context, namespaceId, prepareInput(body));
}

/** Input is copied before dispatch; domain validation still runs inside the transaction. */
async function createPreparedInTx(
  tx: Tx,
  context: ServiceContext,
  namespaceId: string,
  body: Record<string, unknown>,
) {
  const partitionId = requireString(body, "partitionId");
  const checked = checkCardContent(requireString(body, "content"), context.contentMax);
  if (!checked.ok) throw new ValidationError(checked.issue);
  const content = checked.content;
  const posX = optionalNumber(body, "posX") ?? 0;
  const posY = optionalNumber(body, "posY") ?? 0;
  // Omitted means the top of the card's layer, resolved inside the transaction below.
  const requestedZIndex = optionalNumber(body, "zIndex");
  if (requestedZIndex !== undefined && !Number.isSafeInteger(requestedZIndex))
    throw new ValidationError("zIndex must be an integer");
  const scopeId = optionalId(body, "scopeId");
  const requestedLayerId = optionalId(body, "layerId");
  // An open inventory on the board takes new cards. The card is still given a canvas position,
  // which it goes to if it is ever taken out without being dropped somewhere.
  const inventoryId = optionalId(body, "inventoryId");

  // The lookups run inside the transaction that writes, so a partition, layer, or scope
  // removed by another writer in between is a 400 here rather than a foreign-key 500.
  const { id, stored, inventory, placements } = await (async () => {
    const partition = await getPartition({ db: tx, namespaceId, partitionId });
    if (!partition) throw new ValidationError("Partition not found in namespace");
    if (scopeId && !(await getScope({ db: tx, scopeId })))
      throw new ValidationError("Scope not found");

    // Reject unknown layers so cards cannot silently move to a layer the client did not
    // request.
    const layer = requestedLayerId
      ? await getLayer({ db: tx, namespaceId, layerId: requestedLayerId })
      : await getDefaultLayer({ db: tx, namespaceId });
    if (!layer)
      throw new ValidationError(
        requestedLayerId ? "Layer not found in namespace" : "Namespace has no default layer",
      );

    const fields = {
      partitionId,
      layerId: layer.id,
      content,
      ...{
        posX: Math.round(clamp(posX, 0, context.canvasWidth)),
        posY: Math.round(clamp(posY, 0, context.canvasHeight)),
      },
    };
    // An omitted zIndex goes to the top of the layer. `addCardInTx` owns that default and
    // reports the value it stored.
    const { id: cardId, zIndex } = await addCardInTx({
      db: tx,
      ...fields,
      zIndex: requestedZIndex,
    });
    const stored = { ...fields, zIndex };
    if (scopeId) await addScopeRel({ db: tx, scopeId, cardId });
    if (!inventoryId) return { id: cardId, stored, inventory: null, placements: [] };
    // Throwing rolls the card back with the transaction, so a refused store leaves no card.
    const stowed = await stowCardsInTx({
      db: tx,
      namespaceId,
      inventoryId,
      cardIds: [cardId],
      slot: null,
    });
    if (!stowed.ok) rejectBatch(stowed.reason);
    // The placements can also name cards a repair of the inventory moved, so find this one.
    const placed = stowed.placements.find((p) => p.cardId === cardId);
    if (!placed) throw new Error("stowCardsInTx placed no slot for the new card");
    return {
      id: cardId,
      stored,
      inventory: { id: inventoryId, slot: placed.slot },
      placements: stowed.placements,
    };
  })();

  // Return stored coordinates after clamping so the client renders the saved position
  // immediately. New cards use the configured default width. `placements` lists every slot
  // the store changed, including neighbours a repair of the inventory moved, so the board can
  // apply them without waiting for the next poll.
  const card = {
    id,
    ...stored,
    taskspaceId: null,
    glueId: null,
    width: null,
    inventory,
  } satisfies CardWithGlue;
  return { ...card, placements };
}

export async function updatePositionsInTx(
  db: Tx,
  context: ServiceContext,
  namespaceId: string,
  body: Record<string, unknown>,
) {
  body = prepareInput(body);
  const positions = requireObjectArray(
    body,
    "positions",
    (row) => ({
      cardId: requireString(row, "cardId"),
      posX: Math.round(clamp(requireFiniteNumber(row, "posX"), 0, context.canvasWidth)),
      posY: Math.round(clamp(requireFiniteNumber(row, "posY"), 0, context.canvasHeight)),
    }),
    { message: "positions is required" },
  );
  requireUniqueStrings(
    positions.map((p) => p.cardId),
    "cardId",
  );
  const result = await updateNamespaceCardPositionsInTx({ db, namespaceId, positions });
  if (!result.ok) rejectBatch(result.reason);
  return { ok: true as const };
}
export async function removeInTx(
  db: Tx,
  _context: ServiceContext,
  namespaceId: string,
  body: Record<string, unknown>,
) {
  body = prepareInput(body);
  const cardIds = requireStringArray(body, "cardIds");
  const result = await deleteNamespaceCardsInTx({ db, namespaceId, cardIds });
  if (!result.ok) rejectBatch(result.reason);
  return { ok: true as const };
}

export async function moveInTx(
  db: Tx,
  _context: ServiceContext,
  namespaceId: string,
  body: Record<string, unknown>,
) {
  body = prepareInput(body);
  const targetNamespaceId = requireString(body, "targetNamespaceId");
  const cardIds = requireStringArray(body, "cardIds");
  if (targetNamespaceId === namespaceId)
    throw new ValidationError("Target namespace must differ from source");
  const result = await moveCardsToNamespaceInTx({
    db,
    sourceNamespaceId: namespaceId,
    targetNamespaceId,
    cardIds,
  });
  if (!result.ok) rejectBatch(result.reason);
  return { ok: true as const };
}

export async function setLayerInTx(
  db: Tx,
  _context: ServiceContext,
  namespaceId: string,
  body: Record<string, unknown>,
) {
  body = prepareInput(body);
  const layerId = requireString(body, "layerId");
  const cardIds = requireStringArray(body, "cardIds");
  // Let the transaction validate the destination layer, as in the partition handler.
  const result = await reassignCardsToLayerInTx({ db, namespaceId, cardIds, layerId });
  if (!result.ok) rejectBatch(result.reason);
  // Return the new stacking values assigned above the destination layer's existing cards.
  return { ok: true as const, stacking: result.stacking };
}

export async function setPartitionInTx(
  db: Tx,
  _context: ServiceContext,
  namespaceId: string,
  body: Record<string, unknown>,
) {
  body = prepareInput(body);
  const partitionId = requireString(body, "partitionId");
  const cardIds = requireStringArray(body, "cardIds");
  // Validate the partition inside the write transaction so the reported result cannot become
  // stale between a precheck and the update.
  const result = await reassignCardsToPartitionInTx({ db, namespaceId, cardIds, partitionId });
  if (!result.ok) rejectBatch(result.reason);
  return { ok: true as const };
}

export async function setStacking(
  db: DB,
  _context: ServiceContext,
  namespaceId: string,
  body: Record<string, unknown>,
) {
  body = prepareInput(body);
  const cardIds = requireStringArray(body, "cardIds");
  const direction = requireString(body, "direction");
  if (direction !== "front" && direction !== "back")
    throw new ValidationError('direction must be "front" or "back"');
  const result = await reassignCardsStackOrder({ db, namespaceId, cardIds, direction });
  if (!result.ok) rejectBatch(result.reason);
  // Return each moved card's final stacking value because a glue group may span multiple
  // layers.
  return { ok: true as const, stacking: result.stacking };
}

export async function update(
  db: DB,
  context: ServiceContext,
  namespaceId: string,
  cardId: string,
  body: Record<string, unknown>,
) {
  const prepared = prepareInput(body);
  return withTx(db, (tx) => updateInTx(tx, context, namespaceId, cardId, prepared));
}
export async function updateInTx(
  tx: Tx,
  context: ServiceContext,
  namespaceId: string,
  cardId: string,
  body: Record<string, unknown>,
) {
  body = prepareInput(body);
  // Validate the body before opening the transaction. None of these checks reads the
  // database, so running them inside it would only hold the write lock longer against CLI
  // writers.
  const rawContent = optionalString(body, "content");
  let content: string | undefined;
  if (rawContent !== undefined) {
    const checked = checkCardContent(rawContent, context.contentMax);
    if (!checked.ok) throw new ValidationError(checked.issue);
    content = checked.content;
  }

  const requestedPartitionId =
    body.partitionId === undefined ? undefined : requireString(body, "partitionId");
  const requestedLayerId = body.layerId === undefined ? undefined : requireString(body, "layerId");

  const rawPosX = optionalNumber(body, "posX");
  const rawPosY = optionalNumber(body, "posY");
  const { canvasWidth, canvasHeight } = context;
  const posX = rawPosX === undefined ? undefined : Math.round(clamp(rawPosX, 0, canvasWidth));
  const posY = rawPosY === undefined ? undefined : Math.round(clamp(rawPosY, 0, canvasHeight));
  const zIndex = optionalNumber(body, "zIndex");
  if (zIndex !== undefined && !Number.isSafeInteger(zIndex))
    throw new ValidationError("zIndex must be an integer");

  // Null clears the pinned width and restores `ui.defaultCardWidth`. Reject out-of-range
  // widths rather than clamping them.
  const width = optionalNullableNumber(body, "width");
  const [widthMin, widthMax] = CARD_WIDTH_RANGE;
  if (typeof width === "number" && !Number.isInteger(width))
    throw new ValidationError("width must be an integer");
  if (typeof width === "number" && (width < widthMin || width > widthMax))
    throw new ValidationError(`width must be between ${widthMin} and ${widthMax}`);

  if (
    content === undefined &&
    requestedPartitionId === undefined &&
    requestedLayerId === undefined &&
    posX === undefined &&
    posY === undefined &&
    zIndex === undefined &&
    width === undefined
  )
    throw new ValidationError("No fields to update");

  // Every lookup runs inside the transaction that writes, as in the collection POST, so a
  // card, partition, or layer removed by another writer in between is a 404 or 400 here
  // rather than a foreign-key or not-found 500.
  const { stacking, refit } = await (async (): Promise<{
    stacking: CardStacking[];
    refit: Refit | null;
  }> => {
    const { partitionId } = await requireCardInNamespace(tx, namespaceId, cardId);

    if (
      requestedPartitionId !== undefined &&
      !(await getPartition({ db: tx, namespaceId, partitionId: requestedPartitionId }))
    )
      throw new ValidationError("New partition not found in namespace");
    const newPartitionId = requestedPartitionId;

    if (
      requestedLayerId !== undefined &&
      !(await getLayer({ db: tx, namespaceId, layerId: requestedLayerId }))
    )
      throw new ValidationError("New layer not found in namespace");
    const newLayerId = requestedLayerId;

    // A layer change restacks the card above the destination's cards, as the batch layer
    // route does, so it does not keep a zIndex from the layer it left. An explicit zIndex in
    // the same body is applied afterwards and wins.
    let stacking: CardStacking[] = [];
    if (newLayerId !== undefined) {
      const moved = await reassignCardsToLayerInTx({
        db: tx,
        namespaceId,
        cardIds: [cardId],
        layerId: newLayerId,
      });
      // Both were checked above inside this transaction, so a refusal here is a bug.
      if (!moved.ok) throw new Error(`reassignCardsToLayerInTx refused: ${moved.reason}`);
      // Report the value that ends up stored, so the board does not apply the restack an
      // explicit zIndex replaces below.
      stacking =
        zIndex === undefined
          ? moved.stacking
          : moved.stacking.map((entry) => (entry.cardId === cardId ? { ...entry, zIndex } : entry));
    }

    const rest = { newPartitionId, content, posX, posY, zIndex, width };
    if (Object.values(rest).some((value) => value !== undefined))
      await updateCardInTx({ db: tx, cardId, partitionId, ...rest });
    // Longer text can overlap neighbouring cards in an inventory. Move the edited card to
    // the first free slot and return every changed position, including repaired neighbours,
    // so the board can update immediately.
    if (content === undefined) return { stacking, refit: null };
    const refit = await refitStoredCardInTx({ db: tx, cardId });
    // Throwing rolls the text change back, so a card that no longer fits keeps its old text.
    if (!refit.ok) rejectBatch(refit.reason);
    return { stacking, refit };
  })();

  return {
    ok: true,
    stacking,
    // The stored text after normalization, so the board can show exactly what was saved.
    ...(content !== undefined && { content }),
    ...(refit?.moved && { inventory: { id: refit.moved.inventoryId, slot: refit.moved.slot } }),
    ...(refit && refit.placements.length > 0 && { placements: refit.placements }),
  };
}

export async function removeOne(
  db: DB,
  _context: ServiceContext,
  namespaceId: string,
  cardId: string,
) {
  return withTx(db, (tx) => removeOneInTx(tx, _context, namespaceId, cardId));
}

export async function removeOneInTx(
  db: Tx,
  _context: ServiceContext,
  namespaceId: string,
  cardId: string,
) {
  const result = await deleteNamespaceCardsInTx({ db, namespaceId, cardIds: [cardId] });
  if (!result.ok) throw new NotFoundError("Card");
  return { ok: true as const };
}

type SquashFailure = Extract<SquashCardResult, { ok: false }>["reason"];

// Return actionable messages for problems with the selected card.
const FAILURE_MESSAGE: Record<SquashFailure, string> = {
  "not-found": "Card not found in namespace",
  stored: "Stored cards cannot be squashed. Take the card out of its inventory first",
  indivisible: "Card text does not split into more than one card",
  "too-many": `Card text splits into more than ${BATCH_MAX} cards`,
  "inventory-full": "Card text splits into more pieces than one inventory holds",
};

export async function squash(
  db: DB,
  context: ServiceContext,
  namespaceId: string,
  body: Record<string, unknown>,
) {
  body = prepareInput(body);
  const cardId = requireString(body, "cardId");

  const result = await squashNamespaceCard({ db, namespaceId, cardId, ...context });
  if (!result.ok) throw new ValidationError(FAILURE_MESSAGE[result.reason]);

  // Return full stored rows so clients use the slots and return positions planned here. The
  // pieces start unglued. `stacking` names the cards raised above them.
  return {
    inventory: result.inventory,
    cards: result.cards.map(
      (card) => ({ ...withCardInventory(card), glueId: null }) satisfies CardWithGlue,
    ),
    stacking: result.stacking,
  };
}

export async function updatePositions(
  db: DB,
  context: ServiceContext,
  namespaceId: string,
  body: Record<string, unknown>,
) {
  const prepared = prepareInput(body);
  return withTx(db, (tx) => updatePositionsInTx(tx, context, namespaceId, prepared));
}

export async function setLayer(
  db: DB,
  context: ServiceContext,
  namespaceId: string,
  body: Record<string, unknown>,
) {
  const prepared = prepareInput(body);
  return withTx(db, (tx) => setLayerInTx(tx, context, namespaceId, prepared));
}

export async function remove(
  db: DB,
  context: ServiceContext,
  namespaceId: string,
  body: Record<string, unknown>,
) {
  const prepared = prepareInput(body);
  return withTx(db, (tx) => removeInTx(tx, context, namespaceId, prepared));
}

export async function move(
  db: DB,
  context: ServiceContext,
  namespaceId: string,
  body: Record<string, unknown>,
) {
  const prepared = prepareInput(body);
  return withTx(db, (tx) => moveInTx(tx, context, namespaceId, prepared));
}

export async function setPartition(
  db: DB,
  context: ServiceContext,
  namespaceId: string,
  body: Record<string, unknown>,
) {
  const prepared = prepareInput(body);
  return withTx(db, (tx) => setPartitionInTx(tx, context, namespaceId, prepared));
}
