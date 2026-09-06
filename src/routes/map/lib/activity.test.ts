import { describe, expect, it } from "vitest";
import { ACTIVITY_WEEKS, activityCells, validActivityDay } from "./activity.js";

describe("activityCells", () => {
  it("builds 53 Sunday-to-Saturday weeks ending in the current week", () => {
    const cells = activityCells([], "2026-09-05");
    expect(cells).toHaveLength(ACTIVITY_WEEKS * 7);
    expect(cells[0].weekday).toBe(0);
    expect(cells.at(-1)?.weekday).toBe(6);
    expect(cells.find(({ day }) => day !== null)?.day).toBe("2025-09-05");
    expect(cells.filter(({ day }) => day === "2026-09-05")).toHaveLength(1);
  });

  it("aggregates days and assigns stronger levels to busier days", () => {
    const cells = activityCells(
      [
        { day: "2026-09-04", cards: 1 },
        { day: "2026-09-05", cards: 2 },
        { day: "2026-09-05", cards: 2 },
      ],
      "2026-09-05",
    );
    expect(cells.find(({ day }) => day === "2026-09-04")).toMatchObject({ cards: 1, level: 1 });
    expect(cells.find(({ day }) => day === "2026-09-05")).toMatchObject({ cards: 4, level: 4 });
  });

  it("leaves future cells in the current week unavailable", () => {
    const cells = activityCells([], "2026-09-02");
    expect(cells.slice(-3).every(({ day }) => day === null)).toBe(true);
  });

  /**
   * The case the old anchor lost. The grid used to be laid forward from the Sunday on or
   * before *today minus a year*, and 53 weeks from there ends on the Saturday before this
   * one whenever today is a Sunday — so today had no cell, and a day's card changes could
   * be neither seen nor clicked. Every weekday is asserted rather than the Sunday alone,
   * because the two anchors agree on the other six and a single case would have passed
   * against the broken one.
   */
  it("gives today a cell whichever weekday it falls on", () => {
    for (const day of [
      "2026-09-06", // Sunday, and the day the old window ended before
      "2026-09-07",
      "2026-09-08",
      "2026-09-09",
      "2026-09-10",
      "2026-09-11",
      "2026-09-12",
      "2028-02-28", // a leap year's late February, where a year back moves a day further
      "2028-02-27",
    ]) {
      const cells = activityCells([{ day, cards: 1 }], day);
      expect(cells.filter((cell) => cell.day === day)).toHaveLength(1);
      // The grid is whole weeks: it opens on a Sunday and closes on a Saturday, and today
      // is in the last one of them.
      expect(cells[0].weekday).toBe(0);
      expect(cells.at(-1)?.weekday).toBe(6);
      expect(cells.slice(-7).some((cell) => cell.day === day)).toBe(true);
    }
  });

  it("covers a full year back from today", () => {
    for (const day of ["2026-09-06", "2026-09-12", "2027-01-01"]) {
      const days = activityCells([], day).flatMap((cell) => (cell.day ? [cell.day] : []));
      expect(days.at(-1)).toBe(day);
      const span =
        (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${days[0]}T00:00:00Z`)) / 86_400_000;
      expect(span).toBeGreaterThanOrEqual(364);
      expect(span).toBeLessThanOrEqual(366);
    }
  });
});

describe("validActivityDay", () => {
  it("accepts real ISO calendar days and rejects malformed or impossible ones", () => {
    expect(validActivityDay("2026-09-05")).toBe(true);
    expect(validActivityDay("2026-02-29")).toBe(false);
    expect(validActivityDay("09/05/2026")).toBe(false);
  });
});
