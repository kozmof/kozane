<script lang="ts">
  import { css } from "styled-system/css";

  let {
    sidebarsVisible,
    onToggleSidebars,
  }: {
    sidebarsVisible: boolean;
    onToggleSidebars: () => void;
  } = $props();
</script>

<button
  class={css({
    width: "28px",
    height: "28px",
    borderRadius: "2px",
    backgroundColor: "ink.light",
    border: "1px solid token(colors.neutral.border)",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 0.5px 1.5px rgba(0,0,0,0.018)",
  })}
  title={sidebarsVisible ? "Hide panels" : "Show panels"}
  onclick={onToggleSidebars}
>
  <svg width="14" height="10" viewBox="0 0 14 10" fill="none">
    {#if sidebarsVisible}
      <rect x="0" y="0" width="4" height="10" rx="1" fill="var(--colors-neutral-secondary)" />
      <rect x="5.5" y="0" width="8.5" height="10" rx="1" fill="var(--colors-neutral-icon)" />
    {:else}
      <rect x="0" y="0" width="4" height="10" rx="1" fill="var(--colors-neutral-icon)" />
      <rect x="5.5" y="0" width="8.5" height="10" rx="1" fill="var(--colors-neutral-secondary)" />
    {/if}
  </svg>
</button>
