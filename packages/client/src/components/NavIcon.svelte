<script lang="ts">
  /**
   * Draw navigation icons for the namespace list, map, and tag tree. Use distinct shapes that
   * reflect each page's content.
   *
   * Keep the icon hidden from assistive technology. The enclosing link must provide an
   * `aria-label` and a pointer-accessible title.
   */
  type Kind = "namespaces" | "map" | "tags";

  let { kind, size = 16 }: { kind: Kind; size?: number } = $props();

  /**
   * Draw within a shared 16-unit grid and 2-unit margin. SVG clamps `rx` to half the side
   * length, rounding narrow connectors into capsules.
   */
  const RECTS: Record<Kind, { x: number; y: number; w: number; h: number }[]> = {
    // Represent the namespace list with an even grid of equal cells.
    namespaces: [
      { x: 2, y: 2, w: 5.5, h: 5.5 },
      { x: 8.5, y: 2, w: 5.5, h: 5.5 },
      { x: 2, y: 8.5, w: 5.5, h: 5.5 },
      { x: 8.5, y: 8.5, w: 5.5, h: 5.5 },
    ],
    // Draw the map as unequal rectangles packed into a treemap.
    map: [
      { x: 2, y: 2, w: 7, h: 12 },
      { x: 10, y: 2, w: 4, h: 7 },
      { x: 10, y: 10, w: 4, h: 4 },
    ],
    // Connect nested tags with a trunk ending at the last branch.
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
