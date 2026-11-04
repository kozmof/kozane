import type { CardWithGlue } from "../lib/types.js";

import { getPartition } from "../db/api/partition.js";
import { getDefaultLayer, getLayer } from "../db/api/layer.js";
import { getScope } from "../db/api/scope.js";
import { addScopeRel } from "../db/api/scope-rel.js";
import { withTx } from "../db/database.js";
import { addCardInTx } from "../db/api/card.js";

import { stowCardsInTx } from "../db/api/inventory.js";
import { checkCardContent, clamp } from "../lib/constants.js";
import { optionalNumber, optionalId, requireString } from "./validation.js";
import { rejectBatch } from "./rejection.js";

import type { DB } from "../db/database.js";
import type { ServiceContext } from "./context.js";
import { ValidationError } from "./errors.js";
export async function create(
  db: DB,
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
  const { id, stored, inventory, placements } = await withTx(db, async (tx) => {
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
  });

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
