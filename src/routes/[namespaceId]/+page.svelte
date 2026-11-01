<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import type { PageProps } from "./$types";
  import { css } from "styled-system/css";
  import { base } from "$app/paths";
  import { browser } from "$app/environment";
  import { page } from "$app/state";
  import { hasCommandModifier, isTypingTarget, runKeyBindings } from "./lib/board-keymap.js";
  import { boardKeyBindings } from "./lib/board-bindings.js";
  import { createBoardPersistence } from "./lib/board-persistence.js";
  import { NamespaceState, storeActiveLayerId } from "./namespace-state.svelte.js";
  import { createNamespaceActions } from "./namespace-actions.svelte.js";
  import PartitionSidebar from "./components/PartitionSidebar.svelte";
  import ScopeSidebar from "./components/ScopeSidebar.svelte";
  import KozaneCanvas from "./components/KozaneCanvas.svelte";
  import FloatingControls from "./components/FloatingControls.svelte";
  import BoardControls from "./components/BoardControls.svelte";
  import BoardComposer from "./components/BoardComposer.svelte";
  import WarpPalette from "./components/WarpPalette.svelte";
  import InventoryDock from "./components/InventoryDock.svelte";
  import { createInventoryActions } from "./lib/inventory-actions.js";
  import type { InventoryDrag } from "./lib/inventory-drop.js";
  import { arrivalWarp, clearArrivalParams, readArrival } from "./lib/board-arrival.js";
  import { createBoardFiles } from "./lib/board-files.js";
  import { BoardWarps } from "./lib/board-warps.svelte.js";
  import { BoardView } from "./lib/board-view.svelte.js";
  import { PendingFrame } from "./lib/pending-frame.svelte.js";
  import { clampZoom } from "$lib/constants";
  import ErrorBanner from "./components/ErrorBanner.svelte";
  import FileEditor from "./components/FileEditor.svelte";
  import FilePalette from "./components/FilePalette.svelte";
  import FileBrowser from "./components/FileBrowser.svelte";
  import { EditorSession } from "./lib/editor/editor-session.svelte.js";
  import { InFlight } from "./lib/in-flight.js";
  import { startSnapshotPoll } from "./lib/snapshot-poll.js";

  let { data }: PageProps = $props();

  // Static exports have no mutation endpoints. Disable editing controls and live polling for
  // the entire build.
  const readonly = untrack(() => data.readonly);
  // Use embedded file trees when the static export includes them. Derive these from current
  // page data because namespace navigation reuses the component. Without an embedded tree,
  // readonly taskspaces remain non-expandable.
  const staticFiles = $derived(data.taskspaceFiles);

  // ── Reactive namespace state ────────────────────────────────────
  const s = new NamespaceState();
  s.fetcher = fetch;
  // Use the same namespace-loading path as later navigation so layer restoration and other
  // initialization stay consistent.
  untrack(() => s.resetFromData(data));

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
      readonly,
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
      // Cross-namespace navigation reuses this component, so land here without waiting for
      // the canvas to remount.
      openViewOnNewNamespace();
    } else {
      s.refreshFromData(data);
    }
  });

  /** The warp named by `?warp=`. Read only in the browser: prerendering has no query. */
  function warpFromUrl() {
    return browser ? arrivalWarp(page.url.searchParams, s.warps) : null;
  }

  const clearQuery = (...names: string[]) => clearArrivalParams(page.url, names);

  /**
   * Open a namespace at the requested warp or at its center. Do not reuse the previous
   * namespace's scroll offset when a warp is missing or navigation has no target.
   */
  function openViewOnNewNamespace() {
    const target = untrack(warpFromUrl);
    if (!target) {
      tick().then(() => canvasComponent.recenter());
      return;
    }
    warps.focus(target.id);
    tick().then(() => {
      canvasComponent.centerOn(target.posX, target.posY);
      clearQuery("warp");
    });
  }

  /**
   * Open the card named by `?card=` or the taskspace file named by `?taskspace=&path=`.
   * Remove those parameters after use, as with `?warp=`. See `readArrival`.
   */
  function openFromUrl() {
    if (!browser) return;

    // Open static-export files only when their contents are embedded.
    const { card, file, inventory, handled } = readArrival(
      page.url.searchParams,
      s,
      !(readonly && !staticFiles),
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
    if (landing) tick().then(() => canvasComponent.centerOn(landing.posX, landing.posY));
  }

  // Remember the layer being worked on, so a reload comes back to it instead of to Base.
  $effect(() => storeActiveLayerId(s.namespaceId, s.activeLayerId));

  // Resolved before the canvas mounts, so a page loaded with `?warp=` opens on the warp
  // instead of scrolling to it once the middle of the board has already been painted.
  const initialWarp = untrack(warpFromUrl);
  if (initialWarp) untrack(() => warps.focus(initialWarp.id));

  onMount(() => {
    if (initialWarp) clearQuery("warp");
    // After the warp landing above, so a link carrying both ends on the card it named.
    openFromUrl();
  });

  // Poll for CLI and other-tab writes. Apply snapshots while preserving current filters and
  // valid selections.
  onMount(() => {
    // A static export has no /api/snapshot endpoint and no writers to sync with.
    if (readonly) return;
    return startSnapshotPoll({
      fetcher: s.fetcher,
      namespaceId: () => s.namespaceId,
      activities: [positionActivity, s.mutations],
      apply: (snapshot) => s.refreshFromData(snapshot),
      isHidden: () => document.visibilityState === "hidden",
    });
  });

  // ── Domain action handlers ────────────────────────────────────
  const actions = createNamespaceActions(s);

  // Persist optimistic canvas and composer edits. Return success so callers can roll back
  // failed saves.
  const persistence = createBoardPersistence(s);

  const inventoryActions = createInventoryActions(s);

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
    fetcher: s.fetcher,
    namespaceId: s.namespaceId,
    staticFiles,
  });

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
        tick().then(() => composerComponent?.focusInput());
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
</script>

