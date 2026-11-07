<script lang="ts">
  import { startDatasetView } from "$lib/backend/dataset-view.js";
  import { BackendError } from "$lib/backend/contract.js";
  import RefreshNotice from "../RefreshNotice.svelte";
  import BackendNotice from "../BackendNotice.svelte";
  import { onMount, onDestroy, tick, untrack } from "svelte";
  import type { BoardViewProps } from "./types.js";
  import { css } from "styled-system/css";
  import {
    type BoardArrivalParameter,
  } from "$lib/navigation.js";
  import { hasCommandModifier, isTypingTarget, runKeyBindings } from "./lib/board-keymap.js";
  import { boardKeyBindings } from "./lib/board-bindings.js";
  import { createBackendBoardPersistence } from "./lib/board-backend-persistence.js";
  import KozaneCanvas from "./components/KozaneCanvas.svelte";
  import { NamespaceState } from "./namespace-state.svelte.js";
  import { createNamespaceActions } from "./namespace-actions.svelte.js";
  import PartitionSidebar from "./components/PartitionSidebar.svelte";
  import FloatingControls from "./components/FloatingControls.svelte";
  import BoardControls from "./components/BoardControls.svelte";
  import BoardComposer from "./components/BoardComposer.svelte";
  import WarpPalette from "./components/WarpPalette.svelte";
  import InventoryDock from "./components/InventoryDock.svelte";
  import { createBackendInventoryActions } from "./lib/backend-inventory-actions.js";
  import type { InventoryDrag } from "./lib/inventory-drop.js";
  import { arrivalWarp, clearArrivalParams, readArrival } from "./lib/board-arrival.js";
  import { createBoardFiles } from "./lib/board-files.js";
  import { BoardWarps } from "./lib/board-warps.svelte.js";
  import { BoardView } from "./lib/board-view.svelte.js";
  import { PendingFrame } from "./lib/pending-frame.svelte.js";
  import { clampZoom } from "$lib/constants";
  import ErrorBanner from "./components/ErrorBanner.svelte";
  import { FileEditor, EditorSession } from "../editor/index.js";
  import FilePalette from "./components/FilePalette.svelte";
  import FileBrowser from "./components/FileBrowser.svelte";
  import type { FileManagementActions } from "./lib/file-management.js";
  import { InFlight } from "./lib/in-flight.js";
  import { bindViewWrites } from "./lib/view-writes.js";
  import { startSnapshotView, type SnapshotViewStatus } from "$lib/backend/snapshot-view.js";

  let { data, backend, lifetimeNotice, navigation, routing, preferences, readRouteUrl = () => null, initialDataApplied = false, retryIntervalMs, lifecycle, isHidden = () => false }: BoardViewProps = $props();

  // ── Reactive namespace state ────────────────────────────────────
  const s = new NamespaceState(untrack(() => preferences));
  // Use the same namespace-loading path as later navigation so layer restoration and other
  // initialization stay consistent.
  untrack(() => s.resetFromData(data));

  const readonly = $derived(!backend.capabilities.writable);
  let snapshotStatus = $state.raw<SnapshotViewStatus>(untrack(() => ({ current: initialDataApplied && backend.state.status === "ready", namespaceId: data.namespace.id, generation: backend.version.generation })));
  const editingBlocked = $derived(!readonly && (!snapshotStatus.current || snapshotStatus.namespaceId !== data.namespace.id || snapshotStatus.generation !== backend.version.generation));
  const mutationBackend = untrack(() => bindViewWrites(backend, () => !editingBlocked));
  let refreshAttempt = $state(0);
  let refreshFailed = $state(false);
  let filesRefreshFailed = $state(false);
  let appliedGeneration = untrack(() => backend.version.generation);
  let editorGeneration = $state(untrack(() => backend.version.generation));
  $effect(() => {
    const generation = snapshotStatus.generation;
    if (generation === editorGeneration) return;
    editorGeneration = generation;
    untrack(() => { editor.close(); frame.cancel(); warps.paletteOpen = false; warps.directory = []; filePaletteOpen = false; fileBrowserOpen = false; });
  });

  // ── UI state ──────────────────────────────────────────────────
  let sidebarsVisible = $state(untrack(() => data.uiConfig.defaultShowSidePanel));
  let showFooters = $state(untrack(() => data.uiConfig.defaultShowFooter));
  let zoom = $state(untrack(() => data.uiConfig.defaultZoom));
  // The file palette, opened from a selection. Unlike the warp palette it is up while
  // cards are selected, which is why the composer is told to stand down below.
  let filePaletteOpen = $state(false);
  // The three-column browser of scopes, taskspaces, and files, opened by its shortcut.
  let fileBrowserOpen = $state(false);
  // The single taskspace file currently open in the editor.
  const editor = new EditorSession();
  let active = true;
  let landingSequence = 0;
  onDestroy(() => { active = false; editor.close(); });
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

  // ── Canvas component ref (for getNewCardPosition) ─────────────
  let canvasComponent: ReturnType<typeof KozaneCanvas> = $state()!;
  let composerComponent: ReturnType<typeof BoardComposer> | undefined = $state();

  // Warp markers, the warp palette, and arrow-key navigation between warps.
  const warps = new BoardWarps(
    {
      s,
      readonly: untrack(() => readonly),
      backend: mutationBackend,
      navigation: () => navigation,
      navigate: (href) => routing.navigate(href),
      removeWarp: (warpId) => actions.handleRemoveWarp(warpId),
      canvas: () => canvasComponent,
    },
    untrack(() => ({
      visible: data.uiConfig.defaultShowWarps,
      directory: data.warpDirectory ?? [],
    })),
  );

  // ── Derived values ────────────────────────────────────────────
  const view = new BoardView(
    s,
    () => data,
    () => warps.directory,
  );

  // ── Reset on namespace navigation ───────────────────────────────
  let loadedNamespaceId = $state(untrack(() => data.namespace.id));
  let loadedData = $state.raw(untrack(() => data));

  $effect(() => {
    if (data === loadedData) return;
    loadedData = data;
    if (data.namespace.id !== loadedNamespaceId) {
      loadedNamespaceId = data.namespace.id;
      // Replace the warp directory only on namespace changes so same-namespace reloads
      // preserve palette updates. Older static exports may omit the directory.
      warps.directory = data.warpDirectory ?? [];
      s.resetFromData(data);
      newCardSeq = 0;
      sidebarsVisible = data.uiConfig.defaultShowSidePanel;
      showFooters = data.uiConfig.defaultShowFooter;
      warps.visible = data.uiConfig.defaultShowWarps;
      zoom = data.uiConfig.defaultZoom;
      // The route-arrival effect below recenters the existing canvas after this reset.
    } else {
      s.refreshFromData(data);
    }
  });

  /** The warp named by `?warp=`. Read only in the browser: prerendering has no query. */
  function warpFromUrl() {
    const url = readRouteUrl();
    return url ? arrivalWarp(navigation.readBoard(url), s.warps) : null;
  }

  const clearQuery = (...names: BoardArrivalParameter[]) => {
    const url = readRouteUrl();
    if (url) clearArrivalParams(url, names, navigation, (href) => routing.replace(href));
  };

  /**
   * Open a namespace at the requested warp or at its center. Do not reuse the previous
   * namespace's scroll offset when a warp is missing or navigation has no target.
   */
  function openViewOnNewNamespace() {
    const sequence = landingSequence;
    const target = untrack(warpFromUrl);
    if (!target) {
      tick().then(() => { if (active && sequence === landingSequence) canvasComponent.recenter(); });
      return;
    }
    warps.focus(target.id);
    tick().then(() => {
      if (!active || sequence !== landingSequence) return;
      canvasComponent.centerOn(target.posX, target.posY);
      clearQuery("warp");
    });
  }

  /**
   * Open the card named by `?card=` or the taskspace file named by `?taskspace=&path=`.
   * Remove those parameters after use, as with `?warp=`. See `readArrival`.
   */
  function openFromUrl() {
    const sequence = landingSequence;
    const url = readRouteUrl();
    if (!url) return;

    const { card, file, inventory, handled } = readArrival(
      navigation.readBoard(url),
      s,
      (taskspace) => backend.taskspaces?.access(s.namespaceId, taskspace).read ?? false,
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
    if (landing) tick().then(() => { if (active && sequence === landingSequence) canvasComponent.centerOn(landing.posX, landing.posY); });
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
  let handledNamespace = untrack(() => data.namespace.id);
  let handledHref = untrack(() => readRouteUrl()?.href ?? null);
  onMount(() => { mounted = true; });
  $effect(() => {
    const namespaceId = data.namespace.id;
    const url = readRouteUrl();
    const href = url?.href ?? null;
    if (!mounted || (namespaceId === handledNamespace && href === handledHref)) return;
    const changedNamespace = namespaceId !== handledNamespace;
    handledNamespace = namespaceId;
    handledHref = href;
    untrack(() => {
      const destination = url ? navigation.readBoard(url) : {};
      // Cosmetic cleanup must not cancel a landing already queued for this view.
      if (!changedNamespace && !destination.card && !destination.warp && !(destination.taskspace && destination.path)) return;
      landingSequence++;
      if (changedNamespace || destination.warp) openViewOnNewNamespace();
      openFromUrl();
    });
  });

  // Keep live subscriptions stable and read each static export namespace once.
  $effect(() => {
    const current = backend;
    const namespaceId = data.namespace.id;
    const applied = initialDataApplied;
    const attempt = refreshAttempt;
    const interval = retryIntervalMs;
    const wake = lifecycle;
    const hidden = isHidden;
    return untrack(() => startSnapshotView({
      backend: current,
      initialDataApplied: applied,
      refreshInitially: attempt > 0,
      retryIntervalMs: interval,
      lifecycle: wake,
      namespaceId: () => namespaceId,
      activities: [positionActivity, s.mutations],
      apply: (snapshot) => {
        if (appliedGeneration !== current.version.generation) { s.resetFromData(snapshot); appliedGeneration = current.version.generation; }
        else s.refreshFromData(snapshot);
      },
      status: (value) => { snapshotStatus = value; },
      error: () => { if (attempt === refreshAttempt) refreshFailed = true; },
      refreshed: () => { if (attempt === refreshAttempt) refreshFailed = false; },
      isHidden: hidden,
    }));
  });

  // ── Domain action handlers ────────────────────────────────────
  const actions = createNamespaceActions(s, mutationBackend);

  // Persist optimistic canvas and composer edits. Return success so callers can roll back
  // failed saves.
  const persistence = createBackendBoardPersistence(s, mutationBackend);

  const inventoryActions = createBackendInventoryActions(s, mutationBackend);

  /** The drag the canvas reports, for slot highlighting and the preview of a stored card. */
  let inventoryDrag = $state<InventoryDrag>({
    target: null,
    cardId: null,
    carriedCardId: null,
    pointer: null,
  });

  function handleComposerSubmit(id: string | null, content: string, partitionId: string) {
    return persistence.submitComposer(id, content, partitionId, () =>
      canvasComponent.getNewCardPosition(newCardSeq++),
    );
  }

  /** An Alt-drawn rectangle awaiting a scope from the prompt. */
  const frame = new PendingFrame({
    cardIdsIn: (rect) => canvasComponent.cardIdsInWorldRect(rect),
    addToScope: actions.handleCreateScopeArea,
    addToNewScope: actions.handleCreateScopeWithArea,
  });
  $effect(() => frame.measure());

  /** Shows the card's resize handle, or takes it away when it is the one already showing. */
  function handleResizeToggle(cardId: string) {
    s.selection.resizingCardId = s.selection.resizingCardId === cardId ? null : cardId;
  }

  const editorContext = $derived({
    canWrite: () => !readonly && !editingBlocked,
    backend,
    namespaceId: s.namespaceId,
  });

  $effect(() => {
    const current = backend, tree = s.taskspaceTree, context = editorContext;
    const attempt = refreshAttempt, interval = retryIntervalMs, wake = lifecycle, hidden = isHidden;
    if (!current.capabilities.externalWrites || !current.taskspaces) return;
    return untrack(() => {
      let active = true;
      const generation = current.version.generation;
      const stop = startDatasetView({
        backend: current, dataset: "snapshot", retryIntervalMs: interval, lifecycle: wake, isHidden: hidden,
        read: async (isCurrent) => {
          const ok = await tree.refreshWatched(context, () => active && current.version.generation === generation && isCurrent());
          if (!ok) throw new BackendError("unavailable", "Could not refresh files");
        },
        apply: () => { if (attempt === refreshAttempt) filesRefreshFailed = false; },
        error: () => { if (attempt === refreshAttempt) filesRefreshFailed = true; },
      });
      return () => { active = false; stop(); };
    });
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
    boardKeyBindings(data.uiConfig, {
      readonly,
      hasPendingFrame: () => frame.rect !== null,
      noSelection,
      hasFocusedWarp: () => s.focusedWarpId !== null,
      dismissPendingFrame: () => frame.cancel(),
      focusComposer: () => {
        s.selection.composerCard = null;
        s.selection.selectedCards = new Set();
        s.selection.primarySelectedId = null;
        tick().then(() => { if (active) composerComponent?.focusInput(); });
      },
      toggleFooters: () => (showFooters = !showFooters),
      togglePanels: () => (sidebarsVisible = !sidebarsVisible),
      toggleWarps: () => (warps.visible = !warps.visible),
      openWarpPalette: () => warps.openPalette(),
      warpToward: (key) => warps.toward(key),
      setWarpHere: () => {
        // A warp you cannot see is a warp you cannot remove, so setting one reveals them.
        warps.visible = true;
        void actions.handleSetWarp(canvasComponent.getWarpPosition());
      },
      removeFocusedWarp: () => {
        if (s.focusedWarpId) void actions.handleRemoveWarp(s.focusedWarpId);
      },
      // Place under the pointer or at the view center, using the warp placement rule.
      addInventoryHere: () => void inventoryActions.add(canvasComponent.getWarpPosition()),
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
</script>

<svelte:head>
  <title>{data.namespace.name}</title>
</svelte:head>

<svelte:window onkeydown={handleKeydown} />
<BackendNotice capabilities={backend.capabilities} {lifetimeNotice} floating />
<RefreshNotice {backend} failed={refreshFailed || filesRefreshFailed} message={filesRefreshFailed ? "Could not refresh files. Showing the last listings." : "Could not refresh the board. Showing the last board."} retry={() => refreshAttempt++} floating />

{#if editingBlocked}
  <p role="status" class={css({ position: "fixed", top: "12px", left: "50%", zIndex: 1000, padding: "8px 12px", backgroundColor: "ink.white", color: "ink.black", fontSize: "12px" })}>Board editing is paused while current data loads.</p>
{/if}
{#key snapshotStatus.generation}
<fieldset disabled={editingBlocked} inert={editingBlocked} aria-busy={editingBlocked}
  onkeydowncapture={blockEditing} onclickcapture={blockEditing} onmousedowncapture={blockEditing} onpointerdowncapture={blockEditing}
  class={css({ border: "0", margin: "0", padding: "0", minWidth: "0" })}>
<div class={css({ display: "flex", height: "100vh", overflow: "hidden", position: "relative", backgroundColor: "ink.lighter" })}>
  <PartitionSidebar
    namespacesHref={navigation.namespaces()}
    visible={sidebarsVisible}
    panelWidth={data.uiConfig.leftPanelWidth}
    cards={s.cards}
    partitions={view.partitions}
    bind:activePartition={s.sidebar.activePartition}
    bind:newPartitionName={s.sidebar.newPartitionName}
    onCreatePartition={actions.handleCreatePartition}
    onDeletePartition={actions.handleDeletePartition}
    {readonly}
  />

  <div class={css({ flex: "1", display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" })}>
    <KozaneCanvas
      bind:this={canvasComponent}
      bind:cards={s.cards}
      visibleCards={view.visibleCards}
      glueRels={s.glueRels}
      layers={s.layers}
      activeLayerId={s.activeLayerId}
      partitionColorById={view.partitionColorById}
      selection={s.selection}
      scopeCardIds={view.scopeCardIds}
      bind:scopeAreas={s.scopeAreas}
      scopeNameById={view.scopeNameById}
      activeScopeId={s.sidebar.activeScope}
      taskspaces={s.taskspaces}
      taskspaceTree={s.taskspaceTree}
      treeContext={editorContext}
      onOpenFile={s.taskspaces.some(taskspace => backend.taskspaces?.access(s.namespaceId, taskspace).read) ? files.openFromFrame : undefined}
      onCreateTaskspace={readonly ? undefined : actions.createTaskspace}
      bind:pendingScopeAreaRect={frame.rect}
      onPersistScopeArea={persistence.persistScopeArea}
      onRemoveScopeArea={actions.handleDeleteScopeArea}
      onScopeMembershipChange={actions.handleScopeMembershipChange}
      bind:warps={s.warps}
      focusedWarpId={s.focusedWarpId}
      warpsVisible={warps.visible}
      warpMarkerSize={data.uiConfig.warpMarkerSize}
      initialCenter={initialWarp && { posX: initialWarp.posX, posY: initialWarp.posY }}
      onFocusWarp={(warpId) => warps.focus(warpId)}
      onPersistWarpPosition={persistence.persistWarpPosition}
      bind:inventories={s.inventories}
      openInventoryIds={s.openInventoryIds}
      inventoryLabel={view.inventoryLabel}
      onToggleInventory={inventoryActions.toggle}
      onPersistInventoryPosition={inventoryActions.persistPosition}
      onStow={inventoryActions.stow}
      onTake={inventoryActions.take}
      bind:inventoryDrag
      {showFooters}
      bind:zoom
      zoomStep={data.uiConfig.zoomStep}
      canvasWidth={data.uiConfig.canvasWidth}
      canvasHeight={data.uiConfig.canvasHeight}
      cardWidth={data.uiConfig.defaultCardWidth}
      newCardPlacement={data.uiConfig.newCardPlacement}
      fontSize={data.uiConfig.defaultFontSize}
      fontFamily={data.uiConfig.defaultFontFamily}
      onPersistPositions={persistence.persistPositions}
      onPersistWidth={persistence.persistWidth}
      onPositionActivityStart={() => positionActivity.begin()}
      onPositionActivityEnd={() => positionActivity.end()}
      onError={(msg) => (s.lastError = msg)}
      tagHref={(tag) => navigation.tags({ namespaceId: data.namespace.id, tag })}
      {readonly}
    />

    <InventoryDock
      {s}
      {inventoryActions}
      inventoryLabel={view.inventoryLabel}
      {inventoryDrag}
      {zoom}
      fontFamily={data.uiConfig.defaultFontFamily}
      {readonly}
      onCardMouseDown={(e, cardId) => canvasComponent.pressStowedCard(e, cardId)}
      leftInset={sidebarsVisible ? data.uiConfig.leftPanelWidth : 0}
    />

    {#if filePaletteOpen}
    <FilePalette
      scopes={s.scopes}
      scopeRels={s.scopeRels}
      taskspaces={s.taskspaces}
      selectedCards={s.selection.selectedCards}
      tree={s.taskspaceTree}
      ctx={editorContext}
      {readonly}
      onOpenFile={files.openFromPalette}
      onLinkScope={actions.handleLinkScope}
      onCreate={files.createFromPalette}
      onClose={() => (filePaletteOpen = false)}
    />
  {/if}

  {#if fileBrowserOpen}
    <FileBrowser
      scopes={s.scopes}
      taskspaces={s.taskspaces}
      tree={s.taskspaceTree}
      ctx={editorContext}
      {readonly}
      editorFile={editor.file}
      initialScopeId={s.sidebar.activeScope}
      actions={fileActions}
      onOpenFile={files.openFromPalette}
      onClose={() => (fileBrowserOpen = false)}
    />
  {/if}

  {#if warps.paletteOpen}
      <WarpPalette
        entries={view.warpEntries}
        focusedWarpId={s.focusedWarpId}
        {readonly}
        onJump={(entry) => warps.jump(entry)}
        onDelete={(entry) => warps.remove(entry)}
        onClose={() => (warps.paletteOpen = false)}
      />
    {/if}

    {#if s.lastError}
      <ErrorBanner message={s.lastError} onDismiss={() => (s.lastError = null)} />
    {/if}

    <BoardControls
      {s}
      {actions}
      showScopeControl={data.uiConfig.showScopeControl}
      showLayerControl={data.uiConfig.showLayerControl}
      showSidePanelToggle={data.uiConfig.showSidePanelToggle}
      bind:sidebarsVisible
      {readonly}
    />

    <FloatingControls
      {zoom}
      zoomStep={data.uiConfig.zoomStep}
      showZoom={data.uiConfig.showZoomControl}
      onZoom={(delta) => (zoom = clampZoom(zoom + delta))}
    />

    {#if !readonly}
      <BoardComposer
        bind:this={composerComponent}
        {s}
        {actions}
        hasPendingFrame={frame.rect !== null}
        pendingFrameCardCount={frame.cardCount}
        onChooseScope={(scopeId) => frame.chooseScope(scopeId)}
        onCreateScope={(name) => frame.createScope(name)}
        onCancelFrame={() => frame.cancel()}
        partitions={view.partitions}
        defaultPartitionId={view.defaultPartitionId}
        otherNamespaces={data.otherNamespaces}
        onSubmit={handleComposerSubmit}
        onResizeToggle={handleResizeToggle}
        onOpenFilePalette={() => (filePaletteOpen = true)}
        {filePaletteOpen}
        newCardTarget={view.receivingInventory && view.inventoryLabel(view.receivingInventory)}
        shortcuts={data.uiConfig}
      />
    {/if}
  </div>

  <FileEditor
    {routing}
    session={editor}
    ctx={editorContext}
    vimMode={data.uiConfig.editorVimMode}
    autoSave={data.uiConfig.editorAutoSave}
    readonly={readonly || editingBlocked}
    bind:width={editorWidth}
    bind:pinned={editorPinned}
    onClose={() => undefined}
  />
</div>

</fieldset>
{/key}
