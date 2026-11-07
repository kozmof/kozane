import { tagMatches, type TagNode } from "$lib/tag";
import type { Point } from "./treemap.js";

/**
 * Compute tag-row positions from fixed row heights and tree order. This lets graph links
 * render correctly without DOM measurements during server rendering.
 */

/**
 * Fixed map-header height used to place {@link TAG_PANEL_TOP}. Scroll namespace choices
 * horizontally so wrapping cannot cover more of the map.
 */
export const MAP_HEADER_HEIGHT = 40;

/** Shared panel offsets used by both CSS placement and graph-link origins. */
export const TAG_PANEL_LEFT = 16;
export const TAG_PANEL_TOP = MAP_HEADER_HEIGHT + 12;
export const TAG_PANEL_WIDTH = 232;

/**
 * Fixed tag-row height in pixels. Keep rendered rows aligned with `tagRowCenter`
 * calculations.
 */
export const TAG_ROW_HEIGHT = 24;

/**
 * Whether to show a node's children. Expand the top level and the path to the active tag.
 * Share this rule between markup and visible-row calculations.
 */
export function childrenShown(node: TagNode, depth: number, activeTag: string | null): boolean {
  if (node.children.length === 0) return false;
  return depth === 0 || (!!activeTag && tagMatches(node.tag, activeTag));
}

export type TagRow = { tag: string; depth: number };

/** Visible tag rows in document order. */
export function visibleTagRows(nodes: TagNode[], activeTag: string | null, depth = 0): TagRow[] {
  return nodes.flatMap((node) => [
    { tag: node.tag, depth },
    ...(childrenShown(node, depth, activeTag)
      ? visibleTagRows(node.children, activeTag, depth + 1)
      : []),
  ]);
}

/** Tag-row center relative to the panel, or null when the row is not visible. */
export function tagRowCenter(rows: TagRow[], tag: string | null): number | null {
  if (!tag) return null;
  const index = rows.findIndex((row) => row.tag === tag);
  return index === -1 ? null : index * TAG_ROW_HEIGHT + TAG_ROW_HEIGHT / 2;
}

/**
 * Start tag links at the panel's right edge beside the selected row. Subtract measured panel
 * scrolling, which is zero during server rendering. Static pages without JavaScript cannot
 * update links after panel scrolling.
 */
export function tagLineOrigin(rows: TagRow[], tag: string | null, scrolledBy = 0): Point | null {
  const center = tagRowCenter(rows, tag);
  if (center === null) return null;
  return { x: TAG_PANEL_LEFT + TAG_PANEL_WIDTH, y: TAG_PANEL_TOP + center - scrolledBy };
}
