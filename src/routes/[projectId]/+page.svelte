<script lang="ts">
  import { untrack } from "svelte";
  import type { PageProps } from "./$types";
  import { css } from "styled-system/css";
  import { createCard, updateCard, patchCardPositions } from "./lib/project-api";
  import { applyPalette, GRID, clampZoom } from "./lib/project-page";
  import type { CardPositionPatch } from "./lib/project-page";
  import { createProjectActions } from "./project-actions.svelte";
  import BundleSidebar from "./components/BundleSidebar.svelte";
  import ScopeSidebar from "./components/ScopeSidebar.svelte";
  import KozaneCanvas from "./components/KozaneCanvas.svelte";
  import FloatingControls from "./components/FloatingControls.svelte";
  import FloatingComposer from "./components/FloatingComposer.svelte";
  import ErrorBanner from "./components/ErrorBanner.svelte";

  let { data }: PageProps = $props();

  // ── Project data state ────────────────────────────────────────
  let cards = $state(untrack(() => data.cards));
  let bundles = $state(untrack(() => data.bundles));
  let scopes = $state(untrack(() => data.scopes));
  let scopeRels = $state(untrack(() => data.scopeRels));
  let glueRels = $state(untrack(() => data.glueRels));
  let workingCopies = $state(untrack(() => data.workingCopies));

  // ── Selection / filter state ──────────────────────────────────
  let selectedCards = $state(new Set<string>());
  let primarySelectedId = $state<string | null>(null);
  let activeBundle = $state<string | null>(null);
  let activeScope = $state<string | null>(null);
  let composerCard = $state<(typeof cards)[0] | null>(null);

  // ── UI state ──────────────────────────────────────────────────
  let sidebarsVisible = $state(untrack(() => data.uiConfig.defaultShowSidePanel));
  let showFooters = $state(untrack(() => data.uiConfig.defaultShowFooter));
  let zoom = $state(untrack(() => data.uiConfig.defaultZoom));
  let newBundleName = $state("");
  let newScopeName = $state("");
  let newWcName = $state("");
  let lastError = $state<string | null>(null);
  let newCardSeq = 0;

  // ── Canvas component ref (for getNewCardPosition) ─────────────
  let canvasComponent: { getNewCardPosition: (seq: number) => { posX: number; posY: number } } = $state()!;

  // ── Derived values ────────────────────────────────────────────
  let bundlesWithColors = $derived(applyPalette(bundles));
  let bundleColorById = $derived(new Map(bundlesWithColors.map((b) => [b.id, b])));
  let visibleCards = $derived(
    activeBundle ? cards.filter((c) => c.bundleId === activeBundle) : cards,
  );
  let scopeCardIds = $derived(
    activeScope
      ? new Set(scopeRels.filter((r) => r.scopeId === activeScope).map((r) => r.cardId))
      : null,
  );
  let defaultBundleId = $derived(activeBundle ?? bundlesWithColors[0]?.id ?? "");
  let selectedCardObjects = $derived(
    [...selectedCards].map((id) => cards.find((c) => c.id === id)!).filter(Boolean),
  );
  let selectionGlueRels = $derived(
    glueRels.filter((r) => selectedCards.has(r.cardId)),
  );
  let primaryCard = $derived(
    primarySelectedId ? (cards.find((c) => c.id === primarySelectedId) ?? null) : null,
  );

  // ── Reset on project navigation ───────────────────────────────
  let loadedProjectId = $state(untrack(() => data.project.id));

  $effect(() => {
    if (data.project.id === loadedProjectId) return;
    loadedProjectId = data.project.id;
    cards = data.cards;
    bundles = data.bundles;
    scopes = data.scopes;
    scopeRels = data.scopeRels;
    glueRels = data.glueRels;
    workingCopies = data.workingCopies;
    selectedCards = new Set();
    primarySelectedId = null;
    activeBundle = null;
    activeScope = null;
    composerCard = null;
    lastError = null;
    newBundleName = "";
    newScopeName = "";
    newWcName = "";
    newCardSeq = 0;
    sidebarsVisible = data.uiConfig.defaultShowSidePanel;
    showFooters = data.uiConfig.defaultShowFooter;
    zoom = data.uiConfig.defaultZoom;
  });

  // ── Domain action handlers ────────────────────────────────────
  const actions = createProjectActions({
    get projectId() { return data.project.id; },
    fetcher: fetch,

    get cards() { return cards; },
    set cards(v) { cards = v; },

    get bundles() { return bundles; },
    set bundles(v) { bundles = v; },

    get scopes() { return scopes; },
    set scopes(v) { scopes = v; },

    get scopeRels() { return scopeRels; },
    set scopeRels(v) { scopeRels = v; },

    get glueRels() { return glueRels; },
    set glueRels(v) { glueRels = v; },

    get selectedCards() { return selectedCards; },
    set selectedCards(v) { selectedCards = v; },

    get primarySelectedId() { return primarySelectedId; },
    set primarySelectedId(v) { primarySelectedId = v; },

    get composerCard() { return composerCard; },
    set composerCard(v) { composerCard = v; },

    get activeBundle() { return activeBundle; },
    set activeBundle(v) { activeBundle = v; },

    get activeScope() { return activeScope; },
    set activeScope(v) { activeScope = v; },

    get newBundleName() { return newBundleName; },
    set newBundleName(v) { newBundleName = v; },

    get newScopeName() { return newScopeName; },
    set newScopeName(v) { newScopeName = v; },

    get newWcName() { return newWcName; },
    set newWcName(v) { newWcName = v; },

    get workingCopies() { return workingCopies; },
    set workingCopies(v) { workingCopies = v; },

    setError(message) { lastError = message; },
  });

  // ── Composer submit (needs canvas ref for new card position) ──
  async function handleComposerSubmit(id: string | null, content: string, bundleId: string) {
    if (id) {
      const res = await updateCard(fetch, data.project.id, id, { content, bundleId });
      if (!res.ok) { lastError = "Failed to save card"; return; }
      cards = cards.map((c) => (c.id === id ? { ...c, content, bundleId } : c));
      composerCard = null;
    } else {
      const { posX, posY } = canvasComponent.getNewCardPosition(newCardSeq++);
      const res = await createCard(fetch, data.project.id, { bundleId, content, posX, posY });
      if (!res.ok) { lastError = "Failed to create card"; return; }
      const { id: newId } = await res.json();
      cards = [...cards, { id: newId, bundleId, content, posX, posY, glueId: null, workingCopyId: null }];
    }
  }

  async function handlePersistPositions(positions: CardPositionPatch[]): Promise<boolean> {
    const res = await patchCardPositions(fetch, data.project.id, positions);
    return res.ok;
  }
