import type { AnyDB } from "../database.js";
import type { ServiceContext } from "./context.js";
import { getAllNamespaces } from "../../../../src/db/api/namespace.js";
import {
  getAllPartitions,
  getPartitionCardCounts,
  type PartitionCardCount,
} from "../../../../src/db/api/partition.js";
import { getCardChangeCounts, type CardChangeCount } from "../../../../src/db/api/card.js";
import {
  getAllScopes,
  getScopePartitionUsage,
  getScopeNamespaceUsage,
  type ScopePartitionUsage,
  type ScopeNamespaceUsage,
} from "../../../../src/db/api/scope.js";
import { getCardTagHits, type CardTagHits } from "../../../../src/db/api/tag.js";
import type { Namespace, Scope } from "../database-types.js";
import { applyPalette } from "../palette.js";
export type TreemapPartition = PartitionCardCount & { bg: string; dot: string };
export type TreemapSnapshot = {
  namespaces: Namespace[];
  partitions: TreemapPartition[];
  activity: CardChangeCount[];
  scopes: Scope[];
  partitionUsage: ScopePartitionUsage[];
  namespaceUsage: ScopeNamespaceUsage[];
  tags: CardTagHits;
};
async function paletteByPartition(
  db: AnyDB,
  namespaceIds: string[],
): Promise<Record<string, { bg: string; dot: string }>> {
  const palettes = await Promise.all(
    namespaceIds.map(async (namespaceId) =>
      applyPalette(await getAllPartitions({ db, namespaceId })),
    ),
  );
  const colours: Record<string, { bg: string; dot: string }> = {};
  for (const partitions of palettes)
    for (const { id, bg, dot } of partitions) colours[id] = { bg, dot };
  return colours;
}

export async function get(
  db: AnyDB,
  _context: ServiceContext,
  { includeScopes = true } = {},
): Promise<TreemapSnapshot> {
  const [namespaces, counts, activity, tags, scopes, partitionUsage, namespaceUsage] =
    await Promise.all([
      getAllNamespaces({ db }),
      getPartitionCardCounts({ db }),
      getCardChangeCounts({ db }),
      getCardTagHits({ db }),
      includeScopes ? getAllScopes({ db }) : Promise.resolve([]),
      includeScopes ? getScopePartitionUsage({ db }) : Promise.resolve([]),
      includeScopes ? getScopeNamespaceUsage({ db }) : Promise.resolve([]),
    ]);
  const colours = await paletteByPartition(
    db,
    namespaces.map(({ id }) => id),
  );
  const snapshot: TreemapSnapshot = {
    namespaces,
    partitions: counts.map((partition) => ({
      ...partition,
      ...(colours[partition.id] ?? { bg: "transparent", dot: "currentColor" }),
    })),
    activity,
    scopes,
    partitionUsage,
    namespaceUsage,
    tags,
  };

  return snapshot;
}
