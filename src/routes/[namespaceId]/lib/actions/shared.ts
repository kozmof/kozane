import type { CardWithGlue, GlueRel } from "$lib/types";
import { readArray, readFiniteNumber, readString } from "../response.js";

/** Optimistic-update helpers shared by the board's action modules. */

/**
 * Roll back only the affected cards and fields against current state. Restoring a captured
 * array would also undo unrelated edits completed while the failed request was in flight.
 */
export function fieldSnapshot<K extends keyof CardWithGlue>(
  cards: CardWithGlue[],
  cardIds: Iterable<string>,
  field: K,
): Map<string, CardWithGlue[K]> {
  const wanted = new Set(cardIds);
  const previous = new Map<string, CardWithGlue[K]>();
  for (const card of cards) if (wanted.has(card.id)) previous.set(card.id, card[field]);
  return previous;
}

export function restoreField<K extends keyof CardWithGlue>(
  cards: CardWithGlue[],
  field: K,
  previous: Map<string, CardWithGlue[K]>,
): CardWithGlue[] {
  return cards.map((card) =>
    previous.has(card.id) ? { ...card, [field]: previous.get(card.id)! } : card,
  );
}

/**
 * Restore removed rows unless they already reappeared. Append them because canvas stacking
 * follows layer and zIndex rather than array position.
 */
export function reinsert<T extends { id: string }>(current: T[], removed: T[]): T[] {
  const present = new Set(current.map(({ id }) => id));
  return [...current, ...removed.filter(({ id }) => !present.has(id))];
}

export function reinsertGlueRels(current: GlueRel[], removed: GlueRel[]): GlueRel[] {
  const present = new Set(current.map(({ cardId }) => cardId));
  return [...current, ...removed.filter(({ cardId }) => !present.has(cardId))];
}

/**
 * Read the stacking lookup returned by a layer move. If absent or invalid, preserve existing
 * card zIndex values.
 */
export function readStacking(parsed: unknown): Map<string, number> {
  const stacking = readArray(parsed, "stacking");
  if (!stacking) return new Map();
  return new Map(
    stacking.flatMap((entry) => {
      const cardId = readString(entry, "cardId");
      const zIndex = readFiniteNumber(entry, "zIndex");
      return cardId !== undefined && zIndex !== undefined ? [[cardId, zIndex] as const] : [];
    }),
  );
}

/** Apply server-assigned zIndex values. Cards the lookup does not name keep theirs. */
export function withStacking(
  cards: CardWithGlue[],
  zIndexByCardId: ReadonlyMap<string, number>,
): CardWithGlue[] {
  if (zIndexByCardId.size === 0) return cards;
  return cards.map((card) => {
    const zIndex = zIndexByCardId.get(card.id);
    return zIndex === undefined ? card : { ...card, zIndex };
  });
}
