import { layerTable } from "../schema.js";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { NeedsNamespace, NeedsNamespaceLayer, Layer } from "./types.js";
import { assertFound, assertNameWithinLimit } from "./utils.js";
import { withTx, type DB } from "../tx.js";

/** Choose the lowest position, using the ID to break ties. */
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
  // Compute the next position inside INSERT so concurrent creates cannot claim the same
  // position. `addLayer` can already run inside a transaction.
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
 * Reason a reorder was refused. `stale` means the layer count changed since the caller loaded
 * it and can be resolved by reloading.
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

    // Reorder layers in one CASE statement. The validated list includes every layer, and ELSE
    // preserves unmatched positions.
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
