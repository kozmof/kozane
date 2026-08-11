import { layerTable } from "../schema.js";
import { and, asc, eq, sql } from "drizzle-orm";
import type { NeedsProject, NeedsProjectLayer, Layer } from "./types.js";
import { assertFound, assertNameWithinLimit } from "./utils.js";
import { withTx, type DB } from "../tx.js";

/** Ordered the way the canvas stacks them: lowest position first, id as the tiebreak. */
export async function getAllLayers({ db, projectId }: NeedsProject): Promise<Layer[]> {
  return db
    .select()
    .from(layerTable)
    .where(eq(layerTable.projectId, projectId))
    .orderBy(asc(layerTable.position), asc(layerTable.id));
}

type GetLayer = NeedsProjectLayer;
export async function getLayer({ db, projectId, layerId }: GetLayer): Promise<Layer | undefined> {
  // projectId is redundant for the lookup (layerId is a UUID) but is checked as a
  // defence-in-depth access boundary, the same way getBundle does it.
  return db
    .select()
    .from(layerTable)
    .where(and(eq(layerTable.projectId, projectId), eq(layerTable.id, layerId)))
    .get();
}

export async function getDefaultLayer({ db, projectId }: NeedsProject): Promise<Layer | undefined> {
  return db
    .select()
    .from(layerTable)
    .where(and(eq(layerTable.projectId, projectId), eq(layerTable.isDefault, true)))
    .get();
}

type AddLayer = NeedsProject & { name: string; isDefault?: boolean };

/** Appends the layer on top of the project's existing ones (position = current max + 1). */
export async function addLayer({
  db,
  projectId,
  name,
  isDefault = false,
}: AddLayer): Promise<{ id: string; position: number }> {
  assertNameWithinLimit(name, "Layer name");
  // The next position is computed inside the INSERT rather than read first: two concurrent
  // creates would otherwise see the same max and both claim it. Nested transactions are not
  // available here either — addLayer is itself called from inside one (moveCardsToProject).
  const [row] = await db
    .insert(layerTable)
    .values({
      projectId,
      name,
      isDefault,
      position: sql`(SELECT COALESCE(MAX(${layerTable.position}), -1) + 1 FROM ${layerTable} WHERE ${layerTable.projectId} = ${projectId})`,
    })
    .returning({ id: layerTable.id, position: layerTable.position });
  return { id: row.id, position: row.position };
}

type DeleteLayer = NeedsProjectLayer;

/**
 * Deletes the layer row itself, which cascades every card on it away with it. Callers
 * that mean "remove this layer from the project" want `deleteLayerWithReassign` in
 * composite.ts, which rehomes the cards on the default layer first.
 */
export async function deleteLayer({ db, projectId, layerId }: DeleteLayer): Promise<void> {
  const deleted = await db
    .delete(layerTable)
    .where(and(eq(layerTable.projectId, projectId), eq(layerTable.id, layerId)))
    .returning({ id: layerTable.id });
  assertFound(deleted, `Layer projectId=${projectId} layerId=${layerId}`);
}

type ReorderLayers = { db: DB; projectId: string; layerIds: string[] };

/**
 * Why a reorder was refused. `stale` means the project has a different number of layers
 * than the caller listed — someone else added or deleted one — and is the only reason a
 * reload fixes on its own.
 */
export type ReorderRejection = "duplicate" | "stale" | "foreign";
export type ReorderResult = { ok: true } | { ok: false; reason: ReorderRejection };

/**
 * Renumbers a project's layers from `layerIds`, which must list every layer of the
 * project exactly once, bottom to top. A list that does not match the project's layers
 * renumbers nothing rather than half of it, and says which way it failed to match.
 */
export async function reorderLayers({
  db,
  projectId,
  layerIds,
}: ReorderLayers): Promise<ReorderResult> {
  return withTx(db, async (tx) => {
    const existing = await getAllLayers({ db: tx, projectId });
    const requested = new Set(layerIds);
    if (requested.size !== layerIds.length) return { ok: false, reason: "duplicate" };
    if (requested.size !== existing.length) return { ok: false, reason: "stale" };
    if (!existing.every(({ id }) => requested.has(id))) return { ok: false, reason: "foreign" };

    for (const [position, layerId] of layerIds.entries()) {
      await tx
        .update(layerTable)
        .set({ position })
        .where(and(eq(layerTable.projectId, projectId), eq(layerTable.id, layerId)));
    }
    return { ok: true };
  });
}

type UpdateLayerName = NeedsProjectLayer & { name: string };
export async function updateLayerName({
  db,
  projectId,
  layerId,
  name,
}: UpdateLayerName): Promise<void> {
  assertNameWithinLimit(name, "Layer name");
  const updated = await db
    .update(layerTable)
    .set({ name })
    .where(and(eq(layerTable.projectId, projectId), eq(layerTable.id, layerId)))
    .returning({ id: layerTable.id });
  assertFound(updated, `Layer projectId=${projectId} layerId=${layerId}`);
}
