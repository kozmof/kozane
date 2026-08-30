import type { Card } from "../../db/api/types.js";

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

/**
 * The fields the orders below read. `card list` selects these on every path.
 *
 * A `Pick` of the row rather than three field names written out again, so renaming a column
 * is a compile error here as well as in the queries. The import is type-only: this module
 * holds the ordering rules and reaches no database to apply them.
 */
export type CardTimes = Pick<Card, "id" | "createdAt" | "updatedAt">;

export function isCardSortKey(value: unknown): value is CardSortKey {
  return (CARD_SORT_KEYS as readonly unknown[]).includes(value);
}

/**
 * Ids compared the way SQLite's binary `ORDER BY id` compares them, rather than the way the
 * locale of the machine running the CLI would.
 *
 * Card ids are UUIDv7, on which `localeCompare` and a binary comparison agree; the ids a
 * test or an import can put in the column are not, and an order that depends on `LANG` is
 * not an order worth promising in the spec. Every listing that has to separate two equal
 * values breaks the tie with this — {@link sortCards} on equal timestamps, `cardNearest` on
 * equal distances — so the rule and its reason live in one place.
 */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
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
 * Each key's two halves, declared together: the number it orders by, and the string it
 * prints. They have to agree — `gap` clamps a backwards interval in both, so the card sorts
 * where it prints — and a key whose halves are entries in one object cannot gain the clamp
 * in one and not the other. Adding a fourth order is adding one entry here.
 *
 * The values ascend the way each key reads: oldest card first, least recently edited first,
 * shortest interval first. A card never edited since it was added has a gap of zero, so
 * `--sort gap` puts the untouched cards first and the long-reconsidered ones last.
 *
 * Timestamps print to the second, which is the precision the columns are stored at.
 */
const ORDERS: Record<
  CardSortKey,
  { value: (card: CardTimes) => number; column: (card: CardTimes) => string }
> = {
  created: { value: (card) => card.createdAt.getTime(), column: (card) => iso(card.createdAt) },
  updated: { value: (card) => card.updatedAt.getTime(), column: (card) => iso(card.updatedAt) },
  gap: { value: gapMilliseconds, column: (card) => formatGap(gapMilliseconds(card)) },
};

function iso(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Ascending by the key, with the id breaking ties through {@link compareIds}.
 *
 * `reverse` flips the whole comparison, ties included, so the listing is the exact reverse
 * of the one without it — two cards created in the same second keep swapping places with
 * their neighbours rather than staying pinned while everything around them moves.
 *
 * Returns a new array; the caller's is left alone.
 */
export function sortCards<T extends CardTimes>(cards: T[], key: CardSortKey, reverse = false): T[] {
  const { value } = ORDERS[key];
  const direction = reverse ? -1 : 1;
  return [...cards].sort((a, b) => direction * (value(a) - value(b) || compareIds(a.id, b.id)));
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
  { suffix: "s", ms: 1_000 },
] as const;

/**
 * An interval in its largest whole unit: `0s`, `45s`, `12m`, `3h`, `5d`.
 *
 * Truncated rather than rounded, so the number never claims more time than has passed — a
 * card rewritten twenty hours after it was added reads `20h`, not `1d`. Timestamps are
 * stored to the second, so anything under a second is a card added and edited within the
 * same second and reads `0s`.
 *
 * Anything below the smallest unit reads `0s`, a negative interval included: that matches
 * the clamp `gapMilliseconds` applies before anything is ordered by it, so the column and
 * the order agree. The clamp stands for callers reaching this with a raw difference of
 * their own.
 */
export function formatGap(milliseconds: number): string {
  for (const { suffix, ms } of GAP_UNITS) {
    if (milliseconds >= ms) return `${Math.floor(milliseconds / ms)}${suffix}`;
  }
  return "0s";
}

/**
 * The column `--sort` adds to each listed card: the timestamp it sorted on, or the interval
 * for `gap`.
 */
export function sortColumn(card: CardTimes, key: CardSortKey): string {
  return ORDERS[key].column(card);
}
