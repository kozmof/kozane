<script lang="ts">
  import { css, cx } from "styled-system/css";
  import type {
    TaskspaceCreateKind,
    TaskspaceTreeContext,
    TaskspaceTreeState,
  } from "../lib/taskspace-tree.svelte.js";
  import { truncationNote } from "../lib/taskspace-truncation.js";
  import FileGlyph from "./FileGlyph.svelte";
  import TaskspaceCreateButtons from "./TaskspaceCreateButtons.svelte";
  import TaskspaceCreateRow from "./TaskspaceCreateRow.svelte";
  import TaskspaceTree from "./TaskspaceTree.svelte";
  import TreeArrow from "./TreeArrow.svelte";

  let {
    tree,
    ctx,
    taskspaceId,
    path,
    depth = 0,
    onOpenFile,
    canCreate = false,
  }: {
    tree: TaskspaceTreeState;
    ctx: TaskspaceTreeContext;
    taskspaceId: string;
    /** Directory being listed, relative to the taskspace root. Empty is the root. */
    path: string;
    depth?: number;
    /**
     * Opens a file in the editor. Absent in a static export, where there is no endpoint to
     * read one with, and the rows stay inert as they always were.
     */
    onOpenFile?: (taskspacePath: string) => void;
    /**
     * Whether this tree offers new files and folders. False in a static export, which has
     * no server to make one with, and false wherever the panel itself is read-only.
     */
    canCreate?: boolean;
  } = $props();

  const node = $derived(tree.node(taskspaceId, path));

  // The name field belongs to exactly one directory, and this is the level drawing it.
  const creatingHere = $derived(
    tree.creating?.taskspaceId === taskspaceId && tree.creating.path === path
      ? tree.creating.kind
      : null,
  );

  async function submitCreate(name: string): Promise<void> {
    const made = await tree.submitCreate(ctx, name);
    // A new file goes straight into the editor: naming it was the point at which its
    // contents were on someone’s mind, and a folder has nothing to open.
    if (made?.kind === "file") onOpenFile?.(made.path);
  }

  async function startCreate(directory: string, kind: TaskspaceCreateKind): Promise<void> {
    // Opened first when it was closed: the field is drawn among the directory’s own rows,
    // and typing into a folder that is not showing them would be typing into nothing.
    if (!tree.isExpanded(taskspaceId, directory)) await tree.toggle(ctx, taskspaceId, directory);
    tree.beginCreate(taskspaceId, directory, kind);
  }

  // Every level indents by the same step, so the depth of a file is legible at a glance in
  // a panel too narrow to show the path it sits under.
  const indent = $derived(10 + depth * 11);

  function childPath(name: string): string {
    return path ? `${path}/${name}` : name;
  }

  const rowBase = css({
    display: "flex",
    alignItems: "center",
    gap: "5px",
    width: "100%",
    padding: "3px 6px",
    background: "transparent",
    border: "none",
    borderRadius: "2px",
    textAlign: "left",
    fontSize: "11.5px",
    fontFamily: "inherit",
    color: "ink.secondary",
    whiteSpace: "nowrap",
    overflow: "hidden",
  });
  const clickableClass = css({ cursor: "pointer", "&:hover": { backgroundColor: "neutral.bg" } });
  const nameClass = css({ flex: "1", overflow: "hidden", textOverflow: "ellipsis" });
  const noteClass = css({
    padding: "3px 6px",
    fontSize: "11px",
    color: "neutral.subtle",
    fontStyle: "italic",
  });

  // The row and its two controls share a hover, so the controls appear over the row rather
  // than taking width from a name that is already being ellipsised at this panel width.
  const rowWrapClass = css({
    display: "flex",
    alignItems: "center",
    position: "relative",
    "&:hover .hover-reveal": { opacity: "1" },
  });
  const createControlsClass = css({
    position: "absolute",
    right: "4px",
    top: "50%",
    transform: "translateY(-50%)",
    display: "flex",
    alignItems: "center",
    gap: "1px",
    backgroundColor: "ink.light",
  });
</script>

<!-- The glyph draws in `currentColor`, and these rows are `ink.secondary`, so the sheet is
     wrapped in the dim it has always been drawn in rather than taking the row's colour. -->
{#snippet fileIcon(isLink: boolean)}
  <span class={css({ display: "flex", flexShrink: "0", color: "neutral.iconDim" })}>
    <FileGlyph kind={isLink ? "symlink" : "file"} />
  </span>
{/snippet}

<!-- Above the listing rather than in the place the new entry will sort into: where that
     is depends on a name not typed yet, and a field that jumps once it is guessed wrong is
     worse than one that simply stays put. Drawn outside the branches below so that naming a
     file in a folder still loading does not have to wait for the listing. -->
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
  <!-- Only a directory that really is empty says so: one cut off by a limit comes back with
       no rows too, and the note below is what happened to it. -->
  {#if node.entries.length === 0 && !node.truncated}
    <div class={noteClass} style:padding-left={`${indent}px`}>Empty</div>
  {/if}
  {#each node.entries as entry (entry.name)}
    {@const expanded = tree.isExpanded(taskspaceId, childPath(entry.name))}
    {#if entry.kind === "directory"}
      <div class={rowWrapClass}>
        <button
          class={cx(rowBase, clickableClass, canCreate && css({ paddingRight: "48px" }))}
          style:padding-left={`${indent}px`}
          onclick={() => tree.toggle(ctx, taskspaceId, childPath(entry.name))}
          aria-expanded={expanded}
        >
          <TreeArrow {expanded} />
          <span class={nameClass}>{entry.name}</span>
        </button>
        {#if canCreate}
          <span class={createControlsClass}>
            <TaskspaceCreateButtons
              where="this folder"
              onCreate={(kind) => startCreate(childPath(entry.name), kind)}
            />
          </span>
        {/if}
      </div>
      {#if expanded}
        <TaskspaceTree
          {tree}
          {ctx}
          {taskspaceId}
          path={childPath(entry.name)}
          depth={depth + 1}
          {onOpenFile}
          {canCreate}
        />
      {/if}
    {:else if entry.kind === "file" && onOpenFile}
      <button
        class={cx(rowBase, clickableClass)}
        style:padding-left={`${indent}px`}
        onclick={() => onOpenFile(childPath(entry.name))}
      >
        {@render fileIcon(false)}
        <span class={nameClass}>{entry.name}</span>
      </button>
    {:else}
      <!-- A symlink is drawn as what it is and stays closed, because following one is not
           something a read confined to the taskspace can do. Anything that is neither a
           regular file nor a directory is inert for the same reason, and so is every row
           in a static export, which has no endpoint to read a file with. -->
      <div class={rowBase} style:padding-left={`${indent}px`} title={entry.kind === "symlink" ? "Symbolic link" : undefined}>
        {@render fileIcon(entry.kind === "symlink")}
        <span class={nameClass}>{entry.name}</span>
      </div>
    {/if}
  {/each}
  {#if node.truncated}
    <div class={noteClass} style:padding-left={`${indent}px`}>{truncationNote(node.truncated)}</div>
  {/if}
{/if}
