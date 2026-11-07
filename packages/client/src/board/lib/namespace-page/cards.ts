/** Glue groups, card positions for saving and rollback, and stacking bounds. */
import type { GlueRel } from "@kozane/core";
import type { CardData, CardWithGlue } from "@kozane/core";
import type { CardPositionUpdate } from "@kozane/core";
import type { CardPosition } from "./geometry.js";

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
