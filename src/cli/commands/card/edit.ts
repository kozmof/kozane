import { updateInTx, updatePositionsInTx, setLayerInTx } from "../../../services/cards.js";
import { createServiceContext } from "../../../services/context.js";
import { composeWrite } from "../../../db/database.js";
import { ValidationError } from "../../../services/errors.js";
/** Card edits: text, position, layer, partition, namespace, and deletion. */
import { eq } from "drizzle-orm";
import { runWorkspaceCommand } from "../../lib/workspace-command.js";
import { partitionTable, cardTable } from "../../../db/schema.js";
import { reassignCardsToPartition } from "../../../db/api/card.js";
import { getAllLayers } from "../../../db/api/layer.js";
import { findById, resolveShortId, shortId } from "../../lib/short-id.js";
import { loadCards, movedCoordinate, resolveCardGroup } from "../../lib/card-refs.js";
import { resolveLayerRef } from "../../lib/layer-ref.js";
import { canvasBoundsForRoot, clampToBounds } from "../../../lib/server/canvas.js";
import { contentMaxForRoot } from "../../../lib/server/content-limit.js";
import { deleteNamespaceCards, moveCardsToNamespace } from "../../../db/api/composite.js";
import { getAllNamespaces } from "../../../db/api/namespace.js";
import { getAllPartitions } from "../../../db/api/partition.js";
import { type CardMoveOptions } from "./options.js";

/**
 * Move a card to another layer in its namespace. Resolve the layer using the card's
 * namespace, regardless of `--namespace`.
 */
export async function cardSetLayer(requestedCardId: string, requestedLayer: string): Promise<void> {
  await runWorkspaceCommand(async ({ db, root }) => {
    const context = createServiceContext({
      contentMax: contentMaxForRoot(root),
      ...canvasBoundsForRoot(root),
    });
    const { cards, cardId, layer } = await composeWrite(db, async (tx) => {
      const cards = await tx
        .select({ id: cardTable.id, namespaceId: partitionTable.namespaceId })
        .from(cardTable)
        .innerJoin(partitionTable, eq(cardTable.partitionId, partitionTable.id));
      const cardId = resolveShortId(
        requestedCardId,
        cards.map(({ id }) => id),
        "Card",
      );
      const { namespaceId } = findById(cards, cardId, "Card");
      const layers = await getAllLayers({ db: tx, namespaceId });
      const layerId = resolveLayerRef(layers, requestedLayer);

      try {
        await setLayerInTx(tx, context, namespaceId, { cardIds: [cardId], layerId });
      } catch (error) {
        if (error instanceof ValidationError)
          throw new Error("Card and layer do not belong to the same namespace.", { cause: error });
        throw error;
      }
      const layer = findById(layers, layerId, "Layer");
      return { cards, cardId, layer };
    });
    console.log("Card moved to another layer.");
    console.log(
      `  id   : ${shortId(
        cardId,
        cards.map(({ id }) => id),
      )}`,
    );
    console.log(`  layer: ${layer.name}`);
  });
}

export async function cardMove(requestedCardId: string, { x, y }: CardMoveOptions): Promise<void> {
  if (x === undefined && y === undefined) throw new Error("card move requires --x or --y.");
  await runWorkspaceCommand(async ({ db, root }) => {
    const context = createServiceContext({
      contentMax: contentMaxForRoot(root),
      ...canvasBoundsForRoot(root),
    });
    const { allIds, cardId, position } = await composeWrite(db, async (tx) => {
      const { allIds, cardIds, namespaceId } = await resolveCardGroup(tx, [requestedCardId]);
      const cardId = cardIds[0];
      const card = findById(await loadCards(tx, cardIds), cardId, "Card");
      const position = clampToBounds(
        x === undefined ? card.posX : movedCoordinate(x, card.posX),
        y === undefined ? card.posY : movedCoordinate(y, card.posY),
        canvasBoundsForRoot(root),
      );
      try {
        await updatePositionsInTx(tx, context, namespaceId, {
          positions: [{ cardId, ...position }],
        });
      } catch (error) {
        if (error instanceof ValidationError)
          throw new Error("Card does not belong to the namespace.", { cause: error });
        throw error;
      }
      return { allIds, cardId, position };
    });
    console.log("Card moved.");
    console.log(`  id: ${shortId(cardId, allIds)}`);
    console.log(`  position: (${position.posX}, ${position.posY})`);
  });
}

