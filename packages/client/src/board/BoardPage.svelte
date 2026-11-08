<script lang="ts">
  import RefreshNotice from "../RefreshNotice.svelte";
  import ClientNotice from "../ClientNotice.svelte";
  import type { BoardViewProps } from "./types.js";
  import { css } from "../styles/css.js";
  import KozaneCanvas from "./components/KozaneCanvas.svelte";
  import PartitionSidebar from "./components/PartitionSidebar.svelte";
  import FloatingControls from "./components/FloatingControls.svelte";
  import BoardControls from "./components/BoardControls.svelte";
  import BoardComposer from "./components/BoardComposer.svelte";
  import WarpPalette from "./components/WarpPalette.svelte";
  import InventoryDock from "./components/InventoryDock.svelte";
  import { clampZoom } from "../constants/index.js";
  import ErrorBanner from "./components/ErrorBanner.svelte";
  import { FileEditor } from "../editor/index.js";
  import FilePalette from "./components/FilePalette.svelte";
  import FileBrowser from "./components/FileBrowser.svelte";
  import { createBoardController } from "./board-controller.svelte.js";
  let {
    data,
    client,
    lifetimeNotice,
    navigation,
    routing,
    preferences,
    readRouteUrl = () => null,
    initialDataApplied = false,
    retryIntervalMs,
    lifecycle,
    isHidden = () => false,
  }: BoardViewProps = $props();
  let canvasComponent: ReturnType<typeof KozaneCanvas> = $state()!;
  let composerComponent: ReturnType<typeof BoardComposer> | undefined = $state();
  const board = createBoardController({
    get data() {
      return data;
    },
    get client() {
      return client;
    },
    get navigation() {
      return navigation;
    },
    get routing() {
      return routing;
    },
    get preferences() {
      return preferences;
    },
    get readRouteUrl() {
      return readRouteUrl;
    },
    get initialDataApplied() {
      return initialDataApplied;
    },
    get retryIntervalMs() {
      return retryIntervalMs;
    },
    get lifecycle() {
      return lifecycle;
    },
    get isHidden() {
      return isHidden;
    },
    canvas: () => canvasComponent,
    composer: () => composerComponent,
  });
  const {
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
  } = board;
</script>

<svelte:head>
  <title>{data.namespace.name}</title>
</svelte:head>

<svelte:window onkeydown={handleKeydown} />
<ClientNotice capabilities={client.capabilities} {lifetimeNotice} floating />
<RefreshNotice {client} failed={board.refreshFailed || board.filesRefreshFailed} message={board.filesRefreshFailed ? "Could not refresh files. Showing the last listings." : "Could not refresh the board. Showing the last board."} retry={board.retry} floating />

{#if board.editingBlocked}
  <p role="status" class={css({ position: "fixed", top: "12px", left: "50%", zIndex: 1000, padding: "8px 12px", backgroundColor: "ink.white", color: "ink.black", fontSize: "12px" })}>Board editing is paused while current data loads.</p>
{/if}
{#key board.snapshotStatus.generation}
<fieldset disabled={board.editingBlocked} inert={board.editingBlocked} aria-busy={board.editingBlocked}
  onkeydowncapture={blockEditing} onclickcapture={blockEditing} onmousedowncapture={blockEditing} onpointerdowncapture={blockEditing}
  class={css({ border: "0", margin: "0", padding: "0", minWidth: "0" })}>
<div class={css({ display: "flex", height: "100vh", overflow: "hidden", position: "relative", backgroundColor: "ink.lighter" })}>
  <PartitionSidebar
    namespacesHref={navigation.namespaces()}
    visible={board.sidebarsVisible}
    panelWidth={data.uiConfig.leftPanelWidth}
    cards={s.cards}
    partitions={view.partitions}
    bind:activePartition={s.sidebar.activePartition}
    bind:newPartitionName={s.sidebar.newPartitionName}
    onCreatePartition={actions.handleCreatePartition}
    onDeletePartition={actions.handleDeletePartition}
    readonly={board.readonly}
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
      treeContext={board.editorContext}
      onOpenFile={s.taskspaces.some(taskspace => client.taskspaces?.access(s.namespaceId, taskspace).read) ? files.openFromFrame : undefined}
      onCreateTaskspace={board.readonly ? undefined : actions.createTaskspace}
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
      bind:inventoryDrag={board.inventoryDrag}
      showFooters={board.showFooters}
      bind:zoom={board.zoom}
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
      readonly={board.readonly}
    />

    <InventoryDock
      {s}
      {inventoryActions}
      inventoryLabel={view.inventoryLabel}
      inventoryDrag={board.inventoryDrag}
      zoom={board.zoom}
      fontFamily={data.uiConfig.defaultFontFamily}
      readonly={board.readonly}
      onCardMouseDown={(e, cardId) => canvasComponent.pressStowedCard(e, cardId)}
      leftInset={board.sidebarsVisible ? data.uiConfig.leftPanelWidth : 0}
    />

    {#if board.filePaletteOpen}
    <FilePalette
      scopes={s.scopes}
      scopeRels={s.scopeRels}
      taskspaces={s.taskspaces}
      selectedCards={s.selection.selectedCards}
      tree={s.taskspaceTree}
      ctx={board.editorContext}
      readonly={board.readonly}
      onOpenFile={files.openFromPalette}
      onLinkScope={actions.handleLinkScope}
      onCreate={files.createFromPalette}
      onClose={() => (board.filePaletteOpen = false)}
    />
  {/if}

  {#if board.fileBrowserOpen}
    <FileBrowser
      scopes={s.scopes}
      taskspaces={s.taskspaces}
      tree={s.taskspaceTree}
      ctx={board.editorContext}
      readonly={board.readonly}
      editorFile={editor.file}
      initialScopeId={s.sidebar.activeScope}
      actions={fileActions}
      onOpenFile={files.openFromPalette}
      onClose={() => (board.fileBrowserOpen = false)}
    />
  {/if}

  {#if warps.paletteOpen}
      <WarpPalette
        entries={view.warpEntries}
        focusedWarpId={s.focusedWarpId}
        readonly={board.readonly}
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
      bind:sidebarsVisible={board.sidebarsVisible}
      readonly={board.readonly}
    />

    <FloatingControls
      zoom={board.zoom}
      zoomStep={data.uiConfig.zoomStep}
      showZoom={data.uiConfig.showZoomControl}
      onZoom={(delta) => (board.zoom = clampZoom(board.zoom + delta))}
    />

    {#if !board.readonly}
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
        onOpenFilePalette={() => (board.filePaletteOpen = true)}
        filePaletteOpen={board.filePaletteOpen}
        newCardTarget={view.receivingInventory && view.inventoryLabel(view.receivingInventory)}
        shortcuts={data.uiConfig}
      />
    {/if}
  </div>

  <FileEditor
    {routing}
    session={editor}
    ctx={board.editorContext}
    vimMode={data.uiConfig.editorVimMode}
    autoSave={data.uiConfig.editorAutoSave}
    readonly={board.readonly || board.editingBlocked}
    bind:width={board.editorWidth}
    bind:pinned={board.editorPinned}
    onClose={() => undefined}
  />
</div>

</fieldset>
{/key}
