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
  // Anchor on the Saturday ending the current week and lay out backward so today always
  // appears in the final week.
  const end = new Date(todayDate);
  end.setUTCDate(end.getUTCDate() + (6 - end.getUTCDay()));
  const start = new Date(end.getTime() - (ACTIVITY_WEEKS * 7 - 1) * DAY_MS);
  // Leave leading cells blank before the one-year range starts within the first complete
  // week.
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
 * Filter partition activity and card tags by the same selected day. Return inputs unchanged
 * when no day is selected.
 */

/** Partition row with the count used for map sizing. */
type CountedPartition = { id: string; cards: number };

/**
 * Size partitions by total cards or selected-day changes. Keep zero-count partitions visible
 * in the empty strip.
 */
export function partitionsForDay<T extends CountedPartition>(
  partitions: T[],
  activity: { day: string; partitionId: string; cards: number }[],
  day: string | null,
): T[] {
  if (!day) return partitions;
  const counts = new Map(
    activity.filter((row) => row.day === day).map(({ partitionId, cards }) => [partitionId, cards]),
  );
  return partitions.map((partition) => ({ ...partition, cards: counts.get(partition.id) ?? 0 }));
}

/**
 * Filter tag hits to cards changed on the selected day. Exclude file hits because the
 * snapshot contains no file change dates.
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

/** Return the first and last actual dates in the activity grid, excluding placeholder cells. */
export function activityRangeLabel(cells: ActivityCell[]): string {
  const days = cells.flatMap(({ day }) => (day ? [day] : []));
  return `${days[0]} ~ ${days.at(-1)}`;
}
