<script lang="ts">
  import { css, cx } from "styled-system/css";
  import type { Scope, TaskspaceEntryKind, TaskspaceSummary } from "$lib/types";
  import type { TaskspaceTreeContext, TaskspaceTreeState } from "../lib/taskspace-tree.svelte.js";
  import type { OpenFileRef } from "../lib/editor/editor-session.svelte.js";
  import {
    blockedByEditor,
    deleteEntryFlow,
    deleteTaskspaceFlow,
    removeScopeFlow,
    scopeDeleteBlock,
    type FileManagementActions,
    type ManagementMessage,
  } from "../lib/file-management.js";
  import FileBrowserTree from "./FileBrowserTree.svelte";
  import InlineNameInput from "./InlineNameInput.svelte";
  import RowActionButtons from "./RowActionButtons.svelte";
  import TaskspaceCreateButtons from "./TaskspaceCreateButtons.svelte";

  let {
    scopes,
    taskspaces,
    tree,
    ctx,
    readonly = false,
    editorFile,
    initialScopeId = null,
    actions,
    onOpenFile,
    onClose,
  }: {
    scopes: Scope[];
    taskspaces: TaskspaceSummary[];
    tree: TaskspaceTreeState;
    ctx: TaskspaceTreeContext;
    readonly?: boolean;
    /** The file open in the editor, which is highlighted and protected from changes. */
    editorFile: OpenFileRef | null;
    /** The scope to start on when the editor has no file open, such as the sidebar's. */
    initialScopeId?: string | null;
    actions: FileManagementActions;
    onOpenFile: (taskspaceId: string, taskspaceName: string, path: string) => void;
    onClose: () => void;
  } = $props();

  /** Stands in for taskspaces that belong to no scope, so they can still be reached. */
  const NO_SCOPE = "";

  // Start where the open file is, so the modal shows the file's surroundings.
  // svelte-ignore state_referenced_locally
  const startTaskspace = editorFile
    ? taskspaces.find(({ id }) => id === editorFile.taskspaceId)
    : undefined;
  // svelte-ignore state_referenced_locally
  let chosenScopeId = $state<string | null>(
    startTaskspace ? (startTaskspace.scopeId ?? NO_SCOPE) : initialScopeId,
  );
  let chosenTaskspaceId = $state<string | null>(startTaskspace?.id ?? null);

  /**
   * One name field at a time: creating a scope or taskspace, or renaming any row. File and
   * folder creation uses the shared tree's own field instead.
   */
  type Editing =
    | { kind: "new-scope" }
    | { kind: "new-taskspace" }
    | { kind: "scope"; id: string }
    | { kind: "taskspace"; id: string }
    | { kind: "entry"; path: string };
  let editing = $state<Editing | null>(null);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let panelEl: HTMLDivElement | undefined = $state();

  const unscoped = $derived(taskspaces.filter(({ scopeId }) => scopeId === null));
  const scopeId = $derived(
    chosenScopeId !== null &&
      (scopes.some(({ id }) => id === chosenScopeId) ||
        (chosenScopeId === NO_SCOPE && unscoped.length > 0))
      ? chosenScopeId
      : (scopes[0]?.id ?? (unscoped.length > 0 ? NO_SCOPE : null)),
  );
  const scopeTaskspaces = $derived(
    scopeId === null
      ? []
      : taskspaces.filter((t) => (t.scopeId ?? NO_SCOPE) === scopeId),
  );
  const taskspace = $derived(
    scopeTaskspaces.find(({ id }) => id === chosenTaskspaceId) ?? scopeTaskspaces[0] ?? null,
  );
  /** Whether the taskspace's files can be listed: live with a directory, or exported. */
  const browsable = $derived(
    taskspace !== null &&
      (ctx.staticFiles ? ctx.staticFiles[taskspace.id] !== undefined : taskspace.path !== null),
  );
  const openPath = $derived(
    editorFile && taskspace && editorFile.taskspaceId === taskspace.id ? editorFile.path : null,
  );

  // Show the selected taskspace's top level as soon as it is chosen.
  $effect(() => {
    const id = taskspace?.id;
    if (id && browsable && !tree.isExpanded(id, "")) void tree.toggle(ctx, id, "");
  });

  $effect(() => {
    if (panelEl && !panelEl.contains(document.activeElement)) panelEl.focus();
  });

  // Keep focus inside the dialog, as `aria-modal` promises. Watch where focus lands rather
  // than Tab, because the name field keeps its keys to itself.
  $effect(() => {
    const panel = panelEl;
    if (!panel) return;
    const pullBack = (e: FocusEvent) => {
      if (e.target instanceof Node && !panel.contains(e.target)) panel.focus();
    };
    document.addEventListener("focusin", pullBack);
    return () => document.removeEventListener("focusin", pullBack);
  });

  function selectScope(id: string): void {
    if (chosenScopeId === id && scopeId === id) return;
    chosenScopeId = id;
    chosenTaskspaceId = null;
    clearMessages();
  }

  function selectTaskspace(id: string): void {
    if (chosenTaskspaceId === id) return;
    chosenTaskspaceId = id;
    clearMessages();
  }

  function clearMessages(): void {
    error = null;
    notice = null;
  }

  function begin(next: Editing): void {
    tree.cancelCreate();
    clearMessages();
    editing = next;
  }

  function stopEditing(): void {
    editing = null;
    // Give the keyboard back to the modal rather than the page body.
    panelEl?.focus();
  }

  function show(message: ManagementMessage | null): void {
    if (message?.kind === "error") error = message.text;
    else if (message) notice = message.text;
  }

  // ── Scopes ──────────────────────────────────────────────────────

  async function createScope(name: string): Promise<string | null> {
    const made = await actions.createScope(name);
    if ("error" in made) return made.error;
    stopEditing();
    selectScope(made.id);
    return null;
  }

  async function renameScope(id: string, name: string): Promise<string | null> {
    const failed = await actions.renameScope(id, name);
    if (failed) return failed.error;
    stopEditing();
    return null;
  }

  async function removeScope(scope: Scope): Promise<void> {
    clearMessages();
    show(await removeScopeFlow(actions, taskspaces, scope));
    panelEl?.focus();
  }

  // ── Taskspaces ──────────────────────────────────────────────────

  async function createTaskspace(name: string): Promise<string | null> {
    if (!scopeId) return "Choose a scope first";
    const made = await actions.createTaskspace(scopeId, name);
    if ("error" in made) return made.error;
    stopEditing();
    selectTaskspace(made.id);
    return null;
  }

  async function renameTaskspace(id: string, name: string): Promise<string | null> {
    const failed = await actions.renameTaskspace(id, name);
    if (failed) return failed.error;
    stopEditing();
    return null;
  }

  async function deleteTaskspace(target: TaskspaceSummary): Promise<void> {
    clearMessages();
    show(await deleteTaskspaceFlow(actions, editorFile, target));
    panelEl?.focus();
  }

  // ── Files and folders ───────────────────────────────────────────

  function openFile(path: string): void {
    if (!taskspace) return;
    onOpenFile(taskspace.id, taskspace.name, path);
  }

  function startRenameEntry(path: string): void {
    if (!taskspace) return;
    const blocked = blockedByEditor(editorFile, taskspace.id, path);
    if (blocked) {
      clearMessages();
      error = blocked;
      return;
    }
    begin({ kind: "entry", path });
  }

  async function renameEntry(path: string, name: string): Promise<string | null> {
    if (!taskspace) return null;
    const result = await tree.rename(ctx, taskspace.id, path, name);
    if ("error" in result) return result.error;
    stopEditing();
    return null;
  }

  async function deleteEntry(path: string, kind: TaskspaceEntryKind): Promise<void> {
    if (!taskspace) return;
    clearMessages();
    show(
      await deleteEntryFlow(
        (id, p) => tree.remove(ctx, id, p),
        editorFile,
        taskspace.id,
        path,
        kind,
      ),
    );
    panelEl?.focus();
  }

  async function startCreateEntry(kind: "file" | "directory"): Promise<void> {
    if (!taskspace) return;
    editing = null;
    clearMessages();
    if (!tree.isExpanded(taskspace.id, "")) await tree.toggle(ctx, taskspace.id, "");
    tree.beginCreate(taskspace.id, "", kind);
  }

  // ── Keyboard ────────────────────────────────────────────────────

  /** Rows of one column, in screen order. */
  function columnRows(col: number): HTMLButtonElement[] {
    return [...(panelEl?.querySelectorAll<HTMLButtonElement>(`button[data-col="${col}"]`) ?? [])]
      .filter((row) => !row.disabled || col === 2);
  }

  function handleKeydown(e: KeyboardEvent): void {
    // Keep keys away from the board's shortcuts while the modal is up.
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    const target = e.target instanceof HTMLButtonElement ? e.target : null;
    const col = target?.dataset.col !== undefined ? Number(target.dataset.col) : null;

    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const rows = columnRows(col ?? 0);
      if (rows.length === 0) return;
      const at = target ? rows.indexOf(target) : -1;
      const step = e.key === "ArrowDown" ? 1 : -1;
      const next = at === -1 ? (step === 1 ? 0 : rows.length - 1) : at + step;
      rows[Math.max(0, Math.min(rows.length - 1, next))]?.focus();
    } else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && col !== null) {
      const nextCol = col + (e.key === "ArrowRight" ? 1 : -1);
      if (nextCol < 0 || nextCol > 2) return;
      e.preventDefault();
      const rows = columnRows(nextCol);
      (rows.find((row) => row.getAttribute("aria-selected") === "true") ?? rows[0])?.focus();
    }
  }

  // ── Styles ──────────────────────────────────────────────────────

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
    width: "min(960px, calc(100vw - 32px))",
    height: "min(70vh, 600px)",
    background: "ink.white",
    border: "1px solid token(colors.neutral.dim)",
    borderRadius: "4px",
    outline: "none",
    overflow: "hidden",
  });
  const columnsClass = css({
    flex: "1",
    minHeight: "0",
    display: "grid",
    gridTemplateColumns: { base: "1fr", md: "minmax(160px, 1fr) minmax(180px, 1fr) minmax(240px, 2fr)" },
    gridTemplateRows: { base: "repeat(3, minmax(0, 1fr))", md: "minmax(0, 1fr)" },
  });
  const columnClass = css({
    display: "flex",
    flexDirection: "column",
    minHeight: "0",
    minWidth: "0",
    borderRight: { md: "1px solid token(colors.neutral.dim)" },
    borderBottom: { base: "1px solid token(colors.neutral.dim)", md: "none" },
    "&:last-child": { borderRight: "none", borderBottom: "none" },
  });
  const headerClass = css({
    display: "flex",
    alignItems: "center",
    gap: "4px",
    height: "32px",
    flexShrink: "0",
    padding: "0 6px 0 10px",
    borderBottom: "1px solid token(colors.neutral.dim)",
    fontSize: "11.5px",
    fontWeight: "600",
    color: "neutral.subtle",
    // The header's creation buttons are always visible, unlike the ones on rows.
    "& .hover-reveal": { opacity: "1" },
  });
  const headerTitleClass = css({ flex: "1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
  const addBtnClass = css({
    width: "20px",
    height: "20px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "none",
    border: "none",
    borderRadius: "2px",
    cursor: "pointer",
    color: "neutral.subtle",
    fontSize: "15px",
    lineHeight: "1",
    "&:hover:not(:disabled)": { color: "ink.black" },
    "&:disabled": { cursor: "default", color: "neutral.faded" },
  });
  const listClass = css({ flex: "1", overflowY: "auto", padding: "4px" });
  const rowWrapClass = css({
    display: "flex",
    alignItems: "center",
    borderRadius: "2px",
    "&:hover, &:focus-within": { backgroundColor: "neutral.bg" },
    "&:hover .hover-reveal, &:focus-within .hover-reveal": { opacity: "1" },
  });
  const selectedWrapClass = css({
    backgroundColor: "neutral.dim",
    "&:hover, &:focus-within": { backgroundColor: "neutral.dim" },
  });
  const rowClass = css({
    flex: "1",
    minWidth: "0",
    padding: "6px 8px",
    background: "transparent",
    border: "none",
    textAlign: "left",
    fontSize: "12px",
    fontFamily: "inherit",
    color: "ink.black",
    cursor: "pointer",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    outline: "none",
  });
  const mutedRowClass = css({ fontStyle: "italic", color: "neutral.subtle" });
  const actionsClass = css({ display: "flex", alignItems: "center", gap: "1px", paddingRight: "4px" });
  const noteClass = css({ padding: "6px 8px", fontSize: "11px", color: "neutral.subtle", fontStyle: "italic" });
  const footerClass = css({
    display: "flex",
    alignItems: "center",
    gap: "12px",
    flexShrink: "0",
    minHeight: "28px",
    padding: "4px 10px",
    borderTop: "1px solid token(colors.neutral.dim)",
    fontSize: "11px",
    color: "neutral.subtle",
  });
  const hintsClass = css({ marginLeft: "auto", whiteSpace: "nowrap", display: { base: "none", md: "block" } });
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
    aria-label="Files"
    tabindex="-1"
    onkeydown={handleKeydown}
  >
    <div class={columnsClass}>
      <!-- Scopes -->
      <section class={columnClass} aria-label="Scopes">
        <div class={headerClass}>
          <span class={headerTitleClass}>scopes</span>
          {#if !readonly}
            <button class={addBtnClass} title="New scope" aria-label="New scope" onclick={() => begin({ kind: "new-scope" })}>+</button>
          {/if}
        </div>
        <div class={listClass} role="listbox" aria-label="Scopes">
          {#if editing?.kind === "new-scope"}
            <InlineNameInput label="New scope name" onSubmit={createScope} onCancel={stopEditing} />
          {/if}
          {#if scopes.length === 0 && unscoped.length === 0 && editing?.kind !== "new-scope"}
            <div class={noteClass}>{readonly ? "No scopes on this board." : "No scopes yet."}</div>
          {/if}
          {#each scopes as scope (scope.id)}
            {#if editing?.kind === "scope" && editing.id === scope.id}
              <InlineNameInput
                value={scope.name}
                label={`New name for ${scope.name}`}
                onSubmit={(name) => renameScope(scope.id, name)}
                onCancel={stopEditing}
              />
            {:else}
              <div class={cx(rowWrapClass, scopeId === scope.id && selectedWrapClass)}>
                <button
                  class={rowClass}
                  data-col="0"
                  role="option"
                  aria-selected={scopeId === scope.id}
                  onclick={() => selectScope(scope.id)}
                  onfocus={() => selectScope(scope.id)}
                >{scope.name}</button>
                {#if !readonly}
                  <span class={actionsClass}>
                    <RowActionButtons
                      what={scope.name}
                      onRename={() => begin({ kind: "scope", id: scope.id })}
                      onDelete={() => removeScope(scope)}
                      deleteDisabledReason={scopeDeleteBlock(taskspaces, scope.id)}
                    />
                  </span>
                {/if}
              </div>
            {/if}
          {/each}
          {#if unscoped.length > 0}
            <div class={cx(rowWrapClass, scopeId === NO_SCOPE && selectedWrapClass)}>
              <button
                class={cx(rowClass, mutedRowClass)}
                data-col="0"
                role="option"
                aria-selected={scopeId === NO_SCOPE}
                onclick={() => selectScope(NO_SCOPE)}
                onfocus={() => selectScope(NO_SCOPE)}
              >No scope</button>
            </div>
          {/if}
        </div>
      </section>

      <!-- Taskspaces -->
      <section class={columnClass} aria-label="Taskspaces">
        <div class={headerClass}>
          <span class={headerTitleClass}>taskspaces</span>
          {#if !readonly}
            <button
              class={addBtnClass}
              title={scopeId ? "New taskspace" : "Choose a scope first"}
              aria-label="New taskspace"
              disabled={!scopeId}
              onclick={() => begin({ kind: "new-taskspace" })}
            >+</button>
          {/if}
        </div>
        <div class={listClass} role="listbox" aria-label="Taskspaces">
          {#if editing?.kind === "new-taskspace"}
            <InlineNameInput label="New taskspace name" onSubmit={createTaskspace} onCancel={stopEditing} />
          {/if}
          {#if scopeId === null}
            <div class={noteClass}>Choose a scope.</div>
          {:else if scopeTaskspaces.length === 0 && editing?.kind !== "new-taskspace"}
            <div class={noteClass}>No taskspaces in this scope.</div>
          {/if}
          {#each scopeTaskspaces as item (item.id)}
            {#if editing?.kind === "taskspace" && editing.id === item.id}
              <InlineNameInput
                value={item.name}
                label={`New name for ${item.name}`}
                onSubmit={(name) => renameTaskspace(item.id, name)}
                onCancel={stopEditing}
              />
            {:else}
              <div class={cx(rowWrapClass, taskspace?.id === item.id && selectedWrapClass)}>
                <button
                  class={rowClass}
                  data-col="1"
                  role="option"
                  aria-selected={taskspace?.id === item.id}
                  title={item.path ?? "No directory"}
                  onclick={() => selectTaskspace(item.id)}
                  onfocus={() => selectTaskspace(item.id)}
                >{item.name}</button>
                {#if !readonly}
                  <span class={actionsClass}>
                    <RowActionButtons
                      what={item.name}
                      onRename={() => begin({ kind: "taskspace", id: item.id })}
                      onDelete={() => deleteTaskspace(item)}
                    />
                  </span>
                {/if}
              </div>
            {/if}
          {/each}
        </div>
      </section>

      <!-- Files and folders -->
      <section class={columnClass} aria-label="Files">
        <div class={headerClass}>
          <span class={headerTitleClass} title={taskspace?.path ?? undefined}>
            {taskspace ? taskspace.name : "files"}
          </span>
          {#if !readonly && taskspace && browsable}
            <TaskspaceCreateButtons where={`"${taskspace.name}"`} onCreate={startCreateEntry} />
            {#if !ctx.staticFiles}
              <button
                class={addBtnClass}
                title="Refresh from disk"
                aria-label="Refresh from disk"
                onclick={() => tree.refresh(ctx, taskspace.id)}
              >⟳</button>
            {/if}
          {/if}
        </div>
        <div class={listClass}>
          {#if !taskspace}
            <div class={noteClass}>Choose a taskspace.</div>
          {:else if !browsable}
            <div class={noteClass}>This taskspace has no browsable directory.</div>
          {:else}
            {#key taskspace.id}
              <FileBrowserTree
                {tree}
                {ctx}
                taskspaceId={taskspace.id}
                path=""
                {readonly}
                canOpen={!readonly || ctx.staticFiles !== undefined}
                {openPath}
                renaming={editing?.kind === "entry" ? editing.path : null}
                onOpenFile={openFile}
                onStartRename={startRenameEntry}
                onRename={renameEntry}
                onCancelRename={stopEditing}
                onDelete={deleteEntry}
              />
            {/key}
          {/if}
        </div>
      </section>
    </div>

    <div class={footerClass}>
      {#if error}
        <span class={css({ color: "state.error" })} role="alert">{error}</span>
      {:else if notice}
        <span role="status">{notice}</span>
      {/if}
      <span class={hintsClass}>
        ↑↓ move · ←→ column · Esc close
      </span>
    </div>
  </div>
</div>
