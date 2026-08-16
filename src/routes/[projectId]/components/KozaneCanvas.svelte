<script lang="ts">
  import { onMount } from "svelte";
  import { css } from "styled-system/css";
  import KozaneCard from "./KozaneCard.svelte";
  import SelectionRect from "./SelectionRect.svelte";
  import WarpMarker from "./WarpMarker.svelte";
  import type { CardWithGlue, BundleWithColor, GlueRel, Layer, Warp } from "$lib/types";
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
    INACTIVE_LAYER_OPACITY,
    isViewCenteredOn,
    layerStack,
    previousPositions,
    verticalListPosition,
    rectsIntersect,
    scrollForViewCenter,
    selectionRectFromPoints,
    viewCenterWorld,
    worldRectToScreenRect,
  } from "../lib/project-page";
  import type { CardPositionPatch } from "../lib/project-page";
  import { CARD_WIDTH_RANGE, type NewCardPlacement } from "$lib/ui-config";
  import { clamp } from "$lib/constants";

  const [CARD_WIDTH_MIN, CARD_WIDTH_MAX] = CARD_WIDTH_RANGE;

  let {
    cards = $bindable(),
    visibleCards,
    glueRels,
    layers,
    activeLayerId,
    bundleColorById,
    selectedCards = $bindable(),
    primarySelectedId = $bindable(),
    composerCard = $bindable(),
    resizingCardId = $bindable(),
    scopeCardIds,
    warps,
    focusedWarpId,
    warpsVisible,
    warpMarkerSize,
    initialCenter = null,
    onFocusWarp,
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
    onPersistWidth,
    onPositionActivityStart,
    onPositionActivityEnd,
    onError,
    readonly = false,
  }: {
    cards: CardWithGlue[];
    visibleCards: CardWithGlue[];
    glueRels: GlueRel[];
    layers: Layer[];
    activeLayerId: string | null;
    bundleColorById: Map<string, BundleWithColor>;
    selectedCards: Set<string>;
    primarySelectedId: string | null;
    composerCard: CardWithGlue | null;
    /** The one card showing its resize handle, or null when none is armed. */
    resizingCardId: string | null;
    scopeCardIds: Set<string> | null;
    /** In creation order: a warp's number is its place in this list. */
    warps: Warp[];
    focusedWarpId: string | null;
    warpsVisible: boolean;
    /** Diameter of a warp marker, in canvas pixels. */
    warpMarkerSize: number;
    /**
     * Where the view opens, when the page was reached by warping in from another project.
     * Null is the ordinary case: the middle of the board.
     */
    initialCenter?: { posX: number; posY: number } | null;
    onFocusWarp: (warpId: string) => void;
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
    onPersistWidth: (cardId: string, width: number) => Promise<boolean>;
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
  /** Where the pointer was last seen during a resize, so the release can snap to the grid. */
  let resizePointerX: number | null = null;
  // Where the mouse was last seen, so a warp can be dropped under it. Null until the
  // pointer moves at all, which is the case a keyboard-only session stays in.
  let lastPointer: { x: number; y: number } | null = null;

  // Each layer renders as one canvas-sized wrapper: the wrapper's z-index orders the layers
  // against each other, while card.zIndex keeps ordering cards inside their own layer.
  const draggingLayerId = $derived(
    draggingId ? (cards.find(({ id }) => id === draggingId)?.layerId ?? null) : null,
  );
  const layerGroups = $derived.by(() => {
    const stacked = layerStack(layers, activeLayerId, draggingLayerId);
    if (stacked.length === 0) {
      // No layers loaded (an older static export, say): one flat sheet, as before.
      return [{ id: "", rank: 0, active: true, floating: false, cards: visibleCards }];
    }
    const groups = new Map(stacked.map(({ layer }) => [layer.id, [] as CardWithGlue[]]));
    // A card whose layer is missing from this project falls back to the topmost layer
    // rather than disappearing from the canvas.
    const fallbackId = stacked[stacked.length - 1].layer.id;
    for (const card of visibleCards) {
      (groups.get(card.layerId) ?? groups.get(fallbackId)!).push(card);
    }
    return stacked.map(({ layer, rank, active, floating }) => ({
      id: layer.id,
      rank,
      active,
      floating,
      cards: groups.get(layer.id)!,
    }));
  });

  // A marquee only sweeps up what is drawn at full strength. Cards on dimmed layers stay
  // individually clickable — aiming at one is deliberate — but a rectangle dragged across
  // the canvas must not collect cards the user can barely see and then delete them.
  const sweepableCardIds = $derived(
    new Set(
      layerGroups
        .filter(({ active, floating }) => active || floating)
        .flatMap(({ cards: layerCards }) => layerCards.map(({ id }) => id)),
    ),
  );

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
    /** The same ids as `groupIds`, for the membership test every pointer move makes. */
    groupIdSet: Set<string>;
    groupPrevPositions: Map<string, { x: number; y: number }>;
    moved: boolean;
  } | null = null;

  let resizeState: {
    cardId: string;
    /** Where the pointer went down, in client pixels: the drag is measured from here. */
    startClientX: number;
    /** The width the card was drawn at when the drag began, in canvas pixels. */
    startWidth: number;
    /**
     * The width to put back if the save fails. Distinct from `startWidth`, which is
     * always a number: null is a card that had no width of its own and was following
     * `ui.defaultCardWidth`, and a failed resize has to leave it doing that.
     */
    prevWidth: number | null;
    moved: boolean;
  } | null = null;

  // A handle belongs to a card selected on its own. Clear the selection, click another
  // card, or shift-click a second one into it, and the handle goes away with the state
  // that justified it — including on `Escape`, which clears the selection.
  $effect(() => {
    if (resizingCardId === null) return;
    if (selectedCards.size === 1 && selectedCards.has(resizingCardId)) return;
    resizingCardId = null;
  });

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
    // Landing on a warp is decided before the first paint rather than scrolled to
    // afterwards, so arriving from another project does not flash the middle of the board.
    if (initialCenter) {
      centerOn(initialCenter.posX, initialCenter.posY);
      return;
    }
    recenter();
  });

  /**
   * Back to the middle of the board, where a freshly opened project starts. Navigating to
   * another project reuses this component, so the view has to be put back by hand — a new
   * board inheriting the last one's scroll offset opens on nothing in particular.
   */
  export function recenter(): void {
    canvasEl.scrollLeft = centeredScrollOffset(canvasEl.scrollWidth, canvasEl.clientWidth);
    canvasEl.scrollTop = centeredScrollOffset(canvasEl.scrollHeight, canvasEl.clientHeight);
  }

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
    // Indexed once rather than scanned per element: the loop below visits every card on the
    // board, and a lookup through the list inside it makes placing one card cost the square
    // of how many there are.
    const cardById = previous ? new Map(visibleCards.map((card) => [card.id, card])) : null;
    const sizes = previous
      ? [...canvasEl.querySelectorAll<HTMLElement>("[data-card-id]")].flatMap((el) => {
          const cardId = el.dataset.cardId;
          const card = cardId ? cardById!.get(cardId) : undefined;
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

  /** Where the viewport is looking, in world coordinates — where warping measures from. */
  export function getViewCenter(): { posX: number; posY: number } {
    return {
      posX: clamp(
        Math.round(viewCenterWorld(canvasEl.scrollLeft, canvasEl.clientWidth, zoom)),
        0,
        canvasWidth,
      ),
      posY: clamp(
        Math.round(viewCenterWorld(canvasEl.scrollTop, canvasEl.clientHeight, zoom)),
        0,
        canvasHeight,
      ),
    };
  }

  /**
   * Where a new warp goes: under the mouse pointer, which is where the user is already
   * looking when they reach for the key. A pointer that has not moved yet, or that sits
   * over a side panel rather than the board, falls back to the centre of the view.
   */
  export function getWarpPosition(): { posX: number; posY: number } {
    if (!lastPointer) return getViewCenter();
    const rect = canvasEl.getBoundingClientRect();
    const outside =
      lastPointer.x < rect.left ||
      lastPointer.x > rect.right ||
      lastPointer.y < rect.top ||
      lastPointer.y > rect.bottom;
    if (outside) return getViewCenter();
    const { x, y } = clientToWorld(lastPointer.x, lastPointer.y);
    return {
      posX: clamp(Math.round(x), 0, canvasWidth),
      posY: clamp(Math.round(y), 0, canvasHeight),
    };
  }

  /**
   * Whether the viewport is already showing this point as centred as the board allows —
   * which is what "the view has arrived here" means near a canvas edge, where a point
   * cannot be brought to the middle at all. {@link centerOn} moves nothing when this is
   * already true.
   */
  export function isCenteredOn(posX: number, posY: number): boolean {
    return (
      isViewCenteredOn(
        canvasEl.scrollLeft,
        posX,
        canvasEl.clientWidth,
        zoom,
        canvasEl.scrollWidth - canvasEl.clientWidth,
      ) &&
      isViewCenteredOn(
        canvasEl.scrollTop,
        posY,
        canvasEl.clientHeight,
        zoom,
        canvasEl.scrollHeight - canvasEl.clientHeight,
      )
    );
  }

  /** Moves the viewport so `posX`/`posY` sits in the middle of it. Zoom is left alone. */
  export function centerOn(posX: number, posY: number): void {
    canvasEl.scrollLeft = scrollForViewCenter(
      posX,
      canvasEl.clientWidth,
      zoom,
      canvasEl.scrollWidth - canvasEl.clientWidth,
    );
    canvasEl.scrollTop = scrollForViewCenter(
      posY,
      canvasEl.clientHeight,
      zoom,
      canvasEl.scrollHeight - canvasEl.clientHeight,
    );
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
      if (!cardId || !sweepableCardIds.has(cardId)) return;
      if (!rectsIntersect(el.getBoundingClientRect(), screenRect)) return;
      primaryId ??= cardId;
      // A glue group is dragged and deleted as a unit, so it is selected as one too, even
      // where that reaches onto a dimmed layer.
      glueGroupIds(glueGroupMap, cardToGlue, cardId).forEach((id) => next.add(id));
    });
    selectedCards = next;
    primarySelectedId = primaryId;
  }

  export function handleCardMouseDown(e: MouseEvent, cardId: string) {
    if (readonly || e.button !== 0 || dragState || resizeState) return;
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
      groupIdSet: new Set(groupIds),
      groupPrevPositions,
      moved: false,
    };
    draggingId = cardId;
    dragPointer = { x: e.clientX, y: e.clientY };
    onPositionActivityStart();
  }

  /** What a card is drawn at: its own width when it has one, the workspace default when not. */
  function widthOf(card: CardWithGlue): number {
    return card.width ?? cardWidth;
  }

  export function handleResizeMouseDown(e: MouseEvent, cardId: string) {
    if (readonly || e.button !== 0 || dragState || resizeState) return;
    const card = cards.find((c) => c.id === cardId);
    if (!card) return;
    resizeState = {
      cardId,
      startClientX: e.clientX,
      startWidth: widthOf(card),
      prevWidth: card.width,
      moved: false,
    };
    // Counted as position activity for the same reason a drag is: the live-sync poll
    // replaces the card list wholesale, and a card being resized would snap back to its
    // stored width mid-drag.
    onPositionActivityStart();
  }

  function updateResizedCard(clientX: number, snapToGrid = false) {
    if (!resizeState) return;
    const { cardId, startClientX, startWidth } = resizeState;
    // Divided by zoom so the edge keeps up with the pointer rather than lagging or
    // outrunning it on a zoomed board.
    const raw = startWidth + (clientX - startClientX) / zoom;
    const snapped = snapToGrid ? Math.round(raw / GRID) * GRID : raw;
    const width = Math.round(clamp(snapped, CARD_WIDTH_MIN, CARD_WIDTH_MAX));
    // Written through the row rather than mapped into a replacement array, for the reason
    // spelled out in `updateDraggedCard`: this runs on every pointer move.
    for (const c of cards) {
      if (c.id !== cardId) continue;
      c.width = width;
      break;
    }
  }

  function updateDraggedCard(clientX: number, clientY: number, snapToGrid = false) {
    if (!dragState) return;
    const { cardId, offsetX, offsetY, groupIdSet } = dragState;
    const rect = canvasEl.getBoundingClientRect();
    const rawX = (clientX - rect.left + canvasEl.scrollLeft) / zoom - offsetX;
    const rawY = (clientY - rect.top + canvasEl.scrollTop) / zoom - offsetY;
    const x = Math.max(0, snapToGrid ? Math.round(rawX / GRID) * GRID : rawX);
    const y = Math.max(0, snapToGrid ? Math.round(rawY / GRID) * GRID : rawY);
    const dx = x - dragState.lastX;
    const dy = y - dragState.lastY;
    dragState.lastX = x;
    dragState.lastY = y;
    // Written through the rows themselves rather than mapped into a replacement array.
    // This runs on every pointer move, and replacing the array marks the whole list dirty:
    // the derived layer grouping is rebuilt and every card on the board re-evaluates its
    // styles, sixty times a second, to move one card and whatever is glued to it. Assigning
    // a position touches only the card it belongs to. `groupIdSet` keeps the membership
    // test flat, which the array it replaces did not.
    for (const c of cards) {
      if (c.id === cardId) {
        c.posX = x;
        c.posY = y;
      } else if (groupIdSet.has(c.id)) {
        c.posX = Math.max(0, c.posX + dx);
        c.posY = Math.max(0, c.posY + dy);
      }
    }
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
      lastPointer = { x: e.clientX, y: e.clientY };
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
      if (resizeState) {
        resizePointerX = e.clientX;
        if (Math.abs(e.clientX - resizeState.startClientX) > 4) resizeState.moved = true;
        updateResizedCard(e.clientX);
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
      if (resizeState) {
        if (resizeState.moved && resizePointerX !== null) {
          updateResizedCard(resizePointerX, true);
        }
        const { cardId, moved, prevWidth } = resizeState;
        resizeState = null;
        resizePointerX = null;
        if (moved) {
          const sent = cards.find((c) => c.id === cardId)?.width ?? null;
          let ok = false;
          try {
            ok = sent === null ? true : await onPersistWidth(cardId, sent);
          } finally {
            onPositionActivityEnd();
          }
          if (!ok) {
            // Only put the width back if it is still the one that failed to save: a poll
            // or another resize may have moved on since the request went out.
            cards = cards.map((c) =>
              c.id === cardId && c.width === sent ? { ...c, width: prevWidth } : c,
            );
            onError("Failed to save card width");
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
      {#each layerGroups as group (group.id)}
        <!-- pointer-events pass through the wrapper so cards on layers underneath stay
             clickable and canvas panning still works between them. -->
        <div
          data-layer-id={group.id}
          style:position="absolute"
          style:inset="0"
          style:z-index={group.rank}
          style:opacity={group.active || group.floating ? 1 : INACTIVE_LAYER_OPACITY}
          style:pointer-events="none"
          style:transition="opacity 0.18s"
        >
          <!-- Scope dimming applies only where the layer is already at full strength: the
               two opacities multiply, and 0.3 of 0.3 is a card nobody can see. -->
          {#each group.cards as card (card.id)}
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
              dimmed={(group.active || group.floating) &&
                scopeCardIds !== null &&
                !scopeCardIds.has(card.id)}
              isDragging={draggingId === card.id}
              zIndex={card.zIndex}
              {showFooters}
              cardWidth={widthOf(card)}
              {fontSize}
              {fontFamily}
              isResizing={resizingCardId === card.id}
              onCardMouseDown={(e) => handleCardMouseDown(e, card.id)}
              onCardClick={(e) => handleCardClick(e, card.id)}
              onCardDblClick={() => handleCardDblClick(card.id)}
              onResizeMouseDown={(e) => handleResizeMouseDown(e, card.id)}
            />
          {/each}
        </div>
      {/each}

      <!-- Outside the layer wrappers: a warp marks a place on the board, not a place on
           one of its layers, so it never dims with them. -->
      {#if warpsVisible}
        {#each warps as warp, index (warp.id)}
          <WarpMarker
            {warp}
            label={index + 1}
            focused={warp.id === focusedWarpId}
            size={warpMarkerSize}
            onFocus={() => onFocusWarp(warp.id)}
          />
        {/each}
      {/if}

      {#if selectionRect}
        <SelectionRect rect={selectionRect} />
      {/if}
    </div>
  </div>
</div>
