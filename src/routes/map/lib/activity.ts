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
  const rangeStart = new Date(todayDate);
  rangeStart.setUTCFullYear(rangeStart.getUTCFullYear() - 1);
  const start = new Date(rangeStart);
  start.setUTCDate(start.getUTCDate() - start.getUTCDay());

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
