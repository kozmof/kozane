<script lang="ts">
  import { untrack } from "svelte";
  import type { PageProps } from "./$types";
  import KozaneCard from "./KozaneCard.svelte";
  import CardComposer from "./CardComposer.svelte";
  import { CANVAS_W, CANVAS_H } from "$lib/constants";
  import { css, cx } from "styled-system/css";

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
  let bundles = $state(untrack(() => data.bundles));
  let scopes = $state(untrack(() => data.scopes));
  let scopeRels = $state(untrack(() => data.scopeRels));
  let glueRels = $state(untrack(() => data.glueRels));

  let selectedCards = $state(new Set<string>());
  let primarySelectedId = $state<string | null>(null);
  let activeBundle = $state<string | null>(null);
  let activeScope = $state<string | null>(null);
  let composerCard = $state<(typeof cards)[0] | null>(null);
  let draggingId = $state<string | null>(null);
  let isPanning = $state(false);
  let sidebarsVisible = $state(true);
  let showFooters = $state(true);
  let zoom = $state(1);
  let newBundleName = $state("");
  let newScopeName = $state("");
  let lastError = $state<string | null>(null);
  let newCardSeq = 0;

  // ── DOM refs (non-reactive) ────────────────────────────────────
  let canvasEl: HTMLDivElement;

  // Non-reactive event state (updated inside event handlers, not reactive)
  let dragState: {
    cardId: string;
    offsetX: number;
    offsetY: number;
    startX: number;
    startY: number;
    prevX: number;
    prevY: number;
    lastX: number;
    lastY: number;
    groupIds: string[];
    groupPrevPositions: Map<string, { x: number; y: number }>;
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
    bundles.map((b, i) => ({ ...b, ...PALETTE[i % PALETTE.length] })),
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

  let selectedCardObjects = $derived(
    [...selectedCards].map((id) => cards.find((c) => c.id === id)!).filter(Boolean),
  );

  let selectionGlueRels = $derived(
    glueRels.filter((r) => selectedCards.has(r.cardId)),
  );

  let primaryCard = $derived(
    primarySelectedId ? (cards.find((c) => c.id === primarySelectedId) ?? null) : null,
  );

  // ── Window event listeners (drag + pan) ──────────────────────
  $effect(() => {
    function onMove(e: MouseEvent) {
      if (dragState) {
        const { cardId, offsetX, offsetY, startX, startY, groupIds } = dragState;
        if (Math.abs(e.clientX - startX) > 4 || Math.abs(e.clientY - startY) > 4) {
          dragState.moved = true;
        }
        const rect = canvasEl.getBoundingClientRect();
        const rawX = (e.clientX - rect.left + canvasEl.scrollLeft) / zoom - offsetX;
        const rawY = (e.clientY - rect.top + canvasEl.scrollTop) / zoom - offsetY;
        const x = Math.max(0, Math.round(rawX / GRID) * GRID);
        const y = Math.max(0, Math.round(rawY / GRID) * GRID);
        const dx = x - dragState.lastX;
        const dy = y - dragState.lastY;
        dragState.lastX = x;
        dragState.lastY = y;
        cards = cards.map((c) => {
          if (c.id === cardId) return { ...c, posX: x, posY: y };
          if (groupIds.includes(c.id))
            return { ...c, posX: Math.max(0, c.posX + dx), posY: Math.max(0, c.posY + dy) };
          return c;
        });
      }
      if (panState) {
        const { startX, startY, scrollLeft, scrollTop } = panState;
        canvasEl.scrollLeft = scrollLeft - (e.clientX - startX);
        canvasEl.scrollTop = scrollTop - (e.clientY - startY);
      }
    }

    async function onUp() {
      if (dragState) {
        const { cardId, moved, prevX, prevY, groupIds, groupPrevPositions } = dragState;
        dragState = null;
        draggingId = null;
        if (moved) {
          const allIds = [cardId, ...groupIds];
          const results = await Promise.all(
            allIds.map((id) => {
              const c = cards.find((c) => c.id === id);
              if (!c) return Promise.resolve({ ok: true } as Response);
              return fetch(`/${data.project.id}/api/cards/${id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ posX: c.posX, posY: c.posY }),
              });
            }),
          );
          if (results.some((r) => !r.ok)) {
            cards = cards.map((c) => {
              if (c.id === cardId) return { ...c, posX: prevX, posY: prevY };
              const prev = groupPrevPositions.get(c.id);
              if (prev) return { ...c, posX: prev.x, posY: prev.y };
              return c;
            });
            lastError = "Failed to save card position";
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

    // BFS through glueRels to find all cards in the same glue group
    const glueRel = glueRels.find((r) => r.cardId === cardId);
    const groupIds = glueRel
      ? glueRels.filter((r) => r.glueId === glueRel.glueId && r.cardId !== cardId).map((r) => r.cardId)
      : [];
    const groupPrevPositions = new Map(
      groupIds.map((id) => {
        const c = cards.find((c) => c.id === id)!;
        return [id, { x: c.posX, y: c.posY }];
      }),
    );

    dragState = {
      cardId,
      offsetX: (e.clientX - rect.left + canvasEl.scrollLeft) / zoom - card.posX,
      offsetY: (e.clientY - rect.top + canvasEl.scrollTop) / zoom - card.posY,
      startX: e.clientX,
      startY: e.clientY,
      prevX: card.posX,
      prevY: card.posY,
      lastX: card.posX,
      lastY: card.posY,
      groupIds,
      groupPrevPositions,
      moved: false,
    };
    draggingId = cardId;
  }

  function glueGroupIds(cardId: string): string[] {
    const rel = glueRels.find((r) => r.cardId === cardId);
    if (!rel) return [cardId];
    return glueRels.filter((r) => r.glueId === rel.glueId).map((r) => r.cardId);
  }

  function handleCardClick(e: MouseEvent, cardId: string) {
    if (dragState?.moved) return;
    if (composerCard && composerCard.id !== cardId) composerCard = null;
    const groupIds = glueGroupIds(cardId);
    if (e.shiftKey) {
      const next = new Set(selectedCards);
      if (next.has(cardId)) {
        groupIds.forEach((id) => next.delete(id));
      } else {
        groupIds.forEach((id) => next.add(id));
      }
      selectedCards = next;
    } else if (selectedCards.has(cardId) && groupIds.length > 1) {
      // Clicking within an already-selected glue group: change primary without clearing selection
      primarySelectedId = cardId;
    } else {
      primarySelectedId = cardId;
      const allSelected =
        groupIds.every((id) => selectedCards.has(id)) &&
        selectedCards.size === groupIds.length;
      selectedCards = allSelected ? new Set() : new Set(groupIds);
    }
  }

  function handleCardDblClick(cardId: string) {
    if (dragState?.moved) return;
    const card = cards.find((c) => c.id === cardId);
    if (card) composerCard = card;
  }

  function handleCanvasMouseDown(e: MouseEvent) {
    if (e.button !== 0) return;
    composerCard = null;
    if (!e.shiftKey) { selectedCards = new Set(); primarySelectedId = null; }
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
      if (!res.ok) {
        lastError = "Failed to save card";
        return;
      }
      cards = cards.map((c) => (c.id === id ? { ...c, content, bundleId } : c));
      composerCard = null;
    } else {
      const step = (newCardSeq % 8) * GRID;
      newCardSeq++;
      const base = -7 * GRID;
      const posX = Math.max(0, Math.round((canvasEl.scrollLeft + canvasEl.clientWidth / 2) / zoom / GRID) * GRID + base + step);
      const posY = Math.max(0, Math.round((canvasEl.scrollTop + canvasEl.clientHeight / 2) / zoom / GRID) * GRID + base + step);
      const res = await fetch(`/${data.project.id}/api/cards`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bundleId, content, posX, posY }),
      });
      if (!res.ok) {
        lastError = "Failed to create card";
        return;
      }
      const { id: newId } = await res.json();
      cards = [
        ...cards,
        { id: newId, bundleId, content, posX, posY, glueId: null, workingCopyId: null },
      ];
    }
  }

  async function handleCardBundleChange(newBundleId: string) {
    if (!composerCard) return;
    const cardId = composerCard.id;
    const res = await fetch(`/${data.project.id}/api/cards/${cardId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundleId: newBundleId }),
    });
    if (!res.ok) {
      lastError = "Failed to change bundle";
      return;
    }
    cards = cards.map((c) => (c.id === cardId ? { ...c, bundleId: newBundleId } : c));
  }

  // ── Selection ─────────────────────────────────────────────────
  async function handleSelectionBundleChange(cardIds: string[], newBundleId: string) {
    const results = await Promise.all(
      cardIds.map((id) =>
        fetch(`/${data.project.id}/api/cards/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bundleId: newBundleId }),
        }),
      ),
    );
    if (results.some((r) => !r.ok)) {
      lastError = "Failed to change bundle for selected cards";
      return;
    }
    cards = cards.map((c) => (cardIds.includes(c.id) ? { ...c, bundleId: newBundleId } : c));
  }

  async function handleGlueSelected(cardIds: string[]) {
    const res = await fetch(`/${data.project.id}/api/glues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardIds }),
    });
    if (!res.ok) {
      lastError = "Failed to glue cards";
      return;
    }
    const { glueId } = await res.json();
    // Remove old glueRel entries for these cards, add new ones
    glueRels = [
      ...glueRels.filter((r) => !cardIds.includes(r.cardId)),
      ...cardIds.map((cardId) => ({ glueId, cardId })),
    ];
    cards = cards.map((c) => (cardIds.includes(c.id) ? { ...c, glueId } : c));
  }

  async function handleUnglueOne(cardId: string) {
    const res = await fetch(`/${data.project.id}/api/glues`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardIds: [cardId] }),
    });
    if (!res.ok) {
      lastError = "Failed to unglue card";
      return;
    }
    glueRels = glueRels.filter((r) => r.cardId !== cardId);
    cards = cards.map((c) => (c.id === cardId ? { ...c, glueId: null } : c));
  }

  async function handleUnglueSelected(cardIds: string[]) {
    const res = await fetch(`/${data.project.id}/api/glues`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardIds }),
    });
    if (!res.ok) {
      lastError = "Failed to unglue cards";
      return;
    }
    glueRels = glueRels.filter((r) => !cardIds.includes(r.cardId));
    cards = cards.map((c) => (cardIds.includes(c.id) ? { ...c, glueId: null } : c));
  }

  // ── Bundles ───────────────────────────────────────────────────
  async function handleCreateBundle() {
    if (!newBundleName.trim()) return;
    const res = await fetch(`/${data.project.id}/api/bundles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newBundleName.trim() }),
    });
    if (!res.ok) {
      lastError = "Failed to create bundle";
      return;
    }
    const { id } = await res.json();
    bundles = [...bundles, { id, projectId: data.project.id, name: newBundleName.trim(), isDefault: false }];
    newBundleName = "";
  }

  async function handleDeleteBundle(bundleId: string) {
    const res = await fetch(`/${data.project.id}/api/bundles/${bundleId}`, { method: "DELETE" });
    if (!res.ok) {
      lastError = "Failed to delete bundle";
      return;
    }
    const { defaultBundleId } = await res.json();
    cards = cards.map((c) => c.bundleId === bundleId ? { ...c, bundleId: defaultBundleId } : c);
    bundles = bundles.filter((b) => b.id !== bundleId);
    if (activeBundle === bundleId) activeBundle = null;
  }

  // ── Scopes ────────────────────────────────────────────────────
  async function handleCreateScope() {
    if (!newScopeName.trim()) return;
    const res = await fetch(`/${data.project.id}/api/scopes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newScopeName.trim() }),
    });
    if (!res.ok) {
      lastError = "Failed to create scope";
      return;
    }
    const { id } = await res.json();
    scopes = [...scopes, { id, name: newScopeName.trim() }];
    newScopeName = "";
  }

  async function handleDeleteScope(scopeId: string) {
    const res = await fetch(`/${data.project.id}/api/scopes/${scopeId}`, { method: "DELETE" });
    if (!res.ok) {
      lastError = "Failed to delete scope";
      return;
    }
    scopes = scopes.filter((s) => s.id !== scopeId);
    scopeRels = scopeRels.filter((r) => r.scopeId !== scopeId);
    if (activeScope === scopeId) activeScope = null;
  }

  async function handleAddToScope(scopeId: string) {
    if (selectedCards.size === 0) return;
    const cardIds = [...selectedCards];
    const res = await fetch(`/${data.project.id}/api/scopes/${scopeId}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardIds }),
    });
    if (!res.ok) {
      lastError = "Failed to add cards to scope";
      return;
    }
    const newRels = cardIds
      .filter((cid) => !scopeRels.some((r) => r.scopeId === scopeId && r.cardId === cid))
      .map((cardId) => ({ scopeId, cardId }));
    scopeRels = [...scopeRels, ...newRels];
    selectedCards = new Set();
  }

  async function handleRemoveFromScope(scopeId: string) {
    if (selectedCards.size === 0) return;
    const cardIds = [...selectedCards];
    const res = await fetch(`/${data.project.id}/api/scopes/${scopeId}/members`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardIds }),
    });
    if (!res.ok) {
      lastError = "Failed to remove cards from scope";
      return;
    }
    scopeRels = scopeRels.filter((r) => !(r.scopeId === scopeId && cardIds.includes(r.cardId)));
    selectedCards = new Set();
  }

  // ── Shared classes (reused inside each-loops or conditional) ──
  const dotClass = css({ width: "7px", height: "7px", borderRadius: "50%", flexShrink: "0" });
  const flex1Class = css({ flex: "1", overflow: "hidden", textOverflow: "ellipsis" });
  const countClass = css({ fontSize: "10.5px", color: "warm.subtle", flexShrink: "0" });

  const sideBtnBase = css({
    display: "flex",
    alignItems: "center",
    gap: "9px",
    padding: "7px 10px",
    width: "100%",
    background: "transparent",
    border: "none",
    borderRadius: "6px",
    cursor: "pointer",
    textAlign: "left",
    fontSize: "12.5px",
    color: "ink.black",
    fontFamily: "inherit",
    whiteSpace: "nowrap",
    overflow: "hidden",
  });
  const sideBtnActiveClass = css({ backgroundColor: "warm.bg" });

  function sideBtn(active: boolean) {
    return cx(sideBtnBase, active && sideBtnActiveClass);
  }
</script>

<div class={css({ display: "flex", height: "100vh", overflow: "hidden", backgroundColor: "ink.lighter" })}>
  <!-- ── Left sidebar: Bundles ── -->
  <aside
    class={css({
      flexShrink: "0",
      backgroundColor: "ink.light",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
      transition: "width 0.22s ease",
      borderRight: "1px solid token(colors.warm.dim)",
    })}
    style:width={sidebarsVisible ? "216px" : "0"}
  >
    <div class={css({ padding: "10px 12px", borderBottom: "1px solid token(colors.warm.dim)" })}>
      <a
        href="/"
        class={css({
          display: "flex",
          alignItems: "center",
          gap: "6px",
          padding: "6px 8px",
          borderRadius: "6px",
          textDecoration: "none",
          color: "ink.secondary",
          fontSize: "12.5px",
          "&:hover": { backgroundColor: "warm.bg", color: "ink.black" },
        })}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M8 1L3 6l5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        Projects
      </a>
    </div>

    <div class={css({ flex: "1", overflowY: "auto", padding: "14px 0 8px" })}>
      <div class={css({ padding: "0 8px", display: "flex", flexDirection: "column", gap: "1px" })}>
        <button class={sideBtn(activeBundle === null)} onclick={() => (activeBundle = null)}>
          <span class={dotClass} style:background="var(--colors-warm-faded)"></span>
          <span class={flex1Class}>All cards</span>
          <span class={countClass}>{cards.length}</span>
        </button>

        {#each bundlesWithColors as b (b.id)}
          {@const active = activeBundle === b.id}
          <div class={css({ position: "relative", "&:hover .bundle-delete": { opacity: "1" } })}>
            <button
              class={cx(sideBtn(active), css({ paddingRight: "28px" }))}
              style:background={active ? b.bg : "transparent"}
              onclick={() => (activeBundle = active ? null : b.id)}
            >
              <span class={dotClass} style:background={b.dot}></span>
              <span class={flex1Class}>{b.name}</span>
              <span class={countClass}>{cards.filter((c) => c.bundleId === b.id).length}</span>
            </button>
            {#if !b.isDefault}
            <button
              class={cx("bundle-delete", css({
                position: "absolute",
                right: "6px",
                top: "50%",
                transform: "translateY(-50%)",
                width: "18px",
                height: "18px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "none",
                border: "none",
                cursor: "pointer",
                borderRadius: "3px",
                fontSize: "13px",
                color: "warm.subtle",
                opacity: "0",
                transition: "opacity 0.12s, color 0.12s",
                "&:hover": { color: "state.error" },
              }))}
              title="Delete bundle"
              onclick={(e) => { e.stopPropagation(); handleDeleteBundle(b.id); }}
            >×</button>
            {/if}
          </div>
        {/each}
      </div>
    </div>

    <!-- New bundle input -->
    <div class={css({ padding: "10px", borderTop: "1px solid token(colors.warm.dim)", display: "flex", gap: "5px" })}>
      <input
        class={css({ flex: "1", padding: "7px 10px", border: "1px solid token(colors.warm.dim)", borderRadius: "6px", fontSize: "11.5px", background: "ink.white", fontFamily: "inherit", color: "ink.black" })}
        bind:value={newBundleName}
        onkeydown={(e) => e.key === "Enter" && handleCreateBundle()}
        placeholder="New bundle…"
      />
      <button
        class={css({ padding: "7px 11px", backgroundColor: "ink.black", color: "ink.light", border: "none", borderRadius: "6px", cursor: "pointer", fontSize: "14px", fontFamily: "inherit", lineHeight: "1" })}
        onclick={handleCreateBundle}
      >+</button>
    </div>
  </aside>

  <!-- ── Center column: canvas + overlays ── -->
  <div class={css({ flex: "1", display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" })}>
    <!-- Canvas -->
    <div
      class={css({ flex: "1", overflow: "auto", position: "relative", backgroundColor: "ink.lighter" })}
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
                <circle cx={GRID / 2} cy={GRID / 2} r="0.9" fill="var(--colors-warm-grid)" />
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
              isPrimaryUnglue={card.id === primarySelectedId && !!card.glueId}
              isComposing={composerCard?.id === card.id}
              dimmed={scopeCardIds !== null && !scopeCardIds.has(card.id)}
              isDragging={draggingId === card.id}
              {showFooters}
              onCardMouseDown={(e) => handleCardMouseDown(e, card.id)}
              onCardClick={(e) => handleCardClick(e, card.id)}
              onCardDblClick={() => handleCardDblClick(card.id)}
            />
          {/each}
        </div>
      </div>
    </div>

    <!-- Error banner -->
    {#if lastError}
      <div
        class={css({
          position: "absolute",
          top: "12px",
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: "52",
          display: "flex",
          alignItems: "center",
          gap: "10px",
          padding: "8px 14px",
          background: "state.error",
          color: "#fff",
          borderRadius: "7px",
          fontSize: "12.5px",
          boxShadow: "0 2px 10px rgba(0,0,0,0.18)",
          whiteSpace: "nowrap",
        })}
        role="alert"
      >
        <span>{lastError}</span>
        <button
          class={css({ background: "none", border: "none", color: "rgba(255,255,255,0.75)", cursor: "pointer", fontSize: "15px", lineHeight: "1", padding: "0", flexShrink: "0" })}
          onclick={() => (lastError = null)}
        >×</button>
      </div>
    {/if}

    <!-- Footer toggle -->
    <button
      class={css({
        position: "absolute",
        top: "12px",
        right: "52px",
        zIndex: "51",
        width: "28px",
        height: "28px",
        borderRadius: "6px",
        backgroundColor: "ink.light",
        border: "1px solid token(colors.warm.border)",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: "0 1px 4px rgba(0,0,0,0.07)",
      })}
      title={showFooters ? "Hide footers" : "Show footers"}
      onclick={() => (showFooters = !showFooters)}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <rect x="0" y="0" width="12" height="8" rx="1.5"
          fill={showFooters ? "var(--colors-warm-icon)" : "var(--colors-warm-subtle)"} />
        <rect x="0" y="9" width="12" height="3" rx="1"
          fill={showFooters ? "var(--colors-warm-subtle)" : "var(--colors-warm-icon)"} />
      </svg>
    </button>

    <!-- Sidebar toggle -->
    <button
      class={css({
        position: "absolute",
        top: "12px",
        right: "16px",
        zIndex: "51",
        width: "28px",
        height: "28px",
        borderRadius: "6px",
        backgroundColor: "ink.light",
        border: "1px solid token(colors.warm.border)",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: "0 1px 4px rgba(0,0,0,0.07)",
      })}
      title={sidebarsVisible ? "Hide panels" : "Show panels"}
      onclick={() => (sidebarsVisible = !sidebarsVisible)}
    >
      <svg width="14" height="10" viewBox="0 0 14 10" fill="none">
        {#if sidebarsVisible}
          <rect x="0" y="0" width="4" height="10" rx="1" fill="var(--colors-warm-subtle)" />
          <rect x="5.5" y="0" width="8.5" height="10" rx="1" fill="var(--colors-warm-icon)" />
        {:else}
          <rect x="0" y="0" width="4" height="10" rx="1" fill="var(--colors-warm-icon)" />
          <rect x="5.5" y="0" width="8.5" height="10" rx="1" fill="var(--colors-warm-subtle)" />
        {/if}
      </svg>
    </button>

    <!-- Zoom controls -->
    <div
      class={css({
        position: "absolute",
        bottom: "20px",
        right: "16px",
        display: "flex",
        alignItems: "center",
        gap: "1px",
        backgroundColor: "ink.light",
        borderRadius: "7px",
        border: "1px solid token(colors.warm.dim)",
        boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
        zIndex: "51",
        overflow: "hidden",
      })}
    >
      {#each [["−", -ZOOM_STEP], ["+", ZOOM_STEP]] as [label, delta] (label)}
        <button
          class={css({ width: "30px", height: "28px", border: "none", background: "transparent", cursor: "pointer", fontSize: "16px", color: "ink.secondary", lineHeight: "1", fontFamily: "inherit" })}
          onclick={() => applyZoom(delta as number)}
        >{label}</button>
      {/each}
      <div class={css({ padding: "0 8px", fontSize: "11px", color: "warm.secondary", borderLeft: "1px solid token(colors.warm.dim)", height: "28px", display: "flex", alignItems: "center", minWidth: "40px", justifyContent: "center" })}>
        {Math.round(zoom * 100)}%
      </div>
    </div>

    <!-- Floating composer -->
    <div
      class={css({
        position: "absolute",
        bottom: "20px",
        left: "50%",
        transform: "translateX(-50%)",
        width: "540px",
        maxWidth: "calc(100% - 40px)",
        borderRadius: "10px",
        boxShadow: "0 4px 24px rgba(0,0,0,0.13), 0 1px 4px rgba(0,0,0,0.08)",
        zIndex: "50",
      })}
    >
      <CardComposer
        editingCard={composerCard}
        selectedCards={selectedCardObjects}
        {selectionGlueRels}
        {primaryCard}
        bundles={bundlesWithColors}
        {defaultBundleId}
        onSubmit={handleComposerSubmit}
        onCancel={() => { composerCard = null; selectedCards = new Set(); primarySelectedId = null; }}
        onBundleChange={handleCardBundleChange}
        onSelectionBundleChange={handleSelectionBundleChange}
        onGlueSelected={handleGlueSelected}
        onUnglueSelected={handleUnglueSelected}
        onUnglueOne={handleUnglueOne}
      />
    </div>
  </div>

  <!-- ── Right sidebar: Scopes ── -->
  <aside
    class={css({
      flexShrink: "0",
      backgroundColor: "ink.light",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
      transition: "width 0.22s ease",
      borderLeft: "1px solid token(colors.warm.dim)",
    })}
    style:width={sidebarsVisible ? "232px" : "0"}
  >
    <div class={css({ flex: "1", overflowY: "auto", padding: "8px 8px 0", display: "flex", flexDirection: "column", gap: "1px" })}>
      {#each scopes as scope (scope.id)}
        {@const active = activeScope === scope.id}
        <div class={cx(
          css({ borderRadius: "6px", overflow: "hidden", border: "1px solid transparent" }),
          active && css({ borderColor: "warm.scroll" }),
        )}>
          <div class={css({ display: "flex", alignItems: "center", position: "relative", "&:hover .scope-delete": { opacity: "1" } })}>
            <button
              class={cx(sideBtn(active), css({ paddingRight: "28px" }))}
              onclick={() => (activeScope = active ? null : scope.id)}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <rect x="1" y="1" width="8" height="8" rx="1" stroke="var(--colors-warm-icon-dim)" stroke-width="1.2" />
                <path d="M3 5h4M3 3.5h2" stroke="var(--colors-warm-icon-dim)" stroke-width="1" stroke-linecap="round" />
              </svg>
              <span class={flex1Class}>{scope.name}</span>
              <span class={countClass}>
                {scopeRels.filter((r) => r.scopeId === scope.id).length}
              </span>
            </button>
            <button
              class={cx("scope-delete", css({
                position: "absolute",
                right: "6px",
                top: "50%",
                transform: "translateY(-50%)",
                width: "18px",
                height: "18px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "none",
                border: "none",
                cursor: "pointer",
                borderRadius: "3px",
                fontSize: "13px",
                color: "warm.subtle",
                opacity: "0",
                transition: "opacity 0.12s, color 0.12s",
                "&:hover": { color: "state.error" },
              }))}
              title="Delete scope"
              onclick={(e) => { e.stopPropagation(); handleDeleteScope(scope.id); }}
            >×</button>
          </div>

          {#if selectedCards.size > 0}
            {@const allInScope = [...selectedCards].every((cid) => scopeRels.some((r) => r.scopeId === scope.id && r.cardId === cid))}
            <button
              class={css({
                width: "100%",
                padding: "6px 10px",
                backgroundColor: allInScope ? "warm.faded" : "ink.black",
                color: allInScope ? "ink.secondary" : "ink.light",
                border: "none",
                borderTop: "1px solid token(colors.warm.dim)",
                cursor: "pointer",
                fontSize: "11px",
                fontFamily: "inherit",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "6px",
              })}
              onclick={() => allInScope ? handleRemoveFromScope(scope.id) : handleAddToScope(scope.id)}
            >
              <span>{allInScope ? "Remove from scope" : "Add to scope"}</span>
              <span>{allInScope ? "−" : "→"}</span>
            </button>
          {/if}
        </div>
      {/each}
    </div>

    <!-- New scope input -->
    <div class={css({ padding: "10px", borderTop: "1px solid token(colors.warm.dim)", marginTop: "8px", display: "flex", gap: "5px" })}>
      <input
        class={css({ flex: "1", padding: "7px 10px", border: "1px solid token(colors.warm.dim)", borderRadius: "6px", fontSize: "11.5px", background: "ink.white", fontFamily: "inherit", color: "ink.black" })}
        bind:value={newScopeName}
        onkeydown={(e) => e.key === "Enter" && handleCreateScope()}
        placeholder="New scope…"
      />
      <button
        class={css({ padding: "7px 11px", backgroundColor: "ink.black", color: "ink.light", border: "none", borderRadius: "6px", cursor: "pointer", fontSize: "14px", fontFamily: "inherit", lineHeight: "1" })}
        onclick={handleCreateScope}
      >+</button>
    </div>
  </aside>
</div>
