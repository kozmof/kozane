import { layerTable } from "../schema.js";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { NeedsNamespace, NeedsNamespaceLayer, Layer } from "./types.js";
import { assertFound, assertNameWithinLimit } from "./utils.js";
import { withTx, type DB } from "../tx.js";

/** Ordered the way the canvas stacks them: lowest position first, id as the tiebreak. */
export async function getAllLayers({ db, namespaceId }: NeedsNamespace): Promise<Layer[]> {
  return db
    .select()
    .from(layerTable)
    .where(eq(layerTable.namespaceId, namespaceId))
    .orderBy(asc(layerTable.position), asc(layerTable.id));
}

type GetLayer = NeedsNamespaceLayer;
export async function getLayer({ db, namespaceId, layerId }: GetLayer): Promise<Layer | undefined> {
  // namespaceId is redundant for the lookup (layerId is a UUID) but is checked as a
  // defence-in-depth access boundary, the same way getPartition does it.
  return db
    .select()
    .from(layerTable)
    .where(and(eq(layerTable.namespaceId, namespaceId), eq(layerTable.id, layerId)))
    .get();
}

export async function getDefaultLayer({
  db,
  namespaceId,
}: NeedsNamespace): Promise<Layer | undefined> {
  return db
    .select()
    .from(layerTable)
    .where(and(eq(layerTable.namespaceId, namespaceId), eq(layerTable.isDefault, true)))
    .get();
}

type AddLayer = NeedsNamespace & { name: string; isDefault?: boolean };

/** Appends the layer on top of the namespace's existing ones (position = current max + 1). */
export async function addLayer({
  db,
  namespaceId,
  name,
  isDefault = false,
}: AddLayer): Promise<{ id: string; position: number }> {
  assertNameWithinLimit(name, "Layer name");
  // The next position is computed inside the INSERT rather than read first: two concurrent
  // creates would otherwise see the same max and both claim it. Nested transactions are not
  // available here either — addLayer is itself called from inside one (moveCardsToNamespace).
  const [row] = await db
    .insert(layerTable)
    .values({
      namespaceId,
      name,
      isDefault,
      position: sql`(SELECT COALESCE(MAX(${layerTable.position}), -1) + 1 FROM ${layerTable} WHERE ${layerTable.namespaceId} = ${namespaceId})`,
    })
    .returning({ id: layerTable.id, position: layerTable.position });
  return { id: row.id, position: row.position };
}

type DeleteLayer = NeedsNamespaceLayer;

/**
 * Deletes the layer row itself, which cascades every card on it away with it. Callers
 * that mean "remove this layer from the namespace" want `deleteLayerWithReassign` in
 * composite.ts, which rehomes the cards on the default layer first.
 */
export async function deleteLayer({ db, namespaceId, layerId }: DeleteLayer): Promise<void> {
  const deleted = await db
    .delete(layerTable)
    .where(and(eq(layerTable.namespaceId, namespaceId), eq(layerTable.id, layerId)))
    .returning({ id: layerTable.id });
  assertFound(deleted, `Layer namespaceId=${namespaceId} layerId=${layerId}`);
}

type ReorderLayers = { db: DB; namespaceId: string; layerIds: string[] };

/**
 * Why a reorder was refused. `stale` means the namespace has a different number of layers
 * than the caller listed — someone else added or deleted one — and is the only reason a
 * reload fixes on its own.
 */
export type ReorderRejection = "duplicate" | "stale" | "foreign";
export type ReorderResult = { ok: true } | { ok: false; reason: ReorderRejection };

/**
 * Renumbers a namespace's layers from `layerIds`, which must list every layer of the
 * namespace exactly once, bottom to top. A list that does not match the namespace's layers
 * renumbers nothing rather than half of it, and says which way it failed to match.
 */
export async function reorderLayers({
  db,
  namespaceId,
  layerIds,
}: ReorderLayers): Promise<ReorderResult> {
  return withTx(db, async (tx) => {
    const existing = await getAllLayers({ db: tx, namespaceId });
    const requested = new Set(layerIds);
    if (requested.size !== layerIds.length) return { ok: false, reason: "duplicate" };
    if (requested.size !== existing.length) return { ok: false, reason: "stale" };
    if (!existing.every(({ id }) => requested.has(id))) return { ok: false, reason: "foreign" };

    // One statement rather than one per layer. Same shape as the position and zIndex
    // updates in card.ts, including the ELSE, and safe for the same reason: the checks
    // above prove `layerIds` is exactly this namespace's layer set, so no row the WHERE
    // matches lacks a WHEN. `position` carries no unique index, so there is no
    // half-applied ordering to collide with along the way either.
    //
    // The ELSE writes the column back to itself, so should the WHERE and the WHENs ever
    // diverge, the row is left where it was rather than taking a NULL into a NOT NULL
    // column and aborting the statement.
    const whens = layerIds.map((layerId, position) => sql`WHEN ${layerId} THEN ${position}`);
    await tx
      .update(layerTable)
      .set({
        position: sql`CASE ${layerTable.id} ${sql.join(whens, sql` `)} ELSE ${layerTable.position} END`,
      })
      .where(and(eq(layerTable.namespaceId, namespaceId), inArray(layerTable.id, layerIds)));
    return { ok: true };
  });
}

type UpdateLayerName = NeedsNamespaceLayer & { name: string };
export async function updateLayerName({
  db,
  namespaceId,
  layerId,
  name,
}: UpdateLayerName): Promise<void> {
  assertNameWithinLimit(name, "Layer name");
  const updated = await db
    .update(layerTable)
    .set({ name })
    .where(and(eq(layerTable.namespaceId, namespaceId), eq(layerTable.id, layerId)))
    .returning({ id: layerTable.id });
  assertFound(updated, `Layer namespaceId=${namespaceId} layerId=${layerId}`);
}
