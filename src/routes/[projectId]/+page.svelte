<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import type { PageProps } from "./$types";
  import { css } from "styled-system/css";
  import { createCard, updateCard, patchCardPositions } from "./lib/project-api";
  import { applyPalette, clampZoom } from "./lib/project-page";
  import type { CardPositionPatch } from "./lib/project-page";
  import { ProjectState } from "./project-state.svelte";
  import { createProjectActions } from "./project-actions.svelte";
  import BundleSidebar from "./components/BundleSidebar.svelte";
  import ScopeSidebar from "./components/ScopeSidebar.svelte";
  import KozaneCanvas from "./components/KozaneCanvas.svelte";
  import FloatingControls from "./components/FloatingControls.svelte";
  import FloatingComposer from "./components/FloatingComposer.svelte";
  import ErrorBanner from "./components/ErrorBanner.svelte";

  let { data }: PageProps = $props();

  // Static exports (kozane net ssg generate) are read-only: no mutation endpoints exist, so all
  // editing affordances and the live-sync poll are disabled. Build-wide and constant.
  const readonly = untrack(() => data.readonly);

  // ── Reactive project state ────────────────────────────────────
  const s = new ProjectState();
  s.projectId = untrack(() => data.project.id);
  s.fetcher = fetch;
  s.cards = untrack(() => data.cards);
  s.bundles = untrack(() => data.bundles);
  s.scopes = untrack(() => data.scopes);
  s.scopeRels = untrack(() => data.scopeRels);
  s.glueRels = untrack(() => data.glueRels);
  s.workingCopies = untrack(() => data.workingCopies);

  // ── UI state ──────────────────────────────────────────────────
  let sidebarsVisible = $state(untrack(() => data.uiConfig.defaultShowSidePanel));
  let showFooters = $state(untrack(() => data.uiConfig.defaultShowFooter));
  let zoom = $state(untrack(() => data.uiConfig.defaultZoom));
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
  let canvasComponent: { getNewCardPosition: (seq: number) => { posX: number; posY: number } } = $state()!;
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

  // ── Reset on project navigation ───────────────────────────────
  let loadedProjectId = $state(untrack(() => data.project.id));
  let loadedData = $state.raw(untrack(() => data));

  $effect(() => {
    if (data === loadedData) return;
    loadedData = data;
    if (data.project.id !== loadedProjectId) {
      loadedProjectId = data.project.id;
      s.resetFromData(data);
      newCardSeq = 0;
      sidebarsVisible = data.uiConfig.defaultShowSidePanel;
      showFooters = data.uiConfig.defaultShowFooter;
      zoom = data.uiConfig.defaultZoom;
    } else {
      s.refreshFromData(data);
    }
  });

  // Keep this long-lived page in sync with writes made by the CLI or another tab.
  // The snapshot endpoint returns the current database state; refreshFromData applies it
  // without resetting the user's current filters or selection.
  onMount(() => {
    // A static export has no /api/snapshot endpoint and no writers to sync with.
    if (readonly) return;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing || positionActivityCount > 0 || document.visibilityState === "hidden") return;
      refreshing = true;
      const activityVersion = positionActivityVersion;
      try {
        const response = await s.fetcher(`/${s.projectId}/api/snapshot`);
        if (response.ok) {
          const snapshot = await response.json();
          if (positionActivityCount === 0 && positionActivityVersion === activityVersion) {
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
      const res = await updateCard(s.fetcher, data.project.id, id, { content, bundleId });
      if (!res.ok) { s.setError("Failed to save card"); return; }
      s.cards = s.cards.map((c) => (c.id === id ? { ...c, content, bundleId } : c));
      s.selection.composerCard = null;
    } else {
      const { posX, posY } = canvasComponent.getNewCardPosition(newCardSeq++);
      const scopeId = s.sidebar.activeScope;
      const zIndex = Math.max(0, ...s.cards.map((card) => card.zIndex ?? 0)) + 1;
      const res = await createCard(s.fetcher, data.project.id, {
        bundleId,
        content,
        posX,
        posY,
        zIndex,
        ...(scopeId && { scopeId }),
      });
      if (!res.ok) { s.setError("Failed to create card"); return; }
      const parsed = await res.json().catch(() => null);
      if (!parsed) { s.setError("Failed to create card"); return; }
      s.cards = [...s.cards, { id: parsed.id, bundleId, content, posX, posY, zIndex, glueId: null, workingCopyId: null }];
      if (scopeId) s.scopeRels = [...s.scopeRels, { scopeId, cardId: parsed.id }];
    }
  }

  async function handlePersistPositions(positions: CardPositionPatch[]): Promise<boolean> {
    const res = await patchCardPositions(s.fetcher, data.project.id, positions);
    return res.ok;
  }

  async function handleLayerChange(cardId: string, direction: "front" | "back") {
    const card = s.cards.find((item) => item.id === cardId);
    if (!card) return;
    const previous = card.zIndex ?? 0;
    const layers = s.cards.map((item) => item.zIndex ?? 0);
    const zIndex = direction === "front" ? Math.max(...layers) + 1 : Math.min(...layers) - 1;
    s.cards = s.cards.map((item) => (item.id === cardId ? { ...item, zIndex } : item));
    const res = await updateCard(s.fetcher, data.project.id, cardId, { zIndex });
    if (!res.ok) {
      s.cards = s.cards.map((item) =>
        item.id === cardId && item.zIndex === zIndex ? { ...item, zIndex: previous } : item,
      );
      s.setError("Failed to change card layer");
    }
  }

  function handleKeydown(e: KeyboardEvent) {
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
    if (s.selection.selectedCards.size > 0) return;
    if (e.key === data.uiConfig.toggleFootersShortcut) showFooters = !showFooters;
    if (e.key === data.uiConfig.togglePanelsShortcut) sidebarsVisible = !sidebarsVisible;
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
      {bundleColorById}
      bind:selectedCards={s.selection.selectedCards}
      bind:primarySelectedId={s.selection.primarySelectedId}
      bind:composerCard={s.selection.composerCard}
      {scopeCardIds}
      {showFooters}
      bind:zoom
      zoomStep={data.uiConfig.zoomStep}
      canvasWidth={data.uiConfig.canvasWidth}
      canvasHeight={data.uiConfig.canvasHeight}
      cardWidth={data.uiConfig.defaultCardWidth}
      fontSize={data.uiConfig.defaultFontSize}
      fontFamily={data.uiConfig.defaultFontFamily}
      onPersistPositions={handlePersistPositions}
      onPositionActivityStart={startPositionActivity}
      onPositionActivityEnd={endPositionActivity}
      onError={(msg) => (s.lastError = msg)}
      {readonly}
    />

    {#if s.lastError}
      <ErrorBanner message={s.lastError} onDismiss={() => (s.lastError = null)} />
    {/if}

    <FloatingControls
      {zoom}
      zoomStep={data.uiConfig.zoomStep}
      {showFooters}
      {sidebarsVisible}
      onToggleFooters={() => (showFooters = !showFooters)}
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
      onLayerChange={handleLayerChange}
      shortcuts={data.uiConfig}
    />
    {/if}
  </div>

  <ScopeSidebar
    visible={sidebarsVisible}
    panelWidth={data.uiConfig.rightPanelWidth}
    scopes={s.scopes}
    scopeRels={s.scopeRels}
    workingCopies={s.workingCopies}
    selectedCards={s.selection.selectedCards}
    bind:activeScope={s.sidebar.activeScope}
    bind:newScopeName={s.sidebar.newScopeName}
    bind:newWcName={s.sidebar.newWcName}
    onCreateScope={actions.handleCreateScope}
    onDeleteScope={actions.handleDeleteScope}
    onAddToScope={actions.handleAddToScope}
    onRemoveFromScope={actions.handleRemoveFromScope}
    onCreateWorkingCopy={actions.handleCreateWorkingCopy}
    {readonly}
  />
</div>
