<script lang="ts">
  import { css } from "styled-system/css";
  import type { ScopeArea } from "$lib/types";

  let {
    area,
    name,
    focused,
    draggable = false,
    dragging = false,
    resizing = false,
    onMouseDown,
    onResizeMouseDown,
  }: {
    area: ScopeArea;
    /** The scope's name, drawn on the frame's tab. */
    name: string;
    /** Whether this is the scope the board is currently filtered to. */
    focused: boolean;
    /** Whether this board lets a frame be moved. A read-only export does not. */
    draggable?: boolean;
    /** Whether this frame is the one being dragged right now. */
    dragging?: boolean;
    /** Whether this frame is the one being resized right now. */
    resizing?: boolean;
    /** The press on the tab, which the canvas turns into a drag of the frame and its cards. */
    onMouseDown: (event: MouseEvent) => void;
    /** The press on the corner handle, which the canvas turns into a resize. */
    onResizeMouseDown: (event: MouseEvent) => void;
  } = $props();

  // The tab sits above the frame rather than inside it, so it never covers a card in the
  // top-left corner — which is where the first card dragged in tends to land.
  const TAB_HEIGHT = 22;

  const accent = $derived(
    focused ? "var(--colors-select-accent)" : "var(--colors-neutral-iconDim)",
  );
</script>

<!--
  Drawn under every card, and never dimmed with a layer: a frame is a place on the board, the
  same as a warp marker, and the cards it holds may sit on any layer at all.

  The body takes no pointer events. Everything inside a frame — clicking a card, dragging one,
  sweeping a selection across the middle of it — has to keep working exactly as it does on bare
  canvas, so only the tab and the corner handle are grabbable.
-->
<div
  class={css({ position: "absolute" })}
  data-scope-area-id={area.id}
  data-scope-id={area.scopeId}
  style:left="{area.posX}px"
  style:top="{area.posY}px"
  style:width="{area.width}px"
  style:height="{area.height}px"
  style:z-index="0"
  style:pointer-events="none"
>
  <div
    class={css({ position: "absolute", inset: "0", borderRadius: "3px" })}
    style:border="1px solid {accent}"
    style:background="color-mix(in oklch, {accent} {focused ? 7 : 4}%, transparent)"
    style:box-shadow={dragging || resizing
      ? `0 0 0 2px color-mix(in oklch, ${accent} 22%, transparent)`
      : "none"}
  ></div>

  <button
    class={css({
      position: "absolute",
      display: "flex",
      alignItems: "center",
      maxWidth: "100%",
      padding: "0 8px",
      borderRadius: "3px 3px 0 0",
      border: "1px solid",
      borderBottom: "none",
      fontSize: "11px",
      lineHeight: "1",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis",
    })}
    aria-label="Scope area {name}"
    aria-pressed={focused}
    style:left="0"
    style:top="-{TAB_HEIGHT}px"
    style:height="{TAB_HEIGHT}px"
    style:pointer-events="auto"
    style:cursor={dragging ? "grabbing" : draggable ? "grab" : "default"}
    style:background={focused ? accent : "var(--colors-ink-light)"}
    style:color={focused ? "var(--colors-ink-light)" : "var(--colors-neutral-secondary)"}
    style:border-color={accent}
    onmousedown={(e) => {
      // Same reason `WarpMarker` does this: the canvas underneath starts a pan on mousedown
      // and a marquee on shift-mousedown, and a press on the tab means neither.
      e.stopPropagation();
      e.preventDefault();
      onMouseDown(e);
    }}
    onclick={(e) => e.stopPropagation()}
  >
    {name}
  </button>

  {#if draggable}
    <button
      class={css({ position: "absolute", padding: "0", borderRadius: "0 0 3px 0" })}
      aria-label="Resize scope area {name}"
      style:right="-1px"
      style:bottom="-1px"
      style:width="14px"
      style:height="14px"
      style:pointer-events="auto"
      style:cursor="nwse-resize"
      style:background={accent}
      style:border="none"
      style:opacity={resizing ? "1" : "0.55"}
      onmousedown={(e) => {
        e.stopPropagation();
        e.preventDefault();
        onResizeMouseDown(e);
      }}
      onclick={(e) => e.stopPropagation()}
    ></button>
  {/if}
</div>
