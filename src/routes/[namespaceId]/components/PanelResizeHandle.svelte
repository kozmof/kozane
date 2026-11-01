<script lang="ts">
  import { css } from "styled-system/css";

  /**
   * The draggable left edge of the editor panel. It sits over the panel's padding so it
   * leaves the text's click targets alone, and is a focusable separator that arrow keys move.
   */
  let {
    width = $bindable(),
    measuredWidth,
    minWidth,
    keyStep,
  }: {
    /** Requested panel width in pixels, or null for the responsive default. */
    width: number | null;
    /** The panel's drawn width, for a resize that starts from the responsive default. */
    measuredWidth: () => number;
    minWidth: number;
    keyStep: number;
  } = $props();

  function currentWidth(): number {
    // Use the stored width after the first drag to preserve motion beyond the CSS clamp.
    // Measure the rendered width only when starting from the responsive default.
    return width ?? (measuredWidth() || minWidth);
  }

  function resizeTo(px: number): void {
    // Clamp the minimum width here and let CSS enforce the viewport-dependent maximum.
    width = Math.max(minWidth, Math.round(px));
  }

  function onHandleMousedown(event: MouseEvent): void {
    if (event.button !== 0) return;
    // Prevent resizing from selecting text or moving focus.
    event.preventDefault();

    const startX = event.clientX;
    const startWidth = currentWidth();

    // Track resizing on the window so dragging continues beyond the panel edge.
    const onMove = (move: MouseEvent) => resizeTo(startWidth + (startX - move.clientX));
    const onUp = () => {
      globalThis.removeEventListener("mousemove", onMove);
      globalThis.removeEventListener("mouseup", onUp);
    };
    globalThis.addEventListener("mousemove", onMove);
    globalThis.addEventListener("mouseup", onUp);
  }

  function onHandleKeydown(event: KeyboardEvent): void {
    // Left widens, because the edge being moved is the panel's left one.
    if (event.key === "ArrowLeft") resizeTo(currentWidth() + keyStep);
    else if (event.key === "ArrowRight") resizeTo(currentWidth() - keyStep);
    else return;
    event.preventDefault();
    event.stopPropagation();
  }
</script>

<!-- This focusable separator is an interactive splitter, which requires the accessibility-rule exception below. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class={css({
    position: "absolute",
    top: "0",
    bottom: "0",
    left: "0",
    width: "6px",
    cursor: "col-resize",
    zIndex: "1",
    "&:hover": { backgroundColor: "select.bg" },
    "&:focus-visible": { outline: "2px solid token(colors.select.accent)", outlineOffset: "0" },
  })}
  role="separator"
  aria-orientation="vertical"
  aria-label="Resize editor"
  aria-valuenow={Math.round(currentWidth())}
  aria-valuemin={minWidth}
  tabindex="0"
  onmousedown={onHandleMousedown}
  onkeydown={onHandleKeydown}
  data-testid="editor-resize"
></div>
