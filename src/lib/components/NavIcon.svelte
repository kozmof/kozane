<script lang="ts">
  /**
   * The ways across a workspace, drawn instead of written.
   *
   * Each is drawn as the thing its page is about rather than as a decoration standing in for
   * it: many of a size for the list of projects, an area carved up by how much each part
   * holds for the map, and a tree branching into its own children for the tag index.
   *
   * They have to differ in what they mean and not only in how they are arranged, which is
   * the mistake worth recording. The tag index was rows of rectangles at first, and rows of
   * rectangles say "a list" — which is what the project page is. Two icons that look
   * different while meaning the same thing have to be remembered rather than recognised.
   * A tree says nesting, which is what a tag namespace is and what no other page here has.
   *
   * The icon carries no text, so the link around it has to carry the name: every caller
   * gives its anchor an `aria-label`, and a `title` so a pointer can ask. This is
   * `aria-hidden` precisely so that the anchor's name is the one thing announced.
   */
  type Kind = "projects" | "map" | "tags";

  let { kind, size = 16 }: { kind: Kind; size?: number } = $props();

  /**
   * Everything is drawn on a 16-unit grid inside a 2-unit margin — the ink sits between 2
   * and 14 whichever icon it is, so none of them looks larger than the others beside it.
   *
   * All three are rectangles, and `rx` does the rest: SVG clamps a corner radius to half the
   * side it is rounding, so one value gives the wide bars a soft corner and turns the tree's
   * 1.2-thin connectors into capsules without either being asked for separately.
   */
  const RECTS: Record<Kind, { x: number; y: number; w: number; h: number }[]> = {
    // The project list: many of a size, no one of them the large one. An even grid, so what
    // is read is the regularity rather than any one cell.
    projects: [
      { x: 2, y: 2, w: 5.5, h: 5.5 },
      { x: 8.5, y: 2, w: 5.5, h: 5.5 },
      { x: 2, y: 8.5, w: 5.5, h: 5.5 },
      { x: 8.5, y: 8.5, w: 5.5, h: 5.5 },
    ],
    // The map: unequal rectangles tiling the box between them, down to the gutters. A
    // treemap has no margins inside it — every part of it stands for cards — so drawing it
    // packed is what separates it from an arrangement of rectangles that merely looks tidy.
    map: [
      { x: 2, y: 2, w: 7, h: 12 },
      { x: 10, y: 2, w: 4, h: 7 },
      { x: 10, y: 10, w: 4, h: 4 },
    ],
    // The tag index: a tag, and the tags written underneath it. The trunk drops from the
    // root and stops at the last branch it has to reach, which is what makes the shape a
    // tree rather than three bars that happen to be indented — the connection is drawn.
    tags: [
      { x: 2, y: 2, w: 5, h: 3 },
      { x: 3.9, y: 5, w: 1.2, h: 6.9 },
      { x: 5.1, y: 7.4, w: 2.9, h: 1.2 },
      { x: 8, y: 6.25, w: 6, h: 3.5 },
      { x: 5.1, y: 11.3, w: 2.9, h: 1.2 },
      { x: 8, y: 10.15, w: 6, h: 3.5 },
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
