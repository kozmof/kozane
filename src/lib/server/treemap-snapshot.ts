import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AnyDB } from "../../db/client.js";
import { getAllNamespaces } from "../../db/api/namespace.js";
import {
  getAllPartitions,
  getPartitionCardCounts,
  type PartitionCardCount,
} from "../../db/api/partition.js";
import { getCardChangeCounts, type CardChangeCount } from "../../db/api/card.js";
import {
  getAllScopes,
  getScopePartitionUsage,
  getScopeNamespaceUsage,
  type ScopePartitionUsage,
  type ScopeNamespaceUsage,
} from "../../db/api/scope.js";
import { getCardTagHits, type CardTagHits } from "../../db/api/tag.js";
import type { Namespace, Scope } from "../../db/api/types.js";
import { TREEMAP_CACHE_BYTES_MAX } from "../constants.js";
import { applyPalette } from "../palette.js";
import { writeFileAtomic } from "./atomic-write.js";
import { databaseSignature } from "./tag-cache.js";

export const TREEMAP_CACHE_VERSION = 1;
export const TREEMAP_CACHE_FILE = "treemap.json";

export type TreemapPartition = PartitionCardCount & { bg: string; dot: string };

/** The workspace facts needed to derive every map view. Geometry and query selections are
 * deliberately absent: they are cheap browser-side projections of these facts. */
export type TreemapSnapshot = {
  namespaces: Namespace[];
  partitions: TreemapPartition[];
  activity: CardChangeCount[];
  scopes: Scope[];
  partitionUsage: ScopePartitionUsage[];
  namespaceUsage: ScopeNamespaceUsage[];
  tags: CardTagHits;
};

type TreemapCache = {
  version: number;
  db: string;
  builtAt: string;
  includeScopes: boolean;
  snapshot: TreemapSnapshot;
};

export const treemapCachePath = (root: string): string => join(root, ".kozane", TREEMAP_CACHE_FILE);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown, fields: string[]): boolean =>
  isRecord(value) && fields.every((field) => typeof value[field] === "string");
const arrayOf = (value: unknown, check: (entry: unknown) => boolean): boolean =>
  Array.isArray(value) && value.every(check);

const isNamespace = (value: unknown): boolean =>
  strings(value, ["id", "name"]) &&
  typeof (value as Record<string, unknown>).isDefault === "boolean";
const isPartition = (value: unknown): boolean =>
  strings(value, ["id", "namespaceId", "name", "bg", "dot"]) &&
  typeof (value as Record<string, unknown>).isDefault === "boolean" &&
  typeof (value as Record<string, unknown>).cards === "number";
const isActivity = (value: unknown): boolean =>
  strings(value, ["day", "partitionId"]) &&
  typeof (value as Record<string, unknown>).cards === "number";
const isScope = (value: unknown): boolean => strings(value, ["id", "name"]);
const isPartitionUsage = (value: unknown): boolean =>
  strings(value, ["scopeId", "partitionId"]) &&
  typeof (value as Record<string, unknown>).cards === "number";
const isNamespaceUsage = (value: unknown): boolean => strings(value, ["scopeId", "namespaceId"]);
const isTagHit = (value: unknown): boolean => {
  if (!strings(value, ["tag", "excerpt"])) return false;
  const source = (value as Record<string, unknown>).source;
  return isRecord(source) && source.kind === "card" && typeof source.cardId === "string";
};
const isTags = (value: unknown): boolean => {
  if (!isRecord(value) || !arrayOf(value.hits, isTagHit) || typeof value.truncated !== "boolean")
    return false;
  if (
    !isRecord(value.cardNamespaces) ||
    !Object.values(value.cardNamespaces).every((v) => typeof v === "string")
  )
    return false;
  return (
    isRecord(value.cardData) &&
    Object.values(value.cardData).every((card) =>
      strings(card, ["namespaceId", "partitionId", "updatedDay"]),
    )
  );
};

function isTreemapCache(value: unknown): value is TreemapCache {
  if (
    !isRecord(value) ||
    value.version !== TREEMAP_CACHE_VERSION ||
    typeof value.db !== "string" ||
    typeof value.builtAt !== "string" ||
    typeof value.includeScopes !== "boolean" ||
    !isRecord(value.snapshot)
  )
    return false;
  const snapshot = value.snapshot;
  return (
    arrayOf(snapshot.namespaces, isNamespace) &&
    arrayOf(snapshot.partitions, isPartition) &&
    arrayOf(snapshot.activity, isActivity) &&
    arrayOf(snapshot.scopes, isScope) &&
    arrayOf(snapshot.partitionUsage, isPartitionUsage) &&
    arrayOf(snapshot.namespaceUsage, isNamespaceUsage) &&
    isTags(snapshot.tags)
  );
}

export function readTreemapCache(root: string): TreemapCache | null {
  try {
    const path = treemapCachePath(root);
    if (statSync(path).size > TREEMAP_CACHE_BYTES_MAX) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isTreemapCache(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeTreemapCache(root: string, value: TreemapCache): void {
  try {
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized) > TREEMAP_CACHE_BYTES_MAX) return;
    writeFileAtomic(treemapCachePath(root), serialized);
  } catch {
    // A cache must never turn a readable map into an error.
  }
}

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

export async function loadTreemapSnapshot({
  db,
  includeScopes,
  cache,
}: {
  db: AnyDB;
  includeScopes: boolean;
  cache?: { root: string; dbUrl: string };
}): Promise<TreemapSnapshot> {
  const signature = cache ? databaseSignature(cache.dbUrl) : null;
  const stored = cache ? readTreemapCache(cache.root) : null;
  if (signature && stored?.db === signature && stored.includeScopes === includeScopes)
    return stored.snapshot;

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

  if (signature && cache)
    writeTreemapCache(cache.root, {
      version: TREEMAP_CACHE_VERSION,
      db: signature,
      builtAt: new Date().toISOString(),
      includeScopes,
      snapshot,
    });
  return snapshot;
}
