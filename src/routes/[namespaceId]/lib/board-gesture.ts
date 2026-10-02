import type { BoardRect } from "$lib/constants";
import type { Gesture, HorizontalGesture } from "./gesture.js";
import type { Point } from "./namespace-page.js";

/**
 * The one gesture the board can have open, as a type that admits one.
 *
 * `KozaneCanvas.svelte` held these as eight independent nullable `let`s — `dragState`,
 * `resizeState`, `warpDragState`, `areaDragState`, `areaResizeState`, `panState`,
 * `rectangleSelectionState`, `scopeAreaDrawState` — and they are mutually exclusive. Nothing
 * said so. Eight nullable slots describe 256 states, of which nine are legal, and the
 * illegal ones were kept out by hand in three different ways:
 *
 * - **Each press checked a different subset.** A card press refused while `dragState ||
 *   resizeState`; a frame press while `dragState || resizeState || areaDragState`; a frame
 *   *resize* press while `areaResizeState` alone. No two of those lists agreed, and none of
 *   them was wrong about anything in particular — there was simply no statement of the rule
 *   for them to be checked against.
 * - **`onMove` ran all eight movers on every pointer move** and leaned on each returning at
 *   once unless its own slot was open. The comment above it said what that cost: "the order
 *   is kept rather than reasoned about afresh."
 * - **The canvas press cleared two slots defensively** (`dragState = null; panState = null`)
 *   to cover a release the window never saw. Two of eight, and clearing a card drag that way
 *   skipped `onPositionActivityEnd` — so the one case the defence existed for left the
 *   snapshot poll stood down for the life of the page.
 *
 * A tagged union collapses that to one slot: `switch (gesture.kind)` is exhaustive by
 * compilation, a press is refused by one uniform `if (gesture)`, and abandoning a stale
 * gesture is one function that releases what the press reserved.
 *
 * ## What this is not
 *
 * {@link Gesture} in `gesture.ts` says a press has an origin and may have travelled, and its
 * note is explicit that the *substance* beside those three fields does not generalise —
 * which card, which rectangle, who was in the frame before it moved. That still holds, and
 * this does not try to generalise any of it. Each member below carries its own substance.
 * What is shared is the slot, not the contents.
 *
 * ## Reactivity
 *
 * The component holds this in `$state.raw`, which is load-bearing. The fields written on
 * every pointer move — `moved`, and the `pointer` trackers below — must not be reactive
 * writes: there are sixty of them a second during a drag, and a proxied object would rerun
 * every derivation reading the gesture on each one. `$state.raw` tracks the *assignment*, so
 * picking a gesture up and putting it down drives the rendering while moving it does not.
 * That is the same split the eight separate `let`s had — plain fields for the substance,
 * `$state` for the few ids the board draws from — reached by stating it once instead of
 * maintaining a parallel set of variables.
 */
export type BoardGesture =
  | CardDragGesture
  | CardResizeGesture
  | WarpDragGesture
  | AreaDragGesture
  | AreaResizeGesture
  | MarqueeGesture
  | AreaDrawGesture
  | PanGesture;

/** Dragging a card, and with it whatever is glued to it or selected alongside it. */
export type CardDragGesture = Gesture & {
  kind: "card-drag";
  cardId: string;
  /** Pointer to card origin, in world pixels, so the card does not jump to the pointer. */
  offsetX: number;
  offsetY: number;
  /** Where it sat before the drag, to put back if the save fails. */
  prevX: number;
  prevY: number;
  lastX: number;
  lastY: number;
  groupIds: string[];
  /** The same ids as `groupIds`, for the membership test every pointer move makes. */
  groupIdSet: Set<string>;
  groupPrevPositions: Map<string, Point>;
  /**
   * Who was inside each frame when the drag began, by scope id — the `before` half of
   * `membershipTransition`, read once at the press rather than on release.
   *
   * It has to be read at mousedown: by the time the pointer comes up the cards have already
   * moved, and the board no longer holds the answer to what was inside before they did.
   * Every frame, not only the ones under the cards being dragged, because one drag can take
   * a card out of one frame and into another.
   */
  areaMembersBefore: Map<string, Set<string>>;
  /**
   * Where the pointer is, so the release can snap to the grid and the edge-scroll knows
   * which way to go. Set at the press and on every move, so never null — unlike the resize
   * trackers below, which a gesture can be released without ever having moved.
   */
  pointer: Point;
};

/** Dragging a card's width handle. Horizontal travel only; see {@link HorizontalGesture}. */
export type CardResizeGesture = HorizontalGesture & {
  kind: "card-resize";
  cardId: string;
  /** The width the card was drawn at when the drag began, in canvas pixels. */
  startWidth: number;
  /**
   * The width to put back if the save fails. Distinct from `startWidth`, which is always a
   * number: null is a card that had no width of its own and was following
   * `ui.defaultCardWidth`, and a failed resize has to leave it doing that.
   */
  prevWidth: number | null;
  /** Where the pointer was last seen, so the release can snap. Null until it moves. */
  pointerX: number | null;
};

