<script lang="ts">
  import { cx } from "../../styles/css.js";
  import { CELL_HEIGHT, CELL_WIDTH, type FileCell } from "../lib/scope-area-files.js";
  import {
    cellClass,
    clickableClass,
    labelClass,
    swallow,
  } from "../lib/scope-area-files-styles.js";
  import FileGlyph from "./FileGlyph.svelte";

  /**
   * One cell of a scope frame's file strip: a folder or the way back up, which navigate, a
   * file, which opens when files can be opened, or an inactive special entry.
   */
  let {
    cell,
    onNavigate,
    onOpenFile,
  }: {
    cell: FileCell;
    onNavigate: (path: string) => void;
    onOpenFile?: (path: string) => void;
  } = $props();

  const openable = $derived(cell.kind === "entry" && cell.entry.kind === "file" && onOpenFile);
  const navigable = $derived(cell.kind === "up" || cell.entry.kind === "directory");
  const label = $derived(cell.kind === "up" ? "‹ back" : cell.entry.name);
</script>

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
      onNavigate(cell.path);
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
      onOpenFile?.(cell.path);
    }}
  >
    <FileGlyph kind="file" size={18} />
    <span class={labelClass}>{cell.entry.name}</span>
  </button>
{:else if cell.kind === "entry"}
  <!-- Label symlinks and keep them closed to preserve taskspace containment. Keep other
       special entries and files without a read endpoint inactive. -->
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
