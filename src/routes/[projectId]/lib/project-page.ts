import type { Card, GlueRel } from "../../../db/api/types.js";
import type { CardWithGlue } from "$lib/types.js";
import { clamp } from "$lib/constants.js";
import type { CardPositionUpdate } from "../../../db/api/card.js";
export type { CardPositionUpdate as CardPositionPatch } from "../../../db/api/card.js";

export const GRID = 24;
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 2;
/** Opacity of a layer that is not the selected one: present, but well out of the way. */
export const INACTIVE_LAYER_OPACITY = 0.3;

export const PALETTE = [
  { bg: "oklch(93% 0.055 272)", dot: "oklch(80% 0.21 272)" },
  { bg: "oklch(93% 0.055 158)", dot: "oklch(80% 0.21 158)" },
  { bg: "oklch(93% 0.055 220)", dot: "oklch(80% 0.21 220)" },
  { bg: "oklch(93% 0.055 18)", dot: "oklch(80% 0.21 18)" },
  { bg: "oklch(93% 0.055 100)", dot: "oklch(80% 0.21 100)" },
  { bg: "oklch(93% 0.055 52)", dot: "oklch(80% 0.21 52)" },
  { bg: "oklch(93% 0.055 310)", dot: "oklch(80% 0.21 310)" },
  { bg: "oklch(93% 0.055 180)", dot: "oklch(80% 0.21 180)" },
] as const;

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

// Colors repeat intentionally when bundles exceed PALETTE.length (8).
export function applyPalette<T extends { id: string }>(bundles: T[]) {
  return bundles.map((bundle, i) => ({ ...bundle, ...PALETTE[i % PALETTE.length] }));
}

export type StackedLayer<T> = { layer: T; rank: number; active: boolean; floating: boolean };

/**
 * Bottom to top, the one ordering of a project's layers: by position, with the id as the
 * tiebreak. Mirrors what `getAllLayers` asks SQLite for, and is what every other view of
 * the layers is derived from, so nothing has to re-decide what "in order" means.
 */
export function orderLayers<T extends { id: string; position: number }>(layers: T[]): T[] {
  // Plain comparison rather than localeCompare: the tiebreak has to land the same way as
  // SQLite's binary `ORDER BY id`, whatever locale the browser happens to be in.
  return [...layers].sort(
    (a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/**
 * Stacking order of a project's layers: non-active layers keep their own index order at
 * the bottom, the active layer sits above all of them, and `floatingLayerId` (the layer
 * of a card being dragged) is lifted to the very top so a drag stays visible even when it
 * starts on a dimmed layer. Both the active and the floating layer are drawn at full
 * strength — a card is dragged to be looked at.
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
 * The reordering a drop produces: `ids` and the result are both in display order (top of
 * the stack first), which is the reverse of the bottom-to-top order the API takes.
 */
export function reorderByDrop(ids: string[], draggedId: string, targetId: string): string[] {
  if (draggedId === targetId) return [...ids];
  return moveWithin(ids, draggedId, ids.indexOf(targetId));
}

/**
 * The reordering a keyboard nudge produces: `delta` is -1 for up the display list, 1 for
 * down. Returns null at the ends of the list, where there is nothing to commit.
 */
export function reorderByNudge(ids: string[], id: string, delta: -1 | 1): string[] | null {
  const target = ids.indexOf(id) + delta;
  if (target < 0 || target >= ids.length) return null;
  return moveWithin(ids, id, target);
}

export function glueIdByCardId<T extends { cardId: string; glueId: string }>(glueRels: T[]) {
  return new Map(glueRels.map((rel) => [rel.cardId, rel.glueId]));
}

export function cardsWithGlueIds(cards: Card[], glueRels: GlueRel[]): CardWithGlue[] {
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

// Folded rather than spread into Math.max/Math.min: `Math.max(...cards)` throws once
// the workspace grows past the engine's argument limit. Both are seeded at 0, the
// column default, so an empty canvas yields the same layer a first card would get.
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

export type Triangle = [Point, Point, Point];

/** How long a pointer may sit still inside the safe triangle before the popover gives up. */
export const SAFE_AREA_GRACE_MS = 400;

/**
 * The corridor a pointer is allowed to travel through on its way from a trigger to the
 * popover it opened: the point where the pointer left the trigger, plus the two corners of
 * the popover edge facing it. A popover sitting below and to one side of its button is
 * reached diagonally, and that diagonal crosses ground belonging to neither — closing on
 * the way there is the bug this prevents.
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

/** Inside, or on an edge: a pointer on the boundary is still on its way in. */
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
 * Whether a viewport scrolled to `scroll` is showing `center` as centred as the board
 * allows, along one axis. Not the same question as "is the view centre this point": a
 * point within half a viewport of the canvas edge can never reach the middle, because
 * {@link scrollForViewCenter} clamps, and the view has still arrived at everything it can
 * of it. Compared to the nearest pixel, since a browser may round a scroll offset to whole
 * device pixels.
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
 * The next warp in `direction` from `from`, wrapping round the board when there is none:
 * travelling right off the rightmost warp arrives at the leftmost, and down off the
 * bottom one at the top. `currentId` is the warp the view is already on, which the wrap
 * avoids landing back on. `null` only when the project has no warps at all.
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
 * The warp travelling `direction` wraps round to: the leftmost when going right, the
 * topmost when going down, and so on. Ties keep creation order.
 *
 * The warp the view is already on is left out of the running: warps sharing the edge —
 * two at the same x, say — would otherwise wrap the focus straight back onto itself and
 * the key would look broken. It comes back in only when it is the last one standing,
 * where staying put is all a single-warp board can do.
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
 * The closest warp that actually lies `direction` of `from`, weighted so an
 * almost-straight-ahead warp beats a distant diagonal. `null` when nothing lies that way —
 * {@link warpInDirection} is what turns that into a wrap.
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
    // Ties fall to the straighter one, and then to the older warp: `warps` arrives in
    // creation order, so a tie always resolves the same way twice running.
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
