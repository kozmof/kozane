import { layerTable } from "../schema.js";
import { and, asc, eq, max } from "drizzle-orm";
import type { NeedsProject, NeedsProjectLayer, Layer } from "./types.js";
import { assertFound } from "./utils.js";

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
  const top = await db
    .select({ position: max(layerTable.position) })
    .from(layerTable)
    .where(eq(layerTable.projectId, projectId))
    .get();
  const position = (top?.position ?? -1) + 1;
  const [row] = await db
    .insert(layerTable)
    .values({ projectId, name, position, isDefault })
    .returning({ id: layerTable.id });
  return { id: row.id, position };
}

type DeleteLayer = NeedsProjectLayer;
export async function deleteLayer({ db, projectId, layerId }: DeleteLayer): Promise<void> {
  const deleted = await db
    .delete(layerTable)
    .where(and(eq(layerTable.projectId, projectId), eq(layerTable.id, layerId)))
    .returning({ id: layerTable.id });
  assertFound(deleted, `Layer projectId=${projectId} layerId=${layerId}`);
}

type UpdateLayerName = NeedsProjectLayer & { name: string };
export async function updateLayerName({
  db,
  projectId,
  layerId,
  name,
}: UpdateLayerName): Promise<void> {
  const updated = await db
    .update(layerTable)
    .set({ name })
    .where(and(eq(layerTable.projectId, projectId), eq(layerTable.id, layerId)))
    .returning({ id: layerTable.id });
  assertFound(updated, `Layer projectId=${projectId} layerId=${layerId}`);
}
