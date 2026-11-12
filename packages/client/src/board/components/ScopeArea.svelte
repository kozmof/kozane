<script lang="ts">
  import { css } from "../../styles/css.js";
  import { token } from "../../styles/tokens.js";
  import type { ScopeArea } from "@kozane/core";

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
     * Remove this frame from the board. Keep the control on the frame so scopes with
     * multiple frames have an unambiguous removal target.
     */
    onRemove: () => void;
  } = $props();

  // Place the tab above the frame so it does not cover cards near the top-left corner.
  const TAB_HEIGHT = 22;
  const CORNER_RADIUS = 4;
  let labelWidth = $state(0);
  const tabRight = $derived(labelWidth + 2);
  const outline = $derived([
    `M 0 0 V ${-TAB_HEIGHT + CORNER_RADIUS}`,
    `Q 0 ${-TAB_HEIGHT} ${CORNER_RADIUS} ${-TAB_HEIGHT}`,
    `H ${Math.max(CORNER_RADIUS, tabRight - CORNER_RADIUS)}`,
    `Q ${tabRight} ${-TAB_HEIGHT} ${tabRight} ${-TAB_HEIGHT + CORNER_RADIUS}`,
    `V ${-CORNER_RADIUS} Q ${tabRight} 0 ${tabRight + CORNER_RADIUS} 0`,
    `H ${area.width - CORNER_RADIUS} Q ${area.width} 0 ${area.width} ${CORNER_RADIUS}`,
    `V ${area.height - CORNER_RADIUS}`,
    `Q ${area.width} ${area.height} ${area.width - CORNER_RADIUS} ${area.height}`,
    `H ${CORNER_RADIUS} Q 0 ${area.height} 0 ${area.height - CORNER_RADIUS} Z`,
  ].join(" "));

  /**
   * Use the selection accent for the focused scope and gray otherwise. Resolve colors through
   * `token.var` so token names are checked and generated CSS variable names stay correct.
   */
  const accent = $derived(
    focused ? token.var("colors.select.accent") : token.var("colors.neutral.secondary"),
  );
</script>

<!-- Draw frames below cards without layer dimming. Let pointer events pass through the body so normal canvas interactions work inside it. The header and resize handle capture input. -->
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
  <svg
    class={css({ position: "absolute", overflow: "visible" })}
    width={area.width}
    height={area.height}
    aria-hidden="true"
  >
    <path
      d={outline}
      fill={`color-mix(in oklch, ${accent} ${focused ? 7 : 4}%, transparent)`}
      stroke={accent}
      stroke-width="1"
    />
  </svg>

  <!-- Keep a continuous hover target from the name across to the remove button. -->
  <div
    data-scope-area-header
    class={css({ position: "absolute" })}
    style:left="0"
    style:top="-{TAB_HEIGHT}px"
    style:width="calc(100% + 20px)"
    style:height="{TAB_HEIGHT}px"
    style:pointer-events={draggable ? "auto" : "none"}
  >
    <button
      class={css({
        position: "absolute",
        display: "flex",
        alignItems: "center",
        maxWidth: "calc(100% - 20px)",
        padding: "0 8px",
        border: "1px solid transparent",
        borderBottom: "none",
        fontSize: "11px",
        lineHeight: "1",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      })}
      style:border-radius="{CORNER_RADIUS}px {CORNER_RADIUS}px 0 0"
      bind:clientWidth={labelWidth}
      aria-label="Scope area {name}"
      aria-pressed={focused}
      style:left="0"
      style:top="0"
      style:height="{TAB_HEIGHT}px"
      style:pointer-events="auto"
      style:cursor={dragging ? "grabbing" : draggable ? "grab" : "default"}
      style:background="transparent"
      style:color={accent}
      onmousedown={(e) => {
        // `WarpMarker` does this for the same reason. The canvas underneath starts a pan on mousedown
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
      <!-- Keep removal separate from the name tab so pressing it does not start a drag. -->
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
          "[data-scope-area-header]:hover &": { opacity: "0.7" },
        })}
        aria-label="Remove frame {name}"
        title="Remove this frame. The scope keeps its cards."
        style:right="0"
        style:top="0"
        style:height="{TAB_HEIGHT}px"
        style:pointer-events="auto"
        style:color={focused ? accent : "var(--colors-neutral-secondary)"}
        onmousedown={(e) => {
          // The tab beside this one arms a drag on mousedown, but this must not.
          e.stopPropagation();
          e.preventDefault();
        }}
        onclick={(e) => {
          e.stopPropagation();
          onRemove();
        }}>×</button
      >
    {/if}
  </div>

  {#if draggable}
    <button
      class={css({ position: "absolute", padding: "0" })}
      aria-label="Resize scope area {name}"
      style:border-radius="0 0 {CORNER_RADIUS}px 0"
      style:right="0"
      style:bottom="0"
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
