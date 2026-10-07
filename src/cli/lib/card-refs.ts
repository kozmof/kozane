import { eq, inArray } from "drizzle-orm";
import { partitionTable, cardTable, scopeTable } from "../../db/schema.js";
import { getDefaultPartition } from "../../db/api/partition.js";
import { getAllLayers } from "../../db/api/layer.js";
import { chunked, STATEMENT_PARAMS_MAX } from "../../lib/constants.js";
import type { DB } from "../../db/tx.js";
import { findById, resolveShortId } from "./short-id.js";
import { resolveLayerRef } from "./layer-ref.js";

/**
 * Resolve CLI card references, defaults, and related database reads.
 *
 * Keep these helpers independent of command parsing so they can be tested directly. Throw
 * errors for `runWorkspaceCommand` to report. Do not print or exit here.
 */

/** Parse an absolute position or an offset such as `current+100` for `kozane card move`. */
export function movedCoordinate(value: number | string, current: number): number {
  if (typeof value === "number") return value;
  const match = value.match(/^current([+-]\d+)$/);
  if (!match) throw new Error(`Invalid card position: ${value}`);
  return current + Number(match[1]);
}

/**
 * Resolve card references across the workspace and retain their namespace IDs for guarded
 * glue operations.
 *
 * Use the same workspace-wide ID set as `shortId` so a printed prefix resolves consistently
 * after a card moves between namespaces. Read only the ID and namespace here. {@link
 * loadCards} fetches other columns for the selected cards.
 */
export async function resolveCardGroup(db: DB, requestedIds: string[]) {
  const index = await db
    .select({ id: cardTable.id, namespaceId: partitionTable.namespaceId })
    .from(cardTable)
    .innerJoin(partitionTable, eq(cardTable.partitionId, partitionTable.id));
  const allIds = index.map(({ id }) => id);
  const cardIds = requestedIds.map((id) => resolveShortId(id, allIds, "Card"));
  const namespaceId = findById(index, cardIds[0], "Card").namespaceId;
  return { index, allIds, cardIds, namespaceId };
}

/** What a command that positions or re-lays-out cards needs of each one. */
export type LoadedCard = {
  id: string;
  content: string;
  width: number | null;
  posX: number;
  posY: number;
};

/**
 * Load full rows for resolved IDs in bounded batches. Glue expansion can produce a selection
 * larger than one statement's parameter budget.
 */
export async function loadCards(db: DB, cardIds: string[]): Promise<LoadedCard[]> {
  const rows: LoadedCard[] = [];
  for (const batch of chunked(cardIds, { size: STATEMENT_PARAMS_MAX })) {
    const found = await db
      .select({
        id: cardTable.id,
        content: cardTable.content,
        width: cardTable.width,
        posX: cardTable.posX,
        posY: cardTable.posY,
      })
      .from(cardTable)
      .where(inArray(cardTable.id, batch));
    rows.push(...found);
  }
  return rows;
}

export async function resolvePartitionId(
  db: DB,
  namespaceId: string,
  requestedId?: string,
): Promise<string> {
  if (requestedId) {
    const partitions = await db
      .select({ id: partitionTable.id })
      .from(partitionTable)
      .where(eq(partitionTable.namespaceId, namespaceId));
    return resolveShortId(
      requestedId,
      partitions.map(({ id }) => id),
      "Partition",
    );
  }
  const partition = await getDefaultPartition({ db, namespaceId });
  if (!partition) throw new Error(`Namespace has no default partition: ${namespaceId}`);
  return partition.id;
}

/** The requested layer, or the namespace's default one when nothing was asked for. */
export async function resolveLayerId(
  db: DB,
  namespaceId: string,
  requested?: string,
): Promise<string> {
  const layers = await getAllLayers({ db, namespaceId });
  if (!requested) {
    const defaultLayer = layers.find(({ isDefault }) => isDefault);
    if (!defaultLayer) throw new Error(`Namespace has no default layer: ${namespaceId}`);
    return defaultLayer.id;
  }
  return resolveLayerRef(layers, requested);
}

export async function resolveScopeId(db: DB, requestedId: string): Promise<string> {
  const scopes = await db.select({ id: scopeTable.id }).from(scopeTable);
  return resolveShortId(
    requestedId,
    scopes.map(({ id }) => id),
    "Scope",
  );
}
