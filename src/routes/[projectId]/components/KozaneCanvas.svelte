<script lang="ts">
  import { onMount } from "svelte";
  import { css } from "styled-system/css";
  import KozaneCard from "./KozaneCard.svelte";
  import SelectionRect from "./SelectionRect.svelte";
  import type { CardWithGlue, BundleWithColor, GlueRel } from "$lib/types";
  import {
    GRID,
    PALETTE,
    buildGlueGroupMap,
    centeredScrollOffset,
    clampZoom,
    edgeScrollVelocity,
    clientToWorld as toWorldPoint,
    dragGroupIds,
    glueGroupIds,
    glueIdByCardId,
    cardPositionPatches,
    previousPositions,
    verticalListPosition,
    rectsIntersect,
    selectionRectFromPoints,
    worldRectToScreenRect,
  } from "../lib/project-page";
  import type { CardPositionPatch } from "../lib/project-page";
  import type { NewCardPlacement } from "$lib/ui-config";

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
    zoomStep,
    canvasWidth,
    canvasHeight,
    cardWidth,
    newCardPlacement,
    fontSize,
    fontFamily,
    onPersistPositions,
    onPositionActivityStart,
    onPositionActivityEnd,
    onError,
    readonly = false,
  }: {
    cards: CardWithGlue[];
    visibleCards: CardWithGlue[];
    glueRels: GlueRel[];
    bundleColorById: Map<string, BundleWithColor>;
    selectedCards: Set<string>;
    primarySelectedId: string | null;
    composerCard: CardWithGlue | null;
    scopeCardIds: Set<string> | null;
    showFooters: boolean;
    zoom: number;
    zoomStep: number;
    canvasWidth: number;
    canvasHeight: number;
    cardWidth: number;
    newCardPlacement: NewCardPlacement;
    fontSize: number;
    fontFamily: string;
    onPersistPositions: (positions: CardPositionPatch[]) => Promise<boolean>;
    onPositionActivityStart: () => void;
    onPositionActivityEnd: () => void;
    onError: (message: string) => void;
    // Read-only export: keep pan/zoom, disable card drag, selection, and compose.
    readonly?: boolean;
  } = $props();

  const glueGroupMap = $derived(buildGlueGroupMap(glueRels));
  const cardToGlue = $derived(glueIdByCardId(glueRels));

  let canvasEl: HTMLDivElement = $state()!;
  let placementSeq = 0;
  let lastPlacementScroll: { left: number; top: number } | null = null;
  let lastListPosition: { posX: number; posY: number } | null = null;
  let draggingId = $state<string | null>(null);
  let isPanning = $state(false);
  let selectionRect = $state(null as { x: number; y: number; w: number; h: number } | null);
  let dragPointer: { x: number; y: number } | null = null;

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

  onMount(() => {
    canvasEl.scrollLeft = centeredScrollOffset(canvasEl.scrollWidth, canvasEl.clientWidth);
    canvasEl.scrollTop = centeredScrollOffset(canvasEl.scrollHeight, canvasEl.clientHeight);
  });

  export function getNewCardPosition(seq: number): { posX: number; posY: number } {
    const scroll = { left: canvasEl.scrollLeft, top: canvasEl.scrollTop };
    const viewportMoved =
      lastPlacementScroll !== null &&
      (Math.abs(scroll.left - lastPlacementScroll.left) > 1 ||
        Math.abs(scroll.top - lastPlacementScroll.top) > 1);
    if (seq === 0 || viewportMoved) {
      placementSeq = 0;
      lastListPosition = null;
    }
    const layoutSeq = placementSeq++;
    lastPlacementScroll = scroll;

    const centerX = Math.round((scroll.left + canvasEl.clientWidth / 2) / zoom / GRID) * GRID;
    const centerY = Math.round((scroll.top + canvasEl.clientHeight / 2) / zoom / GRID) * GRID;
    const startX = Math.max(0, Math.round((centerX - cardWidth / 2) / GRID) * GRID);
    const startY = Math.max(0, centerY - 2 * GRID);
    if (newCardPlacement === "grid") {
      const col = layoutSeq % 4;
      const row = Math.floor(layoutSeq / 4);
      return {
        posX: startX + col * 6 * GRID,
        posY: startY + row * 4 * GRID,
      };
    }

    const previous = lastListPosition;
    const sizes = previous
      ? [...canvasEl.querySelectorAll<HTMLElement>("[data-card-id]")].flatMap((el) => {
          const card = visibleCards.find(({ id }) => id === el.dataset.cardId);
          return card?.posX === previous.posX && card.posY === previous.posY
            ? [{
                posX: card.posX,
                posY: card.posY,
                width: el.offsetWidth || cardWidth,
                height: el.offsetHeight,
              }]
            : [];
        })
      : [];
    const position = verticalListPosition(sizes, startX, previous?.posY ?? startY, cardWidth, 0);
    lastListPosition = { posX: position.x, posY: position.y };
    return { posX: position.x, posY: position.y };
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
      glueGroupIds(glueGroupMap, cardToGlue, cardId).forEach((id) => next.add(id));
    });
    selectedCards = next;
    primarySelectedId = primaryId;
  }

  export function handleCardMouseDown(e: MouseEvent, cardId: string) {
    if (readonly || e.button !== 0 || dragState) return;
    e.stopPropagation();
    const card = cards.find((c) => c.id === cardId);
    if (!card) return;
    const rect = canvasEl.getBoundingClientRect();
    const groupIds = dragGroupIds(glueGroupMap, cardToGlue, selectedCards, cardId);
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
    dragPointer = { x: e.clientX, y: e.clientY };
    onPositionActivityStart();
  }

  function updateDraggedCard(clientX: number, clientY: number, snapToGrid = false) {
    if (!dragState) return;
    const { cardId, offsetX, offsetY, groupIds } = dragState;
    const rect = canvasEl.getBoundingClientRect();
    const rawX = (clientX - rect.left + canvasEl.scrollLeft) / zoom - offsetX;
    const rawY = (clientY - rect.top + canvasEl.scrollTop) / zoom - offsetY;
    const x = Math.max(0, snapToGrid ? Math.round(rawX / GRID) * GRID : rawX);
    const y = Math.max(0, snapToGrid ? Math.round(rawY / GRID) * GRID : rawY);
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

  export function handleCardClick(e: MouseEvent, cardId: string) {
    if (readonly || dragState?.moved) return;
    if (composerCard && composerCard.id !== cardId) composerCard = null;
    const groupIds = glueGroupIds(glueGroupMap, cardToGlue, cardId);
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
    if (readonly || dragState?.moved) return;
    const card = cards.find((c) => c.id === cardId);
    if (card) composerCard = card;
  }

  function handleCanvasMouseDown(e: MouseEvent) {
    if (!readonly && e.button === 0 && e.shiftKey) {
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
        const { startX, startY } = dragState;
        dragPointer = { x: e.clientX, y: e.clientY };
        if (Math.abs(e.clientX - startX) > 4 || Math.abs(e.clientY - startY) > 4) {
          dragState.moved = true;
        }
        updateDraggedCard(e.clientX, e.clientY);
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
        if (dragState.moved && dragPointer) {
          updateDraggedCard(dragPointer.x, dragPointer.y, true);
        }
        const { cardId, moved, prevX, prevY, groupIds, groupPrevPositions } = dragState;
        dragState = null;
        draggingId = null;
        dragPointer = null;
        if (moved) {
          const allIds = [cardId, ...groupIds];
          const positions = cardPositionPatches(cards, allIds);
          const sentByCardId = new Map(positions.map((p) => [p.cardId, p]));
          let ok = false;
          try {
            ok = await onPersistPositions(positions);
          } finally {
            onPositionActivityEnd();
          }
          if (!ok) {
            cards = cards.map((c) => {
              const sent = sentByCardId.get(c.id);
              if (!sent) return c;
              if (c.id === cardId && c.posX === sent.posX && c.posY === sent.posY)
                return { ...c, posX: prevX, posY: prevY };
              const prev = groupPrevPositions.get(c.id);
              if (prev && c.posX === sent.posX && c.posY === sent.posY)
                return { ...c, posX: prev.x, posY: prev.y };
              return c;
            });
            onError("Failed to save card position");
          }
        } else {
          onPositionActivityEnd();
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
    let frame: number;
    function autoScroll() {
      if (dragState && dragPointer) {
        const rect = canvasEl.getBoundingClientRect();
        const dx = edgeScrollVelocity(dragPointer.x, rect.left, rect.right);
        const dy = edgeScrollVelocity(dragPointer.y, rect.top, rect.bottom);
        if (dx !== 0 || dy !== 0) {
          const beforeX = canvasEl.scrollLeft;
          const beforeY = canvasEl.scrollTop;
          canvasEl.scrollBy(dx, dy);
          if (canvasEl.scrollLeft !== beforeX || canvasEl.scrollTop !== beforeY) {
            dragState.moved = true;
            updateDraggedCard(dragPointer.x, dragPointer.y);
          }
        }
      }
      frame = requestAnimationFrame(autoScroll);
    }
    frame = requestAnimationFrame(autoScroll);
    return () => cancelAnimationFrame(frame);
  });

  $effect(() => {
    const canvas = canvasEl;
    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const delta = e.deltaY < 0 ? zoomStep : -zoomStep;
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
  class={css({ flex: "1", overflow: "auto", position: "relative", backgroundColor: "ink.canvas", isolation: "isolate", zIndex: "0" })}
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
          zIndex={card.zIndex}
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
