<script lang="ts">
  import { css } from "styled-system/css";
  import { base } from "$app/paths";
  import {
    HUB_RADIUS,
    LABEL_MIN_HEIGHT,
    LABEL_MIN_WIDTH,
    type buildMapLayout,
    type tagLinks,
  } from "../lib/map-layout.js";

  /**
   * The map itself: namespace and partition areas, scope hubs with their spokes, and the
   * active tag's lines. Partitions link to their boards.
   */
  let {
    layout,
    links,
    size,
    selectedDay,
    lit,
  }: {
    layout: ReturnType<typeof buildMapLayout>;
    /** The active tag's lines. Any at all dim everything they do not reach. */
    links: ReturnType<typeof tagLinks>;
    size: { width: number; height: number };
    selectedDay: string | null;
    /** Whether a partition stays fully opaque while a tag's lines are shown. */
    lit: (partitionId: string) => boolean;
  } = $props();

  const dimming = $derived(links.length > 0);

  /**
   * Show labels only when the drawn rectangle meets shared minimum dimensions. Keep text size
   * fixed during zoom so small regions can grow large enough to label.
   */
  const roomForLabel = (rect: { width: number; height: number }) =>
    rect.width >= LABEL_MIN_WIDTH && rect.height >= LABEL_MIN_HEIGHT;
</script>

<svg
  width={size.width}
  height={size.height}
  viewBox="0 0 {size.width} {size.height}"
  aria-label={selectedDay
    ? `Namespaces and partitions by cards changed on ${selectedDay}`
    : "Namespaces and partitions by card count, with the scopes and tags that cross between them"}
  class={css({ display: "block" })}
>
  {#each layout.namespaces as namespace (namespace.id)}
    <g opacity={dimming ? 0.55 : 1}>
      <!-- Outline empty namespaces so they remain visible and distinct from small non-empty namespaces. -->
      <rect
        x={namespace.rect.x}
        y={namespace.rect.y}
        width={namespace.rect.width}
        height={namespace.rect.height}
        rx="2"
        fill={namespace.empty ? "transparent" : "var(--colors-ink-white)"}
        stroke="var(--colors-neutral-border)"
        stroke-dasharray={namespace.empty ? "2 2" : undefined}
      />
      {#if roomForLabel(namespace.rect)}
        <text
          x={namespace.rect.x + 8}
          y={namespace.rect.y + 14}
          font-size="11"
          font-family="var(--fonts-mono)"
          fill="var(--colors-neutral-muted)"
        >{namespace.name}</text>
      {/if}
    </g>
  {/each}

  {#each layout.partitions as placed (placed.partition.id)}
    {@const rect = placed.rect}
    <a href="{base}/{placed.partition.namespaceId}" aria-label="{placed.partition.name}, {placed.partition.cards} cards, in the namespace it belongs to">
      <g opacity={lit(placed.partition.id) ? 1 : 0.25}>
        <rect
          x={rect.x}
          y={rect.y}
          width={rect.width}
          height={rect.height}
          rx="2"
          fill={placed.empty ? "transparent" : placed.partition.bg}
          stroke={placed.partition.dot}
          stroke-width={placed.empty ? 1 : 0.5}
          stroke-dasharray={placed.empty ? "2 2" : undefined}
        />
        {#if roomForLabel(rect)}
          <text
            x={rect.x + 6}
            y={rect.y + 14}
            font-size="11"
            fill="var(--colors-ink-content)"
          >{placed.partition.name}</text>
          {#if rect.height >= 34}
            <text
              x={rect.x + 6}
              y={rect.y + 28}
              font-size="10"
              font-family="var(--fonts-mono)"
              fill="var(--colors-neutral-muted)"
            >{placed.partition.cards}</text>
          {/if}
        {/if}
      </g>
    </a>
  {/each}

  <!-- Keep scope edges subdued over the map rectangles. Highlight a hub's edges on hover. -->
  {#each layout.scopes as scope (scope.id)}
    <g class={css({ _hover: { opacity: "1 !important" } })} opacity={dimming ? 0.2 : 0.6}>
      {#each scope.spokes as spoke (spoke.id)}
        <path
          d={spoke.path}
          fill="none"
          stroke="var(--colors-neutral-muted)"
          stroke-width="1"
        />
      {/each}
      <circle
        cx={scope.point.x}
        cy={scope.point.y}
        r={HUB_RADIUS}
        fill="var(--colors-ink-white)"
        stroke="var(--colors-neutral-muted)"
      />
      <text
        x={scope.point.x}
        y={scope.point.y + HUB_RADIUS + 12}
        text-anchor="middle"
        font-size="10"
        font-family="var(--fonts-mono)"
        fill="var(--colors-neutral-subtle)"
      >{scope.name}</text>
    </g>
  {/each}

  <!-- The active tag's lines, drawn last so they sit over everything they cross. -->
  {#each links as link (link.id)}
    <path
      d={link.path}
      fill="none"
      stroke="var(--colors-select-accent)"
      stroke-width="1.5"
      opacity="0.85"
    />
  {/each}
</svg>
