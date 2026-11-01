<script lang="ts">
  import { css, cx } from "styled-system/css";
  import type { TaskspaceEntryKind } from "$lib/types";
  import type {
    TaskspaceCreateKind,
    TaskspaceTreeContext,
    TaskspaceTreeState,
  } from "../lib/taskspace-tree.svelte.js";
  import { truncationNote } from "../lib/taskspace-truncation.js";
  import FileBrowserTree from "./FileBrowserTree.svelte";
  import FileGlyph from "./FileGlyph.svelte";
  import InlineNameInput from "./InlineNameInput.svelte";
  import RowActionButtons from "./RowActionButtons.svelte";
  import TaskspaceCreateButtons from "./TaskspaceCreateButtons.svelte";
  import TaskspaceCreateRow from "./TaskspaceCreateRow.svelte";
  import TreeArrow from "./TreeArrow.svelte";

  let {
    tree,
    ctx,
    taskspaceId,
    path,
    depth = 0,
    readonly = false,
    canOpen,
    openPath,
    renaming,
    onOpenFile,
    onStartRename,
    onRename,
    onCancelRename,
    onDelete,
  }: {
    tree: TaskspaceTreeState;
    ctx: TaskspaceTreeContext;
    taskspaceId: string;
    /** Directory being listed, relative to the taskspace root. Empty is the root. */
    path: string;
    depth?: number;
    readonly?: boolean;
    /** Whether file contents can be read, which a static export without files cannot. */
    canOpen: boolean;
    /** The file open in the editor, when it is in this taskspace. */
    openPath: string | null;
    /** The entry whose name is being edited. */
    renaming: string | null;
    onOpenFile: (path: string) => void;
    onStartRename: (path: string) => void;
    onRename: (path: string, name: string) => Promise<string | null>;
    onCancelRename: () => void;
    onDelete: (path: string, kind: TaskspaceEntryKind) => void;
  } = $props();

  const node = $derived(tree.node(taskspaceId, path));
  const creatingHere = $derived(
    tree.creating?.taskspaceId === taskspaceId && tree.creating.path === path
      ? tree.creating.kind
      : null,
  );
  const indent = $derived(8 + depth * 12);

  function childPath(name: string): string {
    return path ? `${path}/${name}` : name;
  }

  async function submitCreate(name: string): Promise<void> {
    const made = await tree.submitCreate(ctx, name);
    if (made?.kind === "file") onOpenFile(made.path);
  }

  async function startCreate(directory: string, kind: TaskspaceCreateKind): Promise<void> {
    if (!tree.isExpanded(taskspaceId, directory)) await tree.toggle(ctx, taskspaceId, directory);
    tree.beginCreate(taskspaceId, directory, kind);
  }

  const rowWrapClass = css({
    display: "flex",
    alignItems: "center",
    position: "relative",
    borderRadius: "2px",
    "&:hover, &:focus-within": { backgroundColor: "neutral.bg" },
    "&:hover .hover-reveal, &:focus-within .hover-reveal": { opacity: "1" },
    "&:hover .row-actions, &:focus-within .row-actions": { opacity: "1" },
  });
  const rowClass = css({
    display: "flex",
    alignItems: "center",
    gap: "5px",
    flex: "1",
    minWidth: "0",
    padding: "4px 6px",
    background: "transparent",
    border: "none",
    textAlign: "left",
    fontSize: "11.5px",
    fontFamily: "inherit",
    color: "ink.secondary",
    whiteSpace: "nowrap",
    cursor: "pointer",
    outline: "none",
    "&:disabled": { cursor: "default" },
  });
  const openClass = css({ color: "ink.black", fontWeight: "600" });
  const nameClass = css({ flex: "1", overflow: "hidden", textOverflow: "ellipsis" });
  // Laid over the end of the row while it is hovered or focused, so the buttons never take
  // width from the name in a narrow panel. The fill matches the hovered row behind it.
  const actionsClass = css({
    position: "absolute",
    right: "0",
    top: "0",
    bottom: "0",
    display: "flex",
    alignItems: "center",
    gap: "1px",
    padding: "0 4px",
    backgroundColor: "neutral.bg",
    borderRadius: "2px",
    opacity: "0",
  });
  const noteClass = css({ padding: "3px 6px", fontSize: "11px", color: "neutral.subtle", fontStyle: "italic" });
</script>

{#if creatingHere}
  <TaskspaceCreateRow
    kind={creatingHere}
    {indent}
    busy={tree.createBusy}
    error={tree.createError}
    onSubmit={submitCreate}
    onCancel={() => tree.cancelCreate()}
  />
{/if}

{#if node.error}
  <div class={css({ padding: "3px 6px", fontSize: "11px", color: "state.error" })} style:padding-left={`${indent}px`}>
    {node.error}
  </div>
{:else if node.loading && !node.entries}
  <div class={noteClass} style:padding-left={`${indent}px`}>Loading…</div>
{:else if node.entries}
  {#if node.entries.length === 0 && !node.truncated && !creatingHere}
    <div class={noteClass} style:padding-left={`${indent}px`}>Empty</div>
  {/if}
  {#each node.entries as entry (entry.name)}
    {@const entryPath = childPath(entry.name)}
    {@const isDir = entry.kind === "directory"}
    {@const expanded = isDir && tree.isExpanded(taskspaceId, entryPath)}
    {#if renaming === entryPath}
      <InlineNameInput
        value={entry.name}
        label={`New name for ${entry.name}`}
        {indent}
        onSubmit={(name) => onRename(entryPath, name)}
        onCancel={onCancelRename}
      />
    {:else}
      <div class={rowWrapClass}>
        <button
          class={cx(rowClass, openPath === entryPath && openClass)}
          style:padding-left={`${indent}px`}
          data-col="2"
          aria-expanded={isDir ? expanded : undefined}
          aria-current={openPath === entryPath ? "true" : undefined}
          disabled={!isDir && !(entry.kind === "file" && canOpen)}
          title={entry.kind === "symlink" ? "Symbolic link" : undefined}
          onclick={() =>
            isDir ? tree.toggle(ctx, taskspaceId, entryPath) : onOpenFile(entryPath)}
        >
          {#if isDir}
            <TreeArrow {expanded} />
          {/if}
          <span class={css({ display: "flex", flexShrink: "0", color: "neutral.iconDim" })}>
            <FileGlyph kind={entry.kind} />
          </span>
          <span class={nameClass}>{entry.name}</span>
        </button>
        {#if !readonly}
          <span class={cx("row-actions", actionsClass)}>
            {#if isDir}
              <TaskspaceCreateButtons
                where={`"${entry.name}"`}
                onCreate={(kind) => startCreate(entryPath, kind)}
              />
            {/if}
            <RowActionButtons
              what={entry.name}
              onRename={() => onStartRename(entryPath)}
              onDelete={() => onDelete(entryPath, entry.kind)}
            />
          </span>
        {/if}
      </div>
    {/if}
    {#if expanded}
      <FileBrowserTree
        {tree}
        {ctx}
        {taskspaceId}
        path={entryPath}
        depth={depth + 1}
        {readonly}
        {canOpen}
        {openPath}
        {renaming}
        {onOpenFile}
        {onStartRename}
        {onRename}
        {onCancelRename}
        {onDelete}
      />
    {/if}
  {/each}
  {#if node.truncated}
    <div class={noteClass} style:padding-left={`${indent}px`}>{truncationNote(node.truncated)}</div>
  {/if}
{/if}
