import { tagMatches, type TagNode } from "$lib/tag";

/**
 * Where each tag sits in the panel beside the map, worked out from the tree rather than
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
