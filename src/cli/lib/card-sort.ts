import type { Card } from "../../db/api/types.js";
import { compareIds } from "../../lib/order.js";

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

/**
 * The two columns an order actually reads. {@link sortCards} needs the id as well, to break
 * a tie; nothing that only prints a value does — which is what lets `kozane card show
 * --times` render its lines through the same {@link sortColumn} the listing prints.
 */
export type CardStamps = Pick<Card, "createdAt" | "updatedAt">;

export function isCardSortKey(value: unknown): value is CardSortKey {
  return (CARD_SORT_KEYS as readonly unknown[]).includes(value);
}

/**
 * What a listing prints in place of a timestamp that names no moment.
 *
 * The columns are plain integers, so a hand-edited row can hold one too large — or too
 * negative — for a `Date` to represent, and drizzle hands such a column back as an Invalid
 * Date. `kozane doctor` reports those rows; this is what they read as until someone does.
 *
 * A word rather than a blank, so a column that could not be filled is not read as a column
 * that was empty. And a word rather than the `RangeError: Invalid time value` that
 * `toISOString` throws on such a date, which used to leave the command printing one line of
 * error in place of the whole listing — hiding every sound card in the project in order to
 * report a problem with one of them.
 */
const UNREADABLE = "invalid";

/**
 * The distance between a card's two timestamps — how long it stood before its text was
 * rewritten — and never negative.
 *
 * A row whose `updated_at` precedes its `created_at` is one nothing in the app can write,
 * and only a hand-edited database or a doctored import can hold. It counts as zero, which
 * is what `formatGap` prints for it too. Clamped here rather than at the column alone,
 * because a card that sorted ahead of every untouched card while printing the same `0s`
 * they print would be a listing offering no account of its own order.
 *
 * `NaN` when either column names no moment: `Math.max` propagates it, `formatGap` prints
 * {@link UNREADABLE} for it, and {@link compareValues} sorts it last.
 */
function gapMilliseconds(card: CardStamps): number {
  return Math.max(0, card.updatedAt.getTime() - card.createdAt.getTime());
}

/**
 * One order's two halves, which have to agree: the number the listing is sorted by, and the
 * string it prints. `gap` clamps a backwards interval in both, so the card sorts where it
 * prints, and an unreadable column sorts last in one and reads {@link UNREADABLE} in the
 * other. A key whose halves are entries in one object cannot gain either treatment in one
 * and not the other.
 */
type CardOrder = {
  /** Ascending, and `NaN` when the columns it reads name no moment. */
  value: (card: CardStamps) => number;
  /** What `--sort` prints in the column it adds, and `card show --times` on its own line. */
  column: (card: CardStamps) => string;
};

/**
 * Each key declared as one entry, so adding a fourth order is adding one entry here.
 *
 * The values ascend the way each key reads: oldest card first, least recently edited first,
 * shortest interval first. A card never edited since it was added has a gap of zero, so
 * `--sort gap` puts the untouched cards first and the long-reconsidered ones last.
 *
 * Timestamps print to the second, which is the precision the columns are stored at.
 */
const ORDERS: Record<CardSortKey, CardOrder> = {
  created: { value: (card) => card.createdAt.getTime(), column: (card) => iso(card.createdAt) },
  updated: { value: (card) => card.updatedAt.getTime(), column: (card) => iso(card.updatedAt) },
  gap: { value: gapMilliseconds, column: (card) => formatGap(gapMilliseconds(card)) },
};

function iso(at: Date): string {
  if (!Number.isFinite(at.getTime())) return UNREADABLE;
  return at.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Ascending, with a value that names no moment placed after every value that does.
 *
 * `NaN` is neither less than nor greater than a number, so a plain subtraction leaves such
 * a card wherever the sort happened to walk past it — and leaves the comparator itself
 * inconsistent, since two readable cards can each compare equal to the unreadable one while
 * ordering against each other, which is not an ordering `Array.prototype.sort` is entitled
 * to make anything of. Ranking it last makes the order total again, and puts the card that
 * could not be placed where a reader will see it: at the end, printed as
 * {@link UNREADABLE}.
 */
function compareValues(a: number, b: number): number {
  if (Number.isFinite(a) && Number.isFinite(b)) return a - b;
  if (Number.isFinite(a)) return -1;
  if (Number.isFinite(b)) return 1;
  return 0;
}

/**
 * Ascending by the key, with the id breaking ties through {@link compareIds}.
 *
 * `reverse` flips the whole comparison, ties included, so the listing is the exact reverse
 * of the one without it — two cards created in the same second keep swapping places with
 * their neighbours rather than staying pinned while everything around them moves. An
 * unreadable timestamp is carried along by that: last without `reverse`, first with it.
 *
 * Returns a new array; the caller's is left alone.
 */
export function sortCards<T extends CardTimes>(cards: T[], key: CardSortKey, reverse = false): T[] {
  const { value } = ORDERS[key];
  const direction = reverse ? -1 : 1;
  return [...cards].sort(
    (a, b) => direction * (compareValues(value(a), value(b)) || compareIds(a.id, b.id)),
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
 * their own. An interval that is not a number at all — one end of it naming no moment —
 * reads {@link UNREADABLE} instead, since `0s` would claim a card was rewritten the second
 * it was written.
 */
export function formatGap(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) return UNREADABLE;
  for (const { suffix, ms } of GAP_UNITS) {
    if (milliseconds >= ms) return `${Math.floor(milliseconds / ms)}${suffix}`;
  }
  return "0s";
}

/**
 * The column `--sort` adds to each listed card: the timestamp it sorted on, or the interval
 * for `gap`. Also each line of `kozane card show --times`, so a card reads the same way
 * whichever of the two printed it.
 */
export function sortColumn(card: CardStamps, key: CardSortKey): string {
  return ORDERS[key].column(card);
}
