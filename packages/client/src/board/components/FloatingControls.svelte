<script lang="ts">
  import { css } from "../../styles/css.js";

  let {
    zoom,
    zoomStep,
    showZoom = true,
    onZoom,
  }: {
    zoom: number;
    zoomStep: number;
    showZoom?: boolean;
    onZoom: (delta: number) => void;
  } = $props();
</script>

{#if showZoom}
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
    boxShadow: "0 0.5px 3px rgba(0,0,0,0.018)",
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
{/if}
