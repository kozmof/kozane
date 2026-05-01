<script lang="ts">
  import { untrack } from "svelte";
  import type { PageProps } from "./$types";
  import KozaneCard from "./KozaneCard.svelte";
  import CardComposer from "./CardComposer.svelte";
  import { CANVAS_W, CANVAS_H } from "$lib/constants";

  let { data }: PageProps = $props();

  // ── Constants ──────────────────────────────────────────────────
  const GRID = 24;
  const ZOOM_MIN = 0.25;
  const ZOOM_MAX = 2;
  const ZOOM_STEP = 0.1;

  const PALETTE = [
    { bg: "oklch(93% 0.055 52)", dot: "oklch(62% 0.15 52)" },
    { bg: "oklch(93% 0.055 158)", dot: "oklch(62% 0.15 158)" },
    { bg: "oklch(93% 0.055 272)", dot: "oklch(62% 0.15 272)" },
    { bg: "oklch(93% 0.055 18)", dot: "oklch(62% 0.15 18)" },
    { bg: "oklch(93% 0.055 220)", dot: "oklch(62% 0.15 220)" },
    { bg: "oklch(93% 0.055 100)", dot: "oklch(62% 0.15 100)" },
    { bg: "oklch(93% 0.055 310)", dot: "oklch(62% 0.15 310)" },
    { bg: "oklch(93% 0.055 180)", dot: "oklch(62% 0.15 180)" },
  ];

  // ── State ──────────────────────────────────────────────────────
  let cards = $state(untrack(() => data.cards));
  let scopes = $state(untrack(() => data.scopes));
  let scopeRels = $state(untrack(() => data.scopeRels));

  let selectedCards = $state(new Set<string>());
  let activeBundle = $state<string | null>(null);
  let activeScope = $state<string | null>(null);
  let composerCard = $state<(typeof cards)[0] | null>(null);
  let draggingId = $state<string | null>(null);
  let isPanning = $state(false);
  let sidebarsVisible = $state(true);
  let zoom = $state(1);
  let newScopeName = $state("");

  // ── DOM refs (non-reactive) ────────────────────────────────────
  let canvasEl: HTMLDivElement;

  // Non-reactive event state (updated inside event handlers, not reactive)
  let dragState: {
    cardId: string;
    offsetX: number;
    offsetY: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null = null;

  let panState: {
    startX: number;
    startY: number;
    scrollLeft: number;
    scrollTop: number;
  } | null = null;

  // ── Derived ───────────────────────────────────────────────────
  let bundlesWithColors = $derived(
    data.bundles.map((b, i) => ({ ...b, ...PALETTE[i % PALETTE.length] })),
  );

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

  // ── Window event listeners (drag + pan) ──────────────────────
  $effect(() => {
    function onMove(e: MouseEvent) {
      if (dragState) {
        const { cardId, offsetX, offsetY, startX, startY } = dragState;
        if (Math.abs(e.clientX - startX) > 4 || Math.abs(e.clientY - startY) > 4) {
          dragState.moved = true;
        }
        const rect = canvasEl.getBoundingClientRect();
        const rawX = (e.clientX - rect.left + canvasEl.scrollLeft) / zoom - offsetX;
        const rawY = (e.clientY - rect.top + canvasEl.scrollTop) / zoom - offsetY;
        const x = Math.max(0, Math.round(rawX / GRID) * GRID);
        const y = Math.max(0, Math.round(rawY / GRID) * GRID);
        cards = cards.map((c) => (c.id === cardId ? { ...c, posX: x, posY: y } : c));
      }
      if (panState) {
        const { startX, startY, scrollLeft, scrollTop } = panState;
        canvasEl.scrollLeft = scrollLeft - (e.clientX - startX);
        canvasEl.scrollTop = scrollTop - (e.clientY - startY);
      }
    }

    function onUp() {
      if (dragState) {
        const { cardId, moved } = dragState;
        dragState = null;
        draggingId = null;
        if (moved) {
          const card = cards.find((c) => c.id === cardId);
          if (card) {
            fetch(`/${data.project.id}/api/cards/${cardId}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ posX: card.posX, posY: card.posY }),
            });
          }
        }
      }
      if (panState) {
        panState = null;
        isPanning = false;
      }
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  });

  // ── Zoom (Ctrl+wheel) ─────────────────────────────────────────
  $effect(() => {
    const canvas = canvasEl;
    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const delta = e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const prev = zoom;
      const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round((prev + delta) * 10) / 10));
      const worldX = (canvas.scrollLeft + mouseX) / prev;
      const worldY = (canvas.scrollTop + mouseY) / prev;
      zoom = next;
      requestAnimationFrame(() => {
        canvas.scrollLeft = worldX * next - mouseX;
        canvas.scrollTop = worldY * next - mouseY;
      });
    }
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  });

  // ── Card interaction handlers ─────────────────────────────────
  function handleCardMouseDown(e: MouseEvent, cardId: string) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const card = cards.find((c) => c.id === cardId);
    if (!card) return;
    const rect = canvasEl.getBoundingClientRect();
    dragState = {
      cardId,
      offsetX: (e.clientX - rect.left + canvasEl.scrollLeft) / zoom - card.posX,
      offsetY: (e.clientY - rect.top + canvasEl.scrollTop) / zoom - card.posY,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
    };
    draggingId = cardId;
  }

  function handleCardClick(e: MouseEvent, cardId: string) {
    if (dragState?.moved) return;
    if (e.shiftKey) {
      const next = new Set(selectedCards);
      next.has(cardId) ? next.delete(cardId) : next.add(cardId);
      selectedCards = next;
    } else {
      selectedCards =
        selectedCards.size === 1 && selectedCards.has(cardId)
          ? new Set()
          : new Set([cardId]);
    }
  }

  function handleCardDblClick(cardId: string) {
    if (dragState?.moved) return;
    const card = cards.find((c) => c.id === cardId);
    if (card) composerCard = card;
  }

  function handleCanvasMouseDown(e: MouseEvent) {
    if (e.button !== 0) return;
    if (!e.shiftKey) selectedCards = new Set();
    panState = {
      startX: e.clientX,
      startY: e.clientY,
      scrollLeft: canvasEl.scrollLeft,
      scrollTop: canvasEl.scrollTop,
    };
    isPanning = true;
  }

  function applyZoom(delta: number) {
    zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round((zoom + delta) * 10) / 10));
  }

  // ── Composer ──────────────────────────────────────────────────
  async function handleComposerSubmit(
    id: string | null,
    content: string,
    bundleId: string,
  ) {
    if (id) {
      const res = await fetch(`/${data.project.id}/api/cards/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, bundleId }),
      });
      if (!res.ok) return;
      cards = cards.map((c) => (c.id === id ? { ...c, content, bundleId } : c));
      composerCard = null;
    } else {
      const posX = Math.round((canvasEl.scrollLeft / zoom + 80) / GRID) * GRID;
      const posY = Math.round((canvasEl.scrollTop / zoom + 80) / GRID) * GRID;
      const res = await fetch(`/${data.project.id}/api/cards`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bundleId, content, posX, posY }),
      });
      if (!res.ok) return;
      const { id: newId } = await res.json();
      cards = [
        ...cards,
        { id: newId, bundleId, content, posX, posY, tieCount: 0, workingCopyId: null },
      ];
    }
  }

  // ── Scopes ────────────────────────────────────────────────────
  async function handleCreateScope() {
    if (!newScopeName.trim()) return;
    const res = await fetch(`/${data.project.id}/api/scopes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newScopeName.trim() }),
    });
    if (!res.ok) return;
    const { id } = await res.json();
    scopes = [...scopes, { id, name: newScopeName.trim() }];
    newScopeName = "";
  }

  async function handleAddToScope(scopeId: string) {
    if (selectedCards.size === 0) return;
    const cardIds = [...selectedCards];
    const res = await fetch(`/${data.project.id}/api/scopes/${scopeId}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardIds }),
    });
    if (!res.ok) return;
    const newRels = cardIds
      .filter((cid) => !scopeRels.some((r) => r.scopeId === scopeId && r.cardId === cid))
      .map((cardId) => ({ scopeId, cardId }));
    scopeRels = [...scopeRels, ...newRels];
    selectedCards = new Set();
  }

  // ── Sidebar helpers ───────────────────────────────────────────
  function sideBtn(active: boolean) {
    return active ? "side-btn active" : "side-btn";
  }
