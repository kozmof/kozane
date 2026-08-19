<script lang="ts">
  import { css, cx } from "styled-system/css";
  import { TASKSPACE_DIR_ENTRIES_MAX } from "$lib/constants";
  import type { TaskspaceTreeContext, TaskspaceTreeState } from "../lib/taskspace-tree.svelte";
  import TaskspaceTree from "./TaskspaceTree.svelte";

  let {
    tree,
    ctx,
    taskspaceId,
    path,
    depth = 0,
  }: {
    tree: TaskspaceTreeState;
    ctx: TaskspaceTreeContext;
    taskspaceId: string;
    /** Directory being listed, relative to the taskspace root. Empty is the root. */
    path: string;
    depth?: number;
  } = $props();

  const node = $derived(tree.node(taskspaceId, path));

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
  const chevronClass = css({ width: "8px", fontSize: "8px", color: "neutral.subtle", flexShrink: "0" });
</script>

{#snippet folderIcon()}
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style="flex-shrink:0">
    <rect x="1" y="2.5" width="8" height="6" rx="1" stroke="var(--colors-neutral-icon-dim)" stroke-width="1.2" />
    <path d="M3 1.5h4v1.5H3z" fill="var(--colors-neutral-icon-dim)" />
  </svg>
{/snippet}

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
  {#if node.entries.length === 0}
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
        <span class={chevronClass}>{expanded ? "▾" : "▸"}</span>
        {@render folderIcon()}
        <span class={nameClass}>{entry.name}</span>
      </button>
      {#if expanded}
        <TaskspaceTree {tree} {ctx} {taskspaceId} path={childPath(entry.name)} depth={depth + 1} />
      {/if}
    {:else}
      <!-- Files are shown, not opened: no endpoint returns the contents of one. A symlink
           is drawn as what it is and stays closed, because following one is not something
           a listing confined to the taskspace can do. -->
      <div class={rowBase} style:padding-left={`${indent}px`} title={entry.kind === "symlink" ? "Symbolic link" : undefined}>
        <span class={chevronClass}></span>
        {@render fileIcon(entry.kind === "symlink")}
        <span class={nameClass}>{entry.name}</span>
      </div>
    {/if}
  {/each}
  {#if node.truncated}
    <div class={noteClass} style:padding-left={`${indent}px`}>
      First {TASKSPACE_DIR_ENTRIES_MAX} entries only
    </div>
  {/if}
{/if}
