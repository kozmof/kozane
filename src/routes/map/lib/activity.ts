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
