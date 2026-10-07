import type { BoardRect } from "$lib/constants";
import type { Gesture, HorizontalGesture } from "./gesture.js";
import type { Point } from "./namespace-page.js";

/**
 * Represent the board's active gesture in one mutually exclusive slot. Each union member
 * carries the data its gesture needs. An exhaustive switch dispatches movement, and one cleanup
 * path releases resources when a gesture ends or is abandoned.
 *
 * `Gesture` in `gesture.ts` defines the shared press origin and movement threshold. This type
 * adds each gesture's specific state.
 *
 * The component uses `$state.raw` so starting or ending a gesture updates rendering without
 * making every pointer movement reactive. Fields such as `moved` and pointer trackers change in
 * place.
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
   * Scope membership at the start of the drag, captured across every frame before any cards
   * move. Compare it with membership after release.
   */
  areaMembersBefore: Map<string, Set<string>>;
  /**
   * Current pointer position for snapping and edge scrolling. Initialize it at press and
   * update it on every move.
   */
  pointer: Point;
};

/** Horizontal drag of a card width handle. See {@link HorizontalGesture}. */
export type CardResizeGesture = HorizontalGesture & {
  kind: "card-resize";
  cardId: string;
  /** The width the card was drawn at when the drag began, in canvas pixels. */
  startWidth: number;
  /**
   * Width restored after a failed save. Unlike numeric `startWidth`, this may be null to
   * restore the card's use of `ui.defaultCardWidth`.
   */
  prevWidth: number | null;
  /** Where the pointer was last seen, so the release can snap. Null until it moves. */
  pointerX: number | null;
};

/**
 * Warp-marker drag state. Unlike card drags, warps have no layer or glue group and do not
 * snap to the grid.
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
 * Frame drag state and the cards it carries. Capture `cardIds` on mousedown so passing over
 * other cards does not add them during movement.
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
   * Pre-drag membership across every frame of this scope. This is broader than the cards
   * carried by the dragged frame.
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
 * Alt-drag rectangle for a new scope frame. Share point geometry with marquee selection but
 * use `SCOPE_AREA_DRAW_MIN` and a different release action.
 */
export type AreaDrawGesture = Gesture & {
  kind: "area-draw";
  startWorldX: number;
  startWorldY: number;
};

/**
 * Canvas panning state. No movement threshold or commit is needed because an unmoved press
 * changes nothing.
 */
export type PanGesture = {
  kind: "pan";
  startX: number;
  startY: number;
  scrollLeft: number;
  scrollTop: number;
};

/**
 * Whether this gesture reserved position activity and must release it. Classify by gesture
 * kind so cancellation can balance the same reservation as normal release.
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
 * Dragged card ID, or null for other gestures. Derive this from the gesture slot so the
 * reported ID cannot disagree with the active gesture.
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
