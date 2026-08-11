<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import type { PageProps } from "./$types";
  import { css } from "styled-system/css";
  import { base } from "$app/paths";
  import { browser } from "$app/environment";
  import { goto, replaceState } from "$app/navigation";
  import { page } from "$app/state";
  import {
    createCard,
    updateCard,
    patchCardPositions,
    fetchWarpDirectory,
    deleteWarp,
    failureMessage,
  } from "./lib/project-api";
  import {
    applyPalette,
    ARROW_DIRECTIONS,
    clampZoom,
    maxZIndex,
    minZIndex,
    warpInDirection,
  } from "./lib/project-page";
  import type { CardPositionPatch } from "./lib/project-page";
  import { warpEntriesForProject, withoutWarp, type WarpListEntry } from "$lib/warp-list";
  import type { CardWithGlue } from "$lib/types";
  import { ProjectState, storeActiveLayerId } from "./project-state.svelte";
  import { createProjectActions } from "./project-actions.svelte";
  import BundleSidebar from "./components/BundleSidebar.svelte";
  import ScopeSidebar from "./components/ScopeSidebar.svelte";
  import KozaneCanvas from "./components/KozaneCanvas.svelte";
  import FloatingControls from "./components/FloatingControls.svelte";
  import LayerControl from "./components/LayerControl.svelte";
  import FloatingComposer from "./components/FloatingComposer.svelte";
  import WarpPalette from "./components/WarpPalette.svelte";
  import ErrorBanner from "./components/ErrorBanner.svelte";

  let { data }: PageProps = $props();

  // Static exports (kozane net ssg generate) are read-only: no mutation endpoints exist, so all
  // editing affordances and the live-sync poll are disabled. Build-wide and constant.
  const readonly = untrack(() => data.readonly);

  // ── Reactive project state ────────────────────────────────────
  const s = new ProjectState();
  s.fetcher = fetch;
  // The same path project navigation takes below. Loading a project decides more than a
  // list of fields now — which layer it was last worked on, among them — and that belongs
  // in one place rather than being repeated here and kept in step by hand.
  untrack(() => s.resetFromData(data));

  // ── UI state ──────────────────────────────────────────────────
  let sidebarsVisible = $state(untrack(() => data.uiConfig.defaultShowSidePanel));
  let showFooters = $state(untrack(() => data.uiConfig.defaultShowFooter));
  let warpsVisible = $state(untrack(() => data.uiConfig.defaultShowWarps));
  let zoom = $state(untrack(() => data.uiConfig.defaultZoom));
  let warpPaletteOpen = $state(false);
  // Every other project's warps. Loaded with the page so the palette opens filled in, and
  // re-fetched when it opens so a warp set elsewhere since then is not missing.
  // `?? []`: a static export built before this feature has no directory in its page data.
  let warpDirectory = $state.raw<WarpListEntry[]>(untrack(() => data.warpDirectory ?? []));
  let newCardSeq = 0;
  let positionActivityCount = 0;
  let positionActivityVersion = 0;

  function startPositionActivity() {
    positionActivityCount += 1;
    positionActivityVersion += 1;
  }

  function endPositionActivity() {
    positionActivityCount = Math.max(0, positionActivityCount - 1);
    positionActivityVersion += 1;
  }

  // ── Canvas component ref (for getNewCardPosition) ─────────────
  let canvasComponent: {
    getNewCardPosition: (seq: number) => { posX: number; posY: number };
    getViewCenter: () => { posX: number; posY: number };
    getWarpPosition: () => { posX: number; posY: number };
    centerOn: (posX: number, posY: number) => void;
  } = $state()!;
  let composerComponent: { focusInput: () => void } = $state()!;

  // ── Derived values ────────────────────────────────────────────
  let bundlesWithColors = $derived(applyPalette(s.bundles));
  let bundleColorById = $derived(new Map(bundlesWithColors.map((b) => [b.id, b])));
  let visibleCards = $derived(
    s.sidebar.activeBundle ? s.cards.filter((c) => c.bundleId === s.sidebar.activeBundle) : s.cards,
  );
  let scopeCardIds = $derived(
    s.sidebar.activeScope
      ? new Set(s.scopeRels.filter((r) => r.scopeId === s.sidebar.activeScope).map((r) => r.cardId))
      : null,
  );
  let defaultBundleId = $derived(s.sidebar.activeBundle ?? bundlesWithColors[0]?.id ?? "");
  let selectedCardObjects = $derived(
    [...s.selection.selectedCards].map((id) => s.cards.find((c) => c.id === id)!).filter(Boolean),
  );
  let selectionGlueRels = $derived(s.glueRels.filter((r) => s.selection.selectedCards.has(r.cardId)));
  let primaryCard = $derived(
    s.selection.primarySelectedId ? (s.cards.find((c) => c.id === s.selection.primarySelectedId) ?? null) : null,
  );
  // This project's rows come from live state rather than the server, so a warp just set
  // with the warp key is in the palette before any request comes back.
  let warpEntries = $derived([
    ...warpEntriesForProject({
      project: { id: data.project.id, name: data.project.name },
      warps: s.warps,
      cards: s.cards,
      metrics: {
        cardWidth: data.uiConfig.defaultCardWidth,
        fontSize: data.uiConfig.defaultFontSize,
      },
      isCurrent: true,
    }),
    ...warpDirectory,
  ]);

  // ── Reset on project navigation ───────────────────────────────
  let loadedProjectId = $state(untrack(() => data.project.id));
  let loadedData = $state.raw(untrack(() => data));

  $effect(() => {
    if (data === loadedData) return;
    loadedData = data;
    warpDirectory = data.warpDirectory;
    if (data.project.id !== loadedProjectId) {
      loadedProjectId = data.project.id;
      s.resetFromData(data);
      newCardSeq = 0;
      sidebarsVisible = data.uiConfig.defaultShowSidePanel;
      showFooters = data.uiConfig.defaultShowFooter;
      warpsVisible = data.uiConfig.defaultShowWarps;
      zoom = data.uiConfig.defaultZoom;
      // Warping in from another project reuses this component, so the canvas never
      // remounts and its `initialCenter` never runs again: the landing happens here.
      landOnWarpFromUrl();
    } else {
      s.refreshFromData(data);
    }
  });

  /**
   * The warp named by `?warp=`, which is how a jump to another project says where it was
   * headed. Null whenever the id is absent or belongs to a warp this project no longer has.
   */
  function warpFromUrl() {
    // Only in the browser: prerendering a static export forbids reading the query, and a
    // warp landing is a client-side scroll anyway.
    if (!browser) return null;
    const warpId = page.url.searchParams.get("warp");
    return warpId ? (s.warps.find(({ id }) => id === warpId) ?? null) : null;
  }

  function landOnWarpFromUrl() {
    const target = untrack(warpFromUrl);
    if (!target) return;
    s.focusedWarpId = target.id;
    tick().then(() => {
      canvasComponent.centerOn(target.posX, target.posY);
      clearWarpQuery();
    });
  }

  /**
   * Drops the `?warp=` the jump arrived with, so panning away and reloading does not snap
   * back to it. Best-effort: the URL is cosmetic here, and a router that is not ready yet
   * is not worth an error banner.
   */
  function clearWarpQuery() {
    try {
      replaceState(page.url.pathname, {});
    } catch {
      // Ignored: see above.
    }
  }

  // Remember the layer being worked on, so a reload comes back to it instead of to Base.
  $effect(() => storeActiveLayerId(s.projectId, s.activeLayerId));

  // Resolved before the canvas mounts, so a page loaded with `?warp=` opens on the warp
  // instead of scrolling to it once the middle of the board has already been painted.
  const initialWarp = untrack(warpFromUrl);
  if (initialWarp) untrack(() => (s.focusedWarpId = initialWarp.id));

  onMount(() => {
    if (initialWarp) clearWarpQuery();
  });

  // Keep this long-lived page in sync with writes made by the CLI or another tab.
  // The snapshot endpoint returns the current database state; refreshFromData applies it
  // without resetting the user's current filters or selection.
  onMount(() => {
    // A static export has no /api/snapshot endpoint and no writers to sync with.
    if (readonly) return;
    let refreshing = false;
    const refresh = async () => {
      if (
        refreshing ||
        positionActivityCount > 0 ||
        s.pendingMutations > 0 ||
        document.visibilityState === "hidden"
      )
        return;
      refreshing = true;
      const activityVersion = positionActivityVersion;
      const mutationVersion = s.mutationVersion;
      try {
        const response = await s.fetcher(`/${s.projectId}/api/snapshot`);
        if (response.ok) {
          const snapshot = await response.json();
          if (
            positionActivityCount === 0 &&
            positionActivityVersion === activityVersion &&
            s.pendingMutations === 0 &&
            s.mutationVersion === mutationVersion
          ) {
            s.refreshFromData(snapshot);
          }
        }
      } catch {
        // A later poll retries transient navigation or database failures.
      } finally {
        refreshing = false;
      }
    };
    const interval = window.setInterval(refresh, 1_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", refresh);
    };
  });

  // ── Domain action handlers ────────────────────────────────────
  const actions = createProjectActions(s);

  // ── Composer submit (needs canvas ref for new card position) ──
  async function handleComposerSubmit(id: string | null, content: string, bundleId: string) {
    if (id) {
      const res = await updateCard(s.mutationFetcher, data.project.id, id, { content, bundleId });
      if (!res.ok) { s.setError("Failed to save card"); return; }
      s.cards = s.cards.map((c) => (c.id === id ? { ...c, content, bundleId } : c));
      s.selection.composerCard = null;
    } else {
      const { posX, posY } = canvasComponent.getNewCardPosition(newCardSeq++);
      const scopeId = s.sidebar.activeScope;
      const layerId = s.activeLayerId;
      // Only cards on the same layer compete for stacking, so the new card starts above them.
      const zIndex = maxZIndex(s.cards.filter((c) => c.layerId === layerId)) + 1;
      const res = await createCard(s.mutationFetcher, data.project.id, {
        bundleId,
        content,
        posX,
        posY,
        zIndex,
        ...(scopeId && { scopeId }),
        ...(layerId && { layerId }),
      });
      if (!res.ok) { s.setError("Failed to create card"); return; }
      const created: CardWithGlue | null = await res.json().catch(() => null);
      if (!created) { s.setError("Failed to create card"); return; }
      // The stored row, not a local reconstruction: the server clamps posX/posY to the
      // canvas, so a card composed at the edge would otherwise jump on the next poll.
      s.cards = [...s.cards, created];
      if (scopeId) s.scopeRels = [...s.scopeRels, { scopeId, cardId: created.id }];
    }
  }

  async function handlePersistPositions(positions: CardPositionPatch[]): Promise<boolean> {
    const res = await patchCardPositions(s.mutationFetcher, data.project.id, positions);
    return res.ok;
  }

  async function handleStackOrderChange(cardId: string, direction: "front" | "back") {
    const card = s.cards.find((item) => item.id === cardId);
    if (!card) return;
    const previous = card.zIndex;
    // Stacking is relative to the card's own layer: layer order decides the rest.
    const layerCards = s.cards.filter((item) => item.layerId === card.layerId);
    const zIndex = direction === "front" ? maxZIndex(layerCards) + 1 : minZIndex(layerCards) - 1;
    s.cards = s.cards.map((item) => (item.id === cardId ? { ...item, zIndex } : item));
    const res = await updateCard(s.mutationFetcher, data.project.id, cardId, { zIndex });
    if (!res.ok) {
      s.cards = s.cards.map((item) =>
        item.id === cardId && item.zIndex === zIndex ? { ...item, zIndex: previous } : item,
      );
      s.setError("Failed to change card stacking order");
    }
  }

  /** Fills the palette in with warps another tab or the CLI has set since the page loaded. */
  async function refreshWarpDirectory() {
    // A static export has no endpoint to ask, and nothing can have changed under it.
    if (readonly) return;
    try {
      const res = await fetchWarpDirectory(s.fetcher, s.projectId);
      if (res.ok) warpDirectory = await res.json();
    } catch {
      // The copy that came with the page stays: a stale list beats an empty one.
    }
  }

  function handleWarpJump(entry: WarpListEntry) {
    warpPaletteOpen = false;
    if (entry.projectId === s.projectId) {
      canvasComponent.centerOn(entry.posX, entry.posY);
      s.focusedWarpId = entry.id;
      return;
    }
    // The other project's page decides where its own canvas opens, so the warp travels in
    // the URL rather than in memory — which also makes the jump a link worth sharing.
    void goto(`${base}/${entry.projectId}?warp=${entry.id}`);
  }

  /**
   * Removing from the palette, which is the only way to reach another project's warps: the
   * `x` key only ever acts on the marker this board has focused.
   */
  async function handleWarpDelete(entry: WarpListEntry) {
    if (entry.projectId === s.projectId) {
      // Same path the `x` key takes, so one warp cannot be removed two different ways.
      await actions.handleRemoveWarp(entry.id);
      return;
    }
    const previous = warpDirectory;
    warpDirectory = withoutWarp(warpDirectory, entry.id);
    const res = await deleteWarp(s.mutationFetcher, entry.projectId, entry.id);
    if (!res.ok) {
      warpDirectory = previous;
      s.setError(await failureMessage(res, "Failed to remove warp"));
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    // The palette owns the keyboard while it is open, including the key that closes it.
    if (warpPaletteOpen) return;
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
    if (!readonly && e.key === data.uiConfig.focusCardInputShortcut) {
      e.preventDefault();
      s.selection.composerCard = null;
      s.selection.selectedCards = new Set();
      s.selection.primarySelectedId = null;
      tick().then(() => composerComponent.focusInput());
      return;
    }
    // Below this line the composer's action bar owns the keyboard whenever cards are
    // selected, which is what keeps the warp keys from colliding with it.
    if (s.selection.selectedCards.size > 0) return;
    if (e.key === data.uiConfig.toggleFootersShortcut) showFooters = !showFooters;
    if (e.key === data.uiConfig.togglePanelsShortcut) sidebarsVisible = !sidebarsVisible;
    if (e.key === data.uiConfig.toggleWarpsShortcut) warpsVisible = !warpsVisible;

    const direction = ARROW_DIRECTIONS[e.key];
    if (direction && e.shiftKey) {
      // Any of the four arrows opens the same list: the direction is how the hand already
      // reaches for warping, not a choice of which warps to show.
      e.preventDefault();
      warpPaletteOpen = true;
      void refreshWarpDirectory();
      return;
    }
    if (direction) {
      // Measured from where the view is now, so warping works the same whether you
      // arrived by arrow key or by dragging the canvas.
      const { posX, posY } = canvasComponent.getViewCenter();
      const target = warpInDirection(s.warps, { x: posX, y: posY }, direction);
      if (target) {
        e.preventDefault();
        canvasComponent.centerOn(target.posX, target.posY);
        s.focusedWarpId = target.id;
      }
      return;
    }
    if (readonly) return;
    if (e.key === data.uiConfig.setWarpShortcut) {
      // A warp you cannot see is a warp you cannot remove, so setting one reveals them.
      warpsVisible = true;
      void actions.handleSetWarp(canvasComponent.getWarpPosition());
    }
    if (e.key === data.uiConfig.removeWarpShortcut && s.focusedWarpId) {
      void actions.handleRemoveWarp(s.focusedWarpId);
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class={css({ display: "flex", height: "100vh", overflow: "hidden", backgroundColor: "ink.lighter" })}>
  <BundleSidebar
    visible={sidebarsVisible}
    panelWidth={data.uiConfig.leftPanelWidth}
    cards={s.cards}
    bundles={bundlesWithColors}
    bind:activeBundle={s.sidebar.activeBundle}
    bind:newBundleName={s.sidebar.newBundleName}
    onCreateBundle={actions.handleCreateBundle}
    onDeleteBundle={actions.handleDeleteBundle}
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
      {bundleColorById}
      bind:selectedCards={s.selection.selectedCards}
      bind:primarySelectedId={s.selection.primarySelectedId}
      bind:composerCard={s.selection.composerCard}
      {scopeCardIds}
      warps={s.warps}
      focusedWarpId={s.focusedWarpId}
      {warpsVisible}
      warpMarkerSize={data.uiConfig.warpMarkerSize}
      initialCenter={initialWarp && { posX: initialWarp.posX, posY: initialWarp.posY }}
      onFocusWarp={(warpId) => (s.focusedWarpId = warpId)}
      {showFooters}
      bind:zoom
      zoomStep={data.uiConfig.zoomStep}
      canvasWidth={data.uiConfig.canvasWidth}
      canvasHeight={data.uiConfig.canvasHeight}
      cardWidth={data.uiConfig.defaultCardWidth}
      newCardPlacement={data.uiConfig.newCardPlacement}
      fontSize={data.uiConfig.defaultFontSize}
      fontFamily={data.uiConfig.defaultFontFamily}
      onPersistPositions={handlePersistPositions}
      onPositionActivityStart={startPositionActivity}
      onPositionActivityEnd={endPositionActivity}
      onError={(msg) => (s.lastError = msg)}
      {readonly}
    />

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

    <FloatingControls
      {zoom}
      zoomStep={data.uiConfig.zoomStep}
      {sidebarsVisible}
      onToggleSidebars={() => (sidebarsVisible = !sidebarsVisible)}
      onZoom={(delta) => (zoom = clampZoom(zoom + delta))}
    />

    {#if !readonly}
    <FloatingComposer
      bind:this={composerComponent}
      editingCard={s.selection.composerCard}
      selectedCards={selectedCardObjects}
      {selectionGlueRels}
      {primaryCard}
      bundles={bundlesWithColors}
      {defaultBundleId}
      layers={s.layers}
      onSubmit={handleComposerSubmit}
      onCancel={() => { s.selection.composerCard = null; s.selection.selectedCards = new Set(); s.selection.primarySelectedId = null; }}
      onBundleChange={actions.handleCardBundleChange}
      onSelectionBundleChange={actions.handleSelectionBundleChange}
      onGlueSelected={actions.handleGlueSelected}
      onUnglueSelected={actions.handleUnglueSelected}
      onUnglueOne={actions.handleUnglueOne}
      onDeleteSelected={actions.handleDeleteSelected}
      otherProjects={data.otherProjects}
      onMoveToProject={actions.handleMoveSelectionToProject}
      onSelectionLayerChange={actions.handleSelectionLayerChange}
      onStackOrderChange={handleStackOrderChange}
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
    selectedCards={s.selection.selectedCards}
    bind:activeScope={s.sidebar.activeScope}
    bind:newScopeName={s.sidebar.newScopeName}
    bind:newWcName={s.sidebar.newWcName}
    onCreateScope={actions.handleCreateScope}
    onDeleteScope={actions.handleDeleteScope}
    onAddToScope={actions.handleAddToScope}
    onRemoveFromScope={actions.handleRemoveFromScope}
    onCreateTaskspace={actions.handleCreateTaskspace}
    {readonly}
  />
</div>
