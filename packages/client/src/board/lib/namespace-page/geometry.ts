/** Board geometry: the grid, rectangles, selection, frame membership, and resizing. */
import { clamp } from "$lib/constants.js";

export const GRID = 24;
/** Opacity for layers other than the selected layer. */
export const INACTIVE_LAYER_OPACITY = 0.3;

export type Point = { x: number; y: number };
export type WorldRect = Point & { w: number; h: number };
export type ScreenRect = { left: number; top: number; right: number; bottom: number };
export type RectLike = Pick<DOMRect, "left" | "top" | "right" | "bottom">;
export type CardPosition = { x: number; y: number };
export type PositionedCardSize = { posX: number; posY: number; width: number; height: number };

export function centeredScrollOffset(contentSize: number, viewportSize: number): number {
  return Math.max(0, (contentSize - viewportSize) / 2);
}

export function verticalListPosition(
  cards: PositionedCardSize[],
  posX: number,
  startY: number,
  cardWidth: number,
  gap = GRID,
): CardPosition {
  const nextY = cards.reduce((bottom, card) => {
    const intersectsColumn = card.posX < posX + cardWidth && card.posX + card.width > posX;
    return intersectsColumn ? Math.max(bottom, card.posY + card.height + gap) : bottom;
  }, startY);
  return { x: posX, y: Math.ceil(nextY / GRID) * GRID };
}

export function clientToWorld(
  clientX: number,
  clientY: number,
  canvasRect: Pick<DOMRect, "left" | "top">,
  scroll: Point,
  zoom: number,
): Point {
  return {
    x: (clientX - canvasRect.left + scroll.x) / zoom,
    y: (clientY - canvasRect.top + scroll.y) / zoom,
  };
}

export function selectionRectFromPoints(start: Point, current: Point): WorldRect {
  return {
    x: Math.min(start.x, current.x),
    y: Math.min(start.y, current.y),
    w: Math.abs(current.x - start.x),
    h: Math.abs(current.y - start.y),
  };
}

export function worldRectToScreenRect(
  rect: WorldRect,
  canvasRect: Pick<DOMRect, "left" | "top">,
  scroll: Point,
  zoom: number,
): ScreenRect {
  return {
    left: canvasRect.left + rect.x * zoom - scroll.x,
    top: canvasRect.top + rect.y * zoom - scroll.y,
    right: canvasRect.left + (rect.x + rect.w) * zoom - scroll.x,
    bottom: canvasRect.top + (rect.y + rect.h) * zoom - scroll.y,
  };
}

export function rectsIntersect(a: RectLike, b: RectLike): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/**
 * Find cards overlapping a screen-space rectangle using their rendered boxes. Text determines
 * height, so stored positions and widths are insufficient. Keep measurements in screen
 * coordinates to include zoom consistently.
 */
export function cardIdsOverlapping(
  cardEls: Iterable<HTMLElement>,
  screenRect: ScreenRect,
): Set<string> {
  const hit = new Set<string>();
  for (const el of cardEls) {
    const cardId = el.dataset.cardId;
    if (!cardId) continue;
    if (rectsIntersect(el.getBoundingClientRect(), screenRect)) hit.add(cardId);
  }
  return hit;
}

/** Which cards crossed a frame's edge, in each direction. */
export type MembershipTransition = { entered: string[]; exited: string[] };

/**
 * Compare frame overlap before and after a drag to find entered and exited cards. Preserve
 * manual scope membership for cards that crossed no boundary.
 *
 * Report entering cards even if already members. The idempotent insert handles existing
 * memberships.
 */
export function membershipTransition(
  before: Set<string>,
  after: Set<string>,
): MembershipTransition {
  const entered: string[] = [];
  const exited: string[] = [];
  for (const id of after) if (!before.has(id)) entered.push(id);
  for (const id of before) if (!after.has(id)) exited.push(id);
  return { entered, exited };
}

export type RectBounds = { canvasWidth: number; canvasHeight: number };

