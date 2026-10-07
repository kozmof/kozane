import { tick } from "svelte";
import type { CardWithGlue, ScopeArea, Warp } from "$lib/types";
import { CARD_WIDTH_RANGE } from "$lib/ui-config";
import { SCOPE_AREA_DRAW_MIN, SCOPE_AREA_MIN_SIZE, type BoardRect } from "$lib/constants";
import type { SelectionState } from "../namespace-state.svelte.js";
import type { CanvasViewport, BoardPoint } from "./canvas-viewport.js";
import { gestureOrigin, markMoved, markMovedHorizontally } from "./gesture.js";
import {
  draggedAreaId,
  draggedCardId,
  draggedWarpId,
  holdsPositionActivity,
  resizedAreaId,
  type AreaDragGesture,
  type AreaResizeGesture,
  type BoardGesture,
  type CardDragGesture,
  type CardResizeGesture,
  type WarpDragGesture,
} from "./board-gesture.js";
import {
  GRID,
  buildGlueGroupMap,
  cardPositionPatches,
  dragGroupIds,
  edgeScrollVelocity,
  glueGroupIds,
  glueIdByCardId,
  movedRect,
  previousPositions,
  rectsIntersect,
  resizedCardWidth,
  resizedRect,
  revertedPositions,
  selectionRectFromPoints,
  type CardPositionPatch,
  type MembershipTransition,
  type Point,
  type RectBounds,
  type WorldRect,
} from "./namespace-page.js";
import {
  areaBoardRect,
  areasByScope,
  areaWorldRect,
  cardIdsInScope,
  heldScopeAreaRect,
  membersByScope,
  sameBoardRect,
  scopeAreaChanges,
  type ScopeChange,
} from "./scope-areas.js";

/**
 * Board state and callbacks used by gestures. Getters read current props rather than
 * capturing stale values. Setters for `cards` and `pendingScopeAreaRect` update the page
 * bindings after rollback or frame drawing.
 */
export type BoardGestureHost = {
  readonly readonly: boolean;
  readonly el: HTMLElement;
  readonly viewport: CanvasViewport;
  readonly zoom: number;
  readonly bounds: RectBounds;
  /** The width a card without one of its own is drawn at. */
  readonly cardWidth: number;
  cards: CardWithGlue[];
  readonly warps: Warp[];
  readonly scopeAreas: ScopeArea[];
  readonly selection: SelectionState;
  readonly glueGroupMap: ReturnType<typeof buildGlueGroupMap>;
  readonly cardToGlue: ReturnType<typeof glueIdByCardId>;
  /** Fully opaque cards eligible for rectangle selection. */
  readonly sweepableCardIds: ReadonlySet<string>;
  pendingScopeAreaRect: WorldRect | null;
  /** Which cards the drawn board shows overlapping a world rectangle. */
  cardIdsInRect(rect: WorldRect): Set<string>;

  readonly onPositionActivityStart: () => void;
  readonly onPositionActivityEnd: () => void;
  readonly onError: (message: string) => void;
  readonly onFocusWarp: (warpId: string) => void;
  readonly onPersistPositions: (positions: CardPositionPatch[]) => Promise<boolean>;
  readonly onPersistWidth: (cardId: string, width: number) => Promise<boolean>;
  readonly onPersistWarpPosition: (warpId: string, position: BoardPoint) => Promise<boolean>;
  readonly onPersistScopeArea: (
    scopeId: string,
    areaId: string,
    rect: BoardRect,
  ) => Promise<boolean>;
  readonly onScopeMembershipChange: (
    scopeId: string,
    change: MembershipTransition,
  ) => Promise<void>;
};

/** The drafts a release is about, read before the slot is emptied. */
type Drafts = { swept: WorldRect | null; drawn: WorldRect | null };

/**
 * Handle board pointer gestures, including moving and resizing cards, warps, and frames,
 * selection, frame drawing, and panning.
 *
 * The component owns event listeners and forwards presses, moves, releases, and
 * animation-frame scrolling here.
 */
export class BoardGestures {
  readonly #host: BoardGestureHost;

