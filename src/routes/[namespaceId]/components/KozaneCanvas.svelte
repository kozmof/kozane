<script lang="ts">
  import { onMount } from "svelte";
  import { css } from "styled-system/css";
  import { token } from "styled-system/tokens";
  import KozaneCard from "./KozaneCard.svelte";
  import ScopeArea from "./ScopeArea.svelte";
  import ScopeAreaFiles from "./ScopeAreaFiles.svelte";
  import SelectionRect from "./SelectionRect.svelte";
  import WarpMarker from "./WarpMarker.svelte";
  import type {
    CardWithGlue,
    PartitionWithColor,
    GlueRel,
    Layer,
    ScopeArea as ScopeAreaRow,
    TaskspaceSummary,
    Warp,
  } from "$lib/types";
  import type { SelectionState } from "../namespace-state.svelte.js";
  import type {
    TaskspaceTreeContext,
    TaskspaceTreeState,
  } from "../lib/taskspace-tree.svelte.js";
  import { ScopeAreaBrowser } from "../lib/scope-area-browser.svelte.js";
  import { CanvasViewport, type BoardPoint } from "../lib/canvas-viewport.js";
  import { BoardGestures } from "../lib/board-gestures.svelte.js";
  import { PALETTE } from "$lib/palette";
  import {
    buildGlueGroupMap,
    cardIdsOverlapping,
    clampZoom,
    glueIdByCardId,
    INACTIVE_LAYER_OPACITY,
    layerStack,
  } from "../lib/namespace-page.js";
  import type { CardPositionPatch, PositionedCardSize, WorldRect } from "../lib/namespace-page.js";
  import { CardPlacement } from "../lib/card-placement.js";
  import type { NewCardPlacement } from "$lib/ui-config";
  import type { BoardRect } from "$lib/constants";

  let {
    cards = $bindable(),
    visibleCards,
    glueRels,
    layers,
    activeLayerId,
    partitionColorById,
    selection,
    scopeCardIds,
    scopeAreas = $bindable(),
    scopeNameById,
    activeScopeId,
    taskspaces,
    taskspaceTree,
    treeContext,
    onOpenFile,
    pendingScopeAreaRect = $bindable(),
    onPersistScopeArea,
    onRemoveScopeArea,
    onScopeMembershipChange,
    warps = $bindable(),
    focusedWarpId,
    warpsVisible,
    warpMarkerSize,
    initialCenter = null,
    onFocusWarp,
    onPersistWarpPosition,
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
    tagHref,
    readonly = false,
  }: {
    cards: CardWithGlue[];
    visibleCards: CardWithGlue[];
    glueRels: GlueRel[];
    layers: Layer[];
    activeLayerId: string | null;
    partitionColorById: Map<string, PartitionWithColor>;
    /**
     * Share the page's selection state as one object so selected IDs and the primary card are
     * updated together.
     */
    selection: SelectionState;
    scopeCardIds: Set<string> | null;
    /**
     * Scope frames on this board. A scope may have several frames or none. Cards inside any
     * of its frames belong to it.
     */
    scopeAreas: ScopeAreaRow[];
    /** The name each frame draws on its tab, by scope id. */
    scopeNameById: Map<string, string>;
    /** The scope the board is filtered to, whose frame is drawn at full strength. */
    activeScopeId: string | null;
    /**
     * Every taskspace this board draws, whichever scope it belongs to. Narrowed per frame by
     * `taskspacesForScope`, the same filter the scope panel applies to its own rows.
     */
    taskspaces: TaskspaceSummary[];
    /**
     * Share the directory cache with the scope panel and file palette so refreshes and folder
     * loads update every view.
     */
    taskspaceTree: TaskspaceTreeState;
    treeContext: TaskspaceTreeContext;
    /**
     * Opens one file of one taskspace in the editor. Absent on a board with no endpoint to
     * read a file with, where a frame's icons are drawn and inert.
     */
    onOpenFile?: (taskspaceId: string, path: string) => void;
    /**
     * Rectangle drawn with Alt while awaiting scope selection. Keep it visible until the page
     * accepts or cancels the prompt.
     */
    pendingScopeAreaRect: { x: number; y: number; w: number; h: number } | null;
    /**
     * Persist an optimistically moved or resized scope frame. Return false so the caller can
     * restore its previous geometry.
     */
    onPersistScopeArea: (
      scopeId: string,
      areaId: string,
      rect: BoardRect,
    ) => Promise<boolean>;
    /** Takes one frame off the board. The scope and its other frames are left alone. */
    onRemoveScopeArea: (scopeId: string, areaId: string) => void;
    /**
     * Files the cards that crossed a frame's edge into the scope, or out of it. Called after
     * the positions behind the crossing are saved, so a card is never filed into a scope at a
     * position the server refused.
     */
    onScopeMembershipChange: (
      scopeId: string,
      change: { entered: string[]; exited: string[] },
    ) => Promise<void>;
    /** Creation order determines each warp's number. */
    warps: Warp[];
    focusedWarpId: string | null;
    warpsVisible: boolean;
    /** Diameter of a warp marker, in canvas pixels. */
    warpMarkerSize: number;
    /**
     * Initial view position for arrivals from another namespace. Null opens at the board's
     * centre.
     */
    initialCenter?: { posX: number; posY: number } | null;
    onFocusWarp: (warpId: string) => void;
    /**
     * Persist an optimistically moved warp. Return false so the caller can restore its
     * previous position.
     */
    onPersistWarpPosition: (
      warpId: string,
      position: { posX: number; posY: number },
    ) => Promise<boolean>;
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
    /** Passed to each card, which draws a tag in its text as a link to it. See `KozaneCard`. */
    tagHref?: (tag: string) => string;
    // Read-only export: keep pan/zoom, disable card drag, selection, and compose.
    readonly?: boolean;
  } = $props();

  const glueGroupMap = $derived(buildGlueGroupMap(glueRels));
  const cardToGlue = $derived(glueIdByCardId(glueRels));

  let canvasEl: HTMLDivElement = $state()!;
  const canvasRectBounds = $derived({ canvasWidth, canvasHeight });
  const viewport = new CanvasViewport(
    () => canvasEl,
    () => zoom,
    () => canvasRectBounds,
  );
  /** Where new cards go, and the run of them the last one belongs to. */
  const placement = new CardPlacement();

  /** All rendered card elements used to test rectangle coverage. */
  function cardElements(): HTMLElement[] {
    return [...canvasEl.querySelectorAll<HTMLElement>("[data-card-id]")];
  }

  /** Which cards overlap `rect`, given in world coordinates. */
  function cardIdsInRect(rect: WorldRect): Set<string> {
    return cardIdsOverlapping(cardElements(), viewport.toScreen(rect));
  }

  /**
   * Manage pointer gestures through `board-gestures.svelte.ts`. Use getters for changing
   * props and setters for bound state that gestures replace.
   */
  const gestures: BoardGestures = new BoardGestures({
    get readonly() { return readonly; },
    get el() { return canvasEl; },
    viewport,
    get zoom() { return zoom; },
    get bounds() { return canvasRectBounds; },
    get cardWidth() { return cardWidth; },
    get cards() { return cards; },
    set cards(next) { cards = next; },
    get warps() { return warps; },
    get scopeAreas() { return scopeAreas; },
    get selection() { return selection; },
    get glueGroupMap() { return glueGroupMap; },
    get cardToGlue() { return cardToGlue; },
    get sweepableCardIds() { return sweepableCardIds; },
    get pendingScopeAreaRect() { return pendingScopeAreaRect; },
    set pendingScopeAreaRect(rect) { pendingScopeAreaRect = rect; },
    cardIdsInRect,
    get onPositionActivityStart() { return onPositionActivityStart; },
    get onPositionActivityEnd() { return onPositionActivityEnd; },
    get onError() { return onError; },
    get onFocusWarp() { return onFocusWarp; },
    get onPersistPositions() { return onPersistPositions; },
    get onPersistWidth() { return onPersistWidth; },
    get onPersistWarpPosition() { return onPersistWarpPosition; },
    get onPersistScopeArea() { return onPersistScopeArea; },
    get onScopeMembershipChange() { return onScopeMembershipChange; },
  });

  // Render each layer in a canvas-sized wrapper. The wrapper's z-index orders layers, and
  // `card.zIndex` orders cards within them.
  const draggingLayerId = $derived(
    gestures.draggingCardId
      ? (cards.find(({ id }) => id === gestures.draggingCardId)?.layerId ?? null)
      : null,
  );
  const layerGroups = $derived.by(() => {
    const stacked = layerStack(layers, activeLayerId, draggingLayerId);
    if (stacked.length === 0) {
      // Render a flat sheet if layer data is absent, as in older exports.
      return [{ id: "", rank: 0, active: true, floating: false, cards: visibleCards }];
    }
    const groups = new Map(stacked.map(({ layer }) => [layer.id, [] as CardWithGlue[]]));
    // A card whose layer is missing from this namespace falls back to the topmost layer
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

  // Include only fully visible layers in marquee selection. Dimmed cards remain individually
  // clickable.
  const sweepableCardIds = $derived(
    new Set(
      layerGroups
        .filter(({ active, floating }) => active || floating)
        .flatMap(({ cards: layerCards }) => layerCards.map(({ id }) => id)),
    ),
  );

  // Show the width handle only while exactly one card is selected.
  $effect(() => {
    const armed = selection.resizingCardId;
    if (armed === null) return;
    if (selection.selectedCards.size === 1 && selection.selectedCards.has(armed)) return;
    selection.resizingCardId = null;
  });

  onMount(() => {
    // Landing on a warp is decided before the first paint rather than scrolled to
    // afterwards, so arriving from another namespace does not flash the middle of the board.
    if (initialCenter) {
      centerOn(initialCenter.posX, initialCenter.posY);
      return;
    }
    recenter();
  });

  /** Center the viewport when a new namespace reuses this canvas component. */
  export function recenter(): void {
    viewport.recenter();
  }

  /**
   * Measure cards at the placement point for {@link CardPlacement}. Use rendered height and
   * fall back to configured width before layout is available.
   */
  function measureCardsAt(at: { x: number; y: number }): PositionedCardSize[] {
    // Index cards once to avoid a linear search for every rendered element.
    const cardById = new Map(visibleCards.map((card) => [card.id, card]));
    return cardElements().flatMap((el) => {
      const cardId = el.dataset.cardId;
      const card = cardId ? cardById.get(cardId) : undefined;
      if (card?.posX !== at.x || card.posY !== at.y) return [];
      return [{
        posX: card.posX,
        posY: card.posY,
        width: el.offsetWidth || cardWidth,
        height: el.offsetHeight,
      }];
    });
  }

  export function getNewCardPosition(seq: number): BoardPoint {
    return placement.next({
      seq,
      viewport: {
        scrollLeft: canvasEl.scrollLeft,
        scrollTop: canvasEl.scrollTop,
        clientWidth: canvasEl.clientWidth,
        clientHeight: canvasEl.clientHeight,
      },
      zoom,
      cardWidth,
      placement: newCardPlacement,
      measureAt: measureCardsAt,
    });
  }

  /** Viewport center in canvas coordinates, used as the origin for warp navigation. */
  export function getViewCenter(): BoardPoint {
    return viewport.center();
  }

  /**
   * Place new warps under the pointer. Use the view centre if the pointer has not moved or is
   * outside the board.
   */
  export function getWarpPosition(): BoardPoint {
    const pointer = gestures.lastPointer;
    if (!pointer || !viewport.contains(pointer)) return viewport.center();
    return viewport.onCanvas(viewport.toWorld(pointer.x, pointer.y));
  }

  /**
   * Whether the viewport is as centered on this point as canvas bounds allow. Avoid moving it
   * again when it has already arrived.
   */
  export function isCenteredOn(posX: number, posY: number): boolean {
    return viewport.isCenteredOn(posX, posY);
  }

  /** Moves the viewport so `posX`/`posY` sits in the middle of it. Zoom is left alone. */
  export function centerOn(posX: number, posY: number): void {
    viewport.centerOn(posX, posY);
  }

  /**
   * Measure cards covered by the rectangle when the user chooses a scope. The board may have
   * changed while the prompt was open.
   */
  export function cardIdsInWorldRect(rect: WorldRect): string[] {
    return [...cardIdsInRect(rect)];
  }

  /** Use the card's pinned width or the workspace default. */
  function widthOf(card: CardWithGlue): number {
    return card.width ?? cardWidth;
  }

  /**
   * Read frame file icons from the directory cache shared with the sidebar and file palette
   * so refreshes update all views.
   */
  const areaFiles = new ScopeAreaBrowser({
    areas: () => scopeAreas,
    taskspaces: () => taskspaces,
    tree: () => taskspaceTree,
    context: () => treeContext,
  });

  /**
   * Load frame directories as soon as their icons are needed. `ensure` reuses cached or
   * pending loads, so repeated calls only traverse the list.
   */
  $effect(() => areaFiles.readShown());
  $effect(() => areaFiles.prune());

  // Track pointers on the window so drags can continue and finish outside the board.
  $effect(() => {
    const onMove = (e: MouseEvent) => gestures.move(e.clientX, e.clientY);
    const onUp = () => void gestures.release();
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  });

  // Edge scrolling while a card is dragged against the side of the board.
  $effect(() => {
    let frame: number;
    function autoScroll() {
      gestures.autoScroll();
      frame = requestAnimationFrame(autoScroll);
    }
    frame = requestAnimationFrame(autoScroll);
    return () => cancelAnimationFrame(frame);
  });

  // Ctrl/Cmd and the wheel zooms toward the pointer. Registered by hand, because it has to
  // call `preventDefault` and a passive listener may not.
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
  data-canvas-surface
  onmousedown={(e) => gestures.pressCanvas(e)}
  oncontextmenu={(e) => gestures.contextMenu(e)}
  style:cursor={gestures.draggingCardId || gestures.isPanning ? "grabbing" : "grab"}
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
      <!-- Draw frames at z-index 0 below cards and outside layer wrappers. Frames can contain cards from any layer and must not inherit layer dimming. -->
      {#each scopeAreas as area (area.id)}
        <ScopeArea
          {area}
          name={scopeNameById.get(area.scopeId) ?? ""}
          focused={area.scopeId === activeScopeId}
          draggable={!readonly}
          dragging={gestures.draggingAreaId === area.id}
          resizing={gestures.resizingAreaId === area.id}
          onMouseDown={(e) => gestures.pressArea(e, area.id)}
          onResizeMouseDown={(e) => gestures.pressAreaResize(e, area.id)}
          onRemove={() => onRemoveScopeArea(area.scopeId, area.id)}
        />
        <!-- Render the file strip beside the frame so `ScopeArea` stays independent of taskspaces. Both follow the same position row during dragging. -->
        {@const groups = areaFiles.fileGroupsByArea.get(area.id) ?? []}
        {#if groups.length > 0}
          <ScopeAreaFiles
            {area}
            {groups}
            {onOpenFile}
            onNavigate={(taskspaceId, path) => areaFiles.navigate(area.id, taskspaceId, path)}
          />
        {/if}
      {/each}
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
          <!-- Apply scope dimming only to fully opaque layers so multiplying opacities does not make cards unreadable. -->
          {#each group.cards as card (card.id)}
            {@const color = partitionColorById.get(card.partitionId) ?? {
              id: "",
              namespaceId: "",
              isDefault: false,
              bg: PALETTE[0].bg,
              dot: PALETTE[0].dot,
              name: "Unknown",
            }}
            <KozaneCard
              {card}
              {color}
              isSelected={selection.selectedCards.has(card.id)}
              isPrimaryUnglue={card.id === selection.primarySelectedId && !!card.glueId}
              isComposing={selection.composerCard?.id === card.id}
              dimmed={(group.active || group.floating) &&
                scopeCardIds !== null &&
                !scopeCardIds.has(card.id)}
              isDragging={gestures.draggingCardId === card.id}
              zIndex={card.zIndex}
              {showFooters}
              cardWidth={widthOf(card)}
              {fontSize}
              {fontFamily}
              isResizing={selection.resizingCardId === card.id}
              {tagHref}
              onCardMouseDown={(e) => gestures.pressCard(e, card.id)}
              onCardClick={(e) => gestures.clickCard(e, card.id)}
              onCardDblClick={() => gestures.dblClickCard(card.id)}
              onResizeMouseDown={(e) => gestures.pressCardResize(e, card.id)}
            />
          {/each}
        </div>
      {/each}

      <!-- Keep warp markers outside layer wrappers so they never inherit layer dimming. -->
      {#if warpsVisible}
        {#each warps as warp, index (warp.id)}
          <WarpMarker
            {warp}
            draggable={!readonly}
            dragging={gestures.draggingWarpId === warp.id}
            label={index + 1}
            focused={warp.id === focusedWarpId}
            size={warpMarkerSize}
            onMouseDown={(e) => gestures.pressWarp(e, warp.id)}
          />
        {/each}
      {/if}

      {#if gestures.selectionRect}
        <SelectionRect rect={gestures.selectionRect} />
      {/if}

      <!-- The frame being drawn, and then the one waiting for a scope. Drawn in the scope
           accent rather than the selection one, because this rectangle is about to become a
           thing that stays rather than a sweep that ends at mouseup. -->
      {#if gestures.scopeAreaDraft ?? pendingScopeAreaRect}
        <SelectionRect
          rect={(gestures.scopeAreaDraft ?? pendingScopeAreaRect)!}
          accent={token.var("colors.neutral.iconDim")}
        />
      {/if}
    </div>
  </div>
</div>
