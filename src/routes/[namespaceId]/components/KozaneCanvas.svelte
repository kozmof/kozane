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
     * What the board has picked out, as the one object it already is on `NamespaceState`.
     * Passed whole rather than as four `$bindable` props: they are written back together —
     * a click sets the selection and its primary in the same breath — and four separate
     * bindings made that look like four independent channels. Mutating the shared class is
     * the same two-way flow with one name on it.
     */
    selection: SelectionState;
    scopeCardIds: Set<string> | null;
    /**
     * Where this board's scopes are framed. A scope may have several frames here, or none:
     * a frame is drawn only where someone has drawn one, and a scope organised in two places
     * is framed in two places. A card inside any of a scope's frames belongs to it.
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
     * The directory cache the scope panel and the file palette already read from, shared
     * rather than copied: the panel's `⟳` refreshes what a frame draws too, and a folder
     * opened in either place costs the other nothing.
     */
    taskspaceTree: TaskspaceTreeState;
    treeContext: TaskspaceTreeContext;
    /**
     * Opens one file of one taskspace in the editor. Absent on a board with no endpoint to
     * read a file with, where a frame's icons are drawn and inert.
     */
    onOpenFile?: (taskspaceId: string, path: string) => void;
    /**
     * A rectangle drawn with Alt and not yet given a scope, or null.
     *
     * Written by the draw gesture and read by the page, which puts the prompt up beside it.
     * It stays drawn for as long as the prompt is open — the question being asked is "which
     * scope does *this* belong to", and the rectangle is the half of that the canvas holds.
     * The page clears it on answer or cancel.
     */
    pendingScopeAreaRect: { x: number; y: number; w: number; h: number } | null;
    /**
     * Saves where a frame was dropped or how big it was made, answering whether it took —
     * the same contract as {@link onPersistWarpPosition}. The drag has already moved the
     * frame, and a refusal is what puts it back.
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
    /** In creation order: a warp's number is its place in this list. */
    warps: Warp[];
    focusedWarpId: string | null;
    warpsVisible: boolean;
    /** Diameter of a warp marker, in canvas pixels. */
    warpMarkerSize: number;
    /**
     * Where the view opens, when the page was reached by warping in from another namespace.
     * Null is the ordinary case: the middle of the board.
     */
    initialCenter?: { posX: number; posY: number } | null;
    onFocusWarp: (warpId: string) => void;
    /**
     * Saves where a marker was dropped, answering whether it took — the same contract as
     * {@link onPersistPositions}: the drag has already moved the warp, and a refusal is
     * what puts it back.
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

  /** The card elements a rectangle is tested against: every card drawn on the board. */
  function cardElements(): HTMLElement[] {
    return [...canvasEl.querySelectorAll<HTMLElement>("[data-card-id]")];
  }

  /** Which cards overlap `rect`, given in world coordinates. */
  function cardIdsInRect(rect: WorldRect): Set<string> {
    return cardIdsOverlapping(cardElements(), viewport.toScreen(rect));
  }

  /**
   * Pressing, dragging and letting go of everything on the board. See `board-gestures.svelte.ts`.
   *
   * Handed the board as getters, because almost all of it is props that change under it; the
   * two with setters are bound back to the page, and a rollback or a finished frame-draw is
   * written to the binding itself.
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

  // Each layer renders as one canvas-sized wrapper: the wrapper's z-index orders the layers
  // against each other, while card.zIndex keeps ordering cards inside their own layer.
  const draggingLayerId = $derived(
    gestures.draggingCardId
      ? (cards.find(({ id }) => id === gestures.draggingCardId)?.layerId ?? null)
      : null,
  );
  const layerGroups = $derived.by(() => {
    const stacked = layerStack(layers, activeLayerId, draggingLayerId);
    if (stacked.length === 0) {
      // No layers loaded (an older static export, say): one flat sheet, as before.
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

  // A handle belongs to a card selected on its own. Clear the selection, click another
  // card, or shift-click a second one into it, and the handle goes away with the state
  // that justified it — including on `Escape`, which clears the selection.
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

  /**
   * Back to the middle of the board, where a freshly opened namespace starts. Navigating to
   * another namespace reuses this component, so the view has to be put back by hand — a new
   * board inheriting the last one's scroll offset opens on nothing in particular.
   */
  export function recenter(): void {
    viewport.recenter();
  }

  /**
   * The cards drawn at `at`, measured — the DOM half of {@link CardPlacement}, which owns the
   * run this belongs to and the arithmetic over it.
   *
   * Only the board can answer this: a card’s height is whatever its text wrapped to, and
   * `offsetHeight` is the only thing that knows. `offsetWidth || cardWidth` because a card
   * not yet laid out measures zero, and zero is not a width to stack against.
   */
  function measureCardsAt(at: { x: number; y: number }): PositionedCardSize[] {
    // Indexed once rather than scanned per element: the loop below visits every card on the
    // board, and a lookup through the list inside it makes placing one card cost the square
    // of how many there are.
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

  /** Where the viewport is looking, in world coordinates — where warping measures from. */
  export function getViewCenter(): BoardPoint {
    return viewport.center();
  }

  /**
   * Where a new warp goes: under the mouse pointer, which is where the user is already
   * looking when they reach for the key. A pointer that has not moved yet, or that sits
   * over a side panel rather than the board, falls back to the centre of the view.
   */
  export function getWarpPosition(): BoardPoint {
    const pointer = gestures.lastPointer;
    if (!pointer || !viewport.contains(pointer)) return viewport.center();
    return viewport.onCanvas(viewport.toWorld(pointer.x, pointer.y));
  }

  /**
   * Whether the viewport is already showing this point as centred as the board allows —
   * which is what "the view has arrived here" means near a canvas edge, where a point
   * cannot be brought to the middle at all. {@link centerOn} moves nothing when this is
   * already true.
   */
  export function isCenteredOn(posX: number, posY: number): boolean {
    return viewport.isCenteredOn(posX, posY);
  }

  /** Moves the viewport so `posX`/`posY` sits in the middle of it. Zoom is left alone. */
  export function centerOn(posX: number, posY: number): void {
    viewport.centerOn(posX, posY);
  }

  /**
   * Which cards a drawn rectangle covers, for the prompt that turns it into a frame.
   *
   * Exported, and asked when the scope is chosen rather than when the rectangle was drawn:
   * the prompt stays up for as long as it takes to read, and the board does not stop moving
   * underneath it. Measuring late costs nothing and cannot be stale.
   */
  export function cardIdsInWorldRect(rect: WorldRect): string[] {
    return [...cardIdsInRect(rect)];
  }

  /** What a card is drawn at: its own width when it has one, the workspace default when not. */
  function widthOf(card: CardWithGlue): number {
    return card.width ?? cardWidth;
  }

  /**
   * The file icons under each frame, read from the directory cache the scope panel and the
   * file palette already share — the panel's `⟳` refreshes what a frame draws too.
   */
  const areaFiles = new ScopeAreaBrowser({
    areas: () => scopeAreas,
    taskspaces: () => taskspaces,
    tree: () => taskspaceTree,
    context: () => treeContext,
  });

  /**
   * Reads what the frames are showing, as soon as they are showing it.
   *
   * Eager, unlike the panel, where opening a folder is the request: a frame's icons are how
   * it says what the scope is working on, so they have to be there when the board opens.
   * `ensure` is a no-op for a directory already read or in flight, so re-running this costs
   * only the walk over the list.
   */
  $effect(() => areaFiles.readShown());
  $effect(() => areaFiles.prune());

  // The pointer is followed on the window rather than the board, so a drag that leaves the
  // board — over a panel, or off the page — keeps going and still ends where it is let go.
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
      <!-- Before the layer wrappers and at z-index 0, so every card draws over its frame.
           Outside them, so a frame never dims with a layer: the cards it holds can sit on
           any layer at all, which is the same reason a warp marker is not in the stack. -->
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
        <!-- A sibling of the frame rather than a child of it: the strip is drawn outside the
             rectangle, and `ScopeArea` stays what it is — a frame and its two handles, with
             nothing in it that knows about taskspaces. It follows a drag regardless, because
             the gestures write `posX`/`posY` through the row both of these read. -->
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
          <!-- Scope dimming applies only where the layer is already at full strength: the
               two opacities multiply, and 0.3 of 0.3 is a card nobody can see. -->
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

      <!-- Outside the layer wrappers: a warp marks a place on the board, not a place on
           one of its layers, so it never dims with them. -->
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
