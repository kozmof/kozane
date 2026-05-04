<script lang="ts">
  import { css } from "styled-system/css";
  import { ZOOM_STEP } from "../lib/project-page";

  let {
    zoom,
    showFooters,
    sidebarsVisible,
    onToggleFooters,
    onToggleSidebars,
    onZoom,
  }: {
    zoom: number;
    showFooters: boolean;
    sidebarsVisible: boolean;
    onToggleFooters: () => void;
    onToggleSidebars: () => void;
    onZoom: (delta: number) => void;
  } = $props();
</script>

<button
  class={css({
    position: "absolute",
    top: "12px",
    right: "52px",
    zIndex: "51",
    width: "28px",
    height: "28px",
    borderRadius: "6px",
    backgroundColor: "ink.light",
    border: "1px solid token(colors.warm.border)",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 1px 4px rgba(0,0,0,0.07)",
  })}
  title={showFooters ? "Hide footers" : "Show footers"}
  onclick={onToggleFooters}
>
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
    <rect x="0" y="0" width="12" height="8" rx="1.5"
      fill={showFooters ? "var(--colors-warm-icon)" : "var(--colors-warm-subtle)"} />
    <rect x="0" y="9" width="12" height="3" rx="1"
      fill={showFooters ? "var(--colors-warm-subtle)" : "var(--colors-warm-icon)"} />
  </svg>
</button>

<button
  class={css({
    position: "absolute",
    top: "12px",
    right: "16px",
    zIndex: "51",
    width: "28px",
    height: "28px",
    borderRadius: "6px",
    backgroundColor: "ink.light",
    border: "1px solid token(colors.warm.border)",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 1px 4px rgba(0,0,0,0.07)",
  })}
  title={sidebarsVisible ? "Hide panels" : "Show panels"}
  onclick={onToggleSidebars}
>
  <svg width="14" height="10" viewBox="0 0 14 10" fill="none">
    {#if sidebarsVisible}
      <rect x="0" y="0" width="4" height="10" rx="1" fill="var(--colors-warm-subtle)" />
      <rect x="5.5" y="0" width="8.5" height="10" rx="1" fill="var(--colors-warm-icon)" />
    {:else}
      <rect x="0" y="0" width="4" height="10" rx="1" fill="var(--colors-warm-icon)" />
      <rect x="5.5" y="0" width="8.5" height="10" rx="1" fill="var(--colors-warm-subtle)" />
    {/if}
  </svg>
</button>

<div
  class={css({
    position: "absolute",
    bottom: "20px",
    right: "16px",
    display: "flex",
    alignItems: "center",
    gap: "1px",
    backgroundColor: "ink.light",
    borderRadius: "7px",
    border: "1px solid token(colors.warm.dim)",
    boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
    zIndex: "51",
    overflow: "hidden",
  })}
>
  {#each [["−", -ZOOM_STEP], ["+", ZOOM_STEP]] as [label, delta] (label)}
    <button
      class={css({
        width: "30px",
        height: "28px",
        border: "none",
        background: "transparent",
        cursor: "pointer",
        fontSize: "16px",
        color: "ink.secondary",
        lineHeight: "1",
        fontFamily: "inherit",
      })}
      onclick={() => onZoom(delta as number)}
    >{label}</button>
  {/each}
  <div class={css({
    padding: "0 8px",
    fontSize: "11px",
    color: "warm.secondary",
    borderLeft: "1px solid token(colors.warm.dim)",
    height: "28px",
    display: "flex",
    alignItems: "center",
    minWidth: "40px",
    justifyContent: "center",
  })}>
    {Math.round(zoom * 100)}%
  </div>
</div>
