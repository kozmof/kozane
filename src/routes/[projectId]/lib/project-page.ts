import type { Card, GlueRel } from "../../../db/api/types.js";
import type { CardWithGlue } from "$lib/types.js";
import type { CardPositionUpdate } from "../../../db/api/card.js";
export type { CardPositionUpdate as CardPositionPatch } from "../../../db/api/card.js";

export type { CardWithGlue };

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

export type Point = { x: number; y: number };
export type WorldRect = Point & { w: number; h: number };
export type ScreenRect = { left: number; top: number; right: number; bottom: number };
export type RectLike = Pick<DOMRect, "left" | "top" | "right" | "bottom">;
export type CardPosition = { x: number; y: number };

// Colors repeat intentionally when bundles exceed PALETTE.length (8).
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
