import type { MapTagCard } from "./graph.js";
import type { TagHit } from "$lib/types";

export type ActivityCount = { day: string; cards: number };
export type ActivityCell = {
  day: string | null;
  cards: number;
  level: number;
  week: number;
  weekday: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;
export const ACTIVITY_WEEKS = 53;

export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dayDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/**
 * A Sunday-to-Saturday, 53-week contribution grid ending in the current UTC week.
 * Future cells in the last week are placeholders rather than clickable days.
 */
export function activityCells(rows: ActivityCount[], today = utcDay(new Date())): ActivityCell[] {
  const todayDate = dayDate(today);
  // Anchored on the week today sits in — the Saturday that closes it — and laid backwards,
  // so today always has a cell in the last week. Anchoring on the year-ago week instead
  // (the Sunday on or before `rangeStart`, then 53 weeks forward) put the final cell a day
  // *before* today whenever today was a Sunday, and on about a third of Mondays: the window
  // ended on the previous Saturday, so the day's own card changes were neither drawn nor
  // clickable. The two anchors agree on every other day, which is why it read as correct.
  const end = new Date(todayDate);
  end.setUTCDate(end.getUTCDate() + (6 - end.getUTCDay()));
  const start = new Date(end.getTime() - (ACTIVITY_WEEKS * 7 - 1) * DAY_MS);
  // A year back from today, which is what blanks the leading cells of the first week: the
  // grid is whole weeks, so it opens some days before the year the range is meant to cover.
  const rangeStart = new Date(todayDate);
  rangeStart.setUTCFullYear(rangeStart.getUTCFullYear() - 1);

  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.day, (counts.get(row.day) ?? 0) + row.cards);
  const max = Math.max(0, ...counts.values());

  return Array.from({ length: ACTIVITY_WEEKS * 7 }, (_, index) => {
    const date = new Date(start.getTime() + index * DAY_MS);
    const outsideRange = date < rangeStart || date > todayDate;
    const day = outsideRange ? null : utcDay(date);
    const cards = day ? (counts.get(day) ?? 0) : 0;
    const level = cards === 0 || max === 0 ? 0 : Math.max(1, Math.ceil((cards / max) * 4));
    return { day, cards, level, week: Math.floor(index / 7), weekday: index % 7 };
  });
}

export function validActivityDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = dayDate(value);
  return !Number.isNaN(parsed.getTime()) && utcDay(parsed) === value;
}

/**
 * Narrowing the map to one day of the activity grid.
 *
 * Two filters and they have to agree: clicking a day re-sizes the bundle rectangles by what
 * changed that day, *and* narrows the tag tree to the cards that changed that day. Written
 * inline on the page they were two `$derived` blocks that happened to test the same thing
 * two different ways — one against the `activity` rows, one against `tagCards` — with
 * nothing saying they were one decision. A day that filtered the packing but not the tags,
 * or the other way about, is a map that quietly contradicts itself.
 *
 * Both take `day` as null for "no day chosen", which is the ordinary case and returns the
 * input untouched.
 */

/** One row of the map's bundle list — whatever it carries, plus the count the map sizes by. */
type CountedBundle = { id: string; cards: number };

/**
 * The bundles as they are drawn: sized by the whole of their contents, or by what changed
 * on `day` when one is chosen. A bundle with no change that day is kept, at zero — dropping
 * it would make the rectangle vanish rather than empty, and the packing is of the workspace
 * whichever day is being looked at.
 */
export function bundlesForDay<T extends CountedBundle>(
  bundles: T[],
  activity: { day: string; bundleId: string; cards: number }[],
  day: string | null,
): T[] {
  if (!day) return bundles;
  const counts = new Map(
    activity.filter((row) => row.day === day).map(({ bundleId, cards }) => [bundleId, cards]),
  );
  return bundles.map((bundle) => ({ ...bundle, cards: counts.get(bundle.id) ?? 0 }));
}

/**
 * The tag hits as they are counted: all of them, or the ones written on cards whose text
 * changed on `day`.
 *
 * File hits are dropped outright when a day is chosen, and that is the honest answer rather
 * than an oversight: a taskspace file has no change day in the snapshot — nothing stores one
 * — so "was this written on the 4th?" is a question the workspace cannot answer about a
 * file. Keeping them would count them on every day at once.
 */
export function tagHitsForDay(
  hits: TagHit[],
  tagCards: Record<string, MapTagCard | undefined>,
  day: string | null,
): TagHit[] {
  if (!day) return hits;
  return hits.filter(
    (hit) => hit.source.kind === "card" && tagCards[hit.source.cardId]?.updatedDay === day,
  );
}

/**
 * The span the activity grid covers, as it is labelled — the first real day to the last.
 *
 * The grid is laid out in whole weeks, so its opening and closing cells are placeholders
 * with no day on them; those are what the flatMap drops.
 */
export function activityRangeLabel(cells: ActivityCell[]): string {
  const days = cells.flatMap(({ day }) => (day ? [day] : []));
  return `${days[0]} ~ ${days.at(-1)}`;
}
