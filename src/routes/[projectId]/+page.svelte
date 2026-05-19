<script lang="ts">
  import { untrack } from "svelte";
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

  // ── Canvas component ref (for getNewCardPosition) ─────────────
  let canvasComponent: { getNewCardPosition: (seq: number) => { posX: number; posY: number } } = $state()!;

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

  $effect(() => {
    if (data.project.id === loadedProjectId) return;
    loadedProjectId = data.project.id;
    s.projectId = data.project.id;
    s.cards = data.cards;
    s.bundles = data.bundles;
    s.scopes = data.scopes;
    s.scopeRels = data.scopeRels;
    s.glueRels = data.glueRels;
    s.workingCopies = data.workingCopies;
    s.selection.selectedCards = new Set();
    s.selection.primarySelectedId = null;
    s.selection.composerCard = null;
    s.sidebar.activeBundle = null;
    s.sidebar.activeScope = null;
    s.sidebar.newBundleName = "";
    s.sidebar.newScopeName = "";
    s.sidebar.newWcName = "";
    s.lastError = null;
    newCardSeq = 0;
    sidebarsVisible = data.uiConfig.defaultShowSidePanel;
    showFooters = data.uiConfig.defaultShowFooter;
    zoom = data.uiConfig.defaultZoom;
  });

  // ── Domain action handlers ────────────────────────────────────
  const actions = createProjectActions(s);

  // ── Composer submit (needs canvas ref for new card position) ──
  async function handleComposerSubmit(id: string | null, content: string, bundleId: string) {
    if (id) {
      const res = await updateCard(fetch, data.project.id, id, { content, bundleId });
      if (!res.ok) { s.lastError = "Failed to save card"; return; }
      s.cards = s.cards.map((c) => (c.id === id ? { ...c, content, bundleId } : c));
      s.selection.composerCard = null;
    } else {
      const { posX, posY } = canvasComponent.getNewCardPosition(newCardSeq++);
      const res = await createCard(fetch, data.project.id, { bundleId, content, posX, posY });
      if (!res.ok) { s.lastError = "Failed to create card"; return; }
      const { id: newId } = await res.json();
      s.cards = [...s.cards, { id: newId, bundleId, content, posX, posY, glueId: null, workingCopyId: null }];
    }
  }

  async function handlePersistPositions(positions: CardPositionPatch[]): Promise<boolean> {
    const res = await patchCardPositions(fetch, data.project.id, positions);
    return res.ok;
  }

  function handleKeydown(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
    if (e.key === "f") showFooters = !showFooters;
    if (e.key === "b") sidebarsVisible = !sidebarsVisible;
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
      canvasWidth={data.uiConfig.canvasWidth}
      canvasHeight={data.uiConfig.canvasHeight}
      cardWidth={data.uiConfig.defaultCardWidth}
      fontSize={data.uiConfig.defaultFontSize}
      fontFamily={data.uiConfig.defaultFontFamily}
      onPersistPositions={handlePersistPositions}
      onError={(msg) => (s.lastError = msg)}
    />

    {#if s.lastError}
      <ErrorBanner message={s.lastError} onDismiss={() => (s.lastError = null)} />
    {/if}

    <FloatingControls
      {zoom}
      {showFooters}
      {sidebarsVisible}
      onToggleFooters={() => (showFooters = !showFooters)}
      onToggleSidebars={() => (sidebarsVisible = !sidebarsVisible)}
      onZoom={(delta) => (zoom = clampZoom(zoom + delta))}
    />

    <FloatingComposer
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
    />
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
  />
</div>
