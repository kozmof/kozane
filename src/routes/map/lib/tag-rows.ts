import { tagMatches, type TagNode } from "$lib/tag";
import type { Point } from "./treemap.js";

/**
 * Where each tag sits in the panel over the map, worked out from the tree rather than
 * measured off the page.
 *
 * The map draws a line from a tag's row to the bundles it reaches, so it has to know how far
 * down the panel that row is. Reading it back out of the DOM was the obvious way and the
 * wrong one: the server renders this page before any row exists, and a static export renders
 * it on a machine with no browser at all, so every line would have started from the corner
 * of the map until JavaScript arrived to correct it — and in an export opened without
 * JavaScript, it would have stayed there.
 *
 * Arithmetic instead: rows are a fixed height, so a row's position is its index. That works
 * on both sides of hydration and needs nothing to have been laid out first.
 */

/**
 * The band along the top of the map that the header sits in.
 *
 * A fixed height rather than whatever the header comes out at, because the canvas fills the
 * window and everything else is drawn over it: a header free to grow would take that room
 * from the map silently, and {@link TAG_PANEL_TOP} is measured from below it. The project
 * list inside it scrolls sideways rather than wrapping onto a second line, for the same
 * reason.
 */
export const MAP_HEADER_HEIGHT = 40;

/**
 * Where the tag panel sits over the map, in the same pixels the packing is laid out in.
 *
 * The panel used to be a column of a grid, sharing its top-left corner with the map, which
 * is what let a row's offset down the panel be a y on the map with neither measured. The
 * canvas now fills the window and the panel floats over it, so that corner has moved — and
 * these are how far it moved. They are here rather than in the component's CSS because
 * {@link tagLineOrigin} adds them to every line's starting point: a panel positioned by one
 * set of numbers and drawn from by another is a panel whose lines miss it.
 */
export const TAG_PANEL_LEFT = 16;
export const TAG_PANEL_TOP = MAP_HEADER_HEIGHT + 12;
export const TAG_PANEL_WIDTH = 232;

/**
 * How tall one row of the tag tree is drawn, in pixels.
 *
 * The page pins the row to exactly this — it is not a measurement of what the text happens to
 * come out at — because {@link tagRowCenter} multiplies by it. A row whose height came from
 * its font would put every line below it slightly out.
 */
export const TAG_ROW_HEIGHT = 24;

/**
 * Whether a node's children are drawn under it: the top level always is, and a deeper one
 * only while the active tag is inside it — so arriving on `'foo:bar:baz` opens the tree down
 * to it rather than showing a collapsed root.
 *
 * Exported because the page's markup and {@link visibleTagRows} must agree about it exactly.
 * They are the two halves of one question — which rows are on the page — and when each had
 * its own copy of the condition, a line could be drawn to a row that was not being shown.
 */
export function childrenShown(node: TagNode, depth: number, activeTag: string | null): boolean {
  if (node.children.length === 0) return false;
  return depth === 0 || (!!activeTag && tagMatches(node.tag, activeTag));
}

export type TagRow = { tag: string; depth: number };

/** Every row the panel draws, top to bottom — which is document order, since the tree is
 *  nested lists with nothing between them. */
export function visibleTagRows(nodes: TagNode[], activeTag: string | null, depth = 0): TagRow[] {
  return nodes.flatMap((node) => [
    { tag: node.tag, depth },
    ...(childrenShown(node, depth, activeTag)
      ? visibleTagRows(node.children, activeTag, depth + 1)
      : []),
  ]);
}

/** The middle of one tag's row, measured down from the top of the panel. Null for a tag that
 *  is not on the page — a collapsed subcategory, or one nothing carries. */
export function tagRowCenter(rows: TagRow[], tag: string | null): number | null {
  if (!tag) return null;
  const index = rows.findIndex((row) => row.tag === tag);
  return index === -1 ? null : index * TAG_ROW_HEIGHT + TAG_ROW_HEIGHT / 2;
}

/**
 * The point a tag's lines leave from: the panel's right edge, level with the tag's own row.
 *
 * The right edge rather than the left of the map, which is where the lines started when the
 * panel sat beside it. The panel is over the map now, so a line from further left would be
 * drawn under the panel for its first 200px and appear to start nowhere.
 *
 * `scrolledBy` is how far the panel has been scrolled, and it is the one part of this that
 * has to be measured. The panel is only a scroller when the tree is taller than the window —
 * it has to be, or the tags past the fold could not be reached at all — and a row scrolled up
 * out of view is a line that should leave from further up. It is zero on the server and zero
 * on first paint, so what the served HTML draws is right without it; a static export opened
 * without JavaScript keeps correct lines until someone scrolls the panel, and cannot redraw
 * them after.
 */
export function tagLineOrigin(rows: TagRow[], tag: string | null, scrolledBy = 0): Point | null {
  const center = tagRowCenter(rows, tag);
  if (center === null) return null;
  return { x: TAG_PANEL_LEFT + TAG_PANEL_WIDTH, y: TAG_PANEL_TOP + center - scrolledBy };
}
