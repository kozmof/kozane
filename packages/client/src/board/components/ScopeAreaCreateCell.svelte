<script lang="ts">
  import { cx } from "../../styles/css.js";
  import { CELL_HEIGHT, CELL_WIDTH } from "../lib/scope-area-files.js";
  import {
    cellClass,
    clickableClass,
    createButtonClass,
    createIconsClass,
    labelClass,
    swallow,
  } from "../lib/scope-area-files-styles.js";

  /**
   * The new-file and new-folder buttons at the end of a taskspace's file strip, shaped like a
   * file cell so the pair sits where a file's icon does and the taskspace's name sits on the
   * same line as the file names.
   */
  let {
    name,
    path,
    onCreate,
  }: {
    /** The taskspace's name. */
    name: string;
    /** The folder shown, relative to the taskspace, or "" for its root. */
    path: string;
    onCreate: (kind: "file" | "directory") => void;
  } = $props();

  const where = $derived(path || name);
</script>

<div
  class={cellClass}
  style:width="{CELL_WIDTH}px"
  style:min-height="{CELL_HEIGHT}px"
  title={path ? `${name}/${path}` : name}
>
  <div class={createIconsClass}>
    <button
      class={cx(clickableClass, createButtonClass)}
      style:pointer-events="auto"
      aria-label="New file in {where}"
      title="New file in {where}"
      onmousedown={swallow}
      onclick={(e) => {
        e.stopPropagation();
        onCreate("file");
      }}
    >
      <svg width="18" height="18" viewBox="0 0 10 10" fill="none" aria-hidden="true">
        <path
          d="M5 2v6M2 5h6"
          stroke="currentColor"
          stroke-width="0.6"
          stroke-linecap="round"
        />
      </svg>
    </button>
    <button
      class={cx(clickableClass, createButtonClass)}
      style:pointer-events="auto"
      aria-label="New folder in {where}"
      title="New folder in {where}"
      onmousedown={swallow}
      onclick={(e) => {
        e.stopPropagation();
        onCreate("directory");
      }}
    >
      <!-- The panel's new-folder glyph, so the two buttons read apart at a glance. -->
      <svg width="18" height="18" viewBox="0 0 10 10" fill="none" aria-hidden="true">
        <path
          d="M1 8.4V2.2h2.5l.9 1.1H8.2V5.4"
          stroke="currentColor"
          stroke-width="0.6"
          stroke-linejoin="round"
          stroke-linecap="round"
        />
        <path d="M1 8.4h3.4" stroke="currentColor" stroke-width="0.6" stroke-linecap="round" />
        <path
          d="M7.2 6v3.2M5.6 7.6h3.2"
          stroke="currentColor"
          stroke-width="0.6"
          stroke-linecap="round"
        />
      </svg>
    </button>
  </div>
  <span class={labelClass}>{name}</span>
</div>
