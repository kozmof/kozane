import type { PageServerLoad } from "./$types";
import { error } from "@sveltejs/kit";
import { getAllNamespaces, getNamespace } from "$db/api/namespace";
import { getAllPartitions } from "$db/api/partition";
import { getCardPartitionNames } from "$db/api/card";
import type { AnyDB } from "$db/client";
import { getDBURL, getWorkspaceRoot } from "$db/internal/config";
import { loadTagIndex } from "$lib/server/tag-index";
import { buildTagTree, capHitsByKind, normalizeTag, tagMatcher } from "$lib/tag";
import { TAG_HITS_SHOWN_MAX } from "$lib/constants";
import { applyPalette } from "$lib/palette";
import type { TagHit } from "$lib/types";
import { isSsgBuild, ssgIncludesScopedFiles } from "$lib/server/ssg";

// Prerender one workspace-wide tag index. Namespace filtering uses query parameters at
// runtime.
export const prerender = isSsgBuild();
// Include file tags only when static export requests scoped files because hits expose paths
// and excerpts. Taskspace metadata comes from the gather, so an export that scans no files
// also publishes no taskspace names.
const includeScopedFiles = ssgIncludesScopedFiles();

/**
 * Enable persistent caching only with a workspace root and verifiable database URL. Skip it
 * during prerendering, which has no later requests to reuse it.
 */
function cacheLocation(): { cache: { dbUrl: string } } | null {
  if (prerender || !getWorkspaceRoot()) return null;
  try {
    return { cache: { dbUrl: getDBURL() } };
  } catch {
    return null;
  }
}

/**
 * Static exports embed gathered hits for browser-side filtering. Live pages filter on the
 * server before sending results.
 *
 * Apply display caps after filtering on either path so export does not discard hits before a
 * user chooses a tag.
 */
function selectHits(
  hits: TagHit[],
  tag: string | null,
): { hits: TagHit[]; cardTotal: number | null; fileTotal: number | null } {
  // Let the browser report totals after applying export filters and caps.
  if (prerender) return { hits, cardTotal: null, fileTotal: null };
  if (!tag) return { hits: [], cardTotal: 0, fileTotal: 0 };

  const matches = tagMatcher(tag);
  // Cap card and file hits separately so card hits cannot consume the file allowance. Filter
  // inside `capHitsByKind` to avoid allocating an uncapped intermediate array.
  const { cards, files, cardTotal, fileTotal } = capHitsByKind(hits, TAG_HITS_SHOWN_MAX, (hit) =>
    matches(hit.tag),
  );
  return { hits: [...cards, ...files], cardTotal, fileTotal };
}

/**
 * Keep lookup entries needed by the displayed hits and warnings. Static exports retain
 * complete records because the browser filters their embedded results. Omit missing keys.
 */
function narrow<T>(record: Record<string, T>, keys: Iterable<string>): Record<string, T> {
  const kept: Record<string, T> = {};
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined) kept[key] = value;
  }
  return kept;
}

/**
 * Read partition names and colors for displayed cards. Assign each namespace's palette in the
 * same order as its board, and read only namespaces used by the results.
 */
async function partitionsForNamespaces(
  db: AnyDB,
  namespaceIds: string[],
): Promise<Record<string, { name: string; dot: string }>> {
  // Load independent namespace palettes concurrently.
  const palettes = await Promise.all(
    namespaceIds.map(async (namespaceId) =>
      applyPalette(await getAllPartitions({ db, namespaceId })),
    ),
  );

  const byPartition: Record<string, { name: string; dot: string }> = {};
  for (const partitions of palettes) {
    for (const partition of partitions)
      byPartition[partition.id] = { name: partition.name, dot: partition.dot };
  }
  return byPartition;
}

export const load: PageServerLoad = async ({ locals, url }) => {
  const { db } = locals;

  // Read workspace-wide tag-index filters from the query. During prerendering, leave them
  // null and let the browser apply URL selections.
  const requestedNamespace = prerender ? null : url.searchParams.get("namespaceId");
  const requestedTag = prerender ? null : url.searchParams.get("tag");
  const tag = requestedTag ? normalizeTag(requestedTag) : null;

  // Live pages scan taskspace files. Static exports do so only when requested at build time.
  const includeFiles = prerender ? includeScopedFiles : true;

  // Reject unknown namespaces instead of presenting an empty tag index as a valid result.
  if (requestedNamespace && !(await getNamespace({ db, namespaceId: requestedNamespace })))
    throw error(404, "Namespace not found");

  const [index, namespaces] = await Promise.all([
    loadTagIndex({
      db,
      ...(requestedNamespace ? { namespaceId: requestedNamespace } : {}),
      includeFiles,
      // Kept between requests, so clicking from one tag to the next does not re-run the card
      // query and re-read every taskspace file to produce the set it just produced. Skipped
      // where there is no workspace to keep it in, which is a prerender building an export.
      ...cacheLocation(),
    }),
    getAllNamespaces({ db }),
  ]);

  const { hits, cardTotal, fileTotal } = selectHits(index.hits, tag);
  const shownCardIds = [
    ...new Set(hits.flatMap((hit) => (hit.source.kind === "card" ? [hit.source.cardId] : []))),
  ];
  // Drop missing card-to-namespace lookups before requesting partition data. Use explicit
  // narrowing so undefined IDs cannot reach the query.
  const shownNamespaces = [
    ...new Set(
      shownCardIds.flatMap((cardId) => {
        const namespaceId = index.cardNamespaces[cardId];
        return namespaceId ? [namespaceId] : [];
      }),
    ),
  ];
  // Read independent card metadata concurrently.
  const [cardPartitions, partitions] = await Promise.all([
    getCardPartitionNames({ db, cardIds: shownCardIds }),
    partitionsForNamespaces(db, shownNamespaces),
  ]);

  // Retain metadata for displayed hits and taskspaces named in warnings. Exports retain
  // complete lookup data for browser-side filtering.
  const shownTaskspaceIds = new Set([
    ...hits.flatMap((hit) => (hit.source.kind === "file" ? [hit.source.taskspaceId] : [])),
    ...index.truncated.map(({ taskspaceId }) => taskspaceId),
    ...index.missing,
  ]);

  return {
    namespaceId: requestedNamespace,
    // Named so the page can title itself and offer the way back to a board.
    namespaces: namespaces.map(({ id, name, isDefault }) => ({ id, name, isDefault })),
    // Build the tree from every gathered hit so selecting a tag does not remove other
    // branches.
    tree: buildTagTree(index.hits),
    tag,
    hits,
    /**
     * Total matching hits per kind before display caps. Static exports count after browser
     * filtering instead.
     */
    cardTotal,
    fileTotal,
    truncated: index.truncated,
    /**
     * Taskspace IDs whose root directories could not be opened. Keep them separate from
     * partial scans.
     */
    missing: index.missing,
    /**
     * Whether card scanning reached its limit. Display alongside taskspace truncation
     * notices. See `TagIndex.cardsTruncated`.
     */
    cardsTruncated: index.cardsTruncated,
    cardNamespaces: prerender ? index.cardNamespaces : narrow(index.cardNamespaces, shownCardIds),
    // Join partition and taskspace labels for displayed hits rather than duplicating metadata
    // in `TagSource`.
    cardPartitionIds: Object.fromEntries(
      cardPartitions.map((row) => [row.cardId, row.partitionId]),
    ),
    partitions,
    // Plain exports scan no taskspace files and need no taskspace-name lookup.
    taskspaces: prerender ? index.taskspaces : narrow(index.taskspaces, shownTaskspaceIds),
  };
};
