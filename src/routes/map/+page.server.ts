import type { PageServerLoad } from "./$types";
import { error } from "@sveltejs/kit";
import { getDBURL, getWorkspaceRoot, getWorkspaceUiConfig } from "$db/internal/config";
import { normalizeTag } from "$lib/tag";
import { loadTreemapSnapshot, type TreemapPartition } from "$lib/server/treemap-snapshot";
import { validActivityDay } from "./lib/activity.js";

/**
 * The whole workspace at once: every namespace as a rectangle, its partitions inside it sized by
 * how many cards they hold, the scopes that reach across them as a graph over the packing,
 * and the tags as the tree they spell.
 *
 * A read, and only a read. There are no actions here and no snapshot poll — the board is
 * where a workspace is changed, and this page is where its shape is looked at.
 *
 * **Cards only, and no filesystem.** The persisted treemap snapshot gathers card tags without
 * taskspace files, together with the other semantic data every map view derives from.
 */

// Static export: one map of the workspace, prerendered. A static route with no `entries` to
// generate, for the reason `/tags` has none — which namespace is being looked at is a query
// parameter, and a prerender has no query to read.
export const prerender = process.env.KOZANE_SSG === "1";

/**
 * Whether a prerender may draw scopes at all.
 *
 * A plain `kozane net ssg generate` carries no scopes: `loadNamespaceSnapshot` gates them
 * behind `includeScopes`, and `docs/security-matrix.md` states it as a promise about what an
 * export publishes. A scope name is workspace content someone chose not to publish, and this
 * page would be the one place it went out anyway — so the whole scope graph is gathered only
 * under the same `--include-scoped-files` that every other page's scopes are.
 *
 * It gates the gather rather than the drawing, deliberately. A page that fetched the scopes
 * and then declined to render them would still have baked them into the JSON the export
 * ships beside the HTML.
 */
const includeScopedFiles = process.env.KOZANE_SSG_INCLUDE_SCOPED_FILES === "1";
const includeScopes = !prerender || includeScopedFiles;

function cacheLocation(): { root: string; dbUrl: string } | undefined {
  if (prerender || !getWorkspaceRoot()) return undefined;
  try {
    return { root: getWorkspaceRoot()!, dbUrl: getDBURL() };
  } catch {
    return undefined;
  }
}

/** A partition as the map draws it: what it is, how much it holds, and the colour its own board
 *  gives it. */
export type MapPartition = TreemapPartition;

/**
 * One line from a scope's node. A scope reaches a partition by a card filed into it, and reaches
 * a namespace — with no partition to name — by a taskspace attached to it. Both are lines to draw,
 * so both are spokes, and `kind` says which rectangle the other end is.
 */
export type MapSpoke = { kind: "partition" | "namespace"; id: string; cards: number };
export type MapScope = { id: string; name: string; spokes: MapSpoke[] };

export const load: PageServerLoad = async ({ locals, url }) => {
  const { db } = locals;

  // Both read from the query rather than the path, as on the tag index: the map is one page
  // over the whole workspace and `?namespaceId=` narrows it. A prerender has no query, so the
  // export bakes the whole workspace and the browser reads the selection from the URL.
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
  // A scope reaching a namespace only through a taskspace has no card and so no partition, and
  // would vanish from a graph drawn from `scope_rel` alone. Those reach the namespace
  // rectangle instead — but only where the same scope has no partition spoke into that namespace
  // already, or a scope with both would be drawn twice into one namespace.
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
     * How far one notch of the wheel, or one press of the zoom control, moves the zoom.
     *
     * `ui.zoomStep` and nothing else from the ui config: the map has no cards to size and no
     * panels to open, and `ui.defaultZoom` is deliberately left out — see `FITTED_VIEW`.
     * Shared with the board because it is a setting about the input device rather than about
     * either page, so a workspace that has tuned its wheel has tuned both.
     */
    zoomStep: getWorkspaceUiConfig().zoomStep,
    /** Which namespace the map was narrowed to, or null for the whole workspace. */
    namespaceId: requestedNamespace,
    namespaces: namespaces.map(({ id, name, isDefault }) => ({ id, name, isDefault })),
    /** The namespaces actually packed, which is all of them unless `?namespaceId=` narrowed it. */
    drawn: drawn.map(({ id, name }) => ({ id, name })),
    partitions: partitionRows,
    /**
     * Only the scopes with somewhere to point. A scope nobody has put anything in yet is a
     * hub with no spokes, and a node floating under the packing attached to nothing says
     * less than leaving it out does — `kozane scope list` is where a workspace's scopes are
     * enumerated. Empty in a plain static export; see `includeScopes`.
     */
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
