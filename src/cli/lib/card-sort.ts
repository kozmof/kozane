/**
 * The orders `kozane card list --sort` offers, and the column each one prints.
 *
 * Sorting happens here rather than in an `ORDER BY` because `card list` has three query
 * paths — a project's cards, a taskspace scope's members, and the cards tied directly to a
 * taskspace — and each has already materialised its whole list by the time anything is
 * printed. One comparator over the finished list is one behaviour to document and to test;
 * three `ORDER BY` clauses would be three places for the orders to drift apart. It is the
 * same choice `cardNearest` makes for distance.
 */

export const CARD_SORT_KEYS = ["created", "updated", "gap"] as const;

export type CardSortKey = (typeof CARD_SORT_KEYS)[number];

/** The fields the orders below read. `card list` selects these on every path. */
export type CardTimes = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
};

export function isCardSortKey(value: string): value is CardSortKey {
  return (CARD_SORT_KEYS as readonly string[]).includes(value);
}

/**
 * What each key sorts on, as a number that ascends the way the key reads:
 * oldest card first, least recently edited first, shortest interval first.
 *
 * `gap` is the distance between a card's two timestamps — how long it stood before its text
 * was rewritten. A card never edited since it was added has a gap of zero, so `--sort gap`
 * puts the untouched cards first and the long-reconsidered ones last.
 */
function sortValue(card: CardTimes, key: CardSortKey): number {
  switch (key) {
    case "created":
      return card.createdAt.getTime();
    case "updated":
      return card.updatedAt.getTime();
    case "gap":
      return card.updatedAt.getTime() - card.createdAt.getTime();
  }
}

/**
 * Ascending by the key, with the id breaking ties the way the rest of the app breaks them.
 *
 * `reverse` flips the whole comparison, ties included, so the listing is the exact reverse
 * of the one without it — two cards created in the same second keep swapping places with
 * their neighbours rather than staying pinned while everything around them moves.
 *
 * Returns a new array; the caller's is left alone.
 */
export function sortCards<T extends CardTimes>(cards: T[], key: CardSortKey, reverse = false): T[] {
  const direction = reverse ? -1 : 1;
  return [...cards].sort(
    (a, b) => direction * (sortValue(a, key) - sortValue(b, key) || a.id.localeCompare(b.id)),
  );
}

const GAP_UNITS = [
  { suffix: "d", ms: 86_400_000 },
  { suffix: "h", ms: 3_600_000 },
  { suffix: "m", ms: 60_000 },
] as const;

/**
 * An interval in its largest whole unit: `0s`, `45s`, `12m`, `3h`, `5d`.
 *
 * Truncated rather than rounded, so the number never claims more time than has passed — a
 * card rewritten twenty hours after it was added reads `20h`, not `1d`. Timestamps are
 * stored to the second, so anything under a second is a card added and edited within the
 * same second and reads `0s`.
 */
export function formatGap(milliseconds: number): string {
  for (const { suffix, ms } of GAP_UNITS) {
    if (milliseconds >= ms) return `${Math.floor(milliseconds / ms)}${suffix}`;
  }
  return `${Math.max(0, Math.floor(milliseconds / 1000))}s`;
}

/**
 * The column `--sort` adds to each listed card: the timestamp it sorted on, or the interval
 * for `gap`. Seconds precision, because that is the precision the column is stored at.
 */
export function sortColumn(card: CardTimes, key: CardSortKey): string {
  if (key === "gap") return formatGap(card.updatedAt.getTime() - card.createdAt.getTime());
  const at = key === "created" ? card.createdAt : card.updatedAt;
  return at.toISOString().replace(/\.\d{3}Z$/, "Z");
}
