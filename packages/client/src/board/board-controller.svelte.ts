import type { BoardViewProps } from "./types.js";
import { startBoardFileRefresh } from "./lib/board-file-refresh.js";
import { onMount, onDestroy, tick, untrack } from "svelte";
import { type BoardArrivalParameter } from "../navigation.js";
import { hasCommandModifier, isTypingTarget, runKeyBindings } from "./lib/board-keymap.js";
import { boardKeyBindings } from "./lib/board-bindings.js";
import { createClientBoardPersistence } from "./lib/board-backend-persistence.js";
import { NamespaceState } from "./namespace-state.svelte.js";
import { createNamespaceActions } from "./namespace-actions.svelte.js";
import { createClientInventoryActions } from "./lib/backend-inventory-actions.js";
import type { InventoryDrag } from "./lib/inventory-drop.js";
import { arrivalWarp, clearArrivalParams, readArrival } from "./lib/board-arrival.js";
import { createBoardFiles } from "./lib/board-files.js";
import { BoardWarps } from "./lib/board-warps.svelte.js";
import { BoardView } from "./lib/board-view.svelte.js";
import { PendingFrame } from "./lib/pending-frame.svelte.js";
import { EditorSession } from "../editor/index.js";
import type { FileManagementActions } from "./lib/file-management.js";
import { InFlight } from "./lib/in-flight.js";
import { bindViewWrites } from "./lib/view-writes.js";
import { startSnapshotView, type SnapshotViewStatus } from "../client/snapshot-view.js";
import type { WarpCanvas } from "./lib/board-warps.svelte.js";
import type { BoardPoint } from "../host-types.js";
import type { WorldRect } from "./lib/namespace-page.js";

/** DOM actions borrowed from the mounted canvas, without a component dependency. */
export interface BoardCanvasPort extends WarpCanvas {
  recenter(): void;
  getNewCardPosition(sequence: number): BoardPoint;
  getWarpPosition(): BoardPoint;
  cardIdsInWorldRect(rect: WorldRect): string[];
}
export interface BoardControllerOptions extends Omit<
  BoardViewProps,
  "lifetimeNotice" | "readRouteUrl" | "initialDataApplied" | "isHidden"
