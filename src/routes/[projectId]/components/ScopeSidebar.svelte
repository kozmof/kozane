<script lang="ts">
  import { css, cx } from "styled-system/css";
  import type { Scope, ScopeRel, TaskspaceSummary } from "$lib/types";
  import type { TaskspaceTreeContext, TaskspaceTreeState } from "../lib/taskspace-tree.svelte";
  import TaskspaceTree from "./TaskspaceTree.svelte";
  import TreeArrow from "./TreeArrow.svelte";

  let {
    visible,
    panelWidth,
    scopes,
    scopeRels,
    taskspaces,
    taskspaceTree,
    treeContext,
    selectedCards,
    activeScope = $bindable(),
    newScopeName = $bindable(),
    newWcName = $bindable(),
    onCreateScope,
    onDeleteScope,
    onAddToScope,
    onRemoveFromScope,
    onCreateTaskspace,
    onOpenFile,
    readonly = false,
  }: {
    visible: boolean;
    panelWidth: number;
    // Both already narrowed to this project by the snapshot, not filtered here: see
    // ProjectDataSnapshot. Nothing in this panel should assume it holds every scope or
    // every taskspace in the workspace.
    scopes: Scope[];
    scopeRels: ScopeRel[];
    taskspaces: TaskspaceSummary[];
    taskspaceTree: TaskspaceTreeState;
    treeContext: TaskspaceTreeContext;
    selectedCards: Set<string>;
    activeScope: string | null;
    newScopeName: string;
    newWcName: string;
    onCreateScope: () => void;
    onDeleteScope: (scopeId: string) => void;
    onAddToScope: (scopeId: string) => void;
    onRemoveFromScope: (scopeId: string) => void;
    onCreateTaskspace: () => void;
    /**
     * Opens one file of one taskspace in the editor. Absent in a static export, which has
     * no endpoint to read a file with, and the tree rows stay inert there.
     */
    onOpenFile?: (taskspaceId: string, taskspaceName: string, path: string) => void;
    // Read-only export: keep scope filtering, hide create/delete/membership controls.
    readonly?: boolean;
  } = $props();

  const flex1Class = css({ flex: "1", overflow: "hidden", textOverflow: "ellipsis" });
  const countClass = css({ fontSize: "10.5px", color: "neutral.subtle", flexShrink: "0" });

  const sideBtnBase = css({
    display: "flex",
    alignItems: "center",
    gap: "9px",
    padding: "7px 10px",
    width: "100%",
    background: "transparent",
    border: "none",
    borderRadius: "2px",
    cursor: "pointer",
    textAlign: "left",
    fontSize: "12.5px",
    color: "ink.black",
    fontFamily: "inherit",
    whiteSpace: "nowrap",
    overflow: "hidden",
  });
  const sideBtnActiveClass = css({ backgroundColor: "neutral.bg" });

  function sideBtn(active: boolean) {
    return cx(sideBtnBase, active && sideBtnActiveClass);
  }

  const taskspaceRowClass = css({
    display: "flex",
    alignItems: "center",
    gap: "5px",
    width: "100%",
    padding: "4px 6px",
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
  const taskspaceRowButtonClass = css({
    cursor: "pointer",
    paddingRight: "24px",
    "&:hover": { backgroundColor: "neutral.bg" },
  });
  const taskspaceNameClass = css({ flex: "1", overflow: "hidden", textOverflow: "ellipsis" });
  const taskspaceRefreshClass = css({
    position: "absolute",
    right: "4px",
    top: "50%",
    transform: "translateY(-50%)",
    width: "16px",
    height: "16px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "none",
    border: "none",
    cursor: "pointer",
    borderRadius: "2px",
    fontSize: "11px",
    color: "neutral.subtle",
    opacity: "0",
    transition: "opacity 0.12s, color 0.12s",
    "&:hover": { color: "ink.black" },
  });
</script>

{#snippet taskspaceIcon()}
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style="flex-shrink:0">
    <rect x="1" y="2.5" width="8" height="6" rx="1" stroke="var(--colors-neutral-icon-dim)" stroke-width="1.2" />
    <path d="M1 4.5h8" stroke="var(--colors-neutral-icon-dim)" stroke-width="1" />
    <path d="M3 1.5h4v1.5H3z" fill="var(--colors-neutral-icon-dim)" />
  </svg>
{/snippet}

<aside
  class={css({
    flexShrink: "0",
    backgroundColor: "ink.light",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    transition: "width 0.22s ease",
    borderLeft: "1px solid token(colors.neutral.dim)",
  })}
  style:width={visible ? `${panelWidth}px` : "0"}
>
  <div class={css({ flex: "1", overflowY: "auto", padding: "8px 8px 0", display: "flex", flexDirection: "column", gap: "1px" })}>
    {#each scopes as scope (scope.id)}
      {@const active = activeScope === scope.id}
      <div class={cx(
        css({ borderRadius: "2px", overflow: "hidden", border: "1px solid transparent" }),
        active && css({ borderColor: "neutral.scroll" }),
      )}>
        <div class={css({ display: "flex", alignItems: "center", position: "relative", "&:hover .scope-delete": { opacity: "1" } })}>
          <button
            class={cx(sideBtn(active), css({ paddingRight: "28px" }))}
            onclick={() => (activeScope = active ? null : scope.id)}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <rect x="1" y="1" width="8" height="8" rx="1" stroke="var(--colors-neutral-icon-dim)" stroke-width="1.2" />
              <path d="M3 5h4M3 3.5h2" stroke="var(--colors-neutral-icon-dim)" stroke-width="1" stroke-linecap="round" />
            </svg>
            <span class={flex1Class}>{scope.name}</span>
            <!-- This project's cards in the scope, not the scope's total: scopeRels is
                 built from this project's cards. A shared scope reads differently on each
                 board, which is the number each board can act on. -->
            <span class={countClass}>
              {scopeRels.filter((r) => r.scopeId === scope.id).length}
            </span>
          </button>
          {#if !readonly}
          <button
            class={cx("scope-delete", css({
              position: "absolute",
              right: "6px",
              top: "50%",
              transform: "translateY(-50%)",
              width: "18px",
              height: "18px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "none",
              border: "none",
              cursor: "pointer",
              borderRadius: "2px",
              fontSize: "13px",
              color: "neutral.subtle",
              opacity: "0",
              transition: "opacity 0.12s, color 0.12s",
              "&:hover": { color: "state.error" },
            }))}
            title="Delete scope"
            onclick={(e) => { e.stopPropagation(); onDeleteScope(scope.id); }}
          >×</button>
          {/if}
        </div>

        {#if !readonly && selectedCards.size > 0}
          {@const allInScope = [...selectedCards].every((cid) => scopeRels.some((r) => r.scopeId === scope.id && r.cardId === cid))}
          <button
            class={css({
              width: "100%",
              padding: "6px 10px",
              backgroundColor: allInScope ? "neutral.faded" : "ink.black",
              color: allInScope ? "ink.secondary" : "ink.light",
              border: "none",
              borderTop: "1px solid token(colors.neutral.dim)",
              cursor: "pointer",
              fontSize: "11px",
              fontFamily: "inherit",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "6px",
            })}
            onclick={() => allInScope ? onRemoveFromScope(scope.id) : onAddToScope(scope.id)}
          >
            <span>{allInScope ? "Remove from scope" : "Add to scope"}</span>
            <span>{allInScope ? "−" : "→"}</span>
          </button>
        {/if}

        {#if active}
          {@const scopeTaskspaces = taskspaces.filter((taskspace) => taskspace.scopeId === scope.id && taskspace.path !== null)}
          {#if scopeTaskspaces.length > 0}
            <div class={css({ borderTop: "1px solid token(colors.neutral.dim)", padding: "4px 6px", display: "flex", flexDirection: "column", gap: "1px" })}>
              {#each scopeTaskspaces as taskspace (taskspace.id)}
                {@const expanded = taskspaceTree.isExpanded(taskspace.id, "")}
                <div class={css({ display: "flex", flexDirection: "column", gap: "1px" })}>
                  <div class={css({ display: "flex", alignItems: "center", position: "relative", "&:hover .taskspace-refresh": { opacity: "1" } })}>
                    <!-- A static export has no server to ask, and its taskspaces carry no
                         path to ask about, so the row stays the plain label it always was. -->
                    {#if readonly}
                      <div class={taskspaceRowClass}>
                        {@render taskspaceIcon()}
                        <span class={taskspaceNameClass}>{taskspace.name}</span>
                      </div>
                    {:else}
                      <button
                        class={cx(taskspaceRowClass, taskspaceRowButtonClass)}
                        onclick={() => taskspaceTree.toggle(treeContext, taskspace.id, "")}
                        aria-expanded={expanded}
                      >
                        <TreeArrow {expanded} />
                        <span class={taskspaceNameClass}>{taskspace.name}</span>
                      </button>
                      {#if expanded}
                        <button
                          class={cx("taskspace-refresh", taskspaceRefreshClass)}
                          title="Re-read this taskspace from disk"
                          onclick={(e) => { e.stopPropagation(); taskspaceTree.refresh(treeContext, taskspace.id); }}
                        >⟳</button>
                      {/if}
                    {/if}
                  </div>
                  {#if expanded && !readonly}
                    <TaskspaceTree
                      tree={taskspaceTree}
                      ctx={treeContext}
                      taskspaceId={taskspace.id}
                      path=""
                      onOpenFile={onOpenFile &&
                        ((filePath) => onOpenFile(taskspace.id, taskspace.name, filePath))}
                    />
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
          {#if !readonly}
          <div class={css({ padding: "8px", borderTop: "1px solid token(colors.neutral.dim)", display: "flex", gap: "5px" })}>
            <input
              class={css({ flex: "1", padding: "6px 8px", border: "1px solid token(colors.neutral.dim)", borderRadius: "2px", fontSize: "11.5px", background: "ink.white", fontFamily: "inherit", color: "ink.black" })}
              bind:value={newWcName}
              onkeydown={(e) => e.key === "Enter" && onCreateTaskspace()}
            />
            <button
              class={css({ padding: "6px 11px", backgroundColor: "ink.black", color: "ink.light", border: "none", borderRadius: "2px", cursor: "pointer", fontSize: "14px", fontFamily: "inherit", lineHeight: "1" })}
              onclick={onCreateTaskspace}
            >+</button>
          </div>
          {/if}
        {/if}
      </div>
    {/each}
  </div>

  {#if !readonly}
    <div class={css({ padding: "10px", borderTop: "1px solid token(colors.neutral.dim)", marginTop: "8px", display: "flex", gap: "5px" })}>
      <input
        class={css({ flex: "1", padding: "7px 10px", border: "1px solid token(colors.neutral.dim)", borderRadius: "2px", fontSize: "11.5px", background: "ink.white", fontFamily: "inherit", color: "ink.black" })}
        bind:value={newScopeName}
        onkeydown={(e) => e.key === "Enter" && onCreateScope()}
      />
      <button
        class={css({ padding: "7px 11px", backgroundColor: "ink.black", color: "ink.light", border: "none", borderRadius: "2px", cursor: "pointer", fontSize: "14px", fontFamily: "inherit", lineHeight: "1" })}
        onclick={onCreateScope}
      >+</button>
    </div>
  {/if}
</aside>
