<script lang="ts">
  /**
   * The ways across a workspace, drawn instead of written.
   *
   * Each is drawn as the thing its page is about rather than as a decoration standing in for
   * it: many of a size for the list of projects, an area carved up by how much each part
   * holds for the map, and a label for the tag index.
   *
   * That last one is why they are not all rectangles, which they were at first. A tag drawn
   * as rows of rectangles says "a list", and a list is what the project page is — so the two
   * icons differed in arrangement while meaning roughly the same thing, and a reader had to
   * remember which was which instead of recognising them. A tag has a shape of its own, and
   * borrowing it costs one notched corner and a hole.
   *
   * The icon carries no text, so the link around it has to carry the name: every caller
   * gives its anchor an `aria-label`, and a `title` so a pointer can ask. This is
   * `aria-hidden` precisely so that the anchor's name is the one thing announced.
   */
  type Kind = "projects" | "map" | "tags";

  let { kind, size = 16 }: { kind: Kind; size?: number } = $props();

  type Rect = { x: number; y: number; w: number; h: number };

  /**
   * Everything is drawn on a 16-unit grid inside a 2-unit margin — the ink sits between 2
   * and 14 whichever icon it is, so none of them looks larger than the others beside it.
   */
  const RECTS: Record<"projects" | "map", Rect[]> = {
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
  };

  /**
   * A tag: a label with a corner drawn to a point and a hole punched through it.
   *
   * One path rather than a shape and a circle on top, because the hole has to be a hole. The
   * icons take their colour from the link around them and the map's header is transparent
   * over the drawing, so a circle painted in "the background colour" would have to know a
   * background that changes underneath it. `fill-rule="evenodd"` makes the second subpath
   * subtract from the first instead, and it is right on every ground it is put on.
   */
  const TAG_PATH =
    "M 6.4 2.5 H 13 Q 14 2.5 14 3.5 V 12.5 Q 14 13.5 13 13.5 H 6.4 L 2 8 Z" +
    " M 5.6 8 m -1 0 a 1 1 0 1 0 2 0 a 1 1 0 1 0 -2 0 Z";
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
  {#if kind === "tags"}
    <path d={TAG_PATH} fill-rule="evenodd" />
  {:else}
    {#each RECTS[kind] as rect (`${rect.x},${rect.y}`)}
      <rect x={rect.x} y={rect.y} width={rect.w} height={rect.h} rx="1" />
    {/each}
  {/if}
</svg>