/**
 * The marker being dragged. Its own member rather than folded into {@link CardDragGesture}:
 * a warp is not on a layer, is never glued to anything, and does not snap to the grid, so
 * the two share only the shape of a drag and none of its substance.
 */
export type WarpDragGesture = Gesture & {
  kind: "warp-drag";
  warpId: string;
  /** Pointer to marker centre, in world pixels, so the mark does not jump to the pointer. */
  offsetX: number;
  offsetY: number;
  /** Where it sat before the drag, to put back if the save fails. */
  prevX: number;
  prevY: number;
};

/**
 * The frame being dragged, and what it is carrying.
 *
 * `cardIds` is settled at mousedown and not recomputed while the pointer moves: the cards
 * travel with the frame, so the set cannot change on the way, and re-sweeping the board
 * every pointer move would pick up whatever the frame happened to be passing over.
 */
export type AreaDragGesture = Gesture & {
  kind: "area-drag";
  areaId: string;
  scopeId: string;
  /** Where the frame sat before the drag, to put back if the save fails. */
  prevRect: BoardRect;
  /** The cards inside it when the drag began, and where each of them was. */
  cardIds: string[];
  cardIdSet: Set<string>;
  cardPrevPositions: Map<string, Point>;
  /**
   * Who was in the *scope* before the drag, across every frame it has on this board — the
   * `before` half of `membershipTransition`. Wider than `cardIds`, which is only what this
   * frame carries: a card sitting in another frame of the same scope is a member throughout,
   * however this one moves. See `cardIdsInScope`.
   */
  membersBefore: Set<string>;
};

export type AreaResizeGesture = Gesture & {
  kind: "area-resize";
  areaId: string;
  scopeId: string;
  /** The rectangle the frame was drawn at when the drag began. */
  startRect: BoardRect;
  membersBefore: Set<string>;
  /** Where the pointer was last seen, so the release can snap. Null until it moves. */
  pointer: Point | null;
};

/** A shift-drag sweeping up the cards it crosses. */
export type MarqueeGesture = Gesture & {
  kind: "marquee";
  startWorldX: number;
  startWorldY: number;
};

/**
 * An Alt-drag drawing a scope frame. The same fields as {@link MarqueeGesture}, and for the
 * same reason: both are a rectangle pulled out of a point, and neither moves anything while
 * it is being drawn. What differs is only what the release does with it — and the threshold
 * it is held to, which is `SCOPE_AREA_DRAW_MIN` rather than the default.
 */
export type AreaDrawGesture = Gesture & {
  kind: "area-draw";
  startWorldX: number;
  startWorldY: number;
};

/**
 * A drag of the board itself. Not a {@link Gesture}: panning has no click-versus-drag
 * distinction to draw — a press that goes nowhere scrolls nowhere and there is nothing to
 * commit or undo — so it carries no `moved`, and its `startX`/`startY` are kept under those
 * names because the scroll arithmetic reads them as a plain origin rather than as the
 * threshold the other members measure against.
 */
export type PanGesture = {
  kind: "pan";
  startX: number;
  startY: number;
  scrollLeft: number;
  scrollTop: number;
};

/**
 * Whether a gesture reserved position activity at its press, and so owes the matching
 * release.
 *
 * The board calls `onPositionActivityStart` from five of the eight presses — the five that
 * move or resize something a poll would otherwise overwrite mid-drag — and nothing wrote
 * down which five. Each release handler simply remembered to call `onPositionActivityEnd`,
 * and the one path that *abandoned* a gesture rather than releasing it did not, because
 * there was nothing to ask.
 *
 * Asked of the kind rather than carried as a flag on each member, so a new gesture answers
 * it by being added to one list or the other rather than by its author remembering a field.
 */
export function holdsPositionActivity(kind: BoardGesture["kind"]): boolean {
  switch (kind) {
    case "card-drag":
    case "card-resize":
    case "warp-drag":
    case "area-drag":
    case "area-resize":
      return true;
    case "marquee":
    case "area-draw":
    case "pan":
      return false;
  }
}

/**
 * The card being dragged, or null when the open gesture is not a card drag.
 *
 * These four readers are what the component's `draggingId`, `draggingWarpId`,
 * `draggingAreaId` and `resizingAreaId` became: each was a `$state` variable set beside its
 * gesture at the press and nulled beside it on release, which is two writes per gesture that
 * could disagree with the gesture itself. Derived from the one slot instead, so they cannot.
 */
export function draggedCardId(gesture: BoardGesture | null): string | null {
  return gesture?.kind === "card-drag" ? gesture.cardId : null;
}

export function draggedWarpId(gesture: BoardGesture | null): string | null {
  return gesture?.kind === "warp-drag" ? gesture.warpId : null;
}

export function draggedAreaId(gesture: BoardGesture | null): string | null {
  return gesture?.kind === "area-drag" ? gesture.areaId : null;
}

export function resizedAreaId(gesture: BoardGesture | null): string | null {
  return gesture?.kind === "area-resize" ? gesture.areaId : null;
}
