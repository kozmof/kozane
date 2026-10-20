<script lang="ts">
  import { css } from "styled-system/css";
  import type { Inventory } from "$lib/types";

  let {
    inventory,
    label,
    count,
    open,
    dropHover = false,
    draggable = false,
    dragging = false,
    onMouseDown,
    onToggle,
  }: {
    inventory: Inventory;
    /** The inventory's name, or a numbered fallback for an unnamed one. */
    label: string;
    /** How many cards it holds. */
    count: number;
    /** Whether its grid is showing. */
    open: boolean;
    /** Whether a dragged card would be stored here if let go now. */
    dropHover?: boolean;
    /** Whether this board lets an icon be moved. A read-only export does not. */
    draggable?: boolean;
    dragging?: boolean;
    /** The press, which the canvas turns into a drag, or into a toggle if it never moves. */
    onMouseDown: (event: MouseEvent) => void;
    /** Opens or closes the grid where there is no drag to do it, as on a read-only board. */
    onToggle: () => void;
  } = $props();

  const SIZE = 34;
  const accent = $derived(open || dropHover);
</script>

<!-- Centre the icon on the inventory's coordinates, like a warp marker. -->
<button
  class={css({
    position: "absolute",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0",
    borderRadius: "4px",
    transition: "background 0.1s, box-shadow 0.1s, transform 0.1s",
  })}
  aria-label="{label}, {count} card{count === 1 ? '' : 's'}"
  aria-expanded={open}
  data-inventory-id={inventory.id}
  data-inventory-drop={inventory.id}
  style:left="{inventory.posX - SIZE / 2}px"
  style:top="{inventory.posY - SIZE / 2}px"
  style:width="{SIZE}px"
  style:height="{SIZE}px"
  style:z-index="250"
  style:pointer-events="auto"
  style:cursor={dragging ? "grabbing" : draggable ? "grab" : "pointer"}
  style:background={dropHover ? "var(--colors-select-bg)" : "var(--colors-ink-white)"}
  style:color={accent ? "var(--colors-select-accent)" : "var(--colors-neutral-subtle)"}
  style:border="1px solid {accent ? 'var(--colors-select-accent)' : 'var(--colors-neutral-dim)'}"
  style:box-shadow={dropHover
    ? "0 0 0 4px color-mix(in oklch, var(--colors-select-accent) 22%, transparent)"
    : "0 0.5px 1.5px rgba(0,0,0,0.04)"}
  style:transform={dropHover ? "scale(1.08)" : "none"}
  onmousedown={(e) => {
    // Pressing the icon starts neither a pan nor a selection rectangle on the canvas below.
    e.stopPropagation();
    e.preventDefault();
    onMouseDown(e);
  }}
  onclick={(e) => {
    e.stopPropagation();
    if (!draggable) onToggle();
  }}
>
  <!-- Draw the inventory as a box with a lid. -->
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
    <rect x="2.5" y="6.5" width="13" height="9" rx="1" stroke="currentColor" stroke-width="1.2" />
    <path d="M1.5 4.5h15v2h-15z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
    <path d="M7 9.5h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
  </svg>
  {#if count > 0}
    <span
      class={css({
        position: "absolute",
        top: "-7px",
        right: "-7px",
        minWidth: "16px",
        height: "16px",
        padding: "0 4px",
        borderRadius: "8px",
        fontSize: "9.5px",
        lineHeight: "16px",
        fontVariantNumeric: "tabular-nums",
        textAlign: "center",
        color: "ink.white",
        backgroundColor: "select.accent",
      })}
      aria-hidden="true">{count}</span
    >
  {/if}
  <span
    class={css({
      position: "absolute",
      top: "100%",
      left: "50%",
      transform: "translateX(-50%)",
      marginTop: "4px",
      maxWidth: "140px",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      fontSize: "10px",
      color: "neutral.muted",
      pointerEvents: "none",
    })}
    aria-hidden="true">{label}</span
  >
</button>