<svelte:head>
  <title>{data.namespace.name}</title>
</svelte:head>

<svelte:window onkeydown={handleKeydown} />

<div class={css({ display: "flex", height: "100vh", overflow: "hidden", backgroundColor: "ink.lighter" })}>
  <PartitionSidebar
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
      onOpenFile={!readonly || staticFiles ? files.openFromFrame : undefined}
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
      tagHref={(tag) =>
        `${base}/tags?namespaceId=${data.namespace.id}&tag=${encodeURIComponent(tag)}`}
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
      actions={{
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
      }}
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

  <ScopeSidebar
    visible={sidebarsVisible}
    panelWidth={data.uiConfig.rightPanelWidth}
    scopes={s.scopes}
    scopeRels={s.scopeRels}
    taskspaces={s.taskspaces}
    taskspaceTree={s.taskspaceTree}
    treeContext={editorContext}
    selectedCards={s.selection.selectedCards}
    bind:activeScope={s.sidebar.activeScope}
    bind:newScopeName={s.sidebar.newScopeName}
    bind:newWcName={s.sidebar.newWcName}
    onCreateScope={actions.handleCreateScope}
    onDeleteScope={actions.handleDeleteScope}
    onAddToScope={actions.handleAddToScope}
    onRemoveFromScope={actions.handleRemoveFromScope}
    frameCountByScopeId={view.frameCountByScopeId}
    onCreateTaskspace={actions.handleCreateTaskspace}
    onOpenFile={!readonly || staticFiles ? files.open : undefined}
    {readonly}
  />

  <FileEditor
    session={editor}
    ctx={editorContext}
    vimMode={data.uiConfig.editorVimMode}
    autoSave={data.uiConfig.editorAutoSave}
    {readonly}
    bind:width={editorWidth}
    bind:pinned={editorPinned}
    onClose={() => undefined}
  />
</div>
