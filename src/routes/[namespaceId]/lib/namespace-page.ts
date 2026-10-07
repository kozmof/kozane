import type { GlueRel } from "$db/api/types.js";
import type { CardData, CardWithGlue } from "$lib/types.js";
import { clamp } from "$lib/constants.js";
import { compareIds } from "$lib/order.js";
import type { CardPositionUpdate } from "$db/api/card.js";
export type { CardPositionUpdate as CardPositionPatch } from "$db/api/card.js";

export const GRID = 24;
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 2;
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

export type StackedLayer<T> = { layer: T; rank: number; active: boolean; floating: boolean };

/**
 * Order layers bottom to top by position, then ID, matching `getAllLayers`. Derive other
 * layer views from this shared order.
 */
export function orderLayers<T extends { id: string; position: number }>(layers: T[]): T[] {
  // Use `compareIds` to match SQLite's binary ID ordering regardless of browser locale.
  return [...layers].sort((a, b) => a.position - b.position || compareIds(a.id, b.id));
}

/**
 * Stack ordinary layers in index order, then the active layer, then the dragged card's layer.
 * Draw active and dragged layers at full opacity.
 */
export function layerStack<T extends { id: string; position: number }>(
  layers: T[],
  activeLayerId: string | null,
  floatingLayerId: string | null = null,
): StackedLayer<T>[] {
  const priority = (layer: T) =>
    layer.id === floatingLayerId ? 2 : layer.id === activeLayerId ? 1 : 0;
  return orderLayers(layers)
    .map((layer, index) => ({ layer, index }))
    .sort((a, b) => priority(a.layer) - priority(b.layer) || a.index - b.index)
    .map(({ layer }, rank) => ({
      layer,
      rank,
      active: layer.id === activeLayerId,
      floating: layer.id === floatingLayerId,
    }));
}

/** Moves one id to `toIndex` within a list, closing the gap it leaves behind. */
export function moveWithin(ids: string[], id: string, toIndex: number): string[] {
  const next = [...ids];
  const from = next.indexOf(id);
  if (from === -1 || toIndex < 0 || toIndex >= next.length) return next;
  next.splice(from, 1);
  next.splice(toIndex, 0, id);
  return next;
}

/**
 * Reorder layers after a drop. Input and output use top-first display order, opposite to the
 * API's bottom-first order.
 */
export function reorderByDrop(ids: string[], draggedId: string, targetId: string): string[] {
  if (draggedId === targetId) return [...ids];
  return moveWithin(ids, draggedId, ids.indexOf(targetId));
}

/**
 * Move a layer up for `delta` -1 or down for 1 in display order. Return null when already at
 * the requested end.
 */
export function reorderByNudge(ids: string[], id: string, delta: -1 | 1): string[] | null {
  const target = ids.indexOf(id) + delta;
  if (target < 0 || target >= ids.length) return null;
  return moveWithin(ids, id, target);
}

export function glueIdByCardId<T extends { cardId: string; glueId: string }>(glueRels: T[]) {
  return new Map(glueRels.map((rel) => [rel.cardId, rel.glueId]));
}

/**
 * Attach glue groups to `CardData`. Accept the projected type because spreading a full
 * database row would expose unrelated columns in browser data. See `getCardDataByPartitions`.
 */
export function cardsWithGlueIds(cards: CardData[], glueRels: GlueRel[]): CardWithGlue[] {
  const cardGlueMap = glueIdByCardId(glueRels);
  return cards.map((card) => ({
    ...card,
    glueId: cardGlueMap.get(card.id) ?? null,
  }));
}

export function buildGlueGroupMap(glueRels: GlueRel[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const rel of glueRels) {
    const group = map.get(rel.glueId);
    if (group) group.push(rel.cardId);
    else map.set(rel.glueId, [rel.cardId]);
  }
  return map;
}

export function glueGroupIds(
  groupMap: Map<string, string[]>,
  cardToGlue: Map<string, string>,
  cardId: string,
): string[] {
  const glueId = cardToGlue.get(cardId);
  return glueId ? (groupMap.get(glueId) ?? [cardId]) : [cardId];
}

export function dragGroupIds(
  groupMap: Map<string, string[]>,
  cardToGlue: Map<string, string>,
  selectedCards: ReadonlySet<string>,
  cardId: string,
): string[] {
  const glueIds = glueGroupIds(groupMap, cardToGlue, cardId).filter((id) => id !== cardId);
  const selectionIds = selectedCards.has(cardId)
    ? [...selectedCards].filter((id) => id !== cardId)
    : [];
  return [...new Set([...glueIds, ...selectionIds])];
}

function buildCardMap<T extends { id: string }>(cards: T[]): Map<string, T> {
  return new Map(cards.map((card) => [card.id, card]));
}

export function previousPositions<T extends { id: string; posX: number; posY: number }>(
  cards: T[],
  cardIds: string[],
): Map<string, CardPosition> {
  const byId = buildCardMap(cards);
  return new Map(
    cardIds.flatMap((id) => {
      const card = byId.get(id);
      return card ? [[id, { x: card.posX, y: card.posY }]] : [];
    }),
  );
}

export function cardPositionPatches<T extends { id: string; posX: number; posY: number }>(
  cards: T[],
  cardIds: string[],
): CardPositionUpdate[] {
  const byId = buildCardMap(cards);
  return cardIds.flatMap((id) => {
    const card = byId.get(id);
    return card ? [{ cardId: id, posX: card.posX, posY: card.posY }] : [];
  });
}

