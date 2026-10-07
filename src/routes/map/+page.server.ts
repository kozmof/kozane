import type { PageServerLoad } from "./$types";
import { error } from "@sveltejs/kit";
import { getDBURL, getWorkspaceRoot, getWorkspaceUiConfig } from "$db/internal/config";
import { normalizeTag } from "$lib/tag";
import { loadTreemapSnapshot, type TreemapPartition } from "$lib/server/treemap-snapshot";
import { validActivityDay } from "./lib/activity.js";
import { isSsgBuild, ssgIncludesScopedFiles } from "$lib/server/ssg";

/**
 * Load the read-only workspace map, including namespace and partition sizes, scope links, and
 * card tags. Use the persisted semantic snapshot without scanning taskspace files.
 */

// Prerender one map route. Namespace filtering uses query parameters at runtime rather than
// separate prerender entries.
export const prerender = isSsgBuild();

/**
 * Include scope data in static exports only when scoped files were requested. Gate collection
 * before serialization so omitted scopes are absent from page data too.
 */
const includeScopedFiles = ssgIncludesScopedFiles();
const includeScopes = !prerender || includeScopedFiles;

function cacheLocation(): { root: string; dbUrl: string } | undefined {
  if (prerender || !getWorkspaceRoot()) return undefined;
  try {
    return { root: getWorkspaceRoot()!, dbUrl: getDBURL() };
  } catch {
    return undefined;
  }
}

/** Partition identity, size, and board colour used by the map. */
export type MapPartition = TreemapPartition;

/**
 * Scope link target identified as a partition through card membership or a namespace through
 * a taskspace link.
 */
export type MapSpoke = { kind: "partition" | "namespace"; id: string; cards: number };
export type MapScope = { id: string; name: string; spokes: MapSpoke[] };

export const load: PageServerLoad = async ({ locals, url }) => {
  const { db } = locals;

  // Read filters from the query for the workspace-wide map. Static exports bake the entire
  // workspace and apply URL selections in the browser.
  const requestedNamespace = prerender ? null : url.searchParams.get("namespaceId");
  const requestedTag = prerender ? null : url.searchParams.get("tag");
  const requestedDay = prerender ? null : url.searchParams.get("day");
  const tag = requestedTag ? normalizeTag(requestedTag) : null;
  if (requestedDay && !validActivityDay(requestedDay)) throw error(400, "Invalid activity day");

  const snapshot = await loadTreemapSnapshot({ db, includeScopes, cache: cacheLocation() });
  const { namespaces } = snapshot;
  if (requestedNamespace && !namespaces.some(({ id }) => id === requestedNamespace))
    throw error(404, "Namespace not found");

  const drawn = requestedNamespace
    ? namespaces.filter(({ id }) => id === requestedNamespace)
    : namespaces;
  const drawnNamespaces = new Set(drawn.map(({ id }) => id));
  const partitionRows = snapshot.partitions.filter(({ namespaceId }) =>
    drawnNamespaces.has(namespaceId),
  );
  const onMap = new Set(partitionRows.map(({ id }) => id));

  const spokesByScope = new Map<string, MapSpoke[]>();
  for (const { scopeId, partitionId, cards } of snapshot.partitionUsage) {
    if (!onMap.has(partitionId)) continue;
    const spokes = spokesByScope.get(scopeId) ?? [];
    spokes.push({ kind: "partition", id: partitionId, cards });
    spokesByScope.set(scopeId, spokes);
  }
  // Add namespace links for taskspace-only scope usage. Omit them when partition links
  // already connect the same scope to that namespace.
  const partitionNamespace = new Map(partitionRows.map(({ id, namespaceId }) => [id, namespaceId]));
  for (const { scopeId, namespaceId } of snapshot.namespaceUsage) {
    if (!drawnNamespaces.has(namespaceId)) continue;
    const spokes = spokesByScope.get(scopeId) ?? [];
    if (
      spokes.some(
        (spoke) => spoke.kind === "partition" && partitionNamespace.get(spoke.id) === namespaceId,
      )
    )
      continue;
    spokes.push({ kind: "namespace", id: namespaceId, cards: 0 });
    spokesByScope.set(scopeId, spokes);
  }

  return {
    /**
     * Shared zoom step for wheel and button input. The map does not use the board's default
     * zoom or card-specific settings.
     */
    zoomStep: getWorkspaceUiConfig().zoomStep,
    /** Which namespace the map was narrowed to, or null for the whole workspace. */
    namespaceId: requestedNamespace,
    namespaces: namespaces.map(({ id, name, isDefault }) => ({ id, name, isDefault })),
    /** The namespaces actually packed, which is all of them unless `?namespaceId=` narrowed it. */
    drawn: drawn.map(({ id, name }) => ({ id, name })),
    partitions: partitionRows,
    /** Include only scopes with graph targets. Plain static exports omit all scope data. */
    scopes: snapshot.scopes
      .filter(({ id }) => spokesByScope.has(id))
      .map(({ id, name }): MapScope => ({ id, name, spokes: spokesByScope.get(id) ?? [] })),
    tagHits: snapshot.tags.hits.filter(
      (hit) =>
        !requestedNamespace ||
        (hit.source.kind === "card" &&
          snapshot.tags.cardData[hit.source.cardId]?.namespaceId === requestedNamespace),
    ),
    tagCards: requestedNamespace
      ? Object.fromEntries(
          Object.entries(snapshot.tags.cardData).filter(
            ([, card]) => card?.namespaceId === requestedNamespace,
          ),
        )
      : snapshot.tags.cardData,
    tag,
    day: requestedDay,
    activity: snapshot.activity.filter(({ partitionId }) => onMap.has(partitionId)),
    /** Whether the card gather stopped at `TAG_CARD_HITS_MAX`, so the tree counts are a floor
     *  rather than the whole. The same flag the tag index draws, for the same reason. */
    cardsTruncated: snapshot.tags.truncated,
  };
};
