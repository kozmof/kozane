import type { DB } from "$db/client";
import { withTx } from "$db/tx";
import type { Namespace } from "$db/api/types";
import type { NamespaceDataSnapshot, TaskspaceFileTree, TaskspaceSummary } from "$lib/types";
import { getNamespace } from "$db/api/namespace";
import { getAllPartitions } from "$db/api/partition";
import { getAllLayers } from "$db/api/layer";
import { getAllWarps } from "$db/api/warp";
import { getAllInventories } from "$db/api/inventory";
import { getScopesInNamespace } from "$db/api/scope";
import { getScopeAreasInNamespace } from "$db/api/scope-area";
import { getCardDataByPartitions } from "$db/api/card";
import { getGlueRelsByNamespace } from "$db/api/glue";
import { getScopeRelsByNamespace } from "$db/api/scope-rel";
import { getTaskspacesInNamespace } from "$db/api/taskspace";
import { getWorkspaceRoot } from "$db/internal/config";
import { resolveTaskspacePath } from "$lib/server/taskspace-path";
import { buildTaskspaceFileTreeOnce } from "$lib/server/taskspace-snapshot";
import { cardsWithGlueIds } from "./namespace-page.js";

type LoadNamespaceSnapshot = {
  db: DB;
  namespaceId: string;
  /**
   * Whether to include local taskspace paths. Live boards use them to show directories.
   * Static exports null them to avoid publishing machine-specific paths.
   */
  includeTaskspacePaths: boolean;
  /**
   * Whether to fetch scopes, memberships, and taskspace summaries. Live boards include them.
   * Static exports omit them unless scoped files were requested, filtering server-side so
   * omitted details are absent from page data.
   */
  includeScopes: boolean;
  /**
   * Whether to embed taskspace file trees for static export. Require scope data too. Live
   * boards read files on demand and must not recursively scan directories during page loads
   * or polls.
   */
  includeScopedFiles: boolean;
};

/**
 * Load shared board data for page rendering and snapshot polling. Return null when the
 * namespace does not exist, leaving response handling to the caller.
 */
export async function loadNamespaceSnapshot({
  db,
  namespaceId,
  includeTaskspacePaths,
  includeScopes,
  includeScopedFiles,
}: LoadNamespaceSnapshot): Promise<{
  namespace: Namespace;
  snapshot: NamespaceDataSnapshot;
} | null> {
  // Read every table in one transaction so the snapshot reflects a single committed state.
  // In WAL mode a read transaction sees one consistent view without blocking writers.
  const rows = await withTx(db, async (tx) => {
    const namespace = await getNamespace({ db: tx, namespaceId });
    if (!namespace) return null;

    const [partitions, layers, warps, inventories, scopes, scopeAreas, taskspaces] =
      await Promise.all([
        getAllPartitions({ db: tx, namespaceId }),
        getAllLayers({ db: tx, namespaceId }),
        getAllWarps({ db: tx, namespaceId }),
        getAllInventories({ db: tx, namespaceId }),
        includeScopes ? getScopesInNamespace({ db: tx, namespaceId }) : Promise.resolve([]),
        // Gate frames with `includeScopes` because their geometry also exposes scope
        // organization in published exports.
        includeScopes ? getScopeAreasInNamespace({ db: tx, namespaceId }) : Promise.resolve([]),
        includeScopes ? getTaskspacesInNamespace({ db: tx, namespaceId }) : Promise.resolve([]),
      ]);

    const cardRows = await getCardDataByPartitions({
      db: tx,
      partitionIds: partitions.map(({ id }) => id),
    });
    const [glueRels, scopeRels] = await Promise.all([
      getGlueRelsByNamespace({ db: tx, namespaceId }),
      includeScopes ? getScopeRelsByNamespace({ db: tx, namespaceId }) : Promise.resolve([]),
    ]);
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
  if (!rows) return null;
  const {
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
  } = rows;

  // Show cards whose inventory is absent at their saved canvas positions. The reads share one
  // transaction, so this only guards against rows a repair has not yet cleaned up.
  const inventoryIds = new Set(inventories.map(({ id }) => id));
  const cards = cardRows.map((card) =>
    card.inventory && !inventoryIds.has(card.inventory.id) ? { ...card, inventory: null } : card,
  );

  // For static export, include only taskspaces whose scopes appear in this snapshot. The
  // exported panel cannot reach other taskspaces, so publishing their names and files would
  // disclose unused data. Live snapshots retain the full visible taskspace set.
  const drawnScopes = new Set(scopes.map(({ id }) => id));
  const namedTaskspaces = includeScopedFiles
    ? taskspaces.filter(({ scopeId }) => scopeId !== null && drawnScopes.has(scopeId))
    : taskspaces;

  // Build file trees before removing local paths from exported rows. Reuse
  // `buildTaskspaceFileTreeOnce` so taskspaces shared across namespaces are walked only once
  // per build.
  let taskspaceFiles: Record<string, TaskspaceFileTree> | undefined;
  // Require scope data explicitly before embedding files so every tree has a corresponding
  // taskspace summary.
  if (includeScopedFiles && includeScopes) {
    const root = getWorkspaceRoot();
    if (root) {
      taskspaceFiles = {};
      for (const taskspace of namedTaskspaces) {
        if (!taskspace.path) continue;
        const baseDir = resolveTaskspacePath(taskspace.path, taskspace.pathKind, root);
        taskspaceFiles[taskspace.id] = buildTaskspaceFileTreeOnce(baseDir);
      }
    }
  }

  const snapshot = {
    namespace: { id: namespace.id },
    cards: cardsWithGlueIds(cards, glueRels),
    partitions,
    layers,
    warps,
    inventories,
    scopes,
    scopeRels,
    scopeAreas,
    glueRels,
    taskspaces: namedTaskspaces.map(
      ({ id, name, scopeId, path, pathKind }) =>
        ({
          id,
          name,
          scopeId,
          path: includeTaskspacePaths ? path : null,
          pathKind,
        }) satisfies TaskspaceSummary,
    ),
    ...(taskspaceFiles ? { taskspaceFiles } : {}),
  } satisfies NamespaceDataSnapshot;

  // Return the full namespace row for the page title alongside the snapshot, which carries
  // only its ID.
  return { namespace, snapshot };
}
