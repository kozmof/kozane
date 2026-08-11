import type { Card, GlueRel } from "../../../db/api/types.js";
import type { CardWithGlue } from "$lib/types.js";
import type { CardPositionUpdate } from "../../../db/api/card.js";
export type { CardPositionUpdate as CardPositionPatch } from "../../../db/api/card.js";

export const GRID = 24;
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 2;
/** Opacity of a layer that is not the selected one: present, but well out of the way. */
export const INACTIVE_LAYER_OPACITY = 0.3;

export const PALETTE = [
  { bg: "oklch(93% 0.055 52)", dot: "oklch(62% 0.15 52)" },
  { bg: "oklch(93% 0.055 158)", dot: "oklch(62% 0.15 158)" },
  { bg: "oklch(93% 0.055 272)", dot: "oklch(62% 0.15 272)" },
  { bg: "oklch(93% 0.055 18)", dot: "oklch(62% 0.15 18)" },
  { bg: "oklch(93% 0.055 220)", dot: "oklch(62% 0.15 220)" },
  { bg: "oklch(93% 0.055 100)", dot: "oklch(62% 0.15 100)" },
  { bg: "oklch(93% 0.055 310)", dot: "oklch(62% 0.15 310)" },
  { bg: "oklch(93% 0.055 180)", dot: "oklch(62% 0.15 180)" },
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

export type StackedLayer<T> = { layer: T; rank: number; active: boolean };

/**
 * Stacking order of a project's layers: non-active layers keep their own index order at
 * the bottom, the active layer sits above all of them, and `floatingLayerId` (the layer
 * of a card being dragged) is lifted to the very top so a drag stays visible even when it
 * starts on a dimmed layer.
 */
export function layerStack<T extends { id: string; position: number }>(
  layers: T[],
  activeLayerId: string | null,
  floatingLayerId: string | null = null,
): StackedLayer<T>[] {
  const ordered = [...layers].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const priority = (layer: T) =>
    layer.id === floatingLayerId ? 2 : layer.id === activeLayerId ? 1 : 0;
  return ordered
    .map((layer, index) => ({ layer, index }))
    .sort((a, b) => priority(a.layer) - priority(b.layer) || a.index - b.index)
    .map(({ layer }, rank) => ({ layer, rank, active: layer.id === activeLayerId }));
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