</script>

<div class="app">
  <!-- ── Left sidebar: Bundles ── -->
  <aside class="sidebar-left" style:width={sidebarsVisible ? "216px" : "0"}>
    <div class="logo">
      <span class="logo-name">kozane</span>
      <span class="logo-ja">こざね</span>
    </div>

    <div class="section">
      <div class="section-label">Bundles</div>
      <div class="btn-list">
        <button class={sideBtn(activeBundle === null)} onclick={() => (activeBundle = null)}>
          <span class="dot" style:background="#b8b2a8"></span>
          <span class="flex-1">All cards</span>
          <span class="count">{cards.length}</span>
        </button>

        {#each bundlesWithColors as b (b.id)}
          {@const active = activeBundle === b.id}
          <button
            class={sideBtn(active)}
            style:background={active ? b.bg : "transparent"}
            onclick={() => (activeBundle = active ? null : b.id)}
          >
            <span class="dot" style:background={b.dot}></span>
            <span class="flex-1">{b.name}</span>
            <span class="count">{cards.filter((c) => c.bundleId === b.id).length}</span>
          </button>
        {/each}
      </div>
    </div>
  </aside>

  <!-- ── Center column: canvas + overlays ── -->
  <div class="center">
    <!-- Canvas -->
    <div
      class="canvas"
      role="presentation"
      bind:this={canvasEl}
      onmousedown={handleCanvasMouseDown}
      style:cursor={draggingId || isPanning ? "grabbing" : "grab"}
    >
      <!-- Scroll spacer (scaled outer) -->
      <div
        style:width="{CANVAS_W * zoom}px"
        style:height="{CANVAS_H * zoom}px"
        style:position="relative"
        style:flex-shrink="0"
      >
        <!-- Scaled inner canvas -->
        <div
          style:width="{CANVAS_W}px"
          style:height="{CANVAS_H}px"
          style:position="absolute"
          style:top="0"
          style:left="0"
          style:transform="scale({zoom})"
          style:transform-origin="0 0"
        >
          <!-- Dot grid -->
          <svg
            style:position="absolute"
            style:inset="0"
            style:width="100%"
            style:height="100%"
            style:pointer-events="none"
          >
            <defs>
              <pattern id="dotgrid" width={GRID} height={GRID} patternUnits="userSpaceOnUse">
                <circle cx={GRID / 2} cy={GRID / 2} r="0.9" fill="#dedad4" />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#dotgrid)" />
          </svg>

          <!-- Cards -->
          {#each visibleCards as card (card.id)}
            {@const color = bundleColorById.get(card.bundleId) ?? {
              bg: PALETTE[0].bg,
              dot: PALETTE[0].dot,
              name: "Unknown",
            }}
            <KozaneCard
              {card}
              {color}
              isSelected={selectedCards.has(card.id)}
              isComposing={composerCard?.id === card.id}
              dimmed={scopeCardIds !== null && !scopeCardIds.has(card.id)}
              isDragging={draggingId === card.id}
              onCardMouseDown={(e) => handleCardMouseDown(e, card.id)}
              onCardClick={(e) => handleCardClick(e, card.id)}
              onCardDblClick={() => handleCardDblClick(card.id)}
            />
          {/each}
        </div>
      </div>
    </div>

    <!-- Sidebar toggle -->
    <button
      class="sidebar-toggle"
      title={sidebarsVisible ? "Hide panels" : "Show panels"}
      onclick={() => (sidebarsVisible = !sidebarsVisible)}
    >
      <svg width="14" height="10" viewBox="0 0 14 10" fill="none">
        {#if sidebarsVisible}
          <rect x="0" y="0" width="4" height="10" rx="1" fill="#9e9890" />
          <rect x="5.5" y="0" width="8.5" height="10" rx="1" fill="#cdc8be" />
        {:else}
          <rect x="0" y="0" width="4" height="10" rx="1" fill="#cdc8be" />
          <rect x="5.5" y="0" width="8.5" height="10" rx="1" fill="#9e9890" />
        {/if}
      </svg>
    </button>

    <!-- Zoom controls -->
    <div class="zoom-controls">
      {#each [["−", -ZOOM_STEP], ["+", ZOOM_STEP]] as [label, delta] (label)}
        <button class="zoom-btn" onclick={() => applyZoom(delta as number)}>{label}</button>
      {/each}
      <div class="zoom-pct">{Math.round(zoom * 100)}%</div>
    </div>

    <!-- Floating composer -->
    <div class="composer-wrap">
      <CardComposer
        editingCard={composerCard}
        bundles={bundlesWithColors}
        {defaultBundleId}
        onSubmit={handleComposerSubmit}
        onCancel={() => (composerCard = null)}
      />
    </div>
  </div>

  <!-- ── Right sidebar: Scopes ── -->
  <aside class="sidebar-right" style:width={sidebarsVisible ? "232px" : "0"}>
    <div class="scopes-header">
      <div class="section-label">Scopes</div>
    </div>

    {#if selectedCards.size > 0}
      <div class="selection-pill">
        <span><strong>{selectedCards.size}</strong> card{selectedCards.size > 1 ? "s" : ""} selected</span>
        <button class="clear-sel" onclick={() => (selectedCards = new Set())}>×</button>
      </div>
    {/if}

    <div class="scope-list">
      {#each scopes as scope (scope.id)}
        {@const active = activeScope === scope.id}
        <div class="scope-item" class:active>
          <button
            class={sideBtn(active)}
            onclick={() => (activeScope = active ? null : scope.id)}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <rect x="1" y="1" width="8" height="8" rx="1" stroke="#9a9490" stroke-width="1.2" />
              <path d="M3 5h4M3 3.5h2" stroke="#9a9490" stroke-width="1" stroke-linecap="round" />
            </svg>
            <span class="flex-1">{scope.name}</span>
            <span class="count">
              {scopeRels.filter((r) => r.scopeId === scope.id).length}
            </span>
          </button>

          {#if selectedCards.size > 0}
            <button class="add-to-scope" onclick={() => handleAddToScope(scope.id)}>
              <span>Add selected to scope</span>
              <span>→</span>
            </button>
          {/if}
        </div>
      {/each}
    </div>

    <!-- New scope input -->
    <div class="new-scope">
      <input
        bind:value={newScopeName}
        onkeydown={(e) => e.key === "Enter" && handleCreateScope()}
        placeholder="New scope…"
      />
      <button class="add-scope-btn" onclick={handleCreateScope}>+</button>
    </div>
  </aside>
</div>

<style>
  .app {
    display: flex;
    height: 100vh;
    overflow: hidden;
    background: #f2f2f2;
  }

  /* ── Sidebars ── */
  .sidebar-left,
  .sidebar-right {
    flex-shrink: 0;
    background: #f1f1f1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    transition: width 0.22s ease;
  }

  .sidebar-left {
    border-right: 1px solid #cccccc;
  }

  .sidebar-right {
    border-left: 1px solid #cccccc;
  }

  .logo {
    padding: 18px 20px 14px;
    border-bottom: 1px solid #cccccc;
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .logo-name {
    font-size: 15px;
    font-weight: 500;
    letter-spacing: -0.02em;
    color: #1c1a17;
  }

  .logo-ja {
    font-size: 10px;
    color: #b0aaa2;
    letter-spacing: 0.04em;
  }

  .section {
    padding: 14px 0 8px;
  }

  .section-label {
    padding: 0 20px 8px;
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    color: #9e9890;
    text-transform: uppercase;
  }

  .btn-list {
    padding: 0 8px;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .side-btn {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 7px 10px;
    width: 100%;
    background: transparent;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    text-align: left;
    font-size: 12.5px;
    color: #1c1a17;
    font-family: inherit;
    white-space: nowrap;
    overflow: hidden;
  }

  .side-btn.active {
    background: #ede9e1;
  }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .flex-1 {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .count {
    font-size: 10.5px;
    color: #9e9890;
    flex-shrink: 0;
  }

  /* ── Center column ── */
  .center {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    position: relative;
  }

  .canvas {
    flex: 1;
    overflow: auto;
    position: relative;
    background: #f2f2f2;
  }

  /* ── Overlays ── */
  .sidebar-toggle {
    position: absolute;
    top: 12px;
    right: 16px;
    z-index: 51;
    width: 28px;
    height: 28px;
    border-radius: 6px;
    background: #f1f1f1;
    border: 1px solid #e6e1d8;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.07);
  }

  .zoom-controls {
    position: absolute;
    bottom: 20px;
    right: 16px;
    display: flex;
    align-items: center;
    gap: 1px;
    background: #f1f1f1;
    border-radius: 7px;
    border: 1px solid #cccccc;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
    z-index: 51;
    overflow: hidden;
  }

  .zoom-btn {
    width: 30px;
    height: 28px;
    border: none;
    background: transparent;
    cursor: pointer;
    font-size: 16px;
    color: #5a5650;
    line-height: 1;
    font-family: inherit;
  }

  .zoom-pct {
    padding: 0 8px;
    font-size: 11px;
    color: #918c83;
    border-left: 1px solid #cccccc;
    height: 28px;
    display: flex;
    align-items: center;
    min-width: 40px;
    justify-content: center;
  }

  .composer-wrap {
    position: absolute;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    width: 540px;
    max-width: calc(100% - 40px);
    border-radius: 10px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.13), 0 1px 4px rgba(0, 0, 0, 0.08);
    z-index: 50;
  }

  /* ── Right sidebar ── */
  .scopes-header {
    padding: 18px 20px 14px;
    border-bottom: 1px solid #cccccc;
  }

  .scopes-header .section-label {
    padding: 0;
    margin-bottom: 0;
  }

  .selection-pill {
    margin: 10px 10px 2px;
    padding: 8px 12px;
    background: oklch(93% 0.055 272);
    border-radius: 6px;
    font-size: 11.5px;
    color: oklch(38% 0.15 272);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .clear-sel {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 13px;
    color: oklch(55% 0.15 272);
    line-height: 1;
    padding: 0;
  }

  .scope-list {
    flex: 1;
    overflow-y: auto;
    padding: 8px 8px 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .scope-item {
    border-radius: 6px;
    overflow: hidden;
    border: 1px solid transparent;
  }

  .scope-item.active {
    border-color: #a8a8a8;
  }

  .add-to-scope {
    width: 100%;
    padding: 6px 10px;
    background: #1c1a17;
    color: #f1f1f1;
    border: none;
    border-top: 1px solid #cccccc;
    cursor: pointer;
    font-size: 11px;
    font-family: inherit;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
  }

  .new-scope {
    padding: 10px;
    border-top: 1px solid #cccccc;
    margin-top: 8px;
    display: flex;
    gap: 5px;
  }

  .new-scope input {
    flex: 1;
    padding: 7px 10px;
    border: 1px solid #cccccc;
    border-radius: 6px;
    font-size: 11.5px;
    background: #ffffff;
    font-family: inherit;
    color: #1c1a17;
  }

  .add-scope-btn {
    padding: 7px 11px;
    background: #1c1a17;
    color: #f1f1f1;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 14px;
    font-family: inherit;
    line-height: 1;
  }
</style>
