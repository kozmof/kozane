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

export function isCardSortKey(value: unknown): value is CardSortKey {
  return (CARD_SORT_KEYS as readonly unknown[]).includes(value);
}

/**
 * The distance between a card's two timestamps — how long it stood before its text was
 * rewritten — and never negative.
 *
 * A row whose `updated_at` precedes its `created_at` is one nothing in the app can write,
 * and only a hand-edited database or a doctored import can hold. It counts as zero, which
 * is what `formatGap` prints for it too. Clamped here rather than at the column alone,
 * because a card that sorted ahead of every untouched card while printing the same `0s`
 * they print would be a listing offering no account of its own order.
 */
function gapMilliseconds(card: CardTimes): number {
  return Math.max(0, card.updatedAt.getTime() - card.createdAt.getTime());
}

/**
 * What each key sorts on, as a number that ascends the way the key reads:
 * oldest card first, least recently edited first, shortest interval first.
 *
 * A card never edited since it was added has a gap of zero, so `--sort gap` puts the
 * untouched cards first and the long-reconsidered ones last.
 */
function sortValue(card: CardTimes, key: CardSortKey): number {
  switch (key) {
    case "created":
      return card.createdAt.getTime();
    case "updated":
      return card.updatedAt.getTime();
    case "gap":
      return gapMilliseconds(card);
  }
}

/**
 * Ascending by the key, with the id breaking ties.
 *
 * The tiebreak is a plain comparison rather than `localeCompare`: it has to land the same
 * way as SQLite's binary `ORDER BY id`, whatever locale the machine running the CLI happens
 * to be in. Card ids are UUIDv7 and the two agree on those, but the ids a test or an import
 * can put in the column are not, and an order that depends on `LANG` is not an order worth
 * promising in the spec. It is the comparison `reassignCardsToLayer` stacks arriving cards
 * with, and the one `cardNearest` breaks equal distances with.
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
    (a, b) =>
      direction *
      (sortValue(a, key) - sortValue(b, key) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  );
}

/**
 * Largest unit first, and stopping at days: months and years are not fixed lengths, so `2y`
 * is not something an interval alone can be turned into without deciding which months it
 * crossed. A card reconsidered after two years reads `730d`.
 */
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
 *
 * A negative interval reads `0s` rather than `-3d`, matching the clamp `gapMilliseconds`
 * applies before anything is ordered by it, so the column and the order agree. The clamp is
 * on the seconds branch because that is the only branch a negative reaches, every unit
 * above it requiring a positive threshold; it stands for callers reaching this with a raw
 * difference of their own.
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
  if (key === "gap") return formatGap(gapMilliseconds(card));
  const at = key === "created" ? card.createdAt : card.updatedAt;
  return at.toISOString().replace(/\.\d{3}Z$/, "Z");
}