  /**
   * The single active pointer gesture. Use `$state.raw` because its fields change on each
   * pointer move but are not read directly by the renderer. See {@link BoardGesture}.
   */
  gesture = $state.raw<BoardGesture | null>(null);

  /**
   * Reactive draft rectangles drawn during gestures. Keep separate drafts for selection and
   * frame drawing so the renderer can distinguish their purpose.
   */
  selectionRect = $state<WorldRect | null>(null);
  /** The frame being drawn right now, before it is handed over as pending. */
  scopeAreaDraft = $state<WorldRect | null>(null);

  /**
   * Last known pointer position for placing warps. Null until the pointer moves. Keep it
   * outside the gesture slot because it is also read between gestures.
   */
  lastPointer: Point | null = null;

  // Derive board-visible state from the active gesture. See `draggedCardId`.
  readonly draggingCardId = $derived(draggedCardId(this.gesture));
  readonly draggingWarpId = $derived(draggedWarpId(this.gesture));
  readonly draggingAreaId = $derived(draggedAreaId(this.gesture));
  readonly resizingAreaId = $derived(resizedAreaId(this.gesture));
  readonly isPanning = $derived(this.gesture?.kind === "pan");

  constructor(host: BoardGestureHost) {
    this.#host = host;
  }

  // ── Opening and putting down ─────────────────────────────────────────────

