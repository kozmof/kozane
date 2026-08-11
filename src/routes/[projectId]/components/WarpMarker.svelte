<script lang="ts">
  import { css } from "styled-system/css";
  import type { Warp } from "$lib/types";

  let {
    warp,
    label,
    focused,
    onFocus,
  }: {
    warp: Warp;
    /** The warp's number, counting from 1 in creation order. */
    label: number;
    focused: boolean;
    onFocus: () => void;
  } = $props();

  const SIZE = 22;
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
    fontSize: "11px",
    fontVariantNumeric: "tabular-nums",
    lineHeight: "1",
    cursor: "pointer",
    transition: "background 0.1s, box-shadow 0.1s",
  })}
  aria-label="Warp {label}"
  aria-pressed={focused}
  data-warp-id={warp.id}
  style:left="{warp.posX - SIZE / 2}px"
  style:top="{warp.posY - SIZE / 2}px"
  style:width="{SIZE}px"
  style:height="{SIZE}px"
  style:z-index="250"
  style:pointer-events="auto"
  style:background={focused ? "var(--colors-select-accent)" : "var(--colors-ink-light)"}
  style:color={focused ? "var(--colors-ink-light)" : "var(--colors-neutral-secondary)"}
  style:border="1px solid {focused
    ? 'var(--colors-select-accent)'
    : 'var(--colors-neutral-border)'}"
  style:box-shadow={focused ? "0 0 0 4px color-mix(in oklch, var(--colors-select-accent) 22%, transparent)" : "0 1px 3px rgba(0,0,0,0.018)"}
  onmousedown={(e) => {
    // The canvas below starts a pan on mousedown, and a shift-drag draws a selection
    // rectangle. Clicking a marker means neither.
    e.stopPropagation();
    e.preventDefault();
    onFocus();
  }}
  onclick={(e) => e.stopPropagation()}
>
  {label}
</button>
