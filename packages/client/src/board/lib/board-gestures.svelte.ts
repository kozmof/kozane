import { SCOPE_AREA_DRAW_MIN } from "../../constants/index.js";
import { gestureOrigin, markMoved, markMovedHorizontally } from "./gesture.js";
import {
  draggedAreaId,
  draggedCardId,
  draggedInventoryId,
  draggedStowedCardId,
  draggedWarpId,
  holdsPositionActivity,
  resizedAreaId,
  type BoardGesture,
} from "./board-gesture.js";
import { sameDropTarget, type DropTarget } from "./inventory-drop.js";
import {
  edgeScrollVelocity,
  selectionRectFromPoints,
  type Point,
  type WorldRect,
} from "./namespace-page.js";
import type { BoardGestureHost } from "./board-gesture-host.js";
import {
  moveArea,
  moveCard,
  moveInventory,
  moveWarp,
  resizeArea,
  resizeCard,
} from "./board-gesture-moves.js";
import { settleGesture } from "./board-gesture-release.js";
import {
  areaDragGesture,
  areaResizeGesture,
  cardDragGesture,
  cardResizeGesture,
  inventoryDragGesture,
  selectClickedCard,
  stowedDragGesture,
  warpDragGesture,
} from "./board-gesture-press.js";

export type { BoardGestureHost } from "./board-gesture-host.js";
export { STOWED_GRAB_INSET } from "./board-gesture-release.js";

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
   * The inventory or slot a dragged card would drop into, for highlighting it. Null when the
   * pointer is over neither, and while nothing that can be stored is being dragged.
   */
  dropTarget = $state<DropTarget | null>(null);
  /** Screen point of a card dragged out of an inventory, where its preview is drawn. */
  stowedPointer = $state<Point | null>(null);

  /**
   * Last known pointer position for placing warps. Null until the pointer moves. Keep it
   * outside the gesture slot because it is also read between gestures.
   */
  lastPointer: Point | null = null;

  // Derive board-visible state from the active gesture. See `draggedCardId`.
  readonly draggingCardId = $derived(draggedCardId(this.gesture));
  readonly draggingWarpId = $derived(draggedWarpId(this.gesture));
  readonly draggingInventoryId = $derived(draggedInventoryId(this.gesture));
  readonly draggingStowedCardId = $derived(draggedStowedCardId(this.gesture));
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
    this.dropTarget = null;
    this.stowedPointer = null;
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

  /** {@link #openHolding} for a press whose target may have left the board. */
  #openBuilt(g: BoardGesture | null): void {
    if (g) this.#openHolding(g);
  }

  // ── Presses ──────────────────────────────────────────────────────────────

  pressCard(e: MouseEvent, cardId: string): void {
    if (!this.#mayOpen(e)) return;
    e.stopPropagation();
    this.#openBuilt(cardDragGesture(this.#host, e, cardId));
  }

  pressCardResize(e: MouseEvent, cardId: string): void {
    if (!this.#mayOpen(e)) return;
    // Pause polling during resize so snapshots cannot restore the stored width mid-drag.
    this.#openBuilt(cardResizeGesture(this.#host, e, cardId));
  }

  pressArea(e: MouseEvent, areaId: string): void {
    if (!this.#mayOpen(e)) return;
    this.#openBuilt(areaDragGesture(this.#host, e, areaId));
  }

  pressAreaResize(e: MouseEvent, areaId: string): void {
    if (!this.#mayOpen(e)) return;
    this.#openBuilt(areaResizeGesture(this.#host, e, areaId));
  }

  /**
   * Focus the clicked warp and arm a drag when permitted. An unmoved press only changes
   * focus.
   */
  pressWarp(e: MouseEvent, warpId: string): void {
    this.#host.onFocusWarp(warpId);
    if (!this.#mayOpen(e)) return;
    // Pause polling during warp dragging so snapshots cannot restore the stored position
    // mid-drag.
    this.#openBuilt(warpDragGesture(this.#host, e, warpId));
  }

  /**
   * Arm a drag of an inventory icon. Releasing without moving opens or closes the inventory,
   * which is how a click on the icon works on a writable board.
   */
  pressInventory(e: MouseEvent, inventoryId: string): void {
    if (!this.#mayOpen(e)) return;
    this.#openBuilt(inventoryDragGesture(this.#host, e, inventoryId));
  }

  /** Arm a drag of a card out of its inventory grid. */
  pressStowedCard(e: MouseEvent, cardId: string): void {
    if (!this.#mayOpen(e)) return;
    this.#openBuilt(stowedDragGesture(this.#host, e, cardId));
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
    selectClickedCard(this.#host, e, cardId);
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
        moveCard(this.#host, g, clientX, clientY);
        // Only an inventory is a different place to drop a canvas card.
        if (g.moved) this.#aimAt(clientX, clientY, "inventory");
        return;
      case "warp-drag":
        markMoved(g, clientX, clientY);
        moveWarp(this.#host, g, clientX, clientY);
        return;
      case "inventory-drag":
        g.pointer = { x: clientX, y: clientY };
        markMoved(g, clientX, clientY);
        moveInventory(this.#host, g, clientX, clientY);
        return;
      case "stowed-drag":
        g.pointer = { x: clientX, y: clientY };
        markMoved(g, clientX, clientY);
        if (!g.moved) return;
        this.stowedPointer = g.pointer;
        this.#aimAt(clientX, clientY, "any");
        return;
      case "area-drag":
        markMoved(g, clientX, clientY);
        moveArea(this.#host, g, clientX, clientY);
        return;
      case "area-resize":
        g.pointer = { x: clientX, y: clientY };
        markMoved(g, clientX, clientY);
        resizeArea(this.#host, g, clientX, clientY);
        return;
      case "card-resize":
        g.pointerX = clientX;
        // Require horizontal motion to resize. See `markMovedHorizontally`.
        markMovedHorizontally(g, clientX);
        resizeCard(this.#host, g, clientX);
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
   * Scroll at the board edge during a card or inventory icon drag, moving what is dragged
   * with the viewport. Called once per animation frame.
   */
  autoScroll(): void {
    const g = this.gesture;
    if (g?.kind !== "card-drag" && g?.kind !== "inventory-drag") return;
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
      if (g.kind === "card-drag") moveCard(this.#host, g, g.pointer.x, g.pointer.y);
      else moveInventory(this.#host, g, g.pointer.x, g.pointer.y);
    }
  }

  /**
   * Track what the pointer is over for highlighting. Assigned only when it changes, so a
   * pointer moving within one slot does not redraw the grid.
   */
  #aimAt(clientX: number, clientY: number, accept: "inventory" | "any"): void {
    const found = this.#host.dropTargetAt(clientX, clientY);
    const next = accept === "inventory" && found?.kind !== "inventory" ? null : found;
    if (!sameDropTarget(this.dropTarget, next)) this.dropTarget = next;
  }

  // ── Letting go ───────────────────────────────────────────────────────────

  /**
   * Finish the active gesture and apply its release action.
   *
   * The slot is read and cleared before anything is awaited. Each arm then works from `g`,
   * the gesture it narrowed, and not from state a later press may have replaced while a save
   * was in flight.
   */
  async release(): Promise<void> {
    // Read the draft rectangles before `#take` clears them with the gesture.
    const drafts = {
      swept: this.selectionRect,
      drawn: this.scopeAreaDraft,
      target: this.dropTarget,
    };
    const g = this.#take();
    if (!g) return;
    try {
      await settleGesture(this.#host, g, drafts, this.lastPointer);
    } finally {
      // Hold position activity through saves, rollback, and membership writes so polling
      // cannot overwrite an unfinished edit. Release it in finally.
      if (holdsPositionActivity(g.kind)) this.#host.onPositionActivityEnd();
    }
  }
}
