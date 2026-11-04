import type { DB } from "../db/database.js";
import { withReadTx } from "../db/database.js";

import { getNamespace } from "../db/api/namespace.js";
import { getAllPartitions } from "../db/api/partition.js";
import { getAllLayers } from "../db/api/layer.js";
import { getAllWarps } from "../db/api/warp.js";
import { getAllInventories } from "../db/api/inventory.js";
import { getScopesInNamespace } from "../db/api/scope.js";
import { getScopeAreasInNamespace } from "../db/api/scope-area.js";
import { getCardDataByPartitions } from "../db/api/card.js";
import { getGlueRelsByNamespace } from "../db/api/glue.js";
import { getScopeRelsByNamespace } from "../db/api/scope-rel.js";
import { getTaskspacesInNamespace } from "../db/api/taskspace.js";
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
