<script lang="ts">
  import { css } from "styled-system/css";
  import { token } from "styled-system/tokens";
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
    onRemove,
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
    /**
     * Takes this frame off the board.
     *
     * On the frame rather than in the side panel, because a scope may be framed in several
     * places and the panel has no way to say which one you mean. Here the answer is the one
     * you clicked.
     */
    onRemove: () => void;
  } = $props();

  // The tab sits above the frame rather than inside it, so it never covers a card in the
  // top-left corner — which is where the first card dragged in tends to land.
  const TAB_HEIGHT = 22;

  /**
   * What the frame is drawn in — the selection accent when the board is held to this scope,
   * and an icon-weight grey otherwise. Both states are drawn: a frame is where a scope lives
   * on the board, which is true whether or not it is the one being filtered to.
   *
   * Through `token.var` rather than a hand-written `var(--colors-…)`: Panda kebab-cases the
   * camelCase half of a token name, so `neutral.iconDim` is `--colors-neutral-icon-dim`, and
   * spelling it by hand got it wrong. An undefined custom property makes every declaration
   * that reads it invalid, and CSS drops an invalid declaration silently — so the frame had
   * no border and no fill and simply did not appear. This form is type-checked against the
   * same token list `css()` uses, so the next wrong name is a build error instead.
   */
  const accent = $derived(
    focused ? token.var("colors.select.accent") : token.var("colors.neutral.iconDim"),
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
    <!-- Rides at the right-hand end of the tab, outside the tab's own button so a press on
         it is a removal rather than the start of a drag. -->
    <button
      class={css({
        position: "absolute",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: "16px",
        border: "none",
        background: "none",
        cursor: "pointer",
        fontSize: "12px",
        lineHeight: "1",
        opacity: "0",
        transition: "opacity 0.12s, color 0.12s",
        "&:hover, &:focus-visible": { opacity: "1", color: "state.error" },
        "[data-scope-area-id]:hover &": { opacity: "0.7" },
      })}
      aria-label="Remove frame {name}"
      title="Remove this frame. The scope keeps its cards."
      style:left="calc(100% + 4px)"
      style:top="-{TAB_HEIGHT}px"
      style:height="{TAB_HEIGHT}px"
      style:pointer-events="auto"
      style:color={focused ? accent : "var(--colors-neutral-secondary)"}
      onmousedown={(e) => {
        // The tab beside this one arms a drag on mousedown; this must not.
        e.stopPropagation();
        e.preventDefault();
      }}
      onclick={(e) => {
        e.stopPropagation();
        onRemove();
      }}>×</button
    >
  {/if}

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
