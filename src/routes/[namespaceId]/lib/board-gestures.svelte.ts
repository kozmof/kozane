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
 * What the gestures read from the board and hand back to it.
 *
 * Every member is read when it is needed rather than captured, because nearly all of them are
 * props of `KozaneCanvas` and change under it: the component passes an object of getters, so
 * a gesture always sees the cards, the zoom and the callbacks the board has *now*. `cards` and
 * `pendingScopeAreaRect` have setters as well, because both are bound back to the page and a
 * rollback or a finished frame-draw is written to the binding itself.
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
  /** The cards a marquee may sweep up: those drawn at full strength. */
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
 * Everything the pointer does on the board: pressing, dragging, and letting go of cards,
 * warps and scope frames, sweeping a selection, drawing a frame, and panning.
 *
 * The board's half of {@link BoardGesture}, which is the data: this is what opens one, moves
 * it, and settles it. Lifted out of `KozaneCanvas.svelte`, which kept it beside the props and
 * markup it is wired to; it is the bulk of what the board *does*, and none of it is markup.
 *
 * The component still owns the listeners. It forwards window `mousemove` and `mouseup` to
 * {@link move} and {@link release}, calls {@link autoScroll} once a frame, and passes each
 * press on a card, frame or marker to the matching method here.
 */
export class BoardGestures {
  readonly #host: BoardGestureHost;

  /**
   * The gesture the pointer has open, and there is at most one. See {@link BoardGesture} for
   * why this is one slot rather than eight nullable variables, and why it is `$state.raw`:
   * the open gesture is rewritten on every pointer move, and nothing draws from its fields.
   */
  gesture = $state.raw<BoardGesture | null>(null);

  /**
   * The rectangle being swept right now.
   *
   * The one part of a gesture that stays outside the slot, because it is the one part the
   * board *draws while the gesture is open*: it is rewritten on every pointer move and has
   * to be reactive, which is exactly what `$state.raw` denies the slot on purpose. Two
   * drafts rather than one, so a marquee and a frame draw cannot be confused for each other
   * by a renderer that only has a rectangle to go on.
   */
  selectionRect = $state<WorldRect | null>(null);
  /** The frame being drawn right now, before it is handed over as pending. */
  scopeAreaDraft = $state<WorldRect | null>(null);

  /**
   * Where the mouse was last seen, so a warp can be dropped under it. Null until the pointer
   * moves at all, which is the case a keyboard-only session stays in. Not part of the slot:
   * it outlives every gesture and is read when none is open.
   */
  lastPointer: Point | null = null;

  // Read by the board, derived off the slot rather than kept beside it; see the note on
  // `draggedCardId`.
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
   * Lifts the open gesture out of the slot, leaving the board with none.
   *
   * Taking it rather than reading it is what every exit path wants, and taking it *first* is
   * what makes a release safe to await in: the handler then works from the gesture it was
   * handed, not from a slot a later press may have refilled while a save was in flight.
   *
   * Does not release the position activity — see {@link #end} for why that is a separate
   * step rather than part of this one.
   */
  #take(): BoardGesture | null {
    const open = this.gesture;
    this.gesture = null;
    this.selectionRect = null;
    this.scopeAreaDraft = null;
    return open;
  }