> {
  readRouteUrl: () => URL | null;
  initialDataApplied: boolean;
  isHidden: () => boolean;
  canvas: () => BoardCanvasPort;
  composer: () => { focusInput(): void } | undefined;
}
/** Create during component initialization. Effects and cleanup belong to that view. */
export function createBoardController(options: BoardControllerOptions) {
  // ── Reactive namespace state ────────────────────────────────────
  const s = new NamespaceState(untrack(() => options.preferences));
  // Use the same namespace-loading path as later navigation so layer restoration and other
  // initialization stay consistent.
  untrack(() => s.resetFromData(options.data));
  const readonly = $derived(!options.backend.capabilities.writable);
  let snapshotStatus = $state.raw<SnapshotViewStatus>(
    untrack(() => ({
      current: options.initialDataApplied && options.backend.state.status === "ready",
      namespaceId: options.data.namespace.id,
      generation: options.backend.version.generation,
    })),
  );
  const editingBlocked = $derived(
    !readonly &&
      (!snapshotStatus.current ||
        snapshotStatus.namespaceId !== options.data.namespace.id ||
        snapshotStatus.generation !== options.backend.version.generation),
  );
  const mutationClient = untrack(() =>
    bindViewWrites(options.backend, () => active && !editingBlocked),
  );
  let refreshAttempt = $state(0);
  let refreshFailed = $state(false);
  let filesRefreshFailed = $state(false);
  let appliedGeneration = untrack(() => options.backend.version.generation);
  let editorGeneration = $state(untrack(() => options.backend.version.generation));
  $effect(() => {
    const generation = snapshotStatus.generation;
    if (generation === editorGeneration) return;
    editorGeneration = generation;
    untrack(() => {
      editor.close();
      frame.cancel();
      warps.paletteOpen = false;
      warps.directory = [];
      filePaletteOpen = false;
      fileBrowserOpen = false;
    });
  });
  // ── UI state ──────────────────────────────────────────────────
  let sidebarsVisible = $state(untrack(() => options.data.uiConfig.defaultShowSidePanel));
  let showFooters = $state(untrack(() => options.data.uiConfig.defaultShowFooter));
  let zoom = $state(untrack(() => options.data.uiConfig.defaultZoom));
  // The file palette, opened from a selection. Unlike the warp palette it is up while
  // cards are selected, which is why the composer is told to stand down below.
  let filePaletteOpen = $state(false);
  // The three-column browser of scopes, taskspaces, and files, opened by its shortcut.
  let fileBrowserOpen = $state(false);
  // The single taskspace file currently open in the editor.
  const editor = new EditorSession();
  let active = true;
  let landingSequence = 0;
  onDestroy(() => {
    active = false;
    editor.close();
  });
  // Keep the dragged panel width on the page so it survives closing a file. Null uses the
  // responsive default. Reloading resets it.
  let editorWidth = $state<number | null>(null);
  // Whether the editor stays open on a click outside it. Kept here for the same reason.
  let editorPinned = $state(false);
  let newCardSeq = 0;
  // Track the drag and its save separately from requests so polling pauses before the final
  // PATCH begins.
  const positionActivity = new InFlight();
  /**
   * Whether board shortcuts may handle keys shared with the composer's selection actions.
   */
  const noSelection = () => s.selection.selectedCards.size === 0;
  // Warp markers, the warp palette, and arrow-key navigation between warps.
  const warps = new BoardWarps(
    {
      s,
      readonly: untrack(() => readonly),
      backend: mutationClient,
      navigation: () => options.navigation,
      navigate: (href) => options.routing.navigate(href),
      removeWarp: (warpId) => actions.handleRemoveWarp(warpId),
      canvas: () => options.canvas(),
    },
    untrack(() => ({
      visible: options.data.uiConfig.defaultShowWarps,
      directory: options.data.warpDirectory ?? [],
    })),
  );
  // ── Derived values ────────────────────────────────────────────
  const view = new BoardView(
    s,
    () => options.data,
    () => warps.directory,
  );
  // ── Reset on namespace navigation ───────────────────────────────
  let loadedNamespaceId = $state(untrack(() => options.data.namespace.id));
  let loadedData = $state.raw(untrack(() => options.data));
  $effect(() => {
    if (options.data === loadedData) return;
    loadedData = options.data;
    if (options.data.namespace.id !== loadedNamespaceId) {
      loadedNamespaceId = options.data.namespace.id;
      // Replace the warp directory only on namespace changes so same-namespace reloads
      // preserve palette updates. Older static exports may omit the directory.
      warps.directory = options.data.warpDirectory ?? [];
      s.resetFromData(options.data);
      newCardSeq = 0;
      sidebarsVisible = options.data.uiConfig.defaultShowSidePanel;
      showFooters = options.data.uiConfig.defaultShowFooter;
      warps.visible = options.data.uiConfig.defaultShowWarps;
      zoom = options.data.uiConfig.defaultZoom;
      // The route-arrival effect below recenters the existing canvas after this reset.
    } else {
      s.refreshFromData(options.data);
    }
  });
  /** The warp named by `?warp=`. Read only in the browser: prerendering has no query. */
  function warpFromUrl() {
    const url = options.readRouteUrl();
    return url ? arrivalWarp(options.navigation.readBoard(url), s.warps) : null;
  }
  const clearQuery = (...names: BoardArrivalParameter[]) => {
    const url = options.readRouteUrl();
    if (url)
      clearArrivalParams(url, names, options.navigation, (href) => options.routing.replace(href));
  };
  /**
   * Open a namespace at the requested warp or at its center. Do not reuse the previous
   * namespace's scroll offset when a warp is missing or navigation has no target.
   */
  function openViewOnNewNamespace() {
    const sequence = landingSequence;
    const target = untrack(warpFromUrl);
    if (!target) {
      tick().then(() => {
        if (active && sequence === landingSequence) options.canvas().recenter();
      });
      return;
    }
    warps.focus(target.id);
    tick().then(() => {
      if (!active || sequence !== landingSequence) return;
      options.canvas().centerOn(target.posX, target.posY);
      clearQuery("warp");
    });
  }
  /**
   * Open the card named by `?card=` or the taskspace file named by `?taskspace=&path=`.
   * Remove those parameters after use, as with `?warp=`. See `readArrival`.
   */
  function openFromUrl() {
    const sequence = landingSequence;
    const url = options.readRouteUrl();
    if (!url) return;
    const { card, file, inventory, handled } = readArrival(
      options.navigation.readBoard(url),
      s,
      (taskspace) => options.backend.taskspaces?.access(s.namespaceId, taskspace).read ?? false,
    );
    if (file) {
      const { taskspace, path } = file;
      files.open(taskspace.id, taskspace.name, path);
    }
    // Select the card as well as centring it so the matched card is clear on a dense board.
    // Skip selection in read-only exports, where it cannot be cleared.
    if (card && !readonly) {
      s.selection.selectedCards = new Set([card.id]);
      s.selection.primarySelectedId = card.id;
    }
    if (handled.length > 0) clearQuery(...handled);
    // Open the grid of the inventory holding a stored card, to show the card there.
    if (inventory) s.openInventoryIds = new Set([...s.openInventoryIds, inventory.id]);
    const landing = inventory ?? card;
    // The pan is the one part that has to wait for the canvas to exist. It changes nothing on
    // the URL, so it is free to happen after the clear above.
    if (landing)
      tick().then(() => {
        if (active && sequence === landingSequence)
          options.canvas().centerOn(landing.posX, landing.posY);
      });
  }
  // Remember the layer being worked on, so a reload comes back to it instead of to Base.
  $effect(() => s.rememberActiveLayer());
  // Resolved before the canvas mounts, so a page loaded with `?warp=` opens on the warp
  // instead of scrolling to it once the middle of the board has already been painted.
  const initialWarp = untrack(warpFromUrl);
  if (initialWarp) untrack(() => warps.focus(initialWarp.id));
  onMount(() => {
    if (initialWarp) clearQuery("warp");
    // After the warp landing above, so a link carrying both ends on the card it named.
    openFromUrl();
  });
  let mounted = $state(false);
  let handledNamespace = untrack(() => options.data.namespace.id);
  let handledHref = untrack(() => options.readRouteUrl()?.href ?? null);
  onMount(() => {
    mounted = true;
  });
  $effect(() => {
    const namespaceId = options.data.namespace.id;
    const url = options.readRouteUrl();
    const href = url?.href ?? null;
    if (!mounted || (namespaceId === handledNamespace && href === handledHref)) return;
    const changedNamespace = namespaceId !== handledNamespace;
    handledNamespace = namespaceId;
    handledHref = href;
    untrack(() => {
      const destination = url ? options.navigation.readBoard(url) : {};
      // Cosmetic cleanup must not cancel a landing already queued for this view.
      if (
        !changedNamespace &&
        !destination.card &&
        !destination.warp &&
        !(destination.taskspace && destination.path)
      )
        return;
      landingSequence++;
      if (changedNamespace || destination.warp) openViewOnNewNamespace();
      openFromUrl();
    });
  });
  // Keep live subscriptions stable and read each static export namespace once.
  $effect(() => {
    const current = options.backend;
    const namespaceId = options.data.namespace.id;
    const applied = options.initialDataApplied;
    const attempt = refreshAttempt;
    const interval = options.retryIntervalMs;
    const wake = options.lifecycle;
    const hidden = options.isHidden;
    return untrack(() =>
      startSnapshotView({
        backend: current,
        initialDataApplied: applied,
        refreshInitially: attempt > 0,
        retryIntervalMs: interval,
        lifecycle: wake,
        namespaceId: () => namespaceId,
        activities: [positionActivity, s.mutations],
        apply: (snapshot) => {
          if (appliedGeneration !== current.version.generation) {
            s.resetFromData(snapshot);
            appliedGeneration = current.version.generation;
          } else s.refreshFromData(snapshot);
        },
        status: (value) => {
          snapshotStatus = value;
        },
        error: () => {
          if (attempt === refreshAttempt) refreshFailed = true;
        },
        refreshed: () => {
          if (attempt === refreshAttempt) refreshFailed = false;
        },
        isHidden: hidden,
      }),
    );
  });
  // ── Domain action handlers ────────────────────────────────────
  const actions = createNamespaceActions(s, mutationClient);
  // Persist optimistic canvas and composer edits. Return success so callers can roll back
  // failed saves.
  const persistence = createClientBoardPersistence(s, mutationClient);
  const inventoryActions = createClientInventoryActions(s, mutationClient);
  /** The drag the canvas reports, for slot highlighting and the preview of a stored card. */
  let inventoryDrag = $state<InventoryDrag>({
    target: null,
    cardId: null,
    carriedCardId: null,
    pointer: null,
  });
  function handleComposerSubmit(id: string | null, content: string, partitionId: string) {
    return persistence.submitComposer(id, content, partitionId, () =>
      options.canvas().getNewCardPosition(newCardSeq++),
    );
  }
  /** An Alt-drawn rectangle awaiting a scope from the prompt. */
  const frame = new PendingFrame({
    cardIdsIn: (rect) => options.canvas().cardIdsInWorldRect(rect),
    addToScope: actions.handleCreateScopeArea,
    addToNewScope: actions.handleCreateScopeWithArea,
  });
  $effect(() => frame.measure());
  /** Shows the card's resize handle, or takes it away when it is the one already showing. */
  function handleResizeToggle(cardId: string) {
    s.selection.resizingCardId = s.selection.resizingCardId === cardId ? null : cardId;
  }
  const editorContext = $derived({
    canWrite: () => active && !readonly && !editingBlocked,
    backend: options.backend,
    namespaceId: s.namespaceId,
  });
  $effect(() => {
    const current = options.backend,
      tree = s.taskspaceTree,
      context = editorContext;
    const attempt = refreshAttempt,
      interval = options.retryIntervalMs,
      wake = options.lifecycle,
      hidden = options.isHidden;
    if (!current.capabilities.externalWrites || !current.taskspaces) return;
    return untrack(() =>
      startBoardFileRefresh({
        client: current,
        context,
        tree,
        retryIntervalMs: interval,
        lifecycle: wake,
        isHidden: hidden,
        refreshed: () => {
          if (attempt === refreshAttempt) filesRefreshFailed = false;
        },
        error: () => {
          if (attempt === refreshAttempt) filesRefreshFailed = true;
        },
      }),
    );
  });
  /** What the file browser changes. */
  const fileActions: FileManagementActions = {
    createScope: actions.createScope,
    renameScope: actions.renameScope,
    removeScope: actions.removeScope,
    createTaskspace: actions.createTaskspace,
    renameTaskspace: async (taskspaceId, name) => {
      const failed = await actions.renameTaskspace(taskspaceId, name);
      // Keep the open file's title in step with its taskspace.
      if (!failed && editor.file?.taskspaceId === taskspaceId)
        editor.file = { ...editor.file, taskspaceName: name.trim() };
      return failed;
    },
    deleteTaskspace: actions.deleteTaskspace,
  };
  const files = createBoardFiles({
    s,
    editor,
    context: () => editorContext,
    closeFilePalette: () => {
      filePaletteOpen = false;
      fileBrowserOpen = false;
    },
    createScopeWithFile: actions.handleCreateScopeWithFile,
  });
  /**
   * Derive keyboard bindings from the current namespace configuration.
   * `lib/board-bindings.ts` defines their order.
   */
  const keyBindings = $derived(
    boardKeyBindings(options.data.uiConfig, {
      readonly,
      hasPendingFrame: () => frame.rect !== null,
      noSelection,
      hasFocusedWarp: () => s.focusedWarpId !== null,
      dismissPendingFrame: () => frame.cancel(),
      focusComposer: () => {
        s.selection.composerCard = null;
        s.selection.selectedCards = new Set();
        s.selection.primarySelectedId = null;
        tick().then(() => {
          if (active) options.composer()?.focusInput();
        });
      },
      toggleFooters: () => (showFooters = !showFooters),
      togglePanels: () => (sidebarsVisible = !sidebarsVisible),
      toggleWarps: () => (warps.visible = !warps.visible),
      openWarpPalette: () => warps.openPalette(),
      warpToward: (key) => warps.toward(key),
      setWarpHere: () => {
        // A warp you cannot see is a warp you cannot remove, so setting one reveals them.
        warps.visible = true;
        void actions.handleSetWarp(options.canvas().getWarpPosition());
      },
      removeFocusedWarp: () => {
        if (s.focusedWarpId) void actions.handleRemoveWarp(s.focusedWarpId);
      },
      // Place under the pointer or at the view center, using the warp placement rule.
      addInventoryHere: () => void inventoryActions.add(options.canvas().getWarpPosition()),
      openFileBrowser: () => (fileBrowserOpen = true),
    }),
  );
  function handleKeydown(e: KeyboardEvent) {
    if (editingBlocked) return;
    // Apply keyboard ownership gates before resolving shortcuts. Open palettes own all keys,
    // including their close shortcut.
    if (warps.paletteOpen) return;
    if (filePaletteOpen) return;
    if (fileBrowserOpen) return;
    // An open editor owns the keyboard even when focus is on panel controls that do not stop
    // propagation. A pinned one is left open while the board is used, so the board keeps its
    // shortcuts. Keys typed in the panel never reach here, because the panel stops them.
    if (editor.isOpen && !editorPinned) return;
    // Ignore repeated keydown events because shortcuts perform discrete actions, including
    // creating warp markers.
    if (e.repeat) return;
    if (isTypingTarget(e.target)) return;
    if (hasCommandModifier(e)) return;
    runKeyBindings(e, keyBindings);
  }
  function blockEditing(event: Event) {
    if (!editingBlocked) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  return {
    s,
    warps,
    view,
    editor,
    frame,
    actions,
    persistence,
    inventoryActions,
    fileActions,
    files,
    initialWarp,
    positionActivity,
    handleComposerSubmit,
    handleResizeToggle,
    handleKeydown,
    blockEditing,
    get readonly() {
      return readonly;
    },
    get editingBlocked() {
      return editingBlocked;
    },
    get snapshotStatus() {
      return snapshotStatus;
    },
    get refreshFailed() {
      return refreshFailed;
    },
    get filesRefreshFailed() {
      return filesRefreshFailed;
    },
    get editorContext() {
      return editorContext;
    },
    get sidebarsVisible() {
      return sidebarsVisible;
    },
    set sidebarsVisible(value: boolean) {
      sidebarsVisible = value;
    },
    get showFooters() {
      return showFooters;
    },
    set showFooters(value: boolean) {
      showFooters = value;
    },
    get zoom() {
      return zoom;
    },
    set zoom(value: number) {
      zoom = value;
    },
    get filePaletteOpen() {
      return filePaletteOpen;
    },
    set filePaletteOpen(value: boolean) {
      filePaletteOpen = value;
    },
    get fileBrowserOpen() {
      return fileBrowserOpen;
    },
    set fileBrowserOpen(value: boolean) {
      fileBrowserOpen = value;
    },
    get editorWidth() {
      return editorWidth;
    },
    set editorWidth(value: number | null) {
      editorWidth = value;
    },
    get editorPinned() {
      return editorPinned;
    },
    set editorPinned(value: boolean) {
      editorPinned = value;
    },
    get inventoryDrag() {
      return inventoryDrag;
    },
    set inventoryDrag(value: InventoryDrag) {
      inventoryDrag = value;
    },
    retry() {
      refreshAttempt++;
    },
  };
}
