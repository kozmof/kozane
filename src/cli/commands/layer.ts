import { resolve } from "node:path";
import { requireWorkspace } from "../lib/project.js";
import { commandDbUrl } from "../lib/config.js";
import { runMigrations } from "../lib/db.js";
import { createDb } from "../../db/client.js";
import { cardTable } from "../../db/schema.js";
import { addLayer, getAllLayers, reorderLayers, updateLayerName } from "../../db/api/layer.js";
import { deleteLayerWithReassign } from "../../db/api/composite.js";
import { resolveProjectId } from "../lib/project-selection.js";
import { shortId } from "../lib/short-id.js";
import { resolveLayerRef } from "../lib/layer-ref.js";
import { inArray } from "drizzle-orm";

type LayerOptions = { project?: string };

function fail(error: unknown): never {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

export async function layerAdd(name: string, options: LayerOptions = {}): Promise<void> {
  try {
    const trimmedName = name.trim();
    if (!trimmedName) throw new Error("Layer name cannot be empty.");
    const { root } = requireWorkspace();
    const url = commandDbUrl(resolve(root));
    await runMigrations(url);
    const db = await createDb(url);
    const projectId = await resolveProjectId(db, options.project);
    const { id, position } = await addLayer({ db, projectId, name: trimmedName });
    const layerIds = (await getAllLayers({ db, projectId })).map((layer) => layer.id);
    console.log("Layer added.");
    console.log(`  id      : ${shortId(id, layerIds)}`);
    console.log(`  name    : ${trimmedName}`);
    console.log(`  position: ${position}`);
  } catch (error) {
    fail(error);
  }
}

export async function layerList(options: LayerOptions = {}): Promise<void> {
  try {
    const { root } = requireWorkspace();
    const db = await createDb(commandDbUrl(resolve(root)));
    const projectId = await resolveProjectId(db, options.project);
    const layers = await getAllLayers({ db, projectId });
    if (layers.length === 0) {
      console.log("No layers found.");
      return;
    }
    const layerIds = layers.map((layer) => layer.id);
    const counts = new Map(layers.map((layer) => [layer.id, 0]));
    const cards = await db
      .select({ layerId: cardTable.layerId })
      .from(cardTable)
      .where(inArray(cardTable.layerId, layerIds));
    for (const card of cards) counts.set(card.layerId, (counts.get(card.layerId) ?? 0) + 1);
    for (const layer of layers) {
      const marker = layer.isDefault ? " (default)" : "";
      console.log(
        `${shortId(layer.id, layerIds)}  ${layer.position}  ${counts.get(layer.id) ?? 0}  ${layer.name}${marker}`,
      );
    }
  } catch (error) {
    fail(error);
  }
}

export async function layerRename(
  layerId: string,
  name: string,
  options: LayerOptions = {},
): Promise<void> {
  try {
    const trimmedName = name.trim();
    if (!trimmedName) throw new Error("Layer name cannot be empty.");
    const { root } = requireWorkspace();
    const db = await createDb(commandDbUrl(resolve(root)));
    const projectId = await resolveProjectId(db, options.project);
    const layers = await getAllLayers({ db, projectId });
    const resolvedId = resolveLayerRef(layers, layerId);
    await updateLayerName({ db, projectId, layerId: resolvedId, name: trimmedName });
    console.log("Layer renamed.");
    console.log(
      `  id  : ${shortId(
        resolvedId,
        layers.map((layer) => layer.id),
      )}`,
    );
    console.log(`  name: ${trimmedName}`);
  } catch (error) {
    fail(error);
  }
}

export async function layerMove(
  layerId: string,
  direction: string,
  options: LayerOptions = {},
): Promise<void> {
  try {
    if (direction !== "up" && direction !== "down") {
      throw new Error(`Direction must be "up" or "down", not "${direction}".`);
    }
    const { root } = requireWorkspace();
    const db = await createDb(commandDbUrl(resolve(root)));
    const projectId = await resolveProjectId(db, options.project);
    const layers = await getAllLayers({ db, projectId });
    const resolvedId = resolveLayerRef(layers, layerId);
    // getAllLayers is bottom to top, so "up" is one step later in the list.
    const ids = layers.map((layer) => layer.id);
    const index = ids.indexOf(resolvedId);
    const target = index + (direction === "up" ? 1 : -1);
    if (target < 0 || target >= ids.length) {
      throw new Error(`Layer is already at the ${direction === "up" ? "top" : "bottom"}.`);
    }
    const reordered = [...ids];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    const result = await reorderLayers({ db, projectId, layerIds: reordered });
    if (!result.ok) throw new Error(`Failed to reorder layers (${result.reason}).`);
    console.log(`Layer moved ${direction}.`);
    console.log(`  id      : ${shortId(resolvedId, ids)}`);
    console.log(`  position: ${target}`);
  } catch (error) {
    fail(error);
  }
}

export async function layerDelete(layerId: string, options: LayerOptions = {}): Promise<void> {
  try {
    const { root } = requireWorkspace();
    const db = await createDb(commandDbUrl(resolve(root)));
    const projectId = await resolveProjectId(db, options.project);
    const layers = await getAllLayers({ db, projectId });
    const layerIds = layers.map((layer) => layer.id);
    const resolvedId = resolveLayerRef(layers, layerId);
    await deleteLayerWithReassign({ db, projectId, layerId: resolvedId });
    console.log("Layer deleted.");
    console.log(`  id: ${shortId(resolvedId, layerIds)}`);
    console.log("Cards on this layer moved to the project's default layer.");
  } catch (error) {
    fail(error);
  }
}