</script>

<div class={css({ display: "flex", height: "100vh", overflow: "hidden", backgroundColor: "ink.lighter" })}>
  <BundleSidebar
    visible={sidebarsVisible}
    panelWidth={data.uiConfig.leftPanelWidth}
    {cards}
    bundles={bundlesWithColors}
    bind:activeBundle
    bind:newBundleName
    onCreateBundle={actions.handleCreateBundle}
    onDeleteBundle={actions.handleDeleteBundle}
  />

  <div class={css({ flex: "1", display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" })}>
    <KozaneCanvas
      bind:this={canvasComponent}
      bind:cards
      {visibleCards}
      {glueRels}
      {bundleColorById}
      bind:selectedCards
      bind:primarySelectedId
      bind:composerCard
      {scopeCardIds}
      {showFooters}
      bind:zoom
      canvasWidth={data.uiConfig.canvasWidth}
      canvasHeight={data.uiConfig.canvasHeight}
      cardWidth={data.uiConfig.defaultCardWidth}
      fontSize={data.uiConfig.defaultFontSize}
      fontFamily={data.uiConfig.defaultFontFamily}
      onPersistPositions={handlePersistPositions}
      onError={(msg) => (lastError = msg)}
    />

    {#if lastError}
      <ErrorBanner message={lastError} onDismiss={() => (lastError = null)} />
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
      editingCard={composerCard}
      selectedCards={selectedCardObjects}
      {selectionGlueRels}
      {primaryCard}
      bundles={bundlesWithColors}
      {defaultBundleId}
      onSubmit={handleComposerSubmit}
      onCancel={() => { composerCard = null; selectedCards = new Set(); primarySelectedId = null; }}
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
    {scopes}
    {scopeRels}
    {workingCopies}
    {selectedCards}
    bind:activeScope
    bind:newScopeName
    bind:newWcName
    onCreateScope={actions.handleCreateScope}
    onDeleteScope={actions.handleDeleteScope}
    onAddToScope={actions.handleAddToScope}
    onRemoveFromScope={actions.handleRemoveFromScope}
    onCreateWorkingCopy={actions.handleCreateWorkingCopy}
  />
</div>
