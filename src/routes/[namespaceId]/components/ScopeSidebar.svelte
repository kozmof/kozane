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
    frameCountByScopeId,
    onCreateTaskspace,
    onOpenFile,
    readonly = false,
  }: {
    visible: boolean;
    panelWidth: number;
    // The snapshot already limits scopes and taskspaces to this namespace. See
    // NamespaceDataSnapshot.
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
    /**
     * Number of frames for each scope on this board. Frame-specific remove controls live on
     * the canvas because a scope can have several frames.
     */
    frameCountByScopeId: Map<string, number>;
    onCreateTaskspace: () => void;
    /**
     * Optional file-opening callback. Static exports can open embedded files in read-only
     * mode but cannot save them. Omit the callback when neither a live endpoint nor embedded
     * content is available.
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
  // Invert the focused scope row to make the active filter visible. Keep its fill square so
  // the parent's rounded clipping does not leave gaps at the corners.
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

  // One slot to the left of the delete button. A frame is a thing a scope either has or has
  // not got, so this reports rather than offers, and does not take up a row of its own.
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
   * Keep the frame-status indicator visible without hover so users can see which scopes are
   * framed.
   */
  function scopeFrame(focused: boolean) {
    return cx(scopeFrameBase, focused ? scopeFrameFocusedClass : scopeFrameClass);
  }

  function frameTitle(frames: number): string {
    return frames === 1
      ? "Framed once on this board"
      : `Framed in ${frames} places on this board`;
  }

  /**
   * Expand the taskspace before opening its root name field so the field is visible among its
   * rows.
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

<!-- Use empty corner marks for an inactive scope, with neutral.iconDim for legibility. Draw on a 10-unit grid matching the rendered size to avoid blurred, fractional-pixel edges. -->
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
            <!-- The centre mark identifies the board's active scope. -->
            {#if active}{@render frameHeldIcon()}{:else}{@render frameIcon()}{/if}
            <span class={flex1Class}>{scope.name}</span>
            <!-- Count only this namespace's cards in the scope, using scopeRels. Shared scopes can have different counts on different boards. -->
            <span class={cx(countClass, active && countFocusedClass)}>
              {scopeRels.filter((r) => r.scopeId === scope.id).length}
            </span>
          </button>
          {#if !readonly}
          {@const frames = frameCountByScopeId.get(scope.id) ?? 0}
          <!-- Report frame status here. Draw frames with Alt-drag and remove them individually on the canvas. Show a number only when the scope has multiple frames. -->
          {#if frames > 0}
          <span class={scopeFrame(active)} title={frameTitle(frames)}>
            ▣{frames > 1 ? frames : ""}
          </span>
          {/if}
          <button
            class={scopeDelete(active)}
            title="Delete scope"
            onclick={(e) => { e.stopPropagation(); onDeleteScope(scope.id); }}
          >×</button>
          {/if}
        </div>

        {#if !readonly && selectedCards.size > 0}
          <!-- Treat partial membership as an add action. This button completes the selection's membership rather than showing the palette's three states. -->
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
