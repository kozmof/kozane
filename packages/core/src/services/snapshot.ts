import type { DB } from "../database.js";
import { withReadTx } from "../database.js";

import { getNamespace } from "../../../../src/db/api/namespace.js";
import { getAllPartitions } from "../../../../src/db/api/partition.js";
import { getAllLayers } from "../../../../src/db/api/layer.js";
import { getAllWarps } from "../../../../src/db/api/warp.js";
import { getAllInventories } from "../../../../src/db/api/inventory.js";
import { getScopesInNamespace } from "../../../../src/db/api/scope.js";
import { getScopeAreasInNamespace } from "../../../../src/db/api/scope-area.js";
import { getCardDataByPartitions } from "../../../../src/db/api/card.js";
import { getGlueRelsByNamespace } from "../../../../src/db/api/glue.js";
import { getScopeRelsByNamespace } from "../../../../src/db/api/scope-rel.js";
import { getTaskspacesInNamespace } from "../../../../src/db/api/taskspace.js";
import type { ServiceContext } from "./context.js";
export async function readRows(
  db: DB,
  _context: ServiceContext,
  namespaceId: string,
  { includeScopes = true } = {},
) {
  return withReadTx(db, async (tx) => {
    const namespace = await getNamespace({ db: tx, namespaceId });
    if (!namespace) return null;

    const partitions = await getAllPartitions({ db: tx, namespaceId });
    const layers = await getAllLayers({ db: tx, namespaceId });
    const warps = await getAllWarps({ db: tx, namespaceId });
    const inventories = await getAllInventories({ db: tx, namespaceId });
    const scopes = includeScopes ? await getScopesInNamespace({ db: tx, namespaceId }) : [];
    // Gate frames with `includeScopes` because their geometry also exposes scope
    // organization in published exports.
    const scopeAreas = includeScopes ? await getScopeAreasInNamespace({ db: tx, namespaceId }) : [];
    const taskspaces = includeScopes ? await getTaskspacesInNamespace({ db: tx, namespaceId }) : [];
    const cardRows = await getCardDataByPartitions({
      db: tx,
      partitionIds: partitions.map(({ id }) => id),
    });
    const glueRels = await getGlueRelsByNamespace({ db: tx, namespaceId });
    const scopeRels = includeScopes ? await getScopeRelsByNamespace({ db: tx, namespaceId }) : [];
    return {
      namespace,
      partitions,
      layers,
      warps,
      inventories,
      scopes,
      scopeAreas,
      taskspaces,
      cardRows,
      glueRels,
      scopeRels,
    };
  });
}

export type SnapshotRows = NonNullable<Awaited<ReturnType<typeof readRows>>>;
export interface SnapshotEnrichment {
  taskspaces?: import("../../../../src/lib/types.js").TaskspaceSummary[];
  taskspaceFiles?: Record<string, import("../../../../src/lib/types.js").TaskspaceFileTree>;
}
/** Assemble shared board rules once; adapters may supply already-resolved Node data. */
export function assemble(
  rows: SnapshotRows,
  { taskspaces = [], taskspaceFiles }: SnapshotEnrichment = {},
) {
  const {
    namespace,
    partitions,
    layers,
    warps,
    inventories,
    scopes,
    scopeAreas,
    scopeRels,
    glueRels,
  } = rows;
  const inventoryIds = new Set(inventories.map(({ id }) => id));
  const glueByCard = new Map(glueRels.map(({ cardId, glueId }) => [cardId, glueId]));
  const cards = rows.cardRows.map((card) => ({
    ...card,
    inventory: card.inventory && inventoryIds.has(card.inventory.id) ? card.inventory : null,
    glueId: glueByCard.get(card.id) ?? null,
  }));
  const snapshot = {
    namespace: { id: namespace.id },
    cards,
    partitions,
    layers,
    warps,
    inventories,
    scopes,
    scopeAreas,
    scopeRels,
    glueRels,
    taskspaces,
    ...(taskspaceFiles ? { taskspaceFiles } : {}),
  } satisfies import("../../../../src/lib/types.js").NamespaceDataSnapshot;
  return { namespace, snapshot };
}

/** Browser snapshot data excludes Node taskspace features and paths. */
export async function get(db: DB, context: ServiceContext, namespaceId: string) {
  const rows = await readRows(db, context, namespaceId);
  return rows ? assemble(rows) : null;
}