/** A scope area moved by a drag, held on the board. */
export function movedRect(rect: WorldRect, dx: number, dy: number, bounds: RectBounds): WorldRect {
  return {
    ...rect,
    x: clamp(rect.x + dx, 0, Math.max(0, bounds.canvasWidth - rect.w)),
    y: clamp(rect.y + dy, 0, Math.max(0, bounds.canvasHeight - rect.h)),
  };
}

/**
 * Resize from the bottom-right corner while keeping the origin fixed. Convert screen movement
 * by zoom, snap on release, and clamp the result. The server validates it again.
 */
export function resizedRect({
  rect,
  deltaX,
  deltaY,
  zoom,
  snapToGrid = false,
  minSize,
  bounds,
}: {
  rect: WorldRect;
  deltaX: number;
  deltaY: number;
  zoom: number;
  snapToGrid?: boolean;
  minSize: number;
  bounds: RectBounds;
}): WorldRect {
  const rawW = rect.w + deltaX / zoom;
  const rawH = rect.h + deltaY / zoom;
  const w = snapToGrid ? Math.round(rawW / GRID) * GRID : rawW;
  const h = snapToGrid ? Math.round(rawH / GRID) * GRID : rawH;
  return {
    x: rect.x,
    y: rect.y,
    w: clamp(w, minSize, Math.max(minSize, bounds.canvasWidth - rect.x)),
    h: clamp(h, minSize, Math.max(minSize, bounds.canvasHeight - rect.y)),
  };
}

export type Triangle = [Point, Point, Point];

/** How long a pointer may sit still inside the safe triangle before the popover gives up. */
export const SAFE_AREA_GRACE_MS = 400;

/**
 * Build the pointer corridor from the trigger exit point to the facing popover edge. Keep the
 * popover open during diagonal travel between them.
 */
export function safeTriangle(exit: Point, rect: RectLike): Triangle {
  if (exit.y <= rect.top)
    return [exit, { x: rect.left, y: rect.top }, { x: rect.right, y: rect.top }];
  if (exit.y >= rect.bottom)
    return [exit, { x: rect.left, y: rect.bottom }, { x: rect.right, y: rect.bottom }];
  if (exit.x <= rect.left)
    return [exit, { x: rect.left, y: rect.top }, { x: rect.left, y: rect.bottom }];
  return [exit, { x: rect.right, y: rect.top }, { x: rect.right, y: rect.bottom }];
}

/** Which side of the line through `a` and `b` the point falls on, by sign. */
function sideOfLine(point: Point, a: Point, b: Point): number {
  return (point.x - b.x) * (a.y - b.y) - (a.x - b.x) * (point.y - b.y);
}

/** Include points on the boundary. */
export function insideTriangle(point: Point, [a, b, c]: Triangle): boolean {
  const sides = [sideOfLine(point, a, b), sideOfLine(point, b, c), sideOfLine(point, c, a)];
  return !(sides.some((side) => side < 0) && sides.some((side) => side > 0));
}

type ResizedCardWidth = {
  /** The width the card was drawn at when the drag began. */
  startWidth: number;
  /** How far the pointer has travelled since, in screen pixels. */
  deltaX: number;
  zoom: number;
  snapToGrid: boolean;
  range: readonly [min: number, max: number];
};

/**
 * Convert horizontal pointer movement by zoom, then snap, clamp, and round the card width.
 * Keep this order so snapping cannot move the result beyond its bounds.
 */
export function resizedCardWidth({
  startWidth,
  deltaX,
  zoom,
  snapToGrid,
  range: [min, max],
}: ResizedCardWidth): number {
  const raw = startWidth + deltaX / zoom;
  const snapped = snapToGrid ? Math.round(raw / GRID) * GRID : raw;
  return Math.round(clamp(snapped, min, max));
}

export function edgeScrollVelocity(
  pointer: number,
  start: number,
  end: number,
  threshold = 80,
  maxSpeed = 18,
): number {
  if (pointer < start + threshold) {
    return -maxSpeed * Math.min(1, (start + threshold - pointer) / threshold);
  }
  if (pointer > end - threshold) {
    return maxSpeed * Math.min(1, (pointer - (end - threshold)) / threshold);
  }
  return 0;
}
