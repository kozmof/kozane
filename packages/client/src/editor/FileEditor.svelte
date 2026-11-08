<script lang="ts">
  import { css } from "../styles/css.js";
  import { onDestroy, untrack } from "svelte";
  import type { NavigationDriver } from "../navigation.js";
  import EditorSurface, { type EditorMode } from "./EditorSurface.svelte";
  import type {
    EditorSession,
    EditorSessionContext,
  } from "./editor-session.svelte.js";
  import type { EditorDocument } from "./document-store.svelte.js";
  import { createVimState, handleVimKey, type VimState } from "./vim.js";
  import { guardUnsavedLeave, UNSAVED_LEAVE_PROMPT } from "./leave-guard.js";
  import EditorPanelHeader from "./EditorPanelHeader.svelte";
  import EditorPanelNotices from "./EditorPanelNotices.svelte";
  import EditorStatusBar from "./EditorStatusBar.svelte";
  import PanelResizeHandle from "./PanelResizeHandle.svelte";

  let {
    session,
    ctx,
    routing,
    vimMode = false,
    autoSave = false,
    readonly = false,
    width = $bindable(null),
    pinned = $bindable(false),
    onClose,
  }: {
    session: EditorSession;
    ctx: EditorSessionContext;
    routing: NavigationDriver;
    /** `ui.editorVimMode`. Off means the surface's own key handling is all there is. */
    vimMode?: boolean;
    /** `ui.editorAutoSave`. Saves once typing pauses, and on close. Ignored when read-only. */
    autoSave?: boolean;
    readonly?: boolean;
    /**
     * Panel width in pixels, or null for the responsive default. The page owns this value so
     * it survives closing or remounting the editor.
     */
    width?: number | null;
    /**
     * Whether the panel stays open when the user presses outside it. Escape and Close still
     * close it. The page owns this value, like `width`, so it survives closing a file.
     */
    pinned?: boolean;
    onClose: () => void;
  } = $props();

  /** Panel width limits that leave room for readable text and the board. */
  const MIN_WIDTH = 320;
  const EDGE_MARGIN = 120;
  const KEY_STEP = 16;
  /** Pause after the last edit before auto save writes the file. */
  const AUTO_SAVE_DELAY_MS = 1000;

  let panelEl: HTMLDivElement | undefined = $state();
  let surface: { focus: () => void } | undefined = $state();
  let vim = $state<VimState>(createVimState());

  const mode = $derived<EditorMode>(vimMode ? vim.mode : "insert");

  // Keep keyboard events within the open editor so typing cannot trigger board shortcuts.
  $effect(() => {
    if (session.isOpen && panelEl && !panelEl.contains(document.activeElement)) surface?.focus();
  });

  // Reset Vim to normal mode and clear the close prompt when opening a different file.
  $effect(() => {
    void session.file;
    vim = createVimState();
    confirmingClose = false;
  });

  /**
   * Close on a press outside the panel, unless pinned. Use `mousedown` so dragging a text
   * selection beyond the panel does not close the file.
   */
  $effect(() => {
    if (!session.isOpen || pinned) return;
    const onDown = (event: MouseEvent) => {
      if (!panelEl || panelEl.contains(event.target as Node)) return;
      requestClose();
    };
    globalThis.addEventListener("mousedown", onDown);
    return () => globalThis.removeEventListener("mousedown", onDown);
  });

  async function save(): Promise<void> {
    await session.save(ctx);
  }

  const autoSaving = $derived(autoSave && !readonly);

  /**
   * Text auto save watches. Keyed on the text rather than `doc.state`, because Reed's
   * background reconciliation replaces the state without an edit.
   */
  const draft = $derived(autoSaving ? (session.doc?.text() ?? null) : null);

  /**
   * Text whose auto save failed, and the document it belongs to. Retry only after another
   * edit so a failing server is not asked again every second. A conflict waits for a reload
   * instead. Another file, or the same file reopened, starts afresh.
   */
  let failedDraft = $state.raw<{ doc: EditorDocument; text: string } | null>(null);

  // Save once edits pause. Each edit changes `draft`, which restarts the timer. A save in
  // flight blocks scheduling, and edits made during it reschedule when it finishes.
  $effect(() => {
    const text = draft;
    const doc = session.doc;
    if (text === null || !doc) return;
    if (failedDraft?.doc === doc && failedDraft.text === text) return;
    if (!session.dirty || session.saving || session.conflict) return;
    const timer = setTimeout(async () => {
      // A save on close may have started since. This effect runs again when it finishes.
      if (session.saving) return;
      // A failure only counts against the document still open, not one closed meanwhile.
      if (!(await session.save(ctx)) && session.doc === doc) failedDraft = { doc, text };
    }, AUTO_SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  });

  /**
   * Whether closing is awaiting confirmation for unsaved changes. Keep the document open
   * until the user saves or discards those changes.
   */
  let confirmingClose = $state(false);

  /** Whether a save on close is running, so a second close request does not start another. */
  let savingToClose = false;

  /** Where a navigation held by {@link saveThenGo} goes, or null when none is held. */
  let heldNavigation: URL | null = null;

  /** Request closing, prompting first when the file has unsaved changes. */
  function requestClose(): void {
    if (!session.dirty) close();
    else if (autoSaving) void saveAndClose();
    else confirmingClose = true;
  }

  /** Save pending edits before closing. Ask as usual when the save fails. */
  async function saveAndClose(): Promise<void> {
    if (savingToClose) return;
    savingToClose = true;
    try {
      await saveThenClose();
    } finally {
      savingToClose = false;
    }
  }

  async function saveThenClose(): Promise<void> {
    const outcome = await session.flush(ctx);
    if (outcome === "saved") close();
    else if (outcome === "unsaved") confirmingClose = true;
  }

  // Opening another file, as a pinned panel allows from the board, would drop unsaved edits.
  // Auto save writes them first and asks only when that fails. Otherwise ask.
  $effect(() => {
    const guard = async (): Promise<boolean> => {
      if (autoSaving) {
        // When the file was closed or replaced meanwhile, nothing here is left to lose. The
        // session decides whether the click still opens its file.
        if ((await session.flush(ctx)) !== "unsaved") return true;
      }
      return globalThis.confirm(UNSAVED_LEAVE_PROMPT);
    };
    return session.setSwitchGuard(guard);
  });

  function close(): void {
    confirmingClose = false;
    session.close();
    onClose();
  }

  // Guard navigation and tab closing while a file has unsaved changes. Register once and read
  // the current file state when invoked. Navigation needs an immediate confirmation result.
  let disposed = false;
  const releaseNavigationGuard = untrack(() => routing.beforeNavigate((nav) => {
    if (disposed || !session.dirty) return;
    if (autoSaving) {
      // Within the app, hold a link or `goto` until the edits are saved, then go. Back and
      // forward and form posts cannot be replayed faithfully, so they ask as usual.
      if ((nav.type === "link" || nav.type === "goto") && nav.to && !nav.willUnload) {
        nav.cancel();
        void saveThenGo(nav.to.url);
        return;
      }
      if (nav.type === "leave") saveOnUnload();
    }
    guardUnsavedLeave(nav, session.dirty, () => globalThis.confirm(UNSAVED_LEAVE_PROMPT));
  }));
  onDestroy(() => {
    disposed = true;
    heldNavigation = null;
    releaseNavigationGuard?.();
  });

  /**
   * Send the edits while the browser asks about closing the tab, so staying keeps them.
   * Keepalive lets a small file's save finish even when the user leaves. A larger one can
   * still be cut off, which the browser's prompt still warns about.
   */
  function saveOnUnload(): void {
    if (session.saving || session.conflict) return;
    void session.save(ctx, { keepalive: true });
  }

  /**
   * Save pending edits, then follow the held navigation. Ask when the save fails. When the
   * file was closed or replaced meanwhile, follow it anyway, and the guard looks at whatever
   * file is open now.
   *
   * The driver replays the destination after saving. Router-specific navigation options
   * are not part of this shared guard contract.
   */
  async function saveThenGo(url: URL): Promise<void> {
    // One save at a time. A link clicked while it runs replaces the destination, so the last
    // one clicked is where the page goes, once.
    const saving = heldNavigation !== null;
    heldNavigation = url;
    if (saving) return;
    try {
      const result = await session.flush(ctx);
      if (disposed) return;
      if (result === "unsaved") {
        if (!globalThis.confirm(UNSAVED_LEAVE_PROMPT)) return;
        // Discard the edits as confirmed, so the guard lets the replayed navigation through.
        close();
      }
      url = heldNavigation;
    } finally {
      heldNavigation = null;
    }
    if (!disposed) await routing.navigate(url);
  }

  function onSurfaceKey(event: KeyboardEvent): boolean {
    if (!vimMode || !session.doc) return false;
    const result = handleVimKey(vim, event, session.doc, session.caret, readonly);
    if (!result) return false;
    vim = result.vim;
    session.caret = result.caret;
    session.anchor = result.anchor;
    // Stop keys claimed by Vim so Escape leaving insert mode cannot also close the editor.
    event.stopPropagation();
    return true;
  }

  function onPanelKey(event: KeyboardEvent): void {
    // Nothing typed at an open file is meant for the board behind it.
    event.stopPropagation();

    if ((event.ctrlKey || event.metaKey) && (event.key === "s" || event.key === "S")) {
      event.preventDefault();
      if (!readonly) void save();
      return;
    }
    // Escape requests closing when Vim has not claimed it. With unsaved changes, ask for
    // confirmation. A second Escape cancels that prompt.
    if (event.key === "Escape" && !(vimMode && vim.mode === "insert")) {
      event.preventDefault();
      if (confirmingClose) confirmingClose = false;
      else requestClose();
    }
  }

  /**
   * Clamp the rendered panel width to the viewport while preserving the requested width.
   * Restore that width when the viewport has room again.
   */
  const panelWidth = $derived(
    width === null
      ? "min(760px, 70vw)"
      : `clamp(${MIN_WIDTH}px, ${width}px, calc(100vw - ${EDGE_MARGIN}px))`,
  );

  /**
   * Pixels wide right now, whether that came from a drag or from the default. Bound rather
   * than measured on demand so the splitter can report it, and so a drag that starts from
   * the responsive default has a number to start from.
   */
  let panelPx = $state(0);
</script>

{#if session.isOpen}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    bind:this={panelEl}
    class={css({
      position: "absolute",
      top: "0",
      right: "0",
      bottom: "0",
      display: "flex",
      flexDirection: "column",
      zIndex: "60",
      background: "ink.white",
      borderLeft: "1px solid token(colors.neutral.border)",
    })}
    role="dialog"
    aria-label={`Editing ${session.file?.path ?? ""}`}
    onkeydown={onPanelKey}
    tabindex="-1"
    style:width={panelWidth}
    bind:clientWidth={panelPx}
  >
    <PanelResizeHandle
      bind:width
      measuredWidth={() => panelPx || panelEl?.getBoundingClientRect().width || 0}
      minWidth={MIN_WIDTH}
      keyStep={KEY_STEP}
    />

    <EditorPanelHeader {session} {readonly} bind:pinned onSave={save} onClose={requestClose} />

    <!-- Show the unsaved-changes question before error notices because it requires an answer. -->
    <EditorPanelNotices {session} {ctx} bind:confirmingClose onDiscard={close} />

    <!-- The text itself -->
    {#if session.loading}
      <div class={css({ padding: "10px", fontSize: "11.5px", color: "neutral.subtle" })}>
        Loading…
      </div>
    {:else if session.doc}
      <EditorSurface
        bind:this={surface}
        doc={session.doc}
        bind:caret={session.caret}
        bind:anchor={session.anchor}
        {mode}
        {readonly}
        onKeydown={onSurfaceKey}
      />
    {/if}

    <EditorStatusBar {session} {vimMode} {vim} />
  </div>
{/if}
