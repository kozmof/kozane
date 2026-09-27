<script lang="ts">
  import { onMount, tick } from "svelte";
  import { css } from "styled-system/css";
  import KozaneCard from "./KozaneCard.svelte";
  import ScopeArea from "./ScopeArea.svelte";
  import SelectionRect from "./SelectionRect.svelte";
  import WarpMarker from "./WarpMarker.svelte";
  import type {
    CardWithGlue,
    PartitionWithColor,
    GlueRel,
    Layer,
    ScopeArea as ScopeAreaRow,
    Warp,
  } from "$lib/types";
  import type { SelectionState } from "../namespace-state.svelte.js";
  import { PALETTE } from "$lib/palette";
  import {
    GRID,
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
    resizedCardWidth,
    verticalListPosition,
    rectsIntersect,
    cardIdsOverlapping,
    membershipTransition,
    movedRect,
    resizedRect,
    scrollForViewCenter,
    selectionRectFromPoints,
    viewCenterWorld,
    worldRectToScreenRect,
  } from "../lib/namespace-page.js";
  import type { CardPositionPatch, MembershipTransition } from "../lib/namespace-page.js";
  import { CARD_WIDTH_RANGE, type NewCardPlacement } from "$lib/ui-config";
  import { clamp, SCOPE_AREA_MIN_SIZE, SCOPE_AREA_DRAW_MIN } from "$lib/constants";

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
    pendingScopeAreaRect = $bindable(),
    onPersistScopeArea,
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
     * Where this board's scopes are framed. At most one per scope, and most scopes have none:
     * a frame is drawn only for a scope someone has given a place to.
     */
    scopeAreas: ScopeAreaRow[];
    /** The name each frame draws on its tab, by scope id. */
    scopeNameById: Map<string, string>;
    /** The scope the board is filtered to, whose frame is drawn at full strength. */
    activeScopeId: string | null;
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
      rect: { posX: number; posY: number; width: number; height: number },
    ) => Promise<boolean>;
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
  let placementSeq = 0;
  let lastPlacementScroll: { left: number; top: number } | null = null;
  let lastListPosition: { posX: number; posY: number } | null = null;
  let draggingId = $state<string | null>(null);
  let draggingWarpId = $state<string | null>(null);
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
    /**
     * Who was inside each frame when the drag began, by scope id — the `before` half of
     * `membershipTransition`, read once here rather than on release.
     *
     * It has to be read at mousedown: by the time the pointer comes up the cards have already
     * moved, and the board no longer holds the answer to what was inside before they did.
     * Every frame, not only the ones under the cards being dragged, because one drag can take
     * a card out of one frame and into another.
     */
    areaMembersBefore: Map<string, Set<string>>;
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
    const armed = selection.resizingCardId;
    if (armed === null) return;
    if (selection.selectedCards.size === 1 && selection.selectedCards.has(armed)) return;
    selection.resizingCardId = null;
  });

  /**
   * The marker being dragged. Separate from `dragState` rather than folded into it: a warp
   * is not on a layer, is never glued to anything, and does not snap to the grid, so the
   * two share only the shape of a drag and none of its substance.
   */
  let warpDragState: {
    warpId: string;
    /** Pointer to marker centre, in world pixels, so the mark does not jump to the pointer. */
    offsetX: number;
    offsetY: number;
    startX: number;
    startY: number;
    /** Where it sat before the drag, to put back if the save fails. */
    prevX: number;
    prevY: number;
    moved: boolean;
  } | null = null;

  /**
   * The frame being dragged, and what it is carrying.
   *
   * `cardIds` is settled at mousedown and not recomputed while the pointer moves: the cards
   * travel with the frame, so the set cannot change on the way, and re-sweeping the board
   * every pointer move would pick up whatever the frame happened to be passing over.
   */
  let areaDragState: {
    scopeId: string;
    startX: number;
    startY: number;
    /** Where the frame sat before the drag, to put back if the save fails. */
    prevRect: { posX: number; posY: number; width: number; height: number };
    /** The cards inside it when the drag began, and where each of them was. */
    cardIds: string[];
    cardIdSet: Set<string>;
    cardPrevPositions: Map<string, { x: number; y: number }>;
    /** Who was inside before the drag — the `before` half of `membershipTransition`. */
    membersBefore: Set<string>;
    moved: boolean;
  } | null = null;

  let areaResizeState: {
    scopeId: string;
    startClientX: number;
    startClientY: number;
    /** The rectangle the frame was drawn at when the drag began. */
    startRect: { posX: number; posY: number; width: number; height: number };
    membersBefore: Set<string>;
    moved: boolean;
  } | null = null;

  /** Where the pointer was last seen during a frame resize, so the release can snap. */
  let areaResizePointer: { x: number; y: number } | null = null;
  let draggingAreaScopeId = $state<string | null>(null);
  let resizingAreaScopeId = $state<string | null>(null);

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

  /**
   * An Alt-drag that is drawing a scope area. The same shape as the marquee's state, and for
   * the same reason: both are a rectangle pulled out of a point, and neither moves anything
   * while it is being drawn. What differs is only what the release does with it.
   */
  let scopeAreaDrawState: {
    startClientX: number;
    startClientY: number;
    startWorldX: number;
    startWorldY: number;
    moved: boolean;
  } | null = null;

  /** The rectangle being drawn right now, before it is handed over as pending. */
  let scopeAreaDraft = $state(null as { x: number; y: number; w: number; h: number } | null);

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
    selection.selectedCards = next;
    selection.primarySelectedId = primaryId;
  }

  export function handleCardMouseDown(e: MouseEvent, cardId: string) {
    if (readonly || e.button !== 0 || dragState || resizeState) return;
    e.stopPropagation();
    const card = cards.find((c) => c.id === cardId);
    if (!card) return;
    const rect = canvasEl.getBoundingClientRect();
    const groupIds = dragGroupIds(glueGroupMap, cardToGlue, selection.selectedCards, cardId);
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
      areaMembersBefore: new Map(scopeAreas.map((a) => [a.scopeId, cardIdsInArea(a)])),
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

  /** The card elements a rectangle is tested against: every card drawn on the board. */
  function cardElements(): HTMLElement[] {
    return [...canvasEl.querySelectorAll<HTMLElement>("[data-card-id]")];
  }

  /** Which cards overlap `rect`, given in world coordinates. */
  function cardIdsInRect(rect: { x: number; y: number; w: number; h: number }): Set<string> {
    const screenRect = worldRectToScreenRect(
      rect,
      canvasEl.getBoundingClientRect(),
      { x: canvasEl.scrollLeft, y: canvasEl.scrollTop },
      zoom,
    );
    return cardIdsOverlapping(cardElements(), screenRect);
  }

  function areaWorldRect(area: ScopeAreaRow) {
    return { x: area.posX, y: area.posY, w: area.width, h: area.height };
  }

  /** Which cards overlap a frame right now. */
  function cardIdsInArea(area: ScopeAreaRow): Set<string> {
    return cardIdsInRect(areaWorldRect(area));
  }

  const canvasRectBounds = $derived({ canvasWidth, canvasHeight });

  /**
   * Saves a frame's rectangle, putting it back if the save is refused.
   *
   * Only puts it back if the frame still holds the rectangle that failed: a poll or another
   * drag may have moved on since the request went out. Same guard, and the same reason, as
   * the warp drop above.
   */
  async function persistArea(
    scopeId: string,
    sent: { posX: number; posY: number; width: number; height: number },
    prev: { posX: number; posY: number; width: number; height: number },
  ): Promise<boolean> {
    const ok = await onPersistScopeArea(scopeId, sent);
    if (ok) return true;
    const current = scopeAreas.find((a) => a.scopeId === scopeId);
    if (
      current &&
      current.posX === sent.posX &&
      current.posY === sent.posY &&
      current.width === sent.width &&
      current.height === sent.height
    ) {
      Object.assign(current, prev);
    }
    onError("Failed to save scope area");
    return false;
  }

  /**
   * What crossed each frame's edge, given who was inside each of them before.
   *
   * Read at the end of a drag rather than tracked during it: a card belongs where it was let
   * go, and asking mid-drag would file it into every frame it was carried across on the way.
   * Frames with nothing to report are dropped, so the common drag — one that goes nowhere
   * near a frame — produces no entries and no requests.
   */
  function scopeAreaChanges(
    membersBefore: Map<string, Set<string>>,
  ): { scopeId: string; change: MembershipTransition }[] {
    const changes: { scopeId: string; change: MembershipTransition }[] = [];
    for (const area of scopeAreas) {
      const before = membersBefore.get(area.scopeId);
      if (!before) continue;
      const change = membershipTransition(before, cardIdsInArea(area));
      if (change.entered.length === 0 && change.exited.length === 0) continue;
      changes.push({ scopeId: area.scopeId, change });
    }
    return changes;
  }

  async function applyScopeAreaChanges(
    changes: { scopeId: string; change: MembershipTransition }[],
  ) {
    for (const { scopeId, change } of changes) {
      await onScopeMembershipChange(scopeId, change);
    }
  }

  /** The same, for a gesture that moved one frame rather than the cards. */
  function scopeAreaChange(scopeId: string, before: Set<string>) {
    return scopeAreaChanges(new Map([[scopeId, before]]));
  }

  /**
   * The rectangle a drawn frame would be stored as, held on the board.
   *
   * Sized first, then placed — the order `clampRectToBounds` uses on the server, so what is
   * drawn here is what comes back from it. A draw smaller than the minimum is grown to it
   * rather than refused: the pointer said where, and how small a frame may usefully be is a
   * separate question from whether one was asked for.
   */
  function heldScopeAreaRect(rect: { x: number; y: number; w: number; h: number }) {
    const w = clamp(rect.w, SCOPE_AREA_MIN_SIZE, canvasWidth);
    const h = clamp(rect.h, SCOPE_AREA_MIN_SIZE, canvasHeight);
    return {
      x: Math.round(clamp(rect.x, 0, Math.max(0, canvasWidth - w))),
      y: Math.round(clamp(rect.y, 0, Math.max(0, canvasHeight - h))),
      w: Math.round(w),
      h: Math.round(h),
    };
  }

  /**
   * Which cards a drawn rectangle covers, for the prompt that turns it into a frame.
   *
   * Exported, and asked when the scope is chosen rather than when the rectangle was drawn:
   * the prompt stays up for as long as it takes to read, and the board does not stop moving
   * underneath it. Measuring late costs nothing and cannot be stale.
   */
  export function cardIdsInWorldRect(rect: {
    x: number;
    y: number;
    w: number;
    h: number;
  }): string[] {
    return [...cardIdsInRect(rect)];
  }

  export function handleScopeAreaMouseDown(e: MouseEvent, scopeId: string) {
    if (readonly || e.button !== 0 || dragState || resizeState || areaDragState) return;
    const area = scopeAreas.find((a) => a.scopeId === scopeId);
    if (!area) return;
    const cardIds = [...cardIdsInArea(area)];
    areaDragState = {
      scopeId,
      startX: e.clientX,
      startY: e.clientY,
      prevRect: { posX: area.posX, posY: area.posY, width: area.width, height: area.height },
      cardIds,
      cardIdSet: new Set(cardIds),
      cardPrevPositions: previousPositions(cards, cardIds),
      membersBefore: new Set(cardIds),
      moved: false,
    };
    draggingAreaScopeId = scopeId;
    onPositionActivityStart();
  }

  export function handleScopeAreaResizeMouseDown(e: MouseEvent, scopeId: string) {
    if (readonly || e.button !== 0 || areaResizeState) return;
    const area = scopeAreas.find((a) => a.scopeId === scopeId);
    if (!area) return;
    areaResizeState = {
      scopeId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startRect: { posX: area.posX, posY: area.posY, width: area.width, height: area.height },
      membersBefore: cardIdsInArea(area),
      moved: false,
    };
    resizingAreaScopeId = scopeId;
    onPositionActivityStart();
  }

  function updateDraggedArea(clientX: number, clientY: number, snapToGrid = false) {
    if (!areaDragState) return;
    const { scopeId, startX, startY, prevRect, cardIdSet, cardPrevPositions } = areaDragState;
    const area = scopeAreas.find((a) => a.scopeId === scopeId);
    if (!area) return;

    const rawDx = (clientX - startX) / zoom;
    const rawDy = (clientY - startY) / zoom;
    // Measured from where the frame started rather than accumulated per move, so the cards
    // it carries stay exactly where they were relative to it however the pointer wanders.
    const next = movedRect(
      { x: prevRect.posX, y: prevRect.posY, w: prevRect.width, h: prevRect.height },
      snapToGrid ? Math.round(rawDx / GRID) * GRID : rawDx,
      snapToGrid ? Math.round(rawDy / GRID) * GRID : rawDy,
      canvasRectBounds,
    );
    const dx = next.x - prevRect.posX;
    const dy = next.y - prevRect.posY;
    area.posX = next.x;
    area.posY = next.y;

    // Written through the rows for the reason `updateDraggedCard` gives: this runs on every
    // pointer move, and replacing the array rebuilds the layer grouping each time.
    for (const c of cards) {
      if (!cardIdSet.has(c.id)) continue;
      const prev = cardPrevPositions.get(c.id);
      if (!prev) continue;
      c.posX = Math.max(0, prev.x + dx);
      c.posY = Math.max(0, prev.y + dy);
    }
  }

  function updateResizedArea(clientX: number, clientY: number, snapToGrid = false) {
    if (!areaResizeState) return;
    const { scopeId, startClientX, startClientY, startRect } = areaResizeState;
    const area = scopeAreas.find((a) => a.scopeId === scopeId);
    if (!area) return;
    const next = resizedRect({
      rect: { x: startRect.posX, y: startRect.posY, w: startRect.width, h: startRect.height },
      deltaX: clientX - startClientX,
      deltaY: clientY - startClientY,
      zoom,
      snapToGrid,
      minSize: SCOPE_AREA_MIN_SIZE,
      bounds: canvasRectBounds,
    });
    area.width = next.w;
    area.height = next.h;
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
    const width = resizedCardWidth({
      startWidth,
      deltaX: clientX - startClientX,
      zoom,
      snapToGrid,
      range: CARD_WIDTH_RANGE,
    });
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

  /**
   * A press on a marker. It focuses the warp whatever else follows — that is what a click
   * on one has always meant — and then arms a drag, which comes to nothing unless the
   * pointer actually moves.
   */
  function handleWarpMouseDown(e: MouseEvent, warpId: string) {
    onFocusWarp(warpId);
    if (readonly || e.button !== 0 || dragState || resizeState) return;
    const warp = warps.find((w) => w.id === warpId);
    if (!warp) return;
    const rect = canvasEl.getBoundingClientRect();
    warpDragState = {
      warpId,
      offsetX: (e.clientX - rect.left + canvasEl.scrollLeft) / zoom - warp.posX,
      offsetY: (e.clientY - rect.top + canvasEl.scrollTop) / zoom - warp.posY,
      startX: e.clientX,
      startY: e.clientY,
      prevX: warp.posX,
      prevY: warp.posY,
      moved: false,
    };
    draggingWarpId = warpId;
    // Counted as position activity for the reason a card drag is: the poll replaces the
    // warp list wholesale, and a marker being dragged would snap back to its stored place.
    onPositionActivityStart();
  }

  function updateDraggedWarp(clientX: number, clientY: number) {
    if (!warpDragState) return;
    const { warpId, offsetX, offsetY } = warpDragState;
    const rect = canvasEl.getBoundingClientRect();
    // Rounded and held on the board here, which is what the server will store anyway, so
    // the marker does not shift under the pointer when the save answers. No grid snap: a
    // warp marks a point someone chose to come back to, not a slot in a layout, and the
    // key that sets one drops it under the pointer unrounded to any grid.
    const rawX = (clientX - rect.left + canvasEl.scrollLeft) / zoom - offsetX;
    const rawY = (clientY - rect.top + canvasEl.scrollTop) / zoom - offsetY;
    const x = clamp(Math.round(rawX), 0, canvasWidth);
    const y = clamp(Math.round(rawY), 0, canvasHeight);
    // Written through the row rather than into a replacement array, for the reason
    // `updateDraggedCard` gives: this runs on every pointer move.
    for (const w of warps) {
      if (w.id !== warpId) continue;
      w.posX = x;
      w.posY = y;
      break;
    }
  }

  export function handleCardClick(e: MouseEvent, cardId: string) {
    if (readonly || dragState?.moved) return;
    if (selection.composerCard && selection.composerCard.id !== cardId) selection.composerCard = null;
    const groupIds = glueGroupIds(glueGroupMap, cardToGlue, cardId);
    if (e.shiftKey) {
      const next = new Set(selection.selectedCards);
      if (next.has(cardId)) {
        groupIds.forEach((id) => next.delete(id));
      } else {
        groupIds.forEach((id) => next.add(id));
      }
      selection.selectedCards = next;
    } else if (selection.selectedCards.has(cardId) && groupIds.length > 1) {
      selection.primarySelectedId = cardId;
    } else {
      selection.primarySelectedId = cardId;
      const allSelected =
        groupIds.every((id) => selection.selectedCards.has(id)) &&
        selection.selectedCards.size === groupIds.length;
      selection.selectedCards = allSelected ? new Set() : new Set(groupIds);
    }
  }

  export function handleCardDblClick(cardId: string) {
    if (readonly || dragState?.moved) return;
    const card = cards.find((c) => c.id === cardId);
    if (card) selection.composerCard = card;
  }

  function handleCanvasMouseDown(e: MouseEvent) {
    // Alt first, and before the shift branch: Alt-drag draws a scope area, and a press that
    // happens to carry both should draw one rather than sweep a selection. Neither moves
    // anything, so there is no harm in the order — only in leaving it unstated.
    if (!readonly && e.button === 0 && e.altKey) {
      e.preventDefault();
      selection.composerCard = null;
      dragState = null;
      draggingId = null;
      panState = null;
      isPanning = false;
      // A second draw replaces a rectangle still waiting for a scope: the prompt asks about
      // one rectangle, and the newer one is the one the pointer just meant.
      pendingScopeAreaRect = null;
      const start = clientToWorld(e.clientX, e.clientY);
      scopeAreaDrawState = {
        startClientX: e.clientX,
        startClientY: e.clientY,
        startWorldX: start.x,
        startWorldY: start.y,
        moved: false,
      };
      scopeAreaDraft = { x: start.x, y: start.y, w: 0, h: 0 };
      return;
    }
    if (!readonly && e.button === 0 && e.shiftKey) {
      e.preventDefault();
      selection.composerCard = null;
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
    selection.composerCard = null;
    if (!e.shiftKey) { selection.selectedCards = new Set(); selection.primarySelectedId = null; }
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
      if (scopeAreaDrawState) {
        const { startClientX, startClientY, startWorldX, startWorldY } = scopeAreaDrawState;
        if (
          Math.abs(e.clientX - startClientX) > SCOPE_AREA_DRAW_MIN ||
          Math.abs(e.clientY - startClientY) > SCOPE_AREA_DRAW_MIN
        ) {
          scopeAreaDrawState.moved = true;
        }
        const current = clientToWorld(e.clientX, e.clientY);
        scopeAreaDraft = selectionRectFromPoints({ x: startWorldX, y: startWorldY }, current);
      }
      if (dragState) {
        const { startX, startY } = dragState;
        dragPointer = { x: e.clientX, y: e.clientY };
        if (Math.abs(e.clientX - startX) > 4 || Math.abs(e.clientY - startY) > 4) {
          dragState.moved = true;
        }
        updateDraggedCard(e.clientX, e.clientY);
      }
      if (warpDragState) {
        const { startX, startY } = warpDragState;
        if (Math.abs(e.clientX - startX) > 4 || Math.abs(e.clientY - startY) > 4) {
          warpDragState.moved = true;
        }
        updateDraggedWarp(e.clientX, e.clientY);
      }
      if (areaDragState) {
        const { startX, startY } = areaDragState;
        if (Math.abs(e.clientX - startX) > 4 || Math.abs(e.clientY - startY) > 4) {
          areaDragState.moved = true;
        }
        updateDraggedArea(e.clientX, e.clientY);
      }
      if (areaResizeState) {
        const { startClientX, startClientY } = areaResizeState;
        areaResizePointer = { x: e.clientX, y: e.clientY };
        if (Math.abs(e.clientX - startClientX) > 4 || Math.abs(e.clientY - startClientY) > 4) {
          areaResizeState.moved = true;
        }
        updateResizedArea(e.clientX, e.clientY);
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
      if (scopeAreaDrawState) {
        const { moved } = scopeAreaDrawState;
        scopeAreaDrawState = null;
        const drawn = scopeAreaDraft;
        scopeAreaDraft = null;
        // A draw that went nowhere was an Alt-click, not a rectangle. Dropped without asking
        // anything: a prompt nobody meant to open is worse than no frame.
        if (moved && drawn) pendingScopeAreaRect = heldScopeAreaRect(drawn);
      }
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
        const areaMembersBefore = dragState.areaMembersBefore;
        dragState = null;
        draggingId = null;
        dragPointer = null;
        if (moved) {
          const allIds = [cardId, ...groupIds];
          const positions = cardPositionPatches(cards, allIds);
          const sentByCardId = new Map(positions.map((p) => [p.cardId, p]));
          // Measured against the drawn board, which is why the flush comes first: the release
          // snaps the card to the grid by writing `posX`, and reading a box before Svelte has
          // put that on screen measures where the card was a moment ago. A snap is only a few
          // pixels, but a few pixels is the whole question for a card dropped on the edge.
          //
          // Before the save rather than after, so a poll cannot replace the list underneath —
          // `positionActivity` is still open here and closes in the `finally` below. What is
          // *sent* still waits for the save.
          await tick();
          const areaChanges = scopeAreaChanges(areaMembersBefore);
          let ok = false;
          try {
            ok = await onPersistPositions(positions);
          } finally {
            onPositionActivityEnd();
          }
          if (ok) {
            // Only once the positions are stored. A card filed into a scope at a position the
            // server refused would be a member of it while sitting somewhere else entirely.
            await applyScopeAreaChanges(areaChanges);
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
      if (warpDragState) {
        const { warpId, moved, prevX, prevY } = warpDragState;
        warpDragState = null;
        draggingWarpId = null;
        const dropped = moved ? warps.find((w) => w.id === warpId) : undefined;
        if (dropped) {
          const sent = { posX: dropped.posX, posY: dropped.posY };
          let ok = false;
          try {
            ok = await onPersistWarpPosition(warpId, sent);
          } finally {
            onPositionActivityEnd();
          }
          if (!ok) {
            // Only put the position back if the marker still holds the one that failed to
            // save: a poll or another drag may have moved on since the request went out.
            const current = warps.find((w) => w.id === warpId);
            if (current && current.posX === sent.posX && current.posY === sent.posY) {
              current.posX = prevX;
              current.posY = prevY;
            }
            onError("Failed to save warp position");
          }
        } else {
          onPositionActivityEnd();
        }
      }
      if (areaDragState) {
        if (areaDragState.moved && lastPointer) {
          updateDraggedArea(lastPointer.x, lastPointer.y, true);
        }
        const { scopeId, moved, prevRect, cardIds, cardPrevPositions, membersBefore } =
          areaDragState;
        areaDragState = null;
        draggingAreaScopeId = null;
        const dropped = moved ? scopeAreas.find((a) => a.scopeId === scopeId) : undefined;
        if (dropped) {
          const sent = {
            posX: dropped.posX,
            posY: dropped.posY,
            width: dropped.width,
            height: dropped.height,
          };
          const positions = cardPositionPatches(cards, cardIds);
          // The flush matters most here. The frame and everything it carries have moved by
          // the same delta, and none of it is on screen yet — so measuring now would test the
          // frame's new rectangle against the cards' old boxes, and report the members it just
          // carried across the board as having left the scope.
          await tick();
          const areaChanges = scopeAreaChange(scopeId, membersBefore);
          let ok = false;
          try {
            // The frame first: the cards were carried by it, and a frame that did not move is
            // a set of cards that should not have moved either.
            ok = await persistArea(scopeId, sent, prevRect);
            if (ok && positions.length > 0) ok = await onPersistPositions(positions);
          } finally {
            onPositionActivityEnd();
          }
          if (ok) {
            // A frame dragged over a card that was not in it picks that card up. Nothing
            // leaves this way: the members travelled with the frame.
            await applyScopeAreaChanges(areaChanges);
          } else {
            for (const c of cards) {
              const prev = cardPrevPositions.get(c.id);
              if (prev) {
                c.posX = prev.x;
                c.posY = prev.y;
              }
            }
            onError("Failed to save card position");
          }
        } else {
          onPositionActivityEnd();
        }
      }
      if (areaResizeState) {
        if (areaResizeState.moved && areaResizePointer) {
          updateResizedArea(areaResizePointer.x, areaResizePointer.y, true);
        }
        const { scopeId, moved, startRect, membersBefore } = areaResizeState;
        areaResizeState = null;
        areaResizePointer = null;
        resizingAreaScopeId = null;
        const resized = moved ? scopeAreas.find((a) => a.scopeId === scopeId) : undefined;
        if (resized) {
          const sent = {
            posX: resized.posX,
            posY: resized.posY,
            width: resized.width,
            height: resized.height,
          };
          // Nothing moved, but the frame's own edge did, and the release snapped it: the
          // cards it just stopped covering are decided by where that edge came to rest.
          await tick();
          const areaChanges = scopeAreaChange(scopeId, membersBefore);
          let ok = false;
          try {
            ok = await persistArea(scopeId, sent, startRect);
          } finally {
            onPositionActivityEnd();
          }
          // Both directions here, unlike a frame drag: growing the frame takes cards in, and
          // shrinking it past one lets that card out.
          if (ok) await applyScopeAreaChanges(areaChanges);
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
  data-canvas-surface
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
      <!-- Before the layer wrappers and at z-index 0, so every card draws over its frame.
           Outside them, so a frame never dims with a layer: the cards it holds can sit on
           any layer at all, which is the same reason a warp marker is not in the stack. -->
      {#each scopeAreas as area (area.id)}
        <ScopeArea
          {area}
          name={scopeNameById.get(area.scopeId) ?? ""}
          focused={area.scopeId === activeScopeId}
          draggable={!readonly}
          dragging={draggingAreaScopeId === area.scopeId}
          resizing={resizingAreaScopeId === area.scopeId}
          onMouseDown={(e) => handleScopeAreaMouseDown(e, area.scopeId)}
          onResizeMouseDown={(e) => handleScopeAreaResizeMouseDown(e, area.scopeId)}
        />
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
              isDragging={draggingId === card.id}
              zIndex={card.zIndex}
              {showFooters}
              cardWidth={widthOf(card)}
              {fontSize}
              {fontFamily}
              isResizing={selection.resizingCardId === card.id}
              {tagHref}
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
            draggable={!readonly}
            dragging={draggingWarpId === warp.id}
            label={index + 1}
            focused={warp.id === focusedWarpId}
            size={warpMarkerSize}
            onMouseDown={(e) => handleWarpMouseDown(e, warp.id)}
          />
        {/each}
      {/if}

      {#if selectionRect}
        <SelectionRect rect={selectionRect} />
      {/if}

      <!-- The frame being drawn, and then the one waiting for a scope. Drawn in the scope
           accent rather than the selection one, because this rectangle is about to become a
           thing that stays rather than a sweep that ends at mouseup. -->
      {#if scopeAreaDraft ?? pendingScopeAreaRect}
        <SelectionRect
          rect={(scopeAreaDraft ?? pendingScopeAreaRect)!}
          accent="var(--colors-neutral-iconDim)"
        />
      {/if}
    </div>
  </div>
</div>
