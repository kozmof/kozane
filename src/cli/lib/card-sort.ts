import type { Card } from "../../db/api/types.js";
import { compareIds } from "../../lib/order.js";

/**
 * Define the sort orders and displayed values for `kozane card list --sort`.
 *
 * All three query paths already load the complete result before printing. Sort those results
 * with one comparator so namespace, scoped-taskspace, and direct-taskspace listings agree.
 * Sorting adds no database read but requires the complete list in memory.
 */

export const CARD_SORT_KEYS = ["created", "updated", "gap"] as const;

export type CardSortKey = (typeof CARD_SORT_KEYS)[number];

/**
 * Schema-derived fields required for sorting. Use a type-only import so this module performs
 * no database access.
 */
export type CardTimes = CardStamps & Pick<Card, "id">;

/**
 * Timestamp columns used to format a sort value. {@link CardTimes} adds the ID needed to
 * break sorting ties. `card show --times` can use {@link sortColumn} without an ID.
 */
export type CardStamps = Pick<Card, "createdAt" | "updatedAt">;

export function isCardSortKey(value: unknown): value is CardSortKey {
  return (CARD_SORT_KEYS as readonly unknown[]).includes(value);
}

/**
 * Timestamp bounds used by `kozane doctor`.
 *
 * The lower bound is one second after the epoch so diagnostics detect rows that inherited
 * migration 0011's `DEFAULT 0`. Such timestamps remain printable.
 *
 * The upper bound is the largest instant a `Date` can represent. Values outside the
 * representable range produce invalid dates, which the listing labels and sorts separately.
 */
export const CARD_STAMP_EARLIEST = new Date(1_000);
export const CARD_STAMP_LATEST = new Date(8_640_000_000_000_000);

/**
 * Check whether a date has a finite timestamp before formatting it. `toISOString()` throws
 * for an invalid date.
 */
export function namesAMoment(at: Date): boolean {
  return Number.isFinite(at.getTime());
}

/**
 * Text displayed for an invalid timestamp. Use an explicit value so an unreadable date is
 * distinguishable from an empty column.
 */
const UNREADABLE = "invalid";

/**
 * Return the nonnegative interval between creation and the last text update.
 *
 * Clamp negative intervals to zero to match `formatGap`. If either timestamp is invalid,
 * propagate `NaN` so formatting shows {@link UNREADABLE} and sorting places it last.
 */
function gapMilliseconds(card: CardStamps): number {
  return Math.max(0, card.updatedAt.getTime() - card.createdAt.getTime());
}

/**
 * Pair each sort value with its display formatter so clamping and invalid-value handling
 * remain aligned.
 */
type CardOrder = {
  /** Ascending, and `NaN` when the columns it reads name no moment. */
  value: (card: CardStamps) => number;
  /** What `--sort` prints in the column it adds, and `card show --times` on its own line. */
  column: (card: CardStamps) => string;
};

/**
 * Define each sort key and formatter together. Sort ascending by creation time, update time,
 * or nonnegative gap. Print timestamps at stored second precision.
 */
const ORDERS: Record<CardSortKey, CardOrder> = {
  created: { value: (card) => card.createdAt.getTime(), column: (card) => iso(card.createdAt) },
  updated: { value: (card) => card.updatedAt.getTime(), column: (card) => iso(card.updatedAt) },
  gap: { value: gapMilliseconds, column: (card) => formatGap(gapMilliseconds(card)) },
};

function iso(at: Date): string {
  if (!namesAMoment(at)) return UNREADABLE;
  return at.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Compare values in ascending order, placing `NaN` after valid values. Handle it explicitly
 * because subtraction cannot define a consistent ordering for invalid timestamps.
 */
function compareValues(a: number, b: number): number {
  if (Number.isFinite(a) && Number.isFinite(b)) return a - b;
  if (Number.isFinite(a)) return -1;
  if (Number.isFinite(b)) return 1;
  return 0;
}

/**
 * Return a new array sorted by the requested key, with {@link compareIds} breaking ties.
 *
 * `reverse` reverses the full comparison, including ties and invalid timestamps. Invalid
 * timestamps appear last normally and first when reversed.
 */
export function sortCards<T extends CardTimes>(cards: T[], key: CardSortKey, reverse = false): T[] {
  const { value } = ORDERS[key];
  const direction = reverse ? -1 : 1;
  return [...cards].sort(
    (a, b) => direction * (compareValues(value(a), value(b)) || compareIds(a.id, b.id)),
  );
}

/** Format intervals using fixed units up to days. Months and years require calendar context. */
const GAP_UNITS = [
  { suffix: "d", ms: 86_400_000 },
  { suffix: "h", ms: 3_600_000 },
  { suffix: "m", ms: 60_000 },
  { suffix: "s", ms: 1_000 },
] as const;

/**
 * Format an interval in its largest whole unit, such as `45s`, `12m`, `3h`, or `5d`.
 *
 * Truncate rather than round. Values below one second, including negative intervals, print as
 * `0s`. Invalid intervals print as {@link UNREADABLE}.
 */
export function formatGap(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) return UNREADABLE;
  for (const { suffix, ms } of GAP_UNITS) {
    if (milliseconds >= ms) return `${Math.floor(milliseconds / ms)}${suffix}`;
  }
  return "0s";
}

/** Format the selected sort value for listings and `card show --times` consistently. */
export function sortColumn(card: CardStamps, key: CardSortKey): string {
  return ORDERS[key].column(card);
}