  /**
   * Abandons the open gesture, releasing what its press reserved.
   *
   * For the one path that puts a gesture down without finishing it: a press on the bare
   * canvas while one is still open, which means the window never saw the release.
   * {@link holdsPositionActivity} is what makes that safe — the slot knows what it reserved,
   * so putting it down cannot forget to give it back and leave the snapshot poll stood down
   * for the life of the page.
   *
   * {@link release} does not come through here, because it has to hold the activity *open*
   * across the save it is about to make; it releases it in a `finally` of its own.
   */
  #end(): void {
    const open = this.#take();
    if (open && holdsPositionActivity(open.kind)) this.#host.onPositionActivityEnd();
  }

  /**
   * Whether a press may open a gesture. One uniform refusal for every press: not on a
   * read-only board, not with anything but the primary button, and not while a gesture is
   * already open — this press is not the start of another.
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
      // Per scope, not per frame. Built per frame, a scope framed twice would keep only the
      // last frame's set — so a card in the other one would read as having just arrived.
      areaMembersBefore: membersByScope(this.#host.scopeAreas, this.#cardIdsInRect),
      pointer: { x: e.clientX, y: e.clientY },
    });
  }

  pressCardResize(e: MouseEvent, cardId: string): void {
    if (!this.#mayOpen(e)) return;
    const card = this.#host.cards.find((c) => c.id === cardId);
    if (!card) return;
    // Counted as position activity for the same reason a drag is: the live-sync poll
    // replaces the card list wholesale, and a card being resized would snap back to its
    // stored width mid-drag.
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
    // The cards this frame carries are the ones inside *it*; who counts as a member of the
    // scope is a wider question, and `membersBefore` asks it across all of the scope's frames.
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
   * A press on a marker. It focuses the warp whatever else follows — that is what a click on
   * one has always meant, whether or not a drag can be armed behind it — and then arms a
   * drag, which comes to nothing unless the pointer actually moves.
   */
  pressWarp(e: MouseEvent, warpId: string): void {
    this.#host.onFocusWarp(warpId);
    if (!this.#mayOpen(e)) return;
    const warp = this.#host.warps.find((w) => w.id === warpId);
    if (!warp) return;
    const pressed = this.#host.viewport.toWorld(e.clientX, e.clientY);
    // Counted as position activity for the reason a card drag is: the poll replaces the
    // warp list wholesale, and a marker being dragged would snap back to its stored place.
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
    // A gesture still open on a press to the bare canvas means the window never saw the
    // release — the pointer went up over another application, or a context menu took it.
    // Put down properly, so the position activity its press reserved is given back.
    //
    // Unconditional, and before the branches below, because every one of them starts a
    // gesture of its own and none may start on top of another.
    if (this.gesture) this.#end();

    // Alt first, and before the shift branch: Alt-drag draws a scope area, and a press that
    // happens to carry both should draw one rather than sweep a selection.
    if (!readonly && e.altKey) {
      e.preventDefault();
      selection.composerCard = null;
      // A second draw replaces a rectangle still waiting for a scope: the prompt asks about
      // one rectangle, and the newer one is the one the pointer just meant.
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
   * Whether a click or double-click should be ignored as the end of a drag. `release` takes
   * the gesture out of the slot synchronously and the browser fires `click` after `mouseup`,
   * so a drag that has just ended is usually gone by then; this keeps exactly the reach the
   * check has always had.
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
   * Moves the open gesture, if there is one, and remembers where the pointer is.
   *
   * One `switch`, exhaustive by compilation: a gesture added to {@link BoardGesture} with no
   * arm here is a type error rather than a mover someone has to remember to call.
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
        // The longer threshold, which is the whole reason this is not the marquee arm with a
        // different target: an Alt-click that was meant as a click must not open a prompt.
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
        // Horizontal only: the handle sits on the card's edge, so a press that slides
        // straight down is not a resize. See `markMovedHorizontally`.
        markMovedHorizontally(g, clientX);
        this.#resizeCard(g, clientX);
        return;
      case "pan": {
        // No threshold: panning commits nothing, so there is no click to tell a drag from.
        const { el } = this.#host;
        el.scrollLeft = g.scrollLeft - (clientX - g.startX);
        el.scrollTop = g.scrollTop - (clientY - g.startY);
        return;
      }
    }
  }

  /**
   * Scrolls the board while a dragged card is held against its edge, carrying the card with
   * it. Called once a frame; does nothing unless a card drag is open.
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

  // The movers below each take the open gesture as an argument rather than reading the slot:
  // the parameter is non-nullable, so only a `switch` arm that has narrowed it can call one.
  //
  // They all write through the rows rather than mapping a replacement array. They run on
  // every pointer move, and replacing the array marks the whole list dirty: the derived layer
  // grouping is rebuilt and every card on the board re-evaluates its styles, sixty times a
  // second, to move one card and whatever is glued to it. Assigning a position touches only
  // the row it belongs to.

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
    // Rounded and held on the board here, which is what the server will store anyway, so the
    // marker does not shift under the pointer when the save answers. No grid snap: a warp
    // marks a point someone chose to come back to, not a slot in a layout.
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
   * The slot is read and cleared *before* anything is awaited. Each arm then works from `g`,
   * the gesture it narrowed, and not from state a later press may have replaced while a save
   * was in flight.
   */
  async release(): Promise<void> {
    // Read before the slot is emptied: these are what a marquee or a frame-draw release is
    // about, and `#take` clears both along with the gesture.
    const drafts = { swept: this.selectionRect, drawn: this.scopeAreaDraft };
    const g = this.#take();
    if (!g) return;
    try {
      await this.#settle(g, drafts);
    } finally {
      // Held open across everything above, which is the point of releasing it here rather
      // than in `#take`: the snapshot poll must stay stood down until the save it would
      // otherwise overwrite has answered — the local rollbacks and the scope membership
      // writes that follow a save included. Holding it a moment longer can only make the
      // poll wait; releasing it early is what loses an edit.
      if (holdsPositionActivity(g.kind)) this.#host.onPositionActivityEnd();
    }
  }

  async #settle(g: BoardGesture, drafts: Drafts): Promise<void> {
    switch (g.kind) {
      case "area-draw":
        // A draw that went nowhere was an Alt-click, not a rectangle. Dropped without asking
        // anything: a prompt nobody meant to open is worse than no frame.
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
    // Measured against the drawn board, which is why the flush comes first: the release
    // snaps the card to the grid by writing `posX`, and reading a box before Svelte has put
    // that on screen measures where the card was a moment ago. A snap is only a few pixels,
    // but a few pixels is the whole question for a card dropped on a frame's edge.
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
    // Only put the position back if the marker still holds the one that failed to save: a
    // poll or another drag may have moved on since the request went out.
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
    // The flush matters most here. The frame and everything it carries have moved by the
    // same delta, and none of it is on screen yet — so measuring now would test the frame's
    // new rectangle against the cards' old boxes, and report the members it just carried
    // across the board as having left the scope.
    await tick();
    const areaChanges = this.#scopeAreaChanges(new Map([[g.scopeId, g.membersBefore]]));
    // The frame first: the cards were carried by it, and a frame that did not move is a set
    // of cards that should not have moved either.
    let ok = await this.#persistArea(dropped, sent, g.prevRect);
    if (ok && positions.length > 0) ok = await this.#host.onPersistPositions(positions);
    if (ok) {
      // A frame dragged over a card that was not in it picks that card up. Nothing leaves
      // this way: the members travelled with the frame.
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
    // Nothing moved, but the frame's own edge did, and the release snapped it: the cards it
    // just stopped covering are decided by where that edge came to rest.
    await tick();
    const areaChanges = this.#scopeAreaChanges(new Map([[g.scopeId, g.membersBefore]]));
    // Both directions here, unlike a frame drag: growing the frame takes cards in, and
    // shrinking it past one lets that card out.
    if (await this.#persistArea(resized, sent, g.startRect)) {
      await this.#applyScopeAreaChanges(areaChanges);
    }
  }

  async #settleCardResize(g: CardResizeGesture): Promise<void> {
    if (!g.moved || g.pointerX === null) return;
    this.#resizeCard(g, g.pointerX, true);
    const sent = this.#host.cards.find((c) => c.id === g.cardId)?.width ?? null;
    if (sent === null || (await this.#host.onPersistWidth(g.cardId, sent))) return;
    // Only put the width back if it is still the one that failed to save: a poll or another
    // resize may have moved on since the request went out.
    this.#host.cards = this.#host.cards.map((c) =>
      c.id === g.cardId && c.width === sent ? { ...c, width: g.prevWidth } : c,
    );
    this.#host.onError("Failed to save card width");
  }

  // ── What a release decides ───────────────────────────────────────────────

  /**
   * Selects the cards the swept rectangle covers.
   *
   * Takes the rectangle rather than reading `selectionRect`: the slot and its draft are
   * emptied before anything is awaited, so by the time this runs the draft is gone.
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
   * Saves a frame's rectangle, putting it back if the save is refused.
   *
   * Only puts it back if the frame still holds the rectangle that failed: a poll or another
   * drag may have moved on since the request went out. Same guard, and the same reason, as
   * the warp drop.
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
