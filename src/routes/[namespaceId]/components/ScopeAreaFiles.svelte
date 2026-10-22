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
  import type { TaskspaceCreated, TaskspaceCreateKind } from "../lib/taskspace-tree.svelte.js";
  import { truncationNote } from "../lib/taskspace-truncation.js";
  import FileGlyph from "./FileGlyph.svelte";

  let {
    area,
    groups,
    onOpenFile,
    onNavigate,
    onCreate,
    onCreateTaskspace,
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
    /**
     * Create a file or folder named `name` in `path` of one taskspace. Without it, the strip
     * offers no create controls, as in read-only boards and static exports.
     */
    onCreate?: (
      taskspaceId: string,
      path: string,
      kind: TaskspaceCreateKind,
      name: string,
    ) => Promise<TaskspaceCreated | { error: string }>;
    /**
     * Create a taskspace directory named `name` in this frame's scope. Offered only while the
     * scope has none, since the strip has nowhere else to start from then.
     */
    onCreateTaskspace?: (name: string) => Promise<{ id: string } | { error: string }>;
  } = $props();

  type CreateTarget =
    | { kind: TaskspaceCreateKind; taskspaceId: string; path: string }
    | { kind: "taskspace" };

  /**
   * What the open name field will create, or null. Keep this per strip rather than in the
   * shared tree so the panel does not draw a second field for the same directory.
   */
  let creating = $state<CreateTarget | null>(null);
  let createName = $state("");
  let createBusy = $state(false);
  let createError = $state<string | null>(null);

  /**
   * The name field spans two cells so a typical file name fits without scrolling. That is also
   * the room the new-file and new-folder buttons take, which the field replaces while open.
   */
  const FIELD_CELLS = 2;

  function beginCreate(target: CreateTarget) {
    creating = target;
    createName = "";
    createError = null;
  }

  /** The field's label, which also names what Enter will create. */
  const FIELD_LABEL: Record<CreateTarget["kind"], string> = {
    file: "New file name",
    directory: "New folder name",
    taskspace: "New taskspace name",
  };

  function cancelCreate() {
    creating = null;
    createError = null;
  }

  async function submitCreate() {
    const target = creating;
    if (!target || createBusy) return;
    const request =
      target.kind === "taskspace"
        ? onCreateTaskspace?.(createName)
        : onCreate?.(target.taskspaceId, target.path, target.kind, createName);
    if (!request) return;
    createBusy = true;
    createError = null;
    const made = await request;
    createBusy = false;
    if ("error" in made) {
      createError = made.error;
      return;
    }
    creating = null;
    // Open newly created files in the editor, as the panel does. Folders and taskspaces need
    // no editor; the refreshed listing shows them in the strip.
    if ("kind" in made && made.kind === "file") onOpenFile?.(made.taskspaceId, made.path);
  }

  function onCreateKeydown(event: KeyboardEvent) {
    // Prevent typed characters from triggering board shortcuts.
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      submitCreate();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelCreate();
    }
  }

  /** Focus the name field when it mounts so creation can begin without another click. */
  function focusOnMount(node: HTMLInputElement) {
    node.focus();
  }

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
   * Stop file-cell presses from starting canvas panning or Shift-drag selection.
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
    {@const editing =
      creating !== null &&
      creating.kind !== "taskspace" &&
      creating.taskspaceId === group.taskspaceId}
    {@const reserved = onCreate ? FIELD_CELLS : 0}
    {@const shown = visibleCells(group.cells, { width, reserved })}
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
        <!-- Show loading feedback so a pending listing does not appear empty. -->
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

          {#if onCreate && editing && creating}
            {@render nameField(FIELD_LABEL[creating.kind])}
          {:else if onCreate}
            {@const where = group.path || group.name}
            <button
              class={cx(cellClass, clickableClass)}
              style:width="{CELL_WIDTH}px"
              style:min-height="{CELL_HEIGHT}px"
              style:pointer-events="auto"
              aria-label="New file in {where}"
              title="New file in {where}"
              onmousedown={swallow}
              onclick={(e) => {
                e.stopPropagation();
                beginCreate({ kind: "file", taskspaceId: group.taskspaceId, path: group.path });
              }}
            >
              <svg width="18" height="18" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                <path
                  d="M5 2v6M2 5h6"
                  stroke="currentColor"
                  stroke-width="0.9"
                  stroke-linecap="round"
                />
              </svg>
              <span class={labelClass}>New file</span>
            </button>
            <button
              class={cx(cellClass, clickableClass)}
              style:width="{CELL_WIDTH}px"
              style:min-height="{CELL_HEIGHT}px"
              style:pointer-events="auto"
              aria-label="New folder in {where}"
              title="New folder in {where}"
              onmousedown={swallow}
              onclick={(e) => {
                e.stopPropagation();
                beginCreate({ kind: "directory", taskspaceId: group.taskspaceId, path: group.path });
              }}
            >
              <!-- The panel's new-folder glyph, so the two buttons read apart at a glance. -->
              <svg width="18" height="18" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                <path
                  d="M1 8.4V2.2h2.5l.9 1.1H8.2V5.4"
                  stroke="currentColor"
                  stroke-width="0.9"
                  stroke-linejoin="round"
                  stroke-linecap="round"
                />
                <path d="M1 8.4h3.4" stroke="currentColor" stroke-width="0.9" stroke-linecap="round" />
                <path
                  d="M7.2 6v3.2M5.6 7.6h3.2"
                  stroke="currentColor"
                  stroke-width="0.9"
                  stroke-linecap="round"
                />
              </svg>
              <span class={labelClass}>New folder</span>
            </button>
          {/if}
        </div>

        {#if editing}
          {@render errorNote()}
        {/if}

        {#if group.cells.length === 0}
          <div class={noteClass}>Empty</div>
        {/if}
        {#if group.truncated}
          <div class={noteClass}>{truncationNote(group.truncated)}</div>
        {/if}
      {/if}
    </div>
  {/each}

  {#if groups.length === 0 && onCreateTaskspace}
    <!-- A scope with no taskspace yet has no listing to hang file controls from, so offer the
         taskspace itself. Once created, its own group takes this row's place. -->
    <div class={css({ display: "flex", justifyContent: "flex-end" })}>
      {#if creating?.kind === "taskspace"}
        {@render nameField(FIELD_LABEL.taskspace)}
      {:else}
        <button
          class={cx(cellClass, clickableClass)}
          style:width="{CELL_WIDTH}px"
          style:min-height="{CELL_HEIGHT}px"
          style:pointer-events="auto"
          aria-label="New taskspace in this scope"
          title="New taskspace in this scope"
          onmousedown={swallow}
          onclick={(e) => {
            e.stopPropagation();
            beginCreate({ kind: "taskspace" });
          }}
        >
          <svg width="18" height="18" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path
              d="M1 8.4V2.2h2.5l.9 1.1H8.2V5.4"
              stroke="currentColor"
              stroke-width="0.9"
              stroke-linejoin="round"
              stroke-linecap="round"
            />
            <path d="M1 8.4h3.4" stroke="currentColor" stroke-width="0.9" stroke-linecap="round" />
            <path
              d="M7.2 6v3.2M5.6 7.6h3.2"
              stroke="currentColor"
              stroke-width="0.9"
              stroke-linecap="round"
            />
          </svg>
          <span class={labelClass}>New taskspace</span>
        </button>
      {/if}
    </div>
    {#if creating?.kind === "taskspace"}
      {@render errorNote()}
    {/if}
  {/if}
</div>

{#snippet nameField(label: string)}
  <!-- Stop presses from reaching the canvas without preventing default, which would keep the
       caret out of the field. Cancel on blur, as the panel's field does. -->
  <div
    class={cx(cellClass, css({ justifyContent: "center" }))}
    style:width="{CELL_WIDTH * FIELD_CELLS}px"
    style:min-height="{CELL_HEIGHT}px"
    style:pointer-events="auto"
  >
    <input
      use:focusOnMount
      bind:value={createName}
      class={css({
        width: "100%",
        padding: "2px 4px",
        border: "1px solid token(colors.neutral.dim)",
        borderRadius: "2px",
        background: "ink.white",
        color: "ink.black",
        fontSize: "10px",
        fontFamily: "inherit",
        "&:read-only": { color: "neutral.subtle" },
      })}
      type="text"
      readonly={createBusy}
      placeholder={label}
      aria-label={label}
      onmousedown={(e) => e.stopPropagation()}
      onclick={(e) => e.stopPropagation()}
      onkeydown={onCreateKeydown}
      onblur={() => !createBusy && cancelCreate()}
    />
  </div>
{/snippet}

{#snippet errorNote()}
  {#if createError}
    <div class={css({ fontSize: "10px", color: "state.error", textAlign: "right" })} role="alert">
      {createError}
    </div>
  {/if}
{/snippet}
