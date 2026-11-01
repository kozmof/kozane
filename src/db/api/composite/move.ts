/** Moving cards to another namespace, remapping their partitions and layers by name. */
import { withTx, type DB } from "../../tx.js";
import {
  cardsBelongToNamespace,
  getCardPartitionNames,
  getCardLayerNames,
  reassignCardsToLayerInTx,
} from "../card.js";
import { getAllPartitions, addPartition } from "../partition.js";
import { getAllLayers, addLayer } from "../layer.js";
import { unglueCardsInTx } from "../glue.js";
import { releaseCardsInTx } from "../inventory.js";
import { type BatchResult } from "../utils.js";
import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { namespaceTable, cardTable, taskspaceTable } from "../../schema.js";
import { BATCH_MAX, chunked } from "../../../lib/constants.js";

/** Refusals for a namespace move: foreign source cards, or a target that does not exist. */
export type MoveCardsResult = BatchResult<"foreign-cards" | "missing-namespace">;

type MoveCardsToNamespace = {
  db: DB;
  sourceNamespaceId: string;
  targetNamespaceId: string;
  cardIds: string[];
};

type RemapCardsByName = {
  /** Each card paired with its current partition or layer name. */
  current: { cardId: string; name: string }[];
  /** Target partitions or layers matched against `current` by name. */
  targets: { id: string; name: string }[];
  create: (name: string) => Promise<string>;
  assign: (targetId: string, cardIds: string[]) => Promise<void>;
};

/**
 * Resolve a card's partition or layer by name in the target namespace, creating it if needed.
 * Both ownership IDs must change when moving across namespaces.
 */
async function remapCardsByName({
  current,
  targets,
  create,
  assign,
}: RemapCardsByName): Promise<void> {
  // Group cards by the resolved target ID in one pass to avoid a second lookup.
  // Index targets once so each card needs one map lookup.
  const targetIdByName = new Map(targets.map(({ id, name }) => [name, id]));
  const groups = new Map<string, string[]>();
  for (const { cardId, name } of current) {
    let targetId = targetIdByName.get(name);
    if (targetId === undefined) {
      targetId = await create(name);
      targetIdByName.set(name, targetId);
    }
    const group = groups.get(targetId) ?? [];
    group.push(cardId);
    groups.set(targetId, group);
  }

  for (const [targetId, ids] of groups) await assign(targetId, ids);
}

/**
 * Moves cards from one namespace to another, preserving partition and layer names.
 * For each unique source name, a matching partition/layer is found in the target
 * namespace or created if absent. All updates are atomic.
 * Refuses if any card does not belong to sourceNamespaceId. Throws when the two namespaces
 * are the same, since the move would otherwise unglue and unstore the cards and change nothing
 * else.
 *
 * Arriving cards are restacked above each destination layer's cards, as a layer move is.
 * A card whose taskspace is placed in another namespace loses that link, because a placed
 * taskspace only originates cards in its own namespace (see
 * {@link createCardFromTaskspace}).
 */
export async function moveCardsToNamespace({
  db,
  sourceNamespaceId,
  targetNamespaceId,
  cardIds: requestedIds,
}: MoveCardsToNamespace): Promise<MoveCardsResult> {
  if (sourceNamespaceId === targetNamespaceId)
    throw new Error("Target namespace must differ from source");
  if (requestedIds.length === 0) return { ok: true };
  const cardIds = [...new Set(requestedIds)];
  return withTx(db, async (tx) => {
    // Check the target inside the transaction. Otherwise creating its partitions would fail
    // on the foreign key and surface as a server error instead of a refusal.
    const target = await tx
      .select({ id: namespaceTable.id })
      .from(namespaceTable)
      .where(eq(namespaceTable.id, targetNamespaceId))
      .get();
    if (!target) return { ok: false, reason: "missing-namespace" };

    const owned = await cardsBelongToNamespace({ db: tx, namespaceId: sourceNamespaceId, cardIds });
    if (!owned.ok) return owned;

    const cardPartitions = await getCardPartitionNames({ db: tx, cardIds });
    await remapCardsByName({
      current: cardPartitions.map(({ cardId, partitionName }) => ({ cardId, name: partitionName })),
      targets: await getAllPartitions({ db: tx, namespaceId: targetNamespaceId }),
      create: (name) => addPartition({ db: tx, namespaceId: targetNamespaceId, name }),
      assign: async (partitionId, ids) => {
        for (const batch of chunked(ids, { size: BATCH_MAX }))
          await tx.update(cardTable).set({ partitionId }).where(inArray(cardTable.id, batch));
      },
    });

    const cardLayers = await getCardLayerNames({ db: tx, cardIds });
    await remapCardsByName({
      current: cardLayers.map(({ cardId, layerName }) => ({ cardId, name: layerName })),
      targets: await getAllLayers({ db: tx, namespaceId: targetNamespaceId }),
      create: async (name) => (await addLayer({ db: tx, namespaceId: targetNamespaceId, name })).id,
      // Partitions were remapped above, so the cards already belong to the target namespace
      // and the layer move's ownership check holds.
      assign: async (layerId, ids) => {
        const moved = await reassignCardsToLayerInTx({
          db: tx,
          namespaceId: targetNamespaceId,
          cardIds: ids,
          layerId,
        });
        if (!moved.ok) throw new Error(`moveCardsToNamespace: layer move refused: ${moved.reason}`);
      },
    });

    const foreignTaskspaces = tx
      .select({ id: taskspaceTable.id })
      .from(taskspaceTable)
      .where(
        and(
          isNotNull(taskspaceTable.namespaceId),
          ne(taskspaceTable.namespaceId, targetNamespaceId),
        ),
      );
    for (const batch of chunked(cardIds, { size: BATCH_MAX }))
      await tx
        .update(cardTable)
        .set({ taskspaceId: null })
        .where(
          and(inArray(cardTable.id, batch), inArray(cardTable.taskspaceId, foreignTaskspaces)),
        );

    // Moving a card to another namespace removes it from its glue group.
    await unglueCardsInTx({ db: tx, cardIds });

    // Inventories belong to one namespace, so a stored card arrives on the target canvas at
    // the position it had before it was stored.
    await releaseCardsInTx({ db: tx, cardIds });

    return { ok: true };
  });
}
