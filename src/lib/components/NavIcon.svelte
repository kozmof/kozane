<script lang="ts">
  /**
   * The ways across a workspace, drawn instead of written.
   *
   * Three destinations that are each a arrangement of rectangles, so each is drawn as the
   * arrangement it is rather than as a symbol standing in for one: the project list is an
   * even grid, the map is a treemap and so unequal, and the tag index is rows indented under
   * one another. Kept in one file for that reason — the three only read as a set of icons
   * because they are drawn to one grid at one weight, and split across the three pages that
   * use them they would drift apart at the first edit.
   *
   * The icon carries no text, so the link around it has to carry the name: every caller
   * gives its anchor an `aria-label`, and a `title` so a pointer can ask. This is
   * `aria-hidden` precisely so that the anchor's name is the one thing announced.
   */
  type Kind = "projects" | "map" | "tags";

  let { kind, size = 16 }: { kind: Kind; size?: number } = $props();

  /**
   * Laid out on a 16-unit grid with a 2-unit margin, which is what keeps the three the same
   * weight: the ink sits between 2 and 14 whichever one is drawn, so none of them looks
   * larger than the others beside it.
   */
  const RECTS: Record<Kind, { x: number; y: number; w: number; h: number }[]> = {
    // Projects, as many of a size — the list, where no one project is the large one.
    projects: [
      { x: 2, y: 2, w: 5.5, h: 5.5 },
      { x: 8.5, y: 2, w: 5.5, h: 5.5 },
      { x: 2, y: 8.5, w: 5.5, h: 5.5 },
      { x: 8.5, y: 8.5, w: 5.5, h: 5.5 },
    ],
    // The map, as the treemap it is: one rectangle holding more than the others, which is
    // the whole of what that page says.
    map: [
      { x: 2, y: 2, w: 7, h: 12 },
      { x: 10, y: 2, w: 4, h: 5.5 },
      { x: 10, y: 8.5, w: 4, h: 5.5 },
    ],
    // Tags, as a tag sits under the tag above it.
    tags: [
      { x: 2, y: 2.5, w: 12, h: 2.5 },
      { x: 5, y: 6.75, w: 9, h: 2.5 },
      { x: 5, y: 11, w: 9, h: 2.5 },
    ],
  };
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 16 16"
  fill="currentColor"
  aria-hidden="true"
  focusable="false"
  style="display: block"
>
  {#each RECTS[kind] as rect (`${rect.x},${rect.y}`)}
    <rect x={rect.x} y={rect.y} width={rect.w} height={rect.h} rx="1" />
  {/each}
</svg>
