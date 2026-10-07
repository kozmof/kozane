<script lang="ts">
  import { css } from "styled-system/css";
  import { zoomPercent } from "../lib/view.js";

  /**
   * Use the board's zoom-control placement and limits for consistent interaction. Clicking
   * the zoom reading resets the map view.
   */
  let {
    zoom,
    zoomStep,
    atDefault,
    onZoomBy,
    onReset,
  }: {
    zoom: number;
    zoomStep: number;
    /** Whether the map is at the view it opens at, where the reset has nothing to do. */
    atDefault: boolean;
    onZoomBy: (delta: number) => void;
    onReset: () => void;
  } = $props();

  const stepButtons = $derived([
    { label: "Zoom out", glyph: "−", delta: -zoomStep },
    { label: "Zoom in", glyph: "+", delta: zoomStep },
  ]);
</script>

<div
  class={css({
    position: "absolute",
    bottom: "12px",
    right: "12px",
    display: "flex",
    alignItems: "center",
    gap: "1px",
    backgroundColor: "ink.light",
    borderRadius: "2px",
    border: "1px solid token(colors.neutral.dim)",
    boxShadow: "0 1px 6px rgba(0,0,0,0.018)",
    overflow: "hidden",
  })}
>
  {#each stepButtons as { label, glyph, delta } (label)}
    <button
      type="button"
      aria-label={label}
      onclick={() => onZoomBy(delta)}
      class={css({
        width: "30px",
        height: "26px",
        border: "none",
        background: "transparent",
        cursor: "pointer",
        color: "ink.secondary",
        padding: "0",
        fontFamily: "mono",
        fontSize: "13px",
        lineHeight: "1",
      })}>{glyph}</button
    >
  {/each}
  <button
    type="button"
    disabled={atDefault}
    title={atDefault ? "At the size the map opens at" : "Back to the size the map opens at"}
    onclick={onReset}
    class={css({
      padding: "0 8px",
      height: "26px",
      minWidth: "48px",
      fontSize: "11px",
      fontFamily: "mono",
      color: "neutral.secondary",
      background: "transparent",
      border: "none",
      borderLeft: "1px solid token(colors.neutral.dim)",
      cursor: "pointer",
      _disabled: { cursor: "default" },
    })}>{zoomPercent(zoom)}%</button
  >
</div>
