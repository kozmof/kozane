<script lang="ts">
  import { css, cx } from "styled-system/css";
  import type { Scope, ScopeRel, TaskspaceSummary } from "$lib/types";
  import type {
    TaskspaceCreateKind,
    TaskspaceTreeContext,
    TaskspaceTreeState,
  } from "../lib/taskspace-tree.svelte.js";
  import { scopeLinkState } from "../lib/scope-link.js";
  import TaskspaceCreateButtons from "./TaskspaceCreateButtons.svelte";
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
    framedScopeIds,
    onAddScopeArea,
    onRemoveScopeArea,
    onCreateTaskspace,
    onOpenFile,
    readonly = false,
  }: {
    visible: boolean;
    panelWidth: number;
    // Both already narrowed to this namespace by the snapshot, not filtered here: see
    // NamespaceDataSnapshot. Nothing in this panel should assume it holds every scope or
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
    /** The scopes that already have a frame on this board. */
    framedScopeIds: Set<string>;
    /** Frames the selection when there is one, or the middle of the view when there is not. */
    onAddScopeArea: (scopeId: string) => void;
    onRemoveScopeArea: (scopeId: string) => void;
    onCreateTaskspace: () => void;
    /**
     * Opens one file of one taskspace in the editor. Absent in a static export that has no
     * endpoint to read a file with and no embedded tree to read one from instead — a plain
     * export, or one built without `--include-scoped-files`. When `treeContext` carries an
     * embedded tree for a taskspace, this stays wired up even though the export is
     * read-only: browsing and opening are allowed, saving never is.
     */
    onOpenFile?: (taskspaceId: string, taskspaceName: string, path: string) => void;
    // Read-only export: keep scope filtering, hide create/delete/membership controls.
    readonly?: boolean;
  } = $props();

  const flex1Class = css({ flex: "1", overflow: "hidden", textOverflow: "ellipsis" });
  const countClass = css({ fontSize: "10.5px", color: "neutral.subtle", flexShrink: "0" });
  const countFocusedClass = css({ color: "neutral.faded" });

  const sideBtnBase = css({
    display: "flex",
    alignItems: "center",
    gap: "9px",
    padding: "7px 10px",
    width: "100%",
    background: "transparent",
    border: "none",
    cursor: "pointer",
    textAlign: "left",
    fontSize: "12.5px",
    color: "ink.black",
    fontFamily: "inherit",
    whiteSpace: "nowrap",
    overflow: "hidden",
  });
  // Focusing a scope dims every card outside it on the canvas, so the row that did it is
  // inverted rather than merely tinted: at a tint the board looked filtered with nothing on
  // the panel obviously accountable for it.
  // Deliberately square: the card around this row rounds to 2px over a 1px border, so it
  // clips its children to a 1px inner radius. A fill carrying its own 2px curve pulls away
  // from that clip and leaves the panel showing through as a dot in each corner — visible
  // only once the row is filled, which is why the radius sat here harmlessly for so long.
  const sideBtnFocusedClass = css({ backgroundColor: "ink.charcoal", color: "ink.light" });

  function sideBtn(focused: boolean) {
    return cx(sideBtnBase, focused && sideBtnFocusedClass);
  }

  const scopeDeleteBase = css({
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
    opacity: "0",
    transition: "opacity 0.12s, color 0.12s",
  });
  const scopeDeleteClass = css({ color: "neutral.subtle", "&:hover": { color: "state.error" } });
  const scopeDeleteFocusedClass = css({ color: "neutral.faded", "&:hover": { color: "state.errorBright" } });

  function scopeDelete(focused: boolean) {
    return cx("scope-delete", scopeDeleteBase, focused ? scopeDeleteFocusedClass : scopeDeleteClass);
  }

  // Sits where the delete button sits, one slot to its left, and appears on the same hover.
  // A frame is the second thing you do to a scope, not the first, so it does not take up a
  // row of its own.
  const scopeFrameBase = css({
    position: "absolute",
    right: "26px",
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
    fontSize: "12px",
    lineHeight: "1",
    transition: "opacity 0.12s, color 0.12s",
  });
  const scopeFrameClass = css({ color: "neutral.subtle", "&:hover": { color: "neutral.primary" } });
  const scopeFrameFocusedClass = css({
    color: "neutral.faded",
    "&:hover": { color: "ink.light" },
  });

  /**
   * A scope that already has a frame keeps its button visible rather than revealing it on
   * hover: the button is then the only thing in the panel saying the frame is there at all,
   * and a control you have to go looking for is a poor way to be told.
   */
  function scopeFrame(focused: boolean, framed: boolean) {
    return cx(
      framed ? "" : "scope-delete",
      scopeFrameBase,
      !framed && css({ opacity: "0" }),
      focused ? scopeFrameFocusedClass : scopeFrameClass,
    );
  }

  /**
   * Opens the name field at the root of `taskspaceId`, expanding it first if it was closed:
   * the field is drawn among the taskspace’s own rows, so a closed one has nowhere to show it.
   */
  async function startCreate(taskspaceId: string, kind: TaskspaceCreateKind): Promise<void> {
    if (!taskspaceTree.isExpanded(taskspaceId, ""))
      await taskspaceTree.toggle(treeContext, taskspaceId, "");
    taskspaceTree.beginCreate(taskspaceId, "", kind);
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
    paddingRight: "68px",
    "&:hover": { backgroundColor: "neutral.bg" },
  });
  const taskspaceNameClass = css({ flex: "1", overflow: "hidden", textOverflow: "ellipsis" });
  const taskspaceActionsClass = css({
    position: "absolute",
    right: "4px",
    top: "50%",
    transform: "translateY(-50%)",
    display: "flex",
    alignItems: "center",
    gap: "1px",
    backgroundColor: "ink.light",
  });
  const taskspaceRefreshClass = css({
    width: "20px",
    height: "20px",
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
    "&:hover": { color: "ink.black" },
  });
