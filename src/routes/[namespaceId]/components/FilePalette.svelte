<script lang="ts">
  import { css, cx } from "styled-system/css";
  import type { Scope, ScopeRel, TaskspaceSummary } from "$lib/types";
  import type {
    TaskspaceCreateKind,
    TaskspaceTreeContext,
    TaskspaceTreeState,
  } from "../lib/taskspace-tree.svelte.js";
  import { countLinked, scopeLinkState } from "../lib/scope-link.js";
  import TaskspaceCreateButtons from "./TaskspaceCreateButtons.svelte";
  import TaskspaceTree from "./TaskspaceTree.svelte";
  import TreeArrow from "./TreeArrow.svelte";

  let {
    scopes,
    scopeRels,
    taskspaces,
    selectedCards,
    tree,
    ctx,
    readonly = false,
    onOpenFile,
    onLinkScope,
    onCreate,
    onClose,
  }: {
    // The snapshot already limits scopes to those this namespace displays, as in
    // ScopeSidebar.
    scopes: Scope[];
    scopeRels: ScopeRel[];
    taskspaces: TaskspaceSummary[];
    /** The cards this panel is about. Never emptied by anything done here. */
    selectedCards: Set<string>;
    tree: TaskspaceTreeState;
    ctx: TaskspaceTreeContext;
    readonly?: boolean;
    onOpenFile: (taskspaceId: string, taskspaceName: string, path: string) => void;
    onLinkScope: (scopeId: string) => void;
    onCreate: (names: { scope: string; taskspace: string; file: string }) => void;
    onClose: () => void;
  } = $props();

  let panelEl: HTMLDivElement | undefined = $state();
  /**
   * Track collapsed scopes. Show all taskspaces initially and reset folding when the palette
   * reopens.
   */
  let collapsed = $state(new Set<string>());
  let scopeName = $state("");
  let taskspaceName = $state("");
  let fileName = $state("");
  let taskspaceInput: HTMLInputElement | undefined = $state();
  let fileInput: HTMLInputElement | undefined = $state();

  // Focus the palette on opening and after scope updates remove a focused row.
  $effect(() => {
    // oxlint-disable-next-line no-unused-expressions
    scopes.length;
    if (panelEl && !panelEl.contains(document.activeElement)) panelEl.focus();
  });

  function handleKeydown(e: KeyboardEvent): void {
    // Stop palette keystrokes from reaching board selection shortcuts.
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  function toggleScope(scopeId: string): void {
    const next = new Set(collapsed);
    if (!next.delete(scopeId)) next.add(scopeId);
    collapsed = next;
  }

  /**
   * Expand the taskspace before opening its root name field so the field is visible among its
   * rows.
   */
  async function startCreate(taskspaceId: string, kind: TaskspaceCreateKind): Promise<void> {
    if (!tree.isExpanded(taskspaceId, "")) await tree.toggle(ctx, taskspaceId, "");
    tree.beginCreate(taskspaceId, "", kind);
  }

  function submitCreate(): void {
    if (!scopeName.trim() || !taskspaceName.trim() || !fileName.trim()) return;
    onCreate({ scope: scopeName, taskspace: taskspaceName, file: fileName });
  }

  /**
   * Move to the next field on Enter so creation waits until the scope, taskspace, and file
   * name are ready.
   */
  function createKeydown(e: KeyboardEvent, next?: HTMLInputElement): void {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (next) next.focus();
    else submitCreate();
  }

  /** The taskspaces of one scope that there is anything to browse in. */
  function taskspacesOf(scopeId: string): TaskspaceSummary[] {
    return taskspaces.filter(
      (taskspace) =>
        taskspace.scopeId === scopeId &&
        (taskspace.path !== null || ctx.staticFiles?.[taskspace.id] !== undefined),
    );
  }

  // Open every taskspace tree initially so files are immediately visible. The sidebar opens
  // one at a time to stay compact.
  $effect(() => {
    for (const scope of scopes) {
      for (const taskspace of taskspacesOf(scope.id)) {
        if (!tree.isExpanded(taskspace.id, "")) tree.toggle(ctx, taskspace.id, "");
      }
    }
  });

  const backdropClass = css({
    position: "fixed",
    inset: "0",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(0,0,0,0.12)",
    zIndex: "300",
  });
  const panelClass = css({
    display: "flex",
    flexDirection: "column",
    width: "min(520px, calc(100vw - 32px))",
    maxHeight: "min(70vh, 640px)",
    background: "ink.white",
    border: "1px solid token(colors.neutral.border)",
    borderRadius: "4px",
    boxShadow: "0 8px 32px rgba(0,0,0,0.08)",
    outline: "none",
  });
  const bodyClass = css({ flex: "1", overflowY: "auto", padding: "6px" });
  const scopeBlockClass = css({
    border: "1px solid token(colors.neutral.dim)",
    borderRadius: "2px",
    marginBottom: "5px",
    overflow: "hidden",
  });
  const scopeRowClass = css({
    display: "flex",
    alignItems: "center",
    gap: "8px",
    width: "100%",
    padding: "7px 10px",
    background: "transparent",
    border: "none",
    cursor: "pointer",
    textAlign: "left",
    fontSize: "12.5px",
    fontFamily: "inherit",
    color: "ink.black",
    "&:hover": { backgroundColor: "neutral.bg" },
  });
  const scopeNameClass = css({ flex: "1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
  const linkedClass = css({ fontSize: "10.5px", color: "neutral.subtle", flexShrink: "0" });
  const linkBtnClass = css({
    flexShrink: "0",
    padding: "3px 8px",
    background: "ink.black",
    color: "ink.light",
    border: "none",
    borderRadius: "2px",
    cursor: "pointer",
    fontSize: "10.5px",
    fontFamily: "inherit",
    "&:hover": { backgroundColor: "ink.charcoal" },
  });
  const taskspaceRowClass = css({
    display: "flex",
    alignItems: "center",
    gap: "5px",
    width: "100%",
    padding: "4px 8px",
    background: "transparent",
    border: "none",
    borderRadius: "2px",
    textAlign: "left",
    fontSize: "11.5px",
    fontFamily: "inherit",
    color: "ink.secondary",
    cursor: "pointer",
    "&:hover": { backgroundColor: "neutral.bg" },
  });
  const noteClass = css({ padding: "5px 10px", fontSize: "11px", color: "neutral.subtle", fontStyle: "italic" });
  const taskspaceRowWrapClass = css({
    display: "flex",
    alignItems: "center",
    position: "relative",
    "&:hover .hover-reveal": { opacity: "1" },
  });
  const taskspaceRowButtonSpacedClass = css({ paddingRight: "48px" });
  const taskspaceActionsClass = css({
    position: "absolute",
    right: "4px",
    top: "50%",
    transform: "translateY(-50%)",
    display: "flex",
    alignItems: "center",
    gap: "1px",
    backgroundColor: "ink.white",
  });
  const footerClass = css({
    flexShrink: "0",
    borderTop: "1px solid token(colors.neutral.dim)",
    padding: "8px",
    display: "flex",
    flexDirection: "column",
    gap: "5px",
  });
  const inputRowClass = css({ display: "flex", gap: "4px" });
  const inputClass = css({
    flex: "1",
    minWidth: "0",
    padding: "5px 7px",
    border: "1px solid token(colors.neutral.dim)",
    borderRadius: "2px",
    background: "ink.white",
    color: "ink.black",
    fontSize: "11.5px",
    fontFamily: "inherit",
  });
  const createBtnClass = css({
    padding: "5px 11px",
    background: "ink.black",
    color: "ink.light",
    border: "none",
    borderRadius: "2px",
    cursor: "pointer",
    fontSize: "11.5px",
    fontFamily: "inherit",
    flexShrink: "0",
    "&:disabled": { backgroundColor: "neutral.faded", color: "ink.secondary", cursor: "default" },
  });
</script>

<!-- Close only when the press targets the backdrop itself. -->
<div
  class={backdropClass}
  role="presentation"
  onmousedown={(e) => e.target === e.currentTarget && onClose()}
>
  <div
    bind:this={panelEl}
    class={panelClass}
    role="dialog"
    aria-modal="true"
    aria-label="Edit a file"
    tabindex="-1"
    onkeydown={handleKeydown}
  >
    <div class={bodyClass}>
      {#if scopes.length === 0}
        <!-- A read-only export has no form below to point at. -->
        <div class={noteClass}>
          {readonly ? "No scopes on this board." : "No scopes yet. Make one below."}
        </div>
      {/if}
      {#each scopes as scope (scope.id)}
        {@const link = scopeLinkState(scopeRels, scope.id, selectedCards)}
        {@const expanded = !collapsed.has(scope.id)}
        {@const scopeTaskspaces = taskspacesOf(scope.id)}
        <div class={scopeBlockClass}>
          <div class={css({ display: "flex", alignItems: "center", padding: "0 6px 0 0" })}>
            <button
              class={scopeRowClass}
              aria-expanded={expanded}
              onclick={() => toggleScope(scope.id)}
            >
              <TreeArrow {expanded} />
              <span class={scopeNameClass}>{scope.name}</span>
            </button>
            {#if !readonly}
              {#if link === "all"}
                <span class={linkedClass}>Linked</span>
              {:else}
                <button class={linkBtnClass} onclick={() => onLinkScope(scope.id)}>
                  {link === "some"
                    ? `Link ${selectedCards.size - countLinked(scopeRels, scope.id, selectedCards)} more`
                    : "Link"}
                </button>
              {/if}
            {/if}
          </div>

          {#if expanded}
            {#if scopeTaskspaces.length === 0}
              <div class={noteClass}>No taskspaces in this scope.</div>
            {/if}
            {#each scopeTaskspaces as taskspace (taskspace.id)}
              {@const open = tree.isExpanded(taskspace.id, "")}
              <div class={css({ borderTop: "1px solid token(colors.neutral.dim)", padding: "3px 4px" })}>
                <div class={taskspaceRowWrapClass}>
                  <button
                    class={cx(taskspaceRowClass, !readonly && taskspaceRowButtonSpacedClass)}
                    aria-expanded={open}
                    onclick={() => tree.toggle(ctx, taskspace.id, "")}
                  >
                    <TreeArrow expanded={open} />
                    <span class={scopeNameClass}>{taskspace.name}</span>
                  </button>
                  {#if !readonly}
                    <span class={taskspaceActionsClass}>
                      <!-- The taskspace root gets the same pair every folder under it has,
                           because the root is the folder most files are made in and reaching
                           it through the tree would mean opening nothing. -->
                      <TaskspaceCreateButtons
                        where="this taskspace"
                        onCreate={(kind) => startCreate(taskspace.id, kind)}
                      />
                    </span>
                  {/if}
                </div>
                {#if open}
                  <TaskspaceTree
                    {tree}
                    {ctx}
                    taskspaceId={taskspace.id}
                    path=""
                    canCreate={!readonly}
                    onOpenFile={(filePath) => onOpenFile(taskspace.id, taskspace.name, filePath)}
                  />
                {/if}
              </div>
            {/each}
          {/if}
        </div>
      {/each}
    </div>

    {#if !readonly}
      <div class={footerClass}>
        <div class={inputRowClass}>
          <input class={inputClass} bind:value={scopeName} placeholder="Scope" aria-label="New scope name" onkeydown={(e) => createKeydown(e, taskspaceInput)} />
          <input class={inputClass} bind:value={taskspaceName} bind:this={taskspaceInput} placeholder="Taskspace" aria-label="New taskspace name" onkeydown={(e) => createKeydown(e, fileInput)} />
          <input class={inputClass} bind:value={fileName} bind:this={fileInput} placeholder="File" aria-label="New file name" onkeydown={(e) => createKeydown(e)} />
          <button
            class={createBtnClass}
            disabled={!scopeName.trim() || !taskspaceName.trim() || !fileName.trim()}
            onclick={submitCreate}
          >Create</button>
        </div>
      </div>
    {/if}
  </div>
</div>
