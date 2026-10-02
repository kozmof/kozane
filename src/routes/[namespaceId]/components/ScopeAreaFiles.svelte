<script lang="ts">
  import { css, cx } from "styled-system/css";
  import type { ScopeArea } from "$lib/types";
  import {
    CELL_HEIGHT,
    CELL_WIDTH,
    STRIP_GAP,
    stripWidth,
    visibleCells,
    type FileGroup,
  } from "../lib/scope-area-files.js";
  import { truncationNote } from "../lib/taskspace-truncation.js";
  import FileGlyph from "./FileGlyph.svelte";

  let {
    area,
    groups,
    onOpenFile,
    onNavigate,
  }: {
    area: ScopeArea;
    /** One per taskspace of this frame's scope, in the order the panel lists them. */
    groups: FileGroup[];
    /**
     * Opens one file of one taskspace in the editor. Absent where the board has no endpoint
     * to read a file with, and the cells are then drawn and inert — exactly what the panel's
     * tree does with the same prop missing.
     */
    onOpenFile?: (taskspaceId: string, path: string) => void;
    /** Points this frame's view of one taskspace at another of its directories. */
    onNavigate: (taskspaceId: string, path: string) => void;
  } = $props();

  /**
   * Outside the frame, below its bottom edge and right-aligned to it.
   *
   * Outside for the same reason the tab is outside the top edge: everything within a frame
   * has to keep behaving like bare canvas — a card dropped in the bottom-right corner, a
   * marquee swept across it — and a band of icons inside would be a band of board the frame
   * had quietly taken away. Outside it also needs no clipping and no scroll region of its
   * own, which is what makes a fixed two rows enough.
   *
   * The width is {@link stripWidth}, which can exceed the frame's: a frame may be as narrow
   * as 120px, and the strip is not bound by a box it sits outside of. Clamped at the left so
   * a frame near the board's edge does not lay its icons off it.
   */
  const width = $derived(stripWidth(area));
  const left = $derived(Math.max(0, area.posX + area.width - width));
  const top = $derived(area.posY + area.height + STRIP_GAP);

  /**
   * Whether a taskspace's name is written above its icons. Only once a scope has more than
   * one: the frame's tab already names the scope, and with a single taskspace the label
   * would be a second heading over the same handful of files.
   */
  const named = $derived(groups.length > 1);

  const noteClass = css({
    fontSize: "10px",
    lineHeight: "1.3",
    color: "neutral.subtle",
    fontStyle: "italic",
    textAlign: "right",
  });

  const cellClass = css({
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "3px",
    padding: "3px 2px",
    border: "none",
    borderRadius: "3px",
    background: "transparent",
    color: "neutral.iconDim",
    fontFamily: "inherit",
    textAlign: "center",
  });

  const clickableClass = css({
    cursor: "pointer",
    "&:hover": { backgroundColor: "neutral.bg", color: "ink.secondary" },
  });

  /**
   * Two lines of name and no more: a long one wraps once and is then cut off, so a cell
   * cannot grow and push the row below it out of line. Clipped rather than ellipsised, which
   * would want `-webkit-line-clamp` — a vendor property nothing else in the UI reaches for.
   * The whole name is on the cell's `title` either way.
   */
  const labelClass = css({
    width: "100%",
    fontSize: "9.5px",
    lineHeight: "1.2",
    maxHeight: "23px",
    color: "neutral.secondary",
    overflow: "hidden",
    overflowWrap: "anywhere",
  });

  /**
   * The canvas underneath starts a pan on mousedown and a marquee on shift-mousedown, and a
   * press on a cell means neither. The same guard the tab and the resize handle carry.
   */
  function swallow(event: MouseEvent) {
    event.stopPropagation();
    event.preventDefault();
  }
</script>

<!--
  Drawn at the frame's own z-index, so a card parked below the frame covers these icons the
  same way one parked above it covers the tab. Pointer events are off on everything but the
  cells themselves: the strip is a band of ordinary board with icons sitting on it, and
  panning or sweeping a selection through the gaps has to keep working.
-->
<div
  class={css({ position: "absolute", display: "flex", flexDirection: "column", gap: "4px" })}
  data-scope-area-files={area.id}
  data-scope-id={area.scopeId}
  style:left="{left}px"
  style:top="{top}px"
  style:width="{width}px"
  style:z-index="0"
  style:pointer-events="none"
