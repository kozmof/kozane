<script lang="ts">
  import { css } from "styled-system/css";
  import type { Warp } from "$lib/types";

  let {
    warp,
    label,
    focused,
    size,
    draggable = false,
    dragging = false,
    onMouseDown,
  }: {
    warp: Warp;
    /** The warp's number, counting from 1 in creation order. */
    label: number;
    focused: boolean;
    /** Diameter in canvas pixels, from `ui.warpMarkerSize`. */
    size: number;
    /** Whether this board lets a marker be moved. A read-only export does not. */
    draggable?: boolean;
    /** Whether this marker is the one being dragged right now. */
    dragging?: boolean;
    /** The press itself, which the canvas turns into a focus and possibly a drag. */
    onMouseDown: (event: MouseEvent) => void;
  } = $props();

  // The number rides along with the circle: half the diameter keeps a two-digit label
  // inside a small marker, and the floor keeps it readable once the marker is tiny.
  const fontSize = $derived(Math.max(7, Math.round(size * 0.5)));
  const focusRing = $derived(Math.max(2, Math.round(size * 0.18)));
</script>

<!-- Centred on the warp's own coordinates: a warp marks a point, not a corner. -->
<button
  class={css({
    position: "absolute",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0",
    borderRadius: "50%",
    fontVariantNumeric: "tabular-nums",
    lineHeight: "1",
    transition: "background 0.1s, box-shadow 0.1s",
  })}
  aria-label="Warp {label}"
  aria-pressed={focused}
  data-warp-id={warp.id}
  style:left="{warp.posX - size / 2}px"
  style:top="{warp.posY - size / 2}px"
  style:width="{size}px"
  style:height="{size}px"
  style:font-size="{fontSize}px"
  style:z-index="250"
  style:pointer-events="auto"
  style:cursor={dragging ? "grabbing" : draggable ? "grab" : "pointer"}
  style:background={focused ? "var(--colors-select-accent)" : "var(--colors-ink-light)"}
  style:color={focused ? "var(--colors-ink-light)" : "var(--colors-neutral-secondary)"}
  style:border="1px solid {focused
    ? 'var(--colors-select-accent)'
    : 'var(--colors-neutral-border)'}"
  style:box-shadow={focused
    ? `0 0 0 ${focusRing}px color-mix(in oklch, var(--colors-select-accent) 22%, transparent)`
    : "0 1px 3px rgba(0,0,0,0.018)"}
  onmousedown={(e) => {
    // The canvas below starts a pan on mousedown, and a shift-drag draws a selection
    // rectangle. Pressing a marker means neither: it focuses the warp, and may go on to
    // drag it somewhere else.
    e.stopPropagation();
    e.preventDefault();
    onMouseDown(e);
  }}
  onclick={(e) => e.stopPropagation()}
>
  {label}
</button>
