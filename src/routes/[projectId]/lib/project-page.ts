import type { Card, GlueRel } from "../../../db/api/types.js";

export const GRID = 24;
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 2;
export const ZOOM_STEP = 0.1;

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

export type CardWithGlue = Card & { glueId: string | null };
export type Point = { x: number; y: number };
export type WorldRect = Point & { w: number; h: number };
export type ScreenRect = { left: number; top: number; right: number; bottom: number };
export type RectLike = Pick<DOMRect, "left" | "top" | "right" | "bottom">;
export type CardPosition = { x: number; y: number };
export type CardPositionPatch = { cardId: string; posX: number; posY: number };

export function applyPalette<T extends { id: string }>(bundles: T[]) {
  return bundles.map((bundle, i) => ({ ...bundle, ...PALETTE[i % PALETTE.length] }));
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

export function glueGroupIds(glueRels: GlueRel[], cardId: string): string[] {
  const rel = glueRels.find((r) => r.cardId === cardId);
  if (!rel) return [cardId];
  return glueRels.filter((r) => r.glueId === rel.glueId).map((r) => r.cardId);
}

export function dragGroupIds(
  glueRels: GlueRel[],
  selectedCards: ReadonlySet<string>,
  cardId: string,
): string[] {
  const glueIds = glueGroupIds(glueRels, cardId).filter((id) => id !== cardId);
  const selectionIds = selectedCards.has(cardId)
    ? [...selectedCards].filter((id) => id !== cardId)
    : [];
  return [...new Set([...glueIds, ...selectionIds])];
}

export function previousPositions<T extends { id: string; posX: number; posY: number }>(
  cards: T[],
  cardIds: string[],
): Map<string, CardPosition> {
  const byId = new Map(cards.map((card) => [card.id, card]));
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
): CardPositionPatch[] {
  const byId = new Map(cards.map((card) => [card.id, card]));
  return cardIds.flatMap((id) => {
    const card = byId.get(id);
    return card ? [{ cardId: id, posX: card.posX, posY: card.posY }] : [];
  });
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
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value * 10) / 10));
}
