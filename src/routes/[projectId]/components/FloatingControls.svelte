<script lang="ts">
  import { css } from "styled-system/css";

  let {
    zoom,
    zoomStep,
    showFooters,
    sidebarsVisible,
    onToggleFooters,
    onToggleSidebars,
    onZoom,
  }: {
    zoom: number;
    zoomStep: number;
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
    borderRadius: "2px",
    backgroundColor: "ink.light",
    border: "1px solid token(colors.neutral.border)",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 1px 3px rgba(0,0,0,0.018)",
  })}
  title={showFooters ? "Hide footers" : "Show footers"}
  onclick={onToggleFooters}
>
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
    <rect x="0" y="0" width="12" height="8" rx="1.5"
      fill={showFooters ? "var(--colors-neutral-icon)" : "var(--colors-neutral-subtle)"} />
    <rect x="0" y="9" width="12" height="3" rx="1"
      fill={showFooters ? "var(--colors-neutral-subtle)" : "var(--colors-neutral-icon)"} />
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
    borderRadius: "2px",
    backgroundColor: "ink.light",
    border: "1px solid token(colors.neutral.border)",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 1px 3px rgba(0,0,0,0.018)",
  })}
  title={sidebarsVisible ? "Hide panels" : "Show panels"}
  onclick={onToggleSidebars}
>
  <svg width="14" height="10" viewBox="0 0 14 10" fill="none">
    {#if sidebarsVisible}
      <rect x="0" y="0" width="4" height="10" rx="1" fill="var(--colors-neutral-subtle)" />
      <rect x="5.5" y="0" width="8.5" height="10" rx="1" fill="var(--colors-neutral-icon)" />
    {:else}
      <rect x="0" y="0" width="4" height="10" rx="1" fill="var(--colors-neutral-icon)" />
      <rect x="5.5" y="0" width="8.5" height="10" rx="1" fill="var(--colors-neutral-subtle)" />
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
    borderRadius: "2px",
    border: "1px solid token(colors.neutral.dim)",
    boxShadow: "0 1px 6px rgba(0,0,0,0.018)",
    zIndex: "51",
    overflow: "hidden",
  })}
>
  {#each [["−", -zoomStep], ["+", zoomStep]] as [label, delta] (label)}
    <button
      class={css({
        width: "30px",
        height: "28px",
        border: "none",
        background: "transparent",
        cursor: "pointer",
        color: "ink.secondary",
        padding: "0",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      })}
      aria-label={label === "−" ? "Zoom out" : "Zoom in"}
      onclick={() => onZoom(delta as number)}
    >
      <span
        aria-hidden="true"
        class={css({ position: "relative", display: "block", width: "10px", height: "10px" })}
      >
        <span class={css({ position: "absolute", top: "4.5px", left: "0", width: "10px", height: "1px", backgroundColor: "currentColor" })}></span>
        {#if label === "+"}
          <span class={css({ position: "absolute", top: "0", left: "4.5px", width: "1px", height: "10px", backgroundColor: "currentColor" })}></span>
        {/if}
      </span>
    </button>
  {/each}
  <div class={css({
    padding: "0 8px",
    fontSize: "11px",
    color: "neutral.secondary",
    borderLeft: "1px solid token(colors.neutral.dim)",
    height: "28px",
    display: "flex",
    alignItems: "center",
    minWidth: "40px",
    justifyContent: "center",
  })}>
    {Math.round(zoom * 100)}%
  </div>
</div>
