import type { TreemapSnapshot, TreemapPartition } from "../../../services/map.js";
import { BackendError } from "../contract.js";
import { normalizeTag } from "../../tag.js";

/** Partition identity, size, and board colour used by the map. */
export type MapPartition = TreemapPartition;

/**
 * Scope link target identified as a partition through card membership or a namespace through
 * a taskspace link.
 */
export type MapSpoke = { kind: "partition" | "namespace"; id: string; cards: number };
export type MapScope = { id: string; name: string; spokes: MapSpoke[] };

export function validActivityDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + "T00:00:00.000Z");
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Apply map selections to a workspace dataset without changing canvas state. */
export function mapView(
  snapshot: TreemapSnapshot,
  selection: {
    namespaceId: string | null;
    tag: string | null;
    day: string | null;
    zoomStep: number;
  },
) {
  const { namespaceId: requestedNamespace, day: requestedDay, zoomStep } = selection;
  const tag = selection.tag ? normalizeTag(selection.tag) : null;
  const { namespaces } = snapshot;
  if (requestedDay && !validActivityDay(requestedDay))
    throw new BackendError("validation", "Invalid activity day");
  if (requestedNamespace && !namespaces.some(({ id }) => id === requestedNamespace))
    throw new BackendError("not_found", "Namespace not found");
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
    zoomStep,
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
    /** Whether card gathering reached `TAG_CARD_HITS_MAX`. Counts are lower bounds when true,
     *  as in the tag index. */
    cardsTruncated: snapshot.tags.truncated,
  };
}
export type MapViewData = ReturnType<typeof mapView>;
