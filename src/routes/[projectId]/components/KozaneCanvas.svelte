<script lang="ts">
  import { css } from "styled-system/css";
  import KozaneCard from "./KozaneCard.svelte";
  import SelectionRect from "./SelectionRect.svelte";
  import type { CardData, BundleWithColor, GlueRel } from "$lib/types";
  import {
    GRID,
    PALETTE,
    ZOOM_STEP,
    clampZoom,
    clientToWorld as toWorldPoint,
    dragGroupIds,
    glueGroupIds,
    cardPositionPatches,
    previousPositions,
    rectsIntersect,
    selectionRectFromPoints,
    worldRectToScreenRect,
  } from "../lib/project-page";
  import type { CardPositionPatch } from "../lib/project-page";

  let {
    cards = $bindable(),
    visibleCards,
    glueRels,
    bundleColorById,
    selectedCards = $bindable(),
    primarySelectedId = $bindable(),
    composerCard = $bindable(),
    scopeCardIds,
    showFooters,
    zoom = $bindable(),
    canvasWidth,
    canvasHeight,
    cardWidth,
    fontSize,
    fontFamily,
    onPersistPositions,
    onError,
  }: {
    cards: CardData[];
    visibleCards: CardData[];
    glueRels: GlueRel[];
    bundleColorById: Map<string, BundleWithColor>;
    selectedCards: Set<string>;
    primarySelectedId: string | null;
    composerCard: CardData | null;
    scopeCardIds: Set<string> | null;
    showFooters: boolean;
    zoom: number;
    canvasWidth: number;
    canvasHeight: number;
    cardWidth: number;
    fontSize: number;
    fontFamily: string;
    onPersistPositions: (positions: CardPositionPatch[]) => Promise<boolean>;
    onError: (message: string) => void;
  } = $props();

  let canvasEl: HTMLDivElement = $state()!;
  let draggingId = $state<string | null>(null);
  let isPanning = $state(false);
  let selectionRect = $state(null as { x: number; y: number; w: number; h: number } | null);

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

  let rectangleSelectionState: {
    startClientX: number;
    startClientY: number;
    startWorldX: number;
    startWorldY: number;
    moved: boolean;
  } | null = null;

  export function getNewCardPosition(seq: number): { posX: number; posY: number } {
    const step = (seq % 8) * GRID;
    const base = -7 * GRID;
    return {
      posX: Math.max(0, Math.round((canvasEl.scrollLeft + canvasEl.clientWidth / 2) / zoom / GRID) * GRID + base + step),
      posY: Math.max(0, Math.round((canvasEl.scrollTop + canvasEl.clientHeight / 2) / zoom / GRID) * GRID + base + step),
    };
  }

  function clientToWorld(clientX: number, clientY: number) {
    return toWorldPoint(
      clientX,
      clientY,
      canvasEl.getBoundingClientRect(),
      { x: canvasEl.scrollLeft, y: canvasEl.scrollTop },
      zoom,
    );
  }

  function applyRectangleSelection() {
    if (!selectionRect) return;
    const screenRect = worldRectToScreenRect(
      selectionRect,
      canvasEl.getBoundingClientRect(),
      { x: canvasEl.scrollLeft, y: canvasEl.scrollTop },
      zoom,
    );
    const next = new Set<string>();
    let primaryId: string | null = null;
    canvasEl.querySelectorAll<HTMLElement>("[data-card-id]").forEach((el) => {
      const cardId = el.dataset.cardId;
      if (!cardId || !rectsIntersect(el.getBoundingClientRect(), screenRect)) return;
      primaryId ??= cardId;
      glueGroupIds(glueRels, cardId).forEach((id) => next.add(id));
    });
    selectedCards = next;
    primarySelectedId = primaryId;
  }

  export function handleCardMouseDown(e: MouseEvent, cardId: string) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const card = cards.find((c) => c.id === cardId);
    if (!card) return;
    const rect = canvasEl.getBoundingClientRect();
    const groupIds = dragGroupIds(glueRels, selectedCards, cardId);
    const groupPrevPositions = previousPositions(cards, groupIds);
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

  export function handleCardClick(e: MouseEvent, cardId: string) {
    if (dragState?.moved) return;
    if (composerCard && composerCard.id !== cardId) composerCard = null;
    const groupIds = glueGroupIds(glueRels, cardId);
    if (e.shiftKey) {
      const next = new Set(selectedCards);
      if (next.has(cardId)) {
        groupIds.forEach((id) => next.delete(id));
      } else {
        groupIds.forEach((id) => next.add(id));
      }
      selectedCards = next;
    } else if (selectedCards.has(cardId) && groupIds.length > 1) {
      primarySelectedId = cardId;
    } else {
      primarySelectedId = cardId;
      const allSelected =
        groupIds.every((id) => selectedCards.has(id)) &&
        selectedCards.size === groupIds.length;
      selectedCards = allSelected ? new Set() : new Set(groupIds);
    }
  }

  export function handleCardDblClick(cardId: string) {
    if (dragState?.moved) return;
    const card = cards.find((c) => c.id === cardId);
    if (card) composerCard = card;
  }

  function handleCanvasMouseDown(e: MouseEvent) {
    if (e.button === 0 && e.shiftKey) {
      e.preventDefault();
      composerCard = null;
      dragState = null;
      draggingId = null;
      panState = null;
      isPanning = false;
      const start = clientToWorld(e.clientX, e.clientY);
      rectangleSelectionState = {
        startClientX: e.clientX,
        startClientY: e.clientY,
        startWorldX: start.x,
        startWorldY: start.y,
        moved: false,
      };
      selectionRect = { x: start.x, y: start.y, w: 0, h: 0 };
      return;
    }
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

  function handleCanvasContextMenu(e: MouseEvent) {
    if (rectangleSelectionState) e.preventDefault();
  }

  $effect(() => {
    function onMove(e: MouseEvent) {
      if (rectangleSelectionState) {
        const { startClientX, startClientY, startWorldX, startWorldY } = rectangleSelectionState;
        if (Math.abs(e.clientX - startClientX) > 4 || Math.abs(e.clientY - startClientY) > 4) {
          rectangleSelectionState.moved = true;
        }
        const current = clientToWorld(e.clientX, e.clientY);
        selectionRect = selectionRectFromPoints({ x: startWorldX, y: startWorldY }, current);
      }
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
      if (rectangleSelectionState) {
        if (rectangleSelectionState.moved) {
          applyRectangleSelection();
        }
        rectangleSelectionState = null;
        selectionRect = null;
      }
      if (dragState) {
        const { cardId, moved, prevX, prevY, groupIds, groupPrevPositions } = dragState;
        dragState = null;
        draggingId = null;
        if (moved) {
          const allIds = [cardId, ...groupIds];
          const positions = cardPositionPatches(cards, allIds);
          const ok = await onPersistPositions(positions);
          if (!ok) {
            cards = cards.map((c) => {
              if (c.id === cardId) return { ...c, posX: prevX, posY: prevY };
              const prev = groupPrevPositions.get(c.id);
              if (prev) return { ...c, posX: prev.x, posY: prev.y };
              return c;
            });
            onError("Failed to save card position");
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
      const next = clampZoom(prev + delta);
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
</script>

<div
  class={css({ flex: "1", overflow: "auto", position: "relative", backgroundColor: "ink.lighter" })}
  role="presentation"
  bind:this={canvasEl}
  onmousedown={handleCanvasMouseDown}
  oncontextmenu={handleCanvasContextMenu}
  style:cursor={draggingId || isPanning ? "grabbing" : "grab"}
>
  <div
    style:width="{canvasWidth * zoom}px"
    style:height="{canvasHeight * zoom}px"
    style:position="relative"
    style:flex-shrink="0"
  >
    <div
      style:width="{canvasWidth}px"
      style:height="{canvasHeight}px"
      style:position="absolute"
      style:top="0"
      style:left="0"
      style:transform="scale({zoom})"
      style:transform-origin="0 0"
    >
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

      {#each visibleCards as card (card.id)}
        {@const color = bundleColorById.get(card.bundleId) ?? {
          id: "",
          projectId: "",
          isDefault: false,
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
          {cardWidth}
          {fontSize}
          {fontFamily}
          onCardMouseDown={(e) => handleCardMouseDown(e, card.id)}
          onCardClick={(e) => handleCardClick(e, card.id)}
          onCardDblClick={() => handleCardDblClick(card.id)}
        />
      {/each}

      {#if selectionRect}
        <SelectionRect rect={selectionRect} />
      {/if}
    </div>
  </div>
</div>