  /**
   * Remove and return the active gesture before awaiting work so later presses cannot replace
   * the state being settled. Position activity is released separately.
   */
  #take(): BoardGesture | null {
    const open = this.gesture;
    this.gesture = null;
    this.selectionRect = null;
    this.scopeAreaDraft = null;
    return open;
  }

  /**
   * Cancel the active gesture and release its position reservation. Normal release holds that
   * reservation through saving and releases it in its own finally block.
   */
  #end(): void {
    const open = this.#take();
    if (open && holdsPositionActivity(open.kind)) this.#host.onPositionActivityEnd();
  }

  /**
   * Allow a gesture only on a writable board, with the primary button, and when no other
   * gesture is active.
   */
  #mayOpen(e: MouseEvent): boolean {
    return !this.#host.readonly && e.button === 0 && !this.gesture;
  }

  /** Opens a gesture that holds the snapshot poll off until it is settled. */
  #openHolding(g: BoardGesture): void {
    this.gesture = g;
    this.#host.onPositionActivityStart();
  }

  // ── Presses ──────────────────────────────────────────────────────────────

  pressCard(e: MouseEvent, cardId: string): void {
    if (!this.#mayOpen(e)) return;
    e.stopPropagation();
    const { cards, selection, glueGroupMap, cardToGlue, viewport } = this.#host;
    const card = cards.find((c) => c.id === cardId);
    if (!card) return;
    const groupIds = dragGroupIds(glueGroupMap, cardToGlue, selection.selectedCards, cardId);
    const pressed = viewport.toWorld(e.clientX, e.clientY);
    this.#openHolding({
      kind: "card-drag",
      cardId,
      offsetX: pressed.x - card.posX,
      offsetY: pressed.y - card.posY,
      ...gestureOrigin(e),
      prevX: card.posX,
      prevY: card.posY,
      lastX: card.posX,
      lastY: card.posY,
      groupIds,
      groupIdSet: new Set(groupIds),
      groupPrevPositions: previousPositions(cards, groupIds),
      // Combine membership by scope across all its frames so duplicate frames cannot
      // overwrite each other's card sets.
      areaMembersBefore: membersByScope(this.#host.scopeAreas, this.#cardIdsInRect),
      pointer: { x: e.clientX, y: e.clientY },
    });
  }

  pressCardResize(e: MouseEvent, cardId: string): void {
    if (!this.#mayOpen(e)) return;
    const card = this.#host.cards.find((c) => c.id === cardId);
    if (!card) return;
    // Pause polling during resize so snapshots cannot restore the stored width mid-drag.
    this.#openHolding({
      kind: "card-resize",
      cardId,
      startClientX: e.clientX,
      moved: false,
      startWidth: card.width ?? this.#host.cardWidth,
      prevWidth: card.width,
      pointerX: null,
    });
  }

  pressArea(e: MouseEvent, areaId: string): void {
    if (!this.#mayOpen(e)) return;
    const area = this.#host.scopeAreas.find((a) => a.id === areaId);
    if (!area) return;
    // Move cards inside this frame, but compare membership across every frame of the scope.
    const cardIds = [...this.#host.cardIdsInRect(areaWorldRect(area))];
    this.#openHolding({
      kind: "area-drag",
      areaId,
      scopeId: area.scopeId,
      ...gestureOrigin(e),
      prevRect: areaBoardRect(area),
      cardIds,
      cardIdSet: new Set(cardIds),
      cardPrevPositions: previousPositions(this.#host.cards, cardIds),
      membersBefore: this.#scopeMembersOf(area),
    });
  }

  pressAreaResize(e: MouseEvent, areaId: string): void {
    if (!this.#mayOpen(e)) return;
    const area = this.#host.scopeAreas.find((a) => a.id === areaId);
    if (!area) return;
    this.#openHolding({
      kind: "area-resize",
      areaId,
      scopeId: area.scopeId,
      ...gestureOrigin(e),
      startRect: areaBoardRect(area),
      membersBefore: this.#scopeMembersOf(area),
      pointer: null,
    });
  }

  /**
   * Focus the clicked warp and arm a drag when permitted. An unmoved press only changes
   * focus.
   */
  pressWarp(e: MouseEvent, warpId: string): void {
    this.#host.onFocusWarp(warpId);
    if (!this.#mayOpen(e)) return;
    const warp = this.#host.warps.find((w) => w.id === warpId);
    if (!warp) return;
    const pressed = this.#host.viewport.toWorld(e.clientX, e.clientY);
    // Pause polling during warp dragging so snapshots cannot restore the stored position
    // mid-drag.
    this.#openHolding({
      kind: "warp-drag",
      warpId,
      offsetX: pressed.x - warp.posX,
      offsetY: pressed.y - warp.posY,
      ...gestureOrigin(e),
      prevX: warp.posX,
      prevY: warp.posY,
    });
  }

  pressCanvas(e: MouseEvent): void {
    if (e.button !== 0) return;
    const { readonly, selection, viewport, el } = this.#host;
    // Cancel any unfinished gesture before starting one from bare canvas. A release outside
    // the window may have been missed, leaving position activity reserved.
    if (this.gesture) this.#end();

    // Check Alt before Shift so holding both draws a scope frame rather than a selection
    // rectangle.
    if (!readonly && e.altKey) {
      e.preventDefault();
      selection.composerCard = null;
      // Replace any pending rectangle with the newly drawn one.
      this.#host.pendingScopeAreaRect = null;
      const start = viewport.toWorld(e.clientX, e.clientY);
      this.gesture = {
        kind: "area-draw",
        ...gestureOrigin(e),
        startWorldX: start.x,
        startWorldY: start.y,
      };
      this.scopeAreaDraft = { x: start.x, y: start.y, w: 0, h: 0 };
      return;
    }
    if (!readonly && e.shiftKey) {
      e.preventDefault();
      selection.composerCard = null;
      const start = viewport.toWorld(e.clientX, e.clientY);
      this.gesture = {
        kind: "marquee",
        ...gestureOrigin(e),
        startWorldX: start.x,
        startWorldY: start.y,
      };
      this.selectionRect = { x: start.x, y: start.y, w: 0, h: 0 };
      return;
    }
    selection.composerCard = null;
    if (!e.shiftKey) {
      selection.selectedCards = new Set();
      selection.primarySelectedId = null;
    }
    this.gesture = {
      kind: "pan",
      startX: e.clientX,
      startY: e.clientY,
      scrollLeft: el.scrollLeft,
      scrollTop: el.scrollTop,
    };
  }

  contextMenu(e: MouseEvent): void {
    if (this.gesture?.kind === "marquee") e.preventDefault();
  }

  /**
   * Whether an active drag should suppress a click. `release` clears the gesture before the
   * browser dispatches its usual post-mouseup click, so that completed gesture is no longer
   * visible here.
   */
  #suppressClick(): boolean {
    return this.#host.readonly || (this.gesture?.kind === "card-drag" && this.gesture.moved);
  }

  clickCard(e: MouseEvent, cardId: string): void {
    if (this.#suppressClick()) return;
    const { selection, glueGroupMap, cardToGlue } = this.#host;
    if (selection.composerCard && selection.composerCard.id !== cardId) {
      selection.composerCard = null;
    }
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

  dblClickCard(cardId: string): void {
    if (this.#suppressClick()) return;
    const card = this.#host.cards.find((c) => c.id === cardId);
    if (card) this.#host.selection.composerCard = card;
  }

  // ── Moving ───────────────────────────────────────────────────────────────

  /**
   * Move the active gesture and record the pointer position. An exhaustive switch requires
   * every {@link BoardGesture} variant to have a handler.
   */
  move(clientX: number, clientY: number): void {
    this.lastPointer = { x: clientX, y: clientY };
    const g = this.gesture;
    if (!g) return;
    switch (g.kind) {
      case "marquee":
        markMoved(g, clientX, clientY);
        this.selectionRect = selectionRectFromPoints(
          { x: g.startWorldX, y: g.startWorldY },
          this.#host.viewport.toWorld(clientX, clientY),
        );
        return;
      case "area-draw":
        // Use the larger threshold so an Alt-click does not open the scope prompt.
        markMoved(g, clientX, clientY, SCOPE_AREA_DRAW_MIN);
        this.scopeAreaDraft = selectionRectFromPoints(
          { x: g.startWorldX, y: g.startWorldY },
          this.#host.viewport.toWorld(clientX, clientY),
        );
        return;
      case "card-drag":
        g.pointer = { x: clientX, y: clientY };
        markMoved(g, clientX, clientY);
        this.#moveCard(g, clientX, clientY);
        return;
      case "warp-drag":
        markMoved(g, clientX, clientY);
        this.#moveWarp(g, clientX, clientY);
        return;
      case "area-drag":
        markMoved(g, clientX, clientY);
        this.#moveArea(g, clientX, clientY);
        return;
      case "area-resize":
        g.pointer = { x: clientX, y: clientY };
        markMoved(g, clientX, clientY);
        this.#resizeArea(g, clientX, clientY);
        return;
      case "card-resize":
        g.pointerX = clientX;
        // Require horizontal motion to resize. See `markMovedHorizontally`.
        markMovedHorizontally(g, clientX);
        this.#resizeCard(g, clientX);
        return;
      case "pan": {
        // Pan immediately because it does not need a threshold to distinguish a click action.
        const { el } = this.#host;
        el.scrollLeft = g.scrollLeft - (clientX - g.startX);
        el.scrollTop = g.scrollTop - (clientY - g.startY);
        return;
      }
    }
  }

  /**
   * Scroll at the board edge during a card drag, moving the card with the viewport. Called
   * once per animation frame.
   */
  autoScroll(): void {
    const g = this.gesture;
    if (g?.kind !== "card-drag") return;
    const { el } = this.#host;
    const rect = el.getBoundingClientRect();
    const dx = edgeScrollVelocity(g.pointer.x, rect.left, rect.right);
    const dy = edgeScrollVelocity(g.pointer.y, rect.top, rect.bottom);
    if (dx === 0 && dy === 0) return;
    const beforeX = el.scrollLeft;
    const beforeY = el.scrollTop;
    el.scrollBy(dx, dy);
    if (el.scrollLeft !== beforeX || el.scrollTop !== beforeY) {
      g.moved = true;
      this.#moveCard(g, g.pointer.x, g.pointer.y);
    }
  }

  // Pass narrowed gestures to movement handlers so their parameters cannot be null or the
  // wrong variant.
  //
  // Update rows in place during pointer movement. Replacing the array would rebuild layer
  // groups and update styles for every card on every move.

  #moveCard(g: CardDragGesture, clientX: number, clientY: number, snapToGrid = false): void {
    const { cardId, offsetX, offsetY, groupIdSet } = g;
    const pointer = this.#host.viewport.toWorld(clientX, clientY);
    const rawX = pointer.x - offsetX;
    const rawY = pointer.y - offsetY;
    const x = Math.max(0, snapToGrid ? Math.round(rawX / GRID) * GRID : rawX);
    const y = Math.max(0, snapToGrid ? Math.round(rawY / GRID) * GRID : rawY);
    const dx = x - g.lastX;
    const dy = y - g.lastY;
    g.lastX = x;
    g.lastY = y;
    for (const c of this.#host.cards) {
      if (c.id === cardId) {
        c.posX = x;
        c.posY = y;
      } else if (groupIdSet.has(c.id)) {
        c.posX = Math.max(0, c.posX + dx);
        c.posY = Math.max(0, c.posY + dy);
      }
    }
  }

  #resizeCard(g: CardResizeGesture, clientX: number, snapToGrid = false): void {
    const width = resizedCardWidth({
      startWidth: g.startWidth,
      deltaX: clientX - g.startClientX,
      zoom: this.#host.zoom,
      snapToGrid,
      range: CARD_WIDTH_RANGE,
    });
    for (const c of this.#host.cards) {
      if (c.id !== g.cardId) continue;
      c.width = width;
      break;
    }
  }

  #moveWarp(g: WarpDragGesture, clientX: number, clientY: number): void {
    // Round and clamp warp coordinates to match stored values. Do not snap them to the card
    // grid.
    const { viewport } = this.#host;
    const pointer = viewport.toWorld(clientX, clientY);
    const { posX, posY } = viewport.onCanvas({
      x: pointer.x - g.offsetX,
      y: pointer.y - g.offsetY,
    });
    for (const w of this.#host.warps) {
      if (w.id !== g.warpId) continue;
      w.posX = posX;
      w.posY = posY;
      break;
    }
  }

  #moveArea(g: AreaDragGesture, clientX: number, clientY: number, snapToGrid = false): void {
    const { areaId, startClientX, startClientY, prevRect, cardIdSet, cardPrevPositions } = g;
    const area = this.#host.scopeAreas.find((a) => a.id === areaId);
    if (!area) return;

    const { zoom } = this.#host;
    const rawDx = (clientX - startClientX) / zoom;
    const rawDy = (clientY - startClientY) / zoom;
    // Measured from where the frame started rather than accumulated per move, so the cards
    // it carries stay exactly where they were relative to it however the pointer wanders.
    const next = movedRect(
      areaWorldRect({ ...area, ...prevRect }),
      snapToGrid ? Math.round(rawDx / GRID) * GRID : rawDx,
      snapToGrid ? Math.round(rawDy / GRID) * GRID : rawDy,
      this.#host.bounds,
    );
    const dx = next.x - prevRect.posX;
    const dy = next.y - prevRect.posY;
    area.posX = next.x;
    area.posY = next.y;

    for (const c of this.#host.cards) {
      if (!cardIdSet.has(c.id)) continue;
      const prev = cardPrevPositions.get(c.id);
      if (!prev) continue;
      c.posX = Math.max(0, prev.x + dx);
      c.posY = Math.max(0, prev.y + dy);
    }
  }

  #resizeArea(g: AreaResizeGesture, clientX: number, clientY: number, snapToGrid = false): void {
    const area = this.#host.scopeAreas.find((a) => a.id === g.areaId);
    if (!area) return;
    const next = resizedRect({
      rect: areaWorldRect({ ...area, ...g.startRect }),
      deltaX: clientX - g.startClientX,
      deltaY: clientY - g.startClientY,
      zoom: this.#host.zoom,
      snapToGrid,
      minSize: SCOPE_AREA_MIN_SIZE,
      bounds: this.#host.bounds,
    });
    area.width = next.w;
    area.height = next.h;
  }

  // ── Letting go ───────────────────────────────────────────────────────────

  /**
   * Puts the open gesture down and does whatever its release means.
   *
   * The slot is read and cleared before anything is awaited. Each arm then works from `g`,
   * the gesture it narrowed, and not from state a later press may have replaced while a save
   * was in flight.
   */
  async release(): Promise<void> {
    // Read the draft rectangles before `#take` clears them with the gesture.
    const drafts = { swept: this.selectionRect, drawn: this.scopeAreaDraft };
    const g = this.#take();
    if (!g) return;
    try {
      await this.#settle(g, drafts);
    } finally {
      // Hold position activity through saves, rollback, and membership writes so polling
      // cannot overwrite an unfinished edit. Release it in finally.
      if (holdsPositionActivity(g.kind)) this.#host.onPositionActivityEnd();
    }
  }

  async #settle(g: BoardGesture, drafts: Drafts): Promise<void> {
    switch (g.kind) {
      case "area-draw":
        // Discard Alt-clicks that did not draw a rectangle without opening the prompt.
        if (g.moved && drafts.drawn) {
          this.#host.pendingScopeAreaRect = heldScopeAreaRect(drafts.drawn, this.#host.bounds);
        }
        return;
      case "marquee":
        if (g.moved && drafts.swept) this.#selectSwept(drafts.swept);
        return;
      case "pan":
        return;
      case "card-drag":
        return this.#settleCardDrag(g);
      case "warp-drag":
        return this.#settleWarpDrag(g);
      case "area-drag":
        return this.#settleAreaDrag(g);
      case "area-resize":
        return this.#settleAreaResize(g);
      case "card-resize":
        return this.#settleCardResize(g);
    }
  }

  async #settleCardDrag(g: CardDragGesture): Promise<void> {
    if (!g.moved) return;
    this.#moveCard(g, g.pointer.x, g.pointer.y, true);
    const positions = cardPositionPatches(this.#host.cards, [g.cardId, ...g.groupIds]);
    // Flush the snapped card position before measuring frame coverage. A few pixels at a
    // frame edge can change membership.
    await tick();
    const areaChanges = this.#scopeAreaChanges(g.areaMembersBefore);
    if (await this.#host.onPersistPositions(positions)) {
      // Only once the positions are stored. A card filed into a scope at a position the
      // server refused would be a member of it while sitting somewhere else entirely.
      await this.#applyScopeAreaChanges(areaChanges);
      return;
    }
    this.#host.cards = revertedPositions(
      this.#host.cards,
      positions,
      new Map(g.groupPrevPositions).set(g.cardId, { x: g.prevX, y: g.prevY }),
    );
    this.#host.onError("Failed to save card position");
  }

  async #settleWarpDrag(g: WarpDragGesture): Promise<void> {
    const { warps } = this.#host;
    const dropped = g.moved ? warps.find((w) => w.id === g.warpId) : undefined;
    if (!dropped) return;
    const sent = { posX: dropped.posX, posY: dropped.posY };
    if (await this.#host.onPersistWarpPosition(g.warpId, sent)) return;
    // Roll back only if the marker still has the failed position. A later poll or drag may
    // have changed it.
    const current = this.#host.warps.find((w) => w.id === g.warpId);
    if (current && current.posX === sent.posX && current.posY === sent.posY) {
      current.posX = g.prevX;
      current.posY = g.prevY;
    }
    this.#host.onError("Failed to save warp position");
  }

  async #settleAreaDrag(g: AreaDragGesture): Promise<void> {
    if (g.moved && this.lastPointer) {
      this.#moveArea(g, this.lastPointer.x, this.lastPointer.y, true);
    }
    const dropped = g.moved ? this.#host.scopeAreas.find((a) => a.id === g.areaId) : undefined;
    if (!dropped) return;
    const sent = areaBoardRect(dropped);
    const positions = cardPositionPatches(this.#host.cards, g.cardIds);
    // Wait for the frame and carried cards to render before measuring membership. Their new
    // data positions must be compared with updated DOM boxes.
    await tick();
    const areaChanges = this.#scopeAreaChanges(new Map([[g.scopeId, g.membersBefore]]));
    // Save the frame first because its carried cards should move only if the frame moves.
    let ok = await this.#persistArea(dropped, sent, g.prevRect);
    if (ok && positions.length > 0) ok = await this.#host.onPersistPositions(positions);
    if (ok) {
      // Add newly covered cards. Existing members moved with the frame, so this operation
      // removes none.
      await this.#applyScopeAreaChanges(areaChanges);
      return;
    }
    for (const c of this.#host.cards) {
      const prev = g.cardPrevPositions.get(c.id);
      if (prev) {
        c.posX = prev.x;
        c.posY = prev.y;
      }
    }
    this.#host.onError("Failed to save card position");
  }

  async #settleAreaResize(g: AreaResizeGesture): Promise<void> {
    if (g.moved && g.pointer) this.#resizeArea(g, g.pointer.x, g.pointer.y, true);
    const resized = g.moved ? this.#host.scopeAreas.find((a) => a.id === g.areaId) : undefined;
    if (!resized) return;
    const sent = areaBoardRect(resized);
    // Use the frame's final snapped edge to determine coverage after resizing.
    await tick();
    const areaChanges = this.#scopeAreaChanges(new Map([[g.scopeId, g.membersBefore]]));
    // Resizing can add covered cards or remove cards no longer covered.
    if (await this.#persistArea(resized, sent, g.startRect)) {
      await this.#applyScopeAreaChanges(areaChanges);
    }
  }

  async #settleCardResize(g: CardResizeGesture): Promise<void> {
    if (!g.moved || g.pointerX === null) return;
    this.#resizeCard(g, g.pointerX, true);
    const sent = this.#host.cards.find((c) => c.id === g.cardId)?.width ?? null;
    if (sent === null || (await this.#host.onPersistWidth(g.cardId, sent))) return;
    // Roll back only if the width still matches the failed save. A later poll or resize may
    // have changed it.
    this.#host.cards = this.#host.cards.map((c) =>
      c.id === g.cardId && c.width === sent ? { ...c, width: g.prevWidth } : c,
    );
    this.#host.onError("Failed to save card width");
  }

  // ── What a release decides ───────────────────────────────────────────────

  /**
   * Select cards covered by the supplied rectangle. The gesture and draft state are cleared
   * before this async operation runs.
   */
  #selectSwept(rect: WorldRect): void {
    const { el, viewport, sweepableCardIds, glueGroupMap, cardToGlue, selection } = this.#host;
    const screenRect = viewport.toScreen(rect);
    const next = new Set<string>();
    let primaryId: string | null = null;
    el.querySelectorAll<HTMLElement>("[data-card-id]").forEach((cardEl) => {
      const cardId = cardEl.dataset.cardId;
      if (!cardId || !sweepableCardIds.has(cardId)) return;
      if (!rectsIntersect(cardEl.getBoundingClientRect(), screenRect)) return;
      primaryId ??= cardId;
      // A glue group is dragged and deleted as a unit, so it is selected as one too, even
      // where that reaches onto a dimmed layer.
      glueGroupIds(glueGroupMap, cardToGlue, cardId).forEach((id) => next.add(id));
    });
    selection.selectedCards = next;
    selection.primarySelectedId = primaryId;
  }

  /**
   * Save the frame rectangle and restore its previous value on failure. Roll back only if no
   * later poll or drag has changed it.
   */
  async #persistArea(area: ScopeArea, sent: BoardRect, prev: BoardRect): Promise<boolean> {
    if (await this.#host.onPersistScopeArea(area.scopeId, area.id, sent)) return true;
    const current = this.#host.scopeAreas.find((a) => a.id === area.id);
    if (current && sameBoardRect(current, sent)) Object.assign(current, prev);
    this.#host.onError("Failed to save scope area");
    return false;
  }

  async #applyScopeAreaChanges(changes: ScopeChange[]): Promise<void> {
    for (const { scopeId, change } of changes) {
      await this.#host.onScopeMembershipChange(scopeId, change);
    }
  }

  // Bound once, so it can be handed to the `scope-areas.ts` helpers as a plain function.
  #cardIdsInRect = (rect: WorldRect) => this.#host.cardIdsInRect(rect);

  #scopeAreaChanges(membersBefore: Map<string, Set<string>>): ScopeChange[] {
    return scopeAreaChanges(this.#host.scopeAreas, membersBefore, this.#cardIdsInRect);
  }

  /** Who is in a frame's scope, across every frame the scope has on this board. */
  #scopeMembersOf(area: ScopeArea): Set<string> {
    const scopeAreas = areasByScope(this.#host.scopeAreas).get(area.scopeId) ?? [area];
    return cardIdsInScope(scopeAreas, this.#cardIdsInRect);
  }
}