>
  {#each groups as group (group.taskspaceId)}
    {@const shown = visibleCells(group.cells, { width })}
    <div data-taskspace-id={group.taskspaceId}>
      {#if named}
        <div
          class={css({
            fontSize: "10px",
            lineHeight: "1.4",
            color: "neutral.subtle",
            textAlign: "right",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          })}
        >
          {group.name}{group.path ? `/${group.path}` : ""}
        </div>
      {/if}

      {#if group.error}
        <div class={css({ fontSize: "10px", color: "state.error", textAlign: "right" })}>
          {group.error}
        </div>
      {:else if !group.read}
        <!-- Nothing has come back yet. Said rather than left blank, because the listing is
             fetched the moment a frame appears and silence would read as an empty taskspace. -->
        {#if group.loading}
          <div class={noteClass}>Loading…</div>
        {/if}
      {:else}
        <!-- Right-aligned and wrapping, so the first cell of the first row sits against the
             frame's right edge however many there are: the corner stays where the eye left it
             as a directory is drilled into and come back out of. -->
        <div
          class={css({
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "flex-end",
            alignItems: "flex-start",
          })}
        >
          {#each shown.cells as cell (cell.kind === "up" ? "..up" : cell.path)}
            {@const openable = cell.kind === "entry" && cell.entry.kind === "file" && onOpenFile}
            {@const navigable = cell.kind === "up" || cell.entry.kind === "directory"}
            {@const label = cell.kind === "up" ? "‹ back" : cell.entry.name}
            {#if navigable}
              <button
                class={cx(cellClass, clickableClass)}
                style:width="{CELL_WIDTH}px"
                style:min-height="{CELL_HEIGHT}px"
                style:pointer-events="auto"
                aria-label={cell.kind === "up"
                  ? `Leave ${cell.label}`
                  : `Open folder ${cell.entry.name}`}
                title={cell.kind === "up" ? `Leave ${cell.label}` : cell.entry.name}
                onmousedown={swallow}
                onclick={(e) => {
                  e.stopPropagation();
                  onNavigate(group.taskspaceId, cell.path);
                }}
              >
                <FileGlyph kind={cell.kind === "up" ? "up" : "directory"} size={18} />
                <span class={labelClass}>{label}</span>
              </button>
            {:else if openable && cell.kind === "entry"}
              <button
                class={cx(cellClass, clickableClass)}
                style:width="{CELL_WIDTH}px"
                style:min-height="{CELL_HEIGHT}px"
                style:pointer-events="auto"
                aria-label="Open file {cell.entry.name}"
                title={cell.entry.name}
                onmousedown={swallow}
                onclick={(e) => {
                  e.stopPropagation();
                  onOpenFile?.(group.taskspaceId, cell.path);
                }}
              >
                <FileGlyph kind="file" size={18} />
                <span class={labelClass}>{cell.entry.name}</span>
              </button>
            {:else if cell.kind === "entry"}
              <!-- A symlink is drawn as what it is and stays shut, because following one is
                   not something a read confined to the taskspace can do. Anything that is
                   neither a regular file nor a directory is inert for the same reason, and so
                   is every cell on a board with no endpoint to read a file with. -->
              <div
                class={cellClass}
                style:width="{CELL_WIDTH}px"
                style:min-height="{CELL_HEIGHT}px"
                title={cell.entry.kind === "symlink" ? "Symbolic link" : cell.entry.name}
              >
                <FileGlyph kind={cell.entry.kind} size={18} />
                <span class={labelClass}>{cell.entry.name}</span>
              </div>
            {/if}
          {/each}

          {#if shown.overflow > 0}
            <!-- A note, not a button. The strip says what a scope is working on; reading a
                 directory is the panel's job, and a control here that merely sent you there
                 would be a third way to do what the panel's own row already does. -->
            <span
              class={noteClass}
              style:width="{CELL_WIDTH}px"
              style:padding="3px 2px"
              style:text-align="center"
              title="{shown.overflow} more in this folder — open this taskspace in the scope panel to see them"
            >
              +{shown.overflow} more
            </span>
          {/if}
        </div>

        {#if group.cells.length === 0}
          <div class={noteClass}>Empty</div>
        {/if}
        {#if group.truncated}
          <div class={noteClass}>{truncationNote(group.truncated)}</div>
        {/if}
      {/if}
    </div>
  {/each}
</div>