/**
 * Restore cards after a failed position save only if they still have the submitted positions.
 * Preserve later changes. Return a new array while retaining untouched rows.
 */
export function revertedPositions<T extends { id: string; posX: number; posY: number }>(
  cards: T[],
  sent: readonly CardPositionUpdate[],
  previous: ReadonlyMap<string, CardPosition>,
): T[] {
  const sentById = new Map(sent.map((pos) => [pos.cardId, pos]));
  return cards.map((card) => {
    const was = sentById.get(card.id);
    const prev = previous.get(card.id);
    if (!was || !prev || card.posX !== was.posX || card.posY !== was.posY) return card;
    return { ...card, posX: prev.x, posY: prev.y };
  });
}

// Reduce values instead of spreading them into Math.max/Math.min, which can exceed the
// engine's argument limit. Start at the column default of zero for an empty board.
export function maxZIndex(cards: readonly { zIndex: number }[]): number {
  return cards.reduce((highest, card) => (card.zIndex > highest ? card.zIndex : highest), 0);
}

export function minZIndex(cards: readonly { zIndex: number }[]): number {
  return cards.reduce((lowest, card) => (card.zIndex < lowest ? card.zIndex : lowest), 0);
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

/** The world coordinate the viewport is centred on, along one axis. */
export function viewCenterWorld(scroll: number, viewportSize: number, zoom: number): number {
  return (scroll + viewportSize / 2) / zoom;
}

/** The scroll offset that puts `center` in the middle of the viewport, along one axis. */
export function scrollForViewCenter(
  center: number,
  viewportSize: number,
  zoom: number,
  maxScroll: number,
): number {
  return clamp(center * zoom - viewportSize / 2, 0, Math.max(0, maxScroll));
}

/** How far a scroll offset may sit from the one asked for and still count as arrived. */
const SCROLL_EPSILON = 1;

/**
 * Check whether `scroll` centres the target as closely as canvas bounds allow on one axis.
 * Use {@link scrollForViewCenter} and pixel rounding because edge targets cannot reach the
 * viewport centre and browsers may round scroll offsets.
 */
export function isViewCenteredOn(
  scroll: number,
  center: number,
  viewportSize: number,
  zoom: number,
  maxScroll: number,
): boolean {
  return (
    Math.abs(scroll - scrollForViewCenter(center, viewportSize, zoom, maxScroll)) <= SCROLL_EPSILON
  );
}

export type WarpDirection = "left" | "right" | "up" | "down";

/** Arrow keys, as data, so the key-to-direction step is testable outside the component. */
export const ARROW_DIRECTIONS: Record<string, WarpDirection> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

/** Below this many world pixels a warp counts as being where the view already is. */
const WARP_EPSILON = 1;

/**
 * How far off the travelled axis a warp may sit before a nearer-but-sideways one loses.
 * Pressing `→` should reach the warp just to the right rather than the one far right and
 * far down, so distance across the direction costs double distance along it.
 */
const CROSS_AXIS_PENALTY = 2;

/**
 * Find the next warp in `direction`, wrapping to the opposite side when needed. Avoid
 * wrapping to `currentId` when another warp is available. Return null only for an empty
 * namespace.
 */
export function warpInDirection<T extends { id: string; posX: number; posY: number }>(
  warps: readonly T[],
  from: Point,
  direction: WarpDirection,
  currentId: string | null = null,
): T | null {
  return (
    nearestWarpInDirection(warps, from, direction) ??
    farthestWarpBehind(warps, direction, currentId)
  );
}

/**
 * Choose the opposite-edge warp when navigation wraps, breaking ties by creation order.
 * Exclude the focused warp unless it is the only candidate.
 */
function farthestWarpBehind<T extends { id: string; posX: number; posY: number }>(
  warps: readonly T[],
  direction: WarpDirection,
  currentId: string | null,
): T | null {
  const others = currentId === null ? warps : warps.filter(({ id }) => id !== currentId);
  const candidates = others.length > 0 ? others : warps;
  const horizontal = direction === "left" || direction === "right";
  // Going right restarts from the smallest x, going left from the largest.
  const sign = direction === "right" || direction === "down" ? 1 : -1;
  const along = (warp: T) => (horizontal ? warp.posX : warp.posY);
  let best: T | null = null;
  for (const warp of candidates) {
    if (best === null || sign * (along(warp) - along(best)) < 0) best = warp;
  }
  return best;
}

/**
 * Find the closest warp in the requested direction, favoring straight-ahead travel. Return
 * null when none exists so {@link warpInDirection} can wrap.
 */
export function nearestWarpInDirection<T extends { id: string; posX: number; posY: number }>(
  warps: readonly T[],
  from: Point,
  direction: WarpDirection,
): T | null {
  const horizontal = direction === "left" || direction === "right";
  const sign = direction === "right" || direction === "down" ? 1 : -1;

  let best: T | null = null;
  let bestScore = Infinity;
  let bestCross = Infinity;
  for (const warp of warps) {
    const along = sign * (horizontal ? warp.posX - from.x : warp.posY - from.y);
    if (along <= WARP_EPSILON) continue;
    const cross = Math.abs(horizontal ? warp.posY - from.y : warp.posX - from.x);
    const score = along + CROSS_AXIS_PENALTY * cross;
    // Break ties by the straighter direction, then creation order for consistent results.
    if (score < bestScore || (score === bestScore && cross < bestCross)) {
      best = warp;
      bestScore = score;
      bestCross = cross;
    }
  }
  return best;
}

export function clampZoom(value: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value * 100) / 100));
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
