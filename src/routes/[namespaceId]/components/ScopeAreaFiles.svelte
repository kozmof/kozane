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
     * Optional callback to open a taskspace file. Without it, show file cells without opening
     * behavior.
     */
    onOpenFile?: (taskspaceId: string, path: string) => void;
    /** Points this frame's view of one taskspace at another of its directories. */
    onNavigate: (taskspaceId: string, path: string) => void;
  } = $props();

  /**
   * Place the file strip below and right-aligned with the frame to preserve interactions
   * inside it. The strip may be wider than the frame. Clamp its left edge to the board.
   */
  const width = $derived(stripWidth(area));
  const left = $derived(Math.max(0, area.posX + area.width - width));
  const top = $derived(area.posY + area.height + STRIP_GAP);

  /**
   * Show taskspace names only when a scope has more than one taskspace. Otherwise the frame's
   * scope label provides enough context.
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
   * Clip names after two lines to preserve row height. Expose the complete name in the cell
   * title.
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

<!-- Draw file icons at the frame's z-index so cards can cover them. Enable pointer events only on icon cells so gaps still allow panning and rectangle selection. -->
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
        <!-- Right-align and wrap icons to keep the strip anchored to the frame's right edge while browsing directories. -->
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
            <!-- Show this as an informational note. Directory browsing is available in the taskspace panel. -->
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