</script>

<!-- Corner marks framing a region, nothing in the middle: this scope is not the one the
     board is held to. Sparse enough that it needs neutral.iconDim to read at 10px.

     Redrawn on a 10-unit grid rather than sharing the corner control's 14-unit one. Sharing
     it meant scaling 14 units into 10 pixels, which puts every edge on a fraction of a pixel
     and blurs the whole figure. Same design, drawn to the size it is actually rendered at. -->
{#snippet frameIcon()}
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" shape-rendering="crispEdges" style="flex-shrink:0">
    <path d="M4 1.5H1.5V4M6 1.5h2.5V4M8.5 6v2.5H6M4 8.5H1.5V6" stroke="var(--colors-neutral-icon-dim)" stroke-width="1" />
  </svg>
{/snippet}

<!-- Only ever drawn on the focused row, where the fill is ink.charcoal, so it is stroked in
     the row colour rather than the dim grey the resting icon uses. -->
{#snippet frameHeldIcon()}
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" shape-rendering="crispEdges" style="flex-shrink:0">
    <path d="M4 1.5H1.5V4M6 1.5h2.5V4M8.5 6v2.5H6M4 8.5H1.5V6" stroke="currentColor" stroke-width="1" />
    <rect x="4" y="4" width="2" height="2" fill="currentColor" />
  </svg>
{/snippet}

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
        active && css({ borderColor: "ink.charcoal" }),
      )}>
        <div class={css({ display: "flex", alignItems: "center", position: "relative", "&:hover .scope-delete": { opacity: "1" } })}>
          <button
            class={cx(sideBtn(active), css({ paddingRight: readonly ? "28px" : "48px" }))}
            aria-pressed={active}
            onclick={() => (activeScope = active ? null : scope.id)}
          >
            <!-- The centre mark is the state, not decoration: this is the scope the board
                 is currently held to. -->
            {#if active}{@render frameHeldIcon()}{:else}{@render frameIcon()}{/if}
            <span class={flex1Class}>{scope.name}</span>
            <!-- This namespace's cards in the scope, not the scope's total: scopeRels is
                 built from this namespace's cards. A shared scope reads differently on each
                 board, which is the number each board can act on. -->
            <span class={cx(countClass, active && countFocusedClass)}>
              {scopeRels.filter((r) => r.scopeId === scope.id).length}
            </span>
          </button>
          {#if !readonly}
          {@const framed = framedScopeIds.has(scope.id)}
          <!-- The label leaves the scope's own name out: the row button beside this one
               carries it, and repeating it here would give the panel two buttons answering to
               the same name. The title is where the fuller explanation goes. -->
          <button
            class={scopeFrame(active, framed)}
            aria-label={framed ? "Remove frame" : "Add frame"}
            title={framed
              ? "Remove this scope's frame from the board"
              : selectedCards.size > 0
                ? "Frame the selected cards on the board"
                : "Add a frame for this scope to the board"}
            aria-pressed={framed}
            onclick={(e) => {
              e.stopPropagation();
              if (framed) onRemoveScopeArea(scope.id);
              else onAddScopeArea(scope.id);
            }}
          >{framed ? "▣" : "▢"}</button>
          <button
            class={scopeDelete(active)}
            title="Delete scope"
            onclick={(e) => { e.stopPropagation(); onDeleteScope(scope.id); }}
          >×</button>
          {/if}
        </div>

        {#if !readonly && selectedCards.size > 0}
          <!-- Two-state here where the file palette draws three: this button is the end of
               what you were doing, and a half-linked selection still has adding left to do. -->
          {@const allInScope = scopeLinkState(scopeRels, scope.id, selectedCards) === "all"}
          <button
            class={css({
              width: "100%",
              padding: "6px 10px",
              backgroundColor: allInScope ? "neutral.faded" : "ink.black",
              color: allInScope ? "ink.secondary" : "ink.light",
              border: "none",
              // Both blocks are dark once the scope is focused, so the usual dim rule would
              // read as a bright bar between them; the seam only has to out-light both fills.
              borderTop: active ? "1px solid token(colors.neutral.muted)" : "1px solid token(colors.neutral.dim)",
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
            <span>{allInScope ? "Unlink" : "Link"}</span>
            <span>{allInScope ? "−" : "→"}</span>
          </button>
        {/if}

        {#if active}
          {@const scopeTaskspaces = taskspaces.filter((taskspace) => taskspace.scopeId === scope.id && (taskspace.path !== null || treeContext.staticFiles?.[taskspace.id] !== undefined))}
          {#if scopeTaskspaces.length > 0}
            <div class={css({ borderTop: "1px solid token(colors.neutral.dim)", padding: "4px 6px", display: "flex", flexDirection: "column", gap: "1px" })}>
              {#each scopeTaskspaces as taskspace (taskspace.id)}
                {@const expanded = taskspaceTree.isExpanded(taskspace.id, "")}
                <!-- Live, or a static export with an embedded tree for this one (built with
                     `--include-scoped-files`). A plain export has neither a server to ask
                     nor a tree to read instead, so its taskspaces stay the plain label they
                     always were. -->
                {@const browsable = !readonly || treeContext.staticFiles?.[taskspace.id] !== undefined}
                <div class={css({ display: "flex", flexDirection: "column", gap: "1px" })}>
                  <div class={css({ display: "flex", alignItems: "center", position: "relative", "&:hover .hover-reveal": { opacity: "1" } })}>
                    {#if browsable}
                      <button
                        class={cx(taskspaceRowClass, taskspaceRowButtonClass)}
                        onclick={() => taskspaceTree.toggle(treeContext, taskspace.id, "")}
                        aria-expanded={expanded}
                      >
                        <TreeArrow {expanded} />
                        <span class={taskspaceNameClass}>{taskspace.name}</span>
                      </button>
                      {#if !readonly}
                        <span class={taskspaceActionsClass}>
                          <!-- The taskspace root gets the same pair every folder under it
                               has, because the root is the folder most files are made in
                               and reaching it through the tree would mean opening nothing. -->
                          <TaskspaceCreateButtons
                            where="this taskspace"
                            onCreate={(kind) => startCreate(taskspace.id, kind)}
                          />
                          {#if expanded}
                            <button
                              class={cx("hover-reveal", taskspaceRefreshClass)}
                              title="Re-read this taskspace from disk"
                              onclick={(e) => { e.stopPropagation(); taskspaceTree.refresh(treeContext, taskspace.id); }}
                            >⟳</button>
                          {/if}
                        </span>
                      {/if}
                    {:else}
                      <div class={taskspaceRowClass}>
                        {@render taskspaceIcon()}
                        <span class={taskspaceNameClass}>{taskspace.name}</span>
                      </div>
                    {/if}
                  </div>
                  {#if expanded && browsable}
                    <TaskspaceTree
                      tree={taskspaceTree}
                      ctx={treeContext}
                      taskspaceId={taskspace.id}
                      path=""
                      onOpenFile={onOpenFile &&
                        ((filePath) => onOpenFile(taskspace.id, taskspace.name, filePath))}
                      canCreate={!readonly}
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
