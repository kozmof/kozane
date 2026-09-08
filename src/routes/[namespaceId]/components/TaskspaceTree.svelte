<script lang="ts">
  import { css, cx } from "styled-system/css";
  import { TASKSPACE_DIR_ENTRIES_MAX, TASKSPACE_SSG_DEPTH_MAX } from "$lib/constants";
  import type { TaskspaceTruncation } from "$lib/types";
  import type { TaskspaceTreeContext, TaskspaceTreeState } from "../lib/taskspace-tree.svelte.js";
  import TaskspaceTree from "./TaskspaceTree.svelte";
  import TreeArrow from "./TreeArrow.svelte";

  let {
    tree,
    ctx,
    taskspaceId,
    path,
    depth = 0,
    onOpenFile,
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
  } = $props();

  const node = $derived(tree.node(taskspaceId, path));

  // Every level indents by the same step, so the depth of a file is legible at a glance in
  // a panel too narrow to show the path it sits under.
  const indent = $derived(10 + depth * 11);

  function childPath(name: string): string {
    return path ? `${path}/${name}` : name;
  }

  // Each limit in its own words: told only that a directory was "truncated", a reader has
  // no way to tell a folder with more files in it from one this export never walked into.
  function truncationNote(reason: TaskspaceTruncation): string {
    switch (reason) {
      case "entries":
        return `First ${TASKSPACE_DIR_ENTRIES_MAX} entries only`;
      case "depth":
        return `Nested deeper than ${TASKSPACE_SSG_DEPTH_MAX} levels — not included in this export`;
      case "nodes":
        return "Past this export's size limit — not included";
      case "unreadable":
        return "Could not be read";
    }
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
</script>

{#snippet fileIcon(isLink: boolean)}
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style="flex-shrink:0">
    <path d="M2.5 1h3l2 2v6h-5z" stroke="var(--colors-neutral-icon-dim)" stroke-width="1.1" stroke-linejoin="round" />
    {#if isLink}
      <path d="M3.8 6.2h2.4" stroke="var(--colors-neutral-icon-dim)" stroke-width="1.1" stroke-linecap="round" />
    {/if}
  </svg>
{/snippet}

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
      <button
        class={cx(rowBase, clickableClass)}
        style:padding-left={`${indent}px`}
        onclick={() => tree.toggle(ctx, taskspaceId, childPath(entry.name))}
        aria-expanded={expanded}
      >
        <TreeArrow {expanded} />
        <span class={nameClass}>{entry.name}</span>
      </button>
      {#if expanded}
        <TaskspaceTree
          {tree}
          {ctx}
          {taskspaceId}
          path={childPath(entry.name)}
          depth={depth + 1}
          {onOpenFile}
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