export async function cardEdit(requestedCardId: string, rawContent: string): Promise<void> {
  await runWorkspaceCommand(async ({ db, root }) => {
    const context = createServiceContext({
      contentMax: contentMaxForRoot(root),
      ...canvasBoundsForRoot(root),
    });
    const { allIds, cardId, updated } = await composeWrite(db, async (tx) => {
      const { allIds, cardIds, namespaceId } = await resolveCardGroup(tx, [requestedCardId]);
      const cardId = cardIds[0];
      try {
        const updated = await updateInTx(tx, context, namespaceId, cardId, { content: rawContent });
        return { allIds, cardId, updated };
      } catch (error) {
        if (
          error instanceof ValidationError &&
          error.message === "Inventory has no free slot there"
        )
          throw new Error("The longer text does not fit anywhere in the card's inventory.", {
            cause: error,
          });
        throw error;
      }
    });
    console.log("Card updated.");
    console.log(`  id: ${shortId(cardId, allIds)}`);
    if (updated.inventory)
      console.log(`  moved to inventory slot ${updated.inventory.slot} to fit its text`);
  });
}

export async function cardDelete(requestedIds: string[]): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
    const { allIds, cardIds, namespaceId } = await resolveCardGroup(db, requestedIds);
    const result = await deleteNamespaceCards({ db, namespaceId, cardIds });
    if (!result.ok) throw new Error("Cards must belong to the same namespace.");
    console.log(`${cardIds.length} ${cardIds.length === 1 ? "card" : "cards"} deleted.`);
    for (const cardId of cardIds) console.log(`  card: ${shortId(cardId, allIds)}`);
  });
}

export async function cardSetPartition(
  requestedPartitionId: string,
  requestedCardIds: string[],
): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
    const { cardIds, namespaceId } = await resolveCardGroup(db, requestedCardIds);
    const partitions = await getAllPartitions({ db, namespaceId });
    const partitionId = resolveShortId(
      requestedPartitionId,
      partitions.map(({ id }) => id),
      "Partition",
    );
    const result = await reassignCardsToPartition({ db, namespaceId, cardIds, partitionId });
    if (!result.ok)
      throw new Error(
        result.reason === "foreign-cards"
          ? "Cards must belong to the same namespace."
          : "Partition does not belong to the cards' namespace.",
      );
    console.log(`${cardIds.length} ${cardIds.length === 1 ? "card" : "cards"} moved to partition.`);
    console.log(
      `  partition: ${shortId(
        partitionId,
        partitions.map(({ id }) => id),
      )}`,
    );
  });
}

export async function cardSetNamespace(
  requestedNamespaceId: string,
  requestedCardIds: string[],
): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
    const { cardIds, namespaceId: sourceNamespaceId } = await resolveCardGroup(
      db,
      requestedCardIds,
    );
    const namespaces = await getAllNamespaces({ db });
    const targetNamespaceId = resolveShortId(
      requestedNamespaceId,
      namespaces.map(({ id }) => id),
      "Namespace",
    );
    const result = await moveCardsToNamespace({
      db,
      sourceNamespaceId,
      targetNamespaceId,
      cardIds,
    });
    if (!result.ok)
      throw new Error(
        result.reason === "missing-namespace"
          ? "Target namespace not found."
          : "Cards must belong to the same source namespace.",
      );
    console.log(`${cardIds.length} ${cardIds.length === 1 ? "card" : "cards"} moved to namespace.`);
    console.log(
      `  namespace: ${shortId(
        targetNamespaceId,
        namespaces.map(({ id }) => id),
      )}`,
    );
  });
}
