import type { TagsViewData } from "../../../../kozane/src/services/tags.js";
import type { TagHit } from "../../../../kozane/src/lib/types.js";
import {
  buildTagTree,
  capHitsByKind,
  normalizeTag,
  tagMatcher,
  type TagNode,
} from "../../../../kozane/src/lib/tag.js";
import { TAG_HITS_SHOWN_MAX } from "../../constants/index.js";
import { BackendError } from "../contract.js";

/**
 * Static exports embed gathered hits for browser-side filtering. Live pages filter on the
 * server before sending results.
 *
 * Apply display caps after filtering on either path so export does not discard hits before a
 * user chooses a tag.
 */
export function selectTagHits(
  hits: TagHit[],
  tag: string | null,
  staticExport = false,
): { hits: TagHit[]; cardTotal: number | null; fileTotal: number | null } {
  // Let the browser report totals after applying export filters and caps.
  if (staticExport) return { hits, cardTotal: null, fileTotal: null };
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
  return Object.fromEntries(
    [...keys].flatMap((key) =>
      Object.hasOwn(record, key) && record[key] !== undefined ? [[key, record[key]]] : [],
    ),
  );
}

/** Project an already namespace-scoped gather into the tag tree, results and warnings. */
export function tagsView(
  dataset: TagsViewData,
  selection: { namespaceId: string | null; tag: string | null; staticExport?: boolean },
): TagsViewPageData {
  const { index, namespaces, cardPartitions, partitions } = dataset;
  const { namespaceId: requestedNamespace, staticExport = false } = selection;
  const tag = selection.tag ? normalizeTag(selection.tag) : null;
  if (requestedNamespace && !namespaces.some(({ id }) => id === requestedNamespace))
    throw new BackendError("not_found", "Namespace not found");
  const { hits, cardTotal, fileTotal } = selectTagHits(index.hits, tag, staticExport);
  const shownCardIds = new Set(
    hits.flatMap((hit) => (hit.source.kind === "card" ? [hit.source.cardId] : [])),
  );
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
    cardNamespaces: staticExport
      ? index.cardNamespaces
      : narrow(index.cardNamespaces, shownCardIds),
    // Join partition and taskspace labels for displayed hits rather than duplicating metadata
    // in `TagSource`.
    cardPartitionIds: Object.fromEntries(
      cardPartitions
        .filter((row) => shownCardIds.has(row.cardId))
        .map((row) => [row.cardId, row.partitionId]),
    ),
    partitions,
    // Plain exports scan no taskspace files and need no taskspace-name lookup.
    taskspaces: staticExport ? index.taskspaces : narrow(index.taskspaces, shownTaskspaceIds),
  };
}
export interface TagsViewPageData {
  namespaceId: string | null;
  namespaces: TagsViewData["namespaces"];
  tree: TagNode[];
  tag: string | null;
  hits: TagHit[];
  cardTotal: number | null;
  fileTotal: number | null;
  truncated: TagsViewData["index"]["truncated"];
  missing: string[];
  cardsTruncated: boolean;
  cardNamespaces: TagsViewData["index"]["cardNamespaces"];
  cardPartitionIds: Record<string, string>;
  partitions: TagsViewData["partitions"];
  taskspaces: TagsViewData["index"]["taskspaces"];
}
