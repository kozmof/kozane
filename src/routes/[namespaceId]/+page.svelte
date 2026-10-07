<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import type { PageProps } from "./$types";
  import { css } from "styled-system/css";
  import { base } from "$app/paths";
  import { browser } from "$app/environment";
  import { goto, replaceState } from "$app/navigation";
  import { page } from "$app/state";
  import {
    fetchWarpDirectory,
    parseWarpEntries,
    deleteWarp,
    failureMessage,
  } from "./lib/namespace-api.js";
  import { applyPalette } from "$lib/palette";
  import { ARROW_DIRECTIONS, clampZoom, warpInDirection } from "./lib/namespace-page.js";
  import {
    cardMetrics,
    warpEntriesForNamespace,
    withoutWarp,
    type WarpListEntry,
  } from "$lib/warp-list";
  import { hasCommandModifier, isTypingTarget, runKeyBindings } from "./lib/board-keymap.js";
  import { boardKeyBindings } from "./lib/board-bindings.js";
  import { createBoardPersistence } from "./lib/board-persistence.js";
  import type { BoardPoint } from "./lib/canvas-viewport.js";
  import { NamespaceState, storeActiveLayerId } from "./namespace-state.svelte.js";
  import { createNamespaceActions } from "./namespace-actions.svelte.js";
  import PartitionSidebar from "./components/PartitionSidebar.svelte";
  import ScopeSidebar from "./components/ScopeSidebar.svelte";
  import KozaneCanvas from "./components/KozaneCanvas.svelte";
  import FloatingControls from "./components/FloatingControls.svelte";
  import LayerControl from "./components/LayerControl.svelte";
  import ScopeControl from "./components/ScopeControl.svelte";
  import FloatingComposer from "./components/FloatingComposer.svelte";
  import ScopeAreaPrompt from "./components/ScopeAreaPrompt.svelte";
  import WarpPalette from "./components/WarpPalette.svelte";
  import ErrorBanner from "./components/ErrorBanner.svelte";
  import FileEditor from "./components/FileEditor.svelte";
  import FilePalette from "./components/FilePalette.svelte";
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
  let warpsVisible = $state(untrack(() => data.uiConfig.defaultShowWarps));
  let zoom = $state(untrack(() => data.uiConfig.defaultZoom));
  let warpPaletteOpen = $state(false);
  // The file palette, opened from a selection. Unlike the warp palette it is up while
  // cards are selected, which is why the composer is told to stand down below.
  let filePaletteOpen = $state(false);
  // The single taskspace file currently open in the editor.
  const editor = new EditorSession();
  // Keep the dragged panel width on the page so it survives closing a file. Null uses the
  // responsive default. Reloading resets it.
  let editorWidth = $state<number | null>(null);
  // Load other namespaces' warps with the page, then refresh when the palette opens. Older
  // static exports may omit this directory.
  let warpDirectory = $state.raw<WarpListEntry[]>(untrack(() => data.warpDirectory ?? []));
  let newCardSeq = 0;
  // Track the drag and its save separately from requests so polling pauses before the final
  // PATCH begins.
  const positionActivity = new InFlight();
  /**
   * Whether the composer’s action bar has the keyboard. Every board-level shortcut below
   * the composer in `keyBindings` asks this, which is what the bare `return` it replaces
   * used to do for all of them at once.
   */
  const noSelection = () => s.selection.selectedCards.size === 0;

  // ── Canvas component ref (for getNewCardPosition) ─────────────
  let canvasComponent: {
    getNewCardPosition: (seq: number) => BoardPoint;
    getViewCenter: () => BoardPoint;
    getWarpPosition: () => BoardPoint;
    isCenteredOn: (posX: number, posY: number) => boolean;
    centerOn: (posX: number, posY: number) => void;
    recenter: () => void;
    cardIdsInWorldRect: (rect: { x: number; y: number; w: number; h: number }) => string[];
  } = $state()!;
  let composerComponent: { focusInput: () => void } = $state()!;

  // ── Derived values ────────────────────────────────────────────
  let partitionsWithColors = $derived(applyPalette(s.partitions));
  let partitionColorById = $derived(new Map(partitionsWithColors.map((b) => [b.id, b])));
  let visibleCards = $derived(
    s.sidebar.activePartition ? s.cards.filter((c) => c.partitionId === s.sidebar.activePartition) : s.cards,
  );
  let scopeCardIds = $derived(
    s.sidebar.activeScope
      ? new Set(s.scopeRels.filter((r) => r.scopeId === s.sidebar.activeScope).map((r) => r.cardId))
      : null,
  );
  /** What each frame writes on its tab. Built from the scopes this board draws. */
  let scopeNameById = $derived(new Map(s.scopes.map((scope) => [scope.id, scope.name])));
  /** How many frames each scope has on this board, which is what the panel reports. */
  let frameCountByScopeId = $derived(
    s.scopeAreas.reduce(
      (counts, area) => counts.set(area.scopeId, (counts.get(area.scopeId) ?? 0) + 1),
      new Map<string, number>(),
    ),
  );
  let defaultPartitionId = $derived(s.sidebar.activePartition ?? partitionsWithColors[0]?.id ?? "");
  // One pass over the cards instead of a scan per selected id. A selection is capped at
  // BATCH_MAX, so the pair-wise form was up to two thousand scans of the whole board on
  // every keystroke that touched the selection.
  let cardById = $derived(new Map(s.cards.map((c) => [c.id, c])));
  // Drop selected IDs whose cards were deleted before the next snapshot arrived.
  let selectedCardObjects = $derived(
    [...s.selection.selectedCards].flatMap((id) => cardById.get(id) ?? []),
  );
  let selectionGlueRels = $derived(s.glueRels.filter((r) => s.selection.selectedCards.has(r.cardId)));
  let primaryCard = $derived(
    s.selection.primarySelectedId ? (cardById.get(s.selection.primarySelectedId) ?? null) : null,
  );
  // This namespace's rows come from live state rather than the server, so a warp just set
  // with the warp key is in the palette before any request comes back.
  let warpEntries = $derived([
    ...warpEntriesForNamespace({
      namespace: { id: data.namespace.id, name: data.namespace.name },
      warps: s.warps,
      cards: s.cards,
      metrics: cardMetrics(data.uiConfig),
      isCurrent: true,
    }),
    ...warpDirectory,
  ]);

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
      warpDirectory = data.warpDirectory ?? [];
      s.resetFromData(data);
      newCardSeq = 0;
      sidebarsVisible = data.uiConfig.defaultShowSidePanel;
      showFooters = data.uiConfig.defaultShowFooter;
      warpsVisible = data.uiConfig.defaultShowWarps;
      zoom = data.uiConfig.defaultZoom;
      // Cross-namespace navigation reuses this component, so land here without waiting for
      // the canvas to remount.
      openViewOnNewNamespace();
    } else {
      s.refreshFromData(data);
    }
  });

  /**
   * The warp named by `?warp=`, which is how a jump to another namespace says where it was
   * headed. Null whenever the id is absent or belongs to a warp this namespace no longer has.
   */
  function warpFromUrl() {
    // Read query parameters only in the browser. Static prerendering cannot access them.
    if (!browser) return null;
    const warpId = page.url.searchParams.get("warp");
    return warpId ? (s.warps.find(({ id }) => id === warpId) ?? null) : null;
  }

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
    focusWarp(target.id);
    tick().then(() => {
      canvasComponent.centerOn(target.posX, target.posY);
      clearQuery("warp");
    });
  }

  /**
   * Remove arrival parameters after use so reloading does not repeat the jump. Preserve
   * unrelated parameters and ignore router errors during this cosmetic update.
   */
  function clearQuery(...names: string[]) {
    const url = new URL(page.url);
    for (const name of names) url.searchParams.delete(name);
    try {
      replaceState(`${url.pathname}${url.search}`, {});
    } catch {
      // Ignored: see above.
    }
  }

  /** Resolve the card named by `?card=`, or return null if it is absent from this namespace. */
  function cardFromUrl() {
    if (!browser) return null;
    const cardId = page.url.searchParams.get("card");
    return cardId ? (s.cards.find(({ id }) => id === cardId) ?? null) : null;
  }

  /**
   * Open the card named by `?card=` or the taskspace file named by `?taskspace=&path=`.
   * Remove those parameters after use, as with `?warp=`.
   */
  function openFromUrl() {
    if (!browser) return;

    // Read all URL actions before applying them, then remove handled parameters together so
    // asynchronous actions cannot read a partially cleared URL.
    const card = cardFromUrl();
    const taskspaceId = page.url.searchParams.get("taskspace");
    const path = page.url.searchParams.get("path");
    // Open static-export files only when their contents are embedded. There is no live
    // endpoint to fetch omitted content.
    const taskspace =
      taskspaceId && path && !(readonly && !staticFiles)
        ? (s.taskspaces.find(({ id }) => id === taskspaceId) ?? null)
        : null;

    const acted: string[] = [];
    if (taskspace && path) {
      editor.open(editorContext, { taskspaceId: taskspace.id, taskspaceName: taskspace.name, path });
      acted.push("taskspace", "path");
    }
    if (card) {
      // Select the card as well as centring it so the matched card is clear on a dense board.
      // Skip selection in read-only exports, where it cannot be cleared.
      if (!readonly) {
        s.selection.selectedCards = new Set([card.id]);
        s.selection.primarySelectedId = card.id;
      }
      acted.push("card");
    }
    if (acted.length > 0) clearQuery(...acted);

    // The pan is the one part that has to wait for the canvas to exist. It changes nothing on
    // the URL, so it is free to happen after the clear above.
    if (card) tick().then(() => canvasComponent.centerOn(card.posX, card.posY));
  }

  // Remember the layer being worked on, so a reload comes back to it instead of to Base.
  $effect(() => storeActiveLayerId(s.namespaceId, s.activeLayerId));

  // Resolved before the canvas mounts, so a page loaded with `?warp=` opens on the warp
  // instead of scrolling to it once the middle of the board has already been painted.
  const initialWarp = untrack(warpFromUrl);
  if (initialWarp) untrack(() => focusWarp(initialWarp.id));

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

  function handleComposerSubmit(id: string | null, content: string, partitionId: string) {
    return persistence.submitComposer(id, content, partitionId, () =>
      canvasComponent.getNewCardPosition(newCardSeq++),
    );
  }

  /**
   * An Alt-drawn rectangle awaiting a scope. The canvas sets it on release, and the page
   * clears it after handling the scope prompt.
   */
  let pendingScopeAreaRect = $state<{ x: number; y: number; w: number; h: number } | null>(null);

  /**
   * Card count measured when the rectangle is drawn, for display in the prompt.
   * `handleChooseScopeForArea` measures again when the user answers to account for
   * intervening changes.
   */
  let pendingScopeAreaCardCount = $state(0);
  $effect(() => {
    const rect = pendingScopeAreaRect;
    pendingScopeAreaCardCount = rect ? canvasComponent.cardIdsInWorldRect(rect).length : 0;
  });

  /** The drawn rectangle as the API takes it. */
  function pendingRectAsArea(rect: { x: number; y: number; w: number; h: number }) {
    return { posX: rect.x, posY: rect.y, width: rect.w, height: rect.h };
  }

  async function handleChooseScopeForArea(scopeId: string) {
    const rect = pendingScopeAreaRect;
    if (!rect) return;
    // Measure again because polling may have changed the board while the prompt was open.
    const covers = canvasComponent.cardIdsInWorldRect(rect);
    pendingScopeAreaRect = null;
    await actions.handleCreateScopeArea(scopeId, pendingRectAsArea(rect), covers);
  }

  async function handleCreateScopeForArea(name: string) {
    const rect = pendingScopeAreaRect;
    if (!rect) return;
    const covers = canvasComponent.cardIdsInWorldRect(rect);
    pendingScopeAreaRect = null;
    await actions.handleCreateScopeWithArea(name, pendingRectAsArea(rect), covers);
  }

  /** Shows the card's resize handle, or takes it away when it is the one already showing. */
  function handleResizeToggle(cardId: string) {
    s.selection.resizingCardId = s.selection.resizingCardId === cardId ? null : cardId;
  }

  /** Fills the palette in with warps another tab or the CLI has set since the page loaded. */
  async function refreshWarpDirectory() {
    // A static export has no endpoint to ask, and nothing can have changed under it.
    if (readonly) return;
    try {
      const res = await fetchWarpDirectory(s.fetcher, s.namespaceId);
      if (!res.ok) return;
      const parsed = parseWarpEntries(await res.json().catch(() => null));
      // An answer that is not a list of rows is treated as no answer at all.
      if (parsed) warpDirectory = parsed;
    } catch {
      // The copy that came with the page stays: a stale list beats an empty one.
    }
  }

  /** Focus a warp and reveal its marker so the remove shortcut's target is visible. */
  function focusWarp(warpId: string) {
    warpsVisible = true;
    s.focusedWarpId = warpId;
  }

  const editorContext = $derived({
    fetcher: s.fetcher,
    namespaceId: s.namespaceId,
    staticFiles,
  });

  /**
   * Close the palette before opening its selected file so the editor receives focus and
   * outside-press events correctly.
   */
  function handlePaletteOpenFile(taskspaceId: string, taskspaceName: string, path: string) {
    filePaletteOpen = false;
    editor.open(editorContext, { taskspaceId, taskspaceName, path });
  }

  /**
   * Open a file from a scope frame's icon. Resolve the taskspace name here for the editor
   * title using the same rows that supply the canvas icons.
   */
  function handleFrameOpenFile(taskspaceId: string, path: string) {
    const taskspace = s.taskspaces.find(({ id }) => id === taskspaceId);
    if (!taskspace) return;
    editor.open(editorContext, { taskspaceId, taskspaceName: taskspace.name, path });
  }

  /** Creates the scope, taskspace and file, then opens the file that came of it. */
  async function handlePaletteCreate(names: {
    scope: string;
    taskspace: string;
    file: string;
  }) {
    const made = await actions.handleCreateScopeWithFile(names);
    if (!made) return; // the action has already said why
    handlePaletteOpenFile(made.taskspaceId, made.taskspaceName, made.path);
  }

  function handleWarpJump(entry: WarpListEntry) {
    warpPaletteOpen = false;
    if (entry.namespaceId === s.namespaceId) {
      canvasComponent.centerOn(entry.posX, entry.posY);
      focusWarp(entry.id);
      return;
    }
    // Pass cross-namespace warp targets in the URL so the destination page controls its
    // viewport and the link can be shared. Preserve the route's trailing-slash style.
    const slash = page.url.pathname.endsWith("/") ? "/" : "";
    void goto(`${base}/${entry.namespaceId}${slash}?warp=${entry.id}`);
  }

  /**
   * Remove a warp through the palette, including warps in other namespaces. The `x` shortcut
   * affects only the focused marker on this board.
   */
  async function handleWarpDelete(entry: WarpListEntry) {
    if (entry.namespaceId === s.namespaceId) {
      // Same path the `x` key takes, so one warp cannot be removed two different ways.
      await actions.handleRemoveWarp(entry.id);
      return;
    }
    const previous = warpDirectory;
    warpDirectory = withoutWarp(warpDirectory, entry.id);
    const res = await deleteWarp(s.mutationFetcher, entry.namespaceId, entry.id);
    if (!res.ok) {
      warpDirectory = previous;
      s.setError(await failureMessage(res, "Failed to remove warp"));
    }
  }

  /**
   * Exclude the focused warp once the viewport is as centered on it as canvas bounds allow.
   * Otherwise an edge warp remains ahead of the center and repeated arrow navigation keeps
   * choosing it. Panning away makes it eligible again.
   */
  function reachableWarps() {
    const focused = s.warps.find(({ id }) => id === s.focusedWarpId);
    return focused && canvasComponent.isCenteredOn(focused.posX, focused.posY)
      ? s.warps.filter(({ id }) => id !== focused.id)
      : s.warps;
  }

  /** Centres on the nearest warp toward an arrow key, answering whether there was one. */
  function warpToward(key: string): boolean {
    // Measured from where the view is now, so warping works the same whether you arrived
    // by arrow key or by dragging the canvas.
    const { posX, posY } = canvasComponent.getViewCenter();
    const target = warpInDirection(
      reachableWarps(),
      { x: posX, y: posY },
      ARROW_DIRECTIONS[key],
      s.focusedWarpId,
    );
    if (!target) return false;
    canvasComponent.centerOn(target.posX, target.posY);
    focusWarp(target.id);
    return true;
  }

  /**
   * Derive keyboard bindings from the current namespace configuration.
   * `lib/board-bindings.ts` defines their order.
   */
  const keyBindings = $derived(
    boardKeyBindings(data.uiConfig, {
      readonly,
      hasPendingFrame: () => pendingScopeAreaRect !== null,
      noSelection,
      hasFocusedWarp: () => s.focusedWarpId !== null,
      dismissPendingFrame: () => (pendingScopeAreaRect = null),
      focusComposer: () => {
        s.selection.composerCard = null;
        s.selection.selectedCards = new Set();
        s.selection.primarySelectedId = null;
        tick().then(() => composerComponent.focusInput());
      },
      toggleFooters: () => (showFooters = !showFooters),
      togglePanels: () => (sidebarsVisible = !sidebarsVisible),
      toggleWarps: () => (warpsVisible = !warpsVisible),
      openWarpPalette: () => {
        warpPaletteOpen = true;
        void refreshWarpDirectory();
      },
      warpToward,
      setWarpHere: () => {
        // A warp you cannot see is a warp you cannot remove, so setting one reveals them.
        warpsVisible = true;
        void actions.handleSetWarp(canvasComponent.getWarpPosition());
      },
      removeFocusedWarp: () => {
        if (s.focusedWarpId) void actions.handleRemoveWarp(s.focusedWarpId);
      },
    }),
  );

  function handleKeydown(e: KeyboardEvent) {
    // Apply keyboard ownership gates before resolving shortcuts. Open palettes own all keys,
    // including their close shortcut.
    if (warpPaletteOpen) return;
    if (filePaletteOpen) return;
    // An open editor owns the keyboard even when focus is on panel controls that do not stop
    // propagation.
    if (editor.isOpen) return;
    // Ignore repeated keydown events because shortcuts perform discrete actions, including
    // creating warp markers.
    if (e.repeat) return;
    if (isTypingTarget(e.target)) return;
    if (hasCommandModifier(e)) return;

    runKeyBindings(e, keyBindings);
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class={css({ display: "flex", height: "100vh", overflow: "hidden", backgroundColor: "ink.lighter" })}>
  <PartitionSidebar
    visible={sidebarsVisible}
    panelWidth={data.uiConfig.leftPanelWidth}
    cards={s.cards}
    partitions={partitionsWithColors}
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
      {visibleCards}
      glueRels={s.glueRels}
      layers={s.layers}
      activeLayerId={s.activeLayerId}
      {partitionColorById}
      selection={s.selection}
      {scopeCardIds}
      bind:scopeAreas={s.scopeAreas}
      {scopeNameById}
      activeScopeId={s.sidebar.activeScope}
      taskspaces={s.taskspaces}
      taskspaceTree={s.taskspaceTree}
      treeContext={editorContext}
      onOpenFile={!readonly || staticFiles ? handleFrameOpenFile : undefined}
      bind:pendingScopeAreaRect
      onPersistScopeArea={persistence.persistScopeArea}
      onRemoveScopeArea={actions.handleDeleteScopeArea}
      onScopeMembershipChange={actions.handleScopeMembershipChange}
      bind:warps={s.warps}
      focusedWarpId={s.focusedWarpId}
      {warpsVisible}
      warpMarkerSize={data.uiConfig.warpMarkerSize}
      initialCenter={initialWarp && { posX: initialWarp.posX, posY: initialWarp.posY }}
      onFocusWarp={focusWarp}
      onPersistWarpPosition={persistence.persistWarpPosition}
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

    {#if filePaletteOpen}
    <FilePalette
      scopes={s.scopes}
      scopeRels={s.scopeRels}
      taskspaces={s.taskspaces}
      selectedCards={s.selection.selectedCards}
      tree={s.taskspaceTree}
      ctx={editorContext}
      {readonly}
      onOpenFile={handlePaletteOpenFile}
      onLinkScope={actions.handleLinkScope}
      onCreate={handlePaletteCreate}
      onClose={() => (filePaletteOpen = false)}
    />
  {/if}

  {#if warpPaletteOpen}
      <WarpPalette
        entries={warpEntries}
        focusedWarpId={s.focusedWarpId}
        {readonly}
        onJump={handleWarpJump}
        onDelete={handleWarpDelete}
        onClose={() => (warpPaletteOpen = false)}
      />
    {/if}

    {#if s.lastError}
      <ErrorBanner message={s.lastError} onDismiss={() => (s.lastError = null)} />
    {/if}

    <LayerControl
      layers={s.layers}
      cards={s.cards}
      bind:activeLayerId={s.activeLayerId}
      onCreateLayer={actions.handleCreateLayer}
      onDeleteLayer={actions.handleDeleteLayer}
      onRenameLayer={actions.handleRenameLayer}
      onReorderLayers={actions.handleReorderLayers}
      {readonly}
    />

    <ScopeControl scopes={s.scopes} bind:activeScope={s.sidebar.activeScope} />

    <FloatingControls
      {zoom}
      zoomStep={data.uiConfig.zoomStep}
      {sidebarsVisible}
      onToggleSidebars={() => (sidebarsVisible = !sidebarsVisible)}
      onZoom={(delta) => (zoom = clampZoom(zoom + delta))}
    />

    <!-- Replace the composer with the scope prompt while the rectangle awaits a scope. -->
    {#if !readonly && pendingScopeAreaRect}
    <ScopeAreaPrompt
      scopes={s.scopes}
      cardCount={pendingScopeAreaCardCount}
      onChoose={handleChooseScopeForArea}
      onCreate={handleCreateScopeForArea}
      onCancel={() => (pendingScopeAreaRect = null)}
    />
    {:else if !readonly}
    <FloatingComposer
      bind:this={composerComponent}
      editingCard={s.selection.composerCard}
      selectedCards={selectedCardObjects}
      {selectionGlueRels}
      {primaryCard}
      partitions={partitionsWithColors}
      {defaultPartitionId}
      layers={s.layers}
      onSubmit={handleComposerSubmit}
      onCancel={() => { s.selection.composerCard = null; s.selection.selectedCards = new Set(); s.selection.primarySelectedId = null; }}
      onPartitionChange={actions.handleCardPartitionChange}
      onSelectionPartitionChange={actions.handleSelectionPartitionChange}
      onGlueSelected={actions.handleGlueSelected}
      onUnglueSelected={actions.handleUnglueSelected}
      onUnglueOne={actions.handleUnglueOne}
      onDeleteSelected={actions.handleDeleteSelected}
      otherNamespaces={data.otherNamespaces}
      onMoveToNamespace={actions.handleMoveSelectionToNamespace}
      onSelectionLayerChange={actions.handleSelectionLayerChange}
      onStackOrderChange={actions.handleStackOrderChange}
      onResizeToggle={handleResizeToggle}
      onSquashCard={actions.handleSquashCard}
      onOpenFilePalette={() => (filePaletteOpen = true)}
      suspendShortcuts={filePaletteOpen}
      resizingCardId={s.selection.resizingCardId}
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
    {frameCountByScopeId}
    onCreateTaskspace={actions.handleCreateTaskspace}
    onOpenFile={!readonly || staticFiles
      ? (taskspaceId, taskspaceName, path) =>
          editor.open(editorContext, { taskspaceId, taskspaceName, path })
      : undefined}
    {readonly}
  />

  <FileEditor
    session={editor}
    ctx={editorContext}
    vimMode={data.uiConfig.editorVimMode}
    {readonly}
    bind:width={editorWidth}
    onClose={() => undefined}
  />
</div>
