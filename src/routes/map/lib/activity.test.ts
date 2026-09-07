import { describe, expect, it } from "vitest";
import {
  ACTIVITY_WEEKS,
  activityCells,
  activityRangeLabel,
  bundlesForDay,
  tagHitsForDay,
  validActivityDay,
} from "./activity.js";

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

describe("bundlesForDay", () => {
  const bundles = [
    { id: "b1", name: "One", cards: 10 },
    { id: "b2", name: "Two", cards: 4 },
  ];
  const activity = [
    { day: "2026-03-01", bundleId: "b1", cards: 3 },
    { day: "2026-03-02", bundleId: "b1", cards: 1 },
    { day: "2026-03-02", bundleId: "b2", cards: 5 },
  ];

  it("leaves the bundles alone when no day is chosen", () => {
    expect(bundlesForDay(bundles, activity, null)).toBe(bundles);
  });

  it("re-sizes each bundle by what changed on the day", () => {
    expect(bundlesForDay(bundles, activity, "2026-03-02")).toEqual([
      { id: "b1", name: "One", cards: 1 },
      { id: "b2", name: "Two", cards: 5 },
    ]);
  });

  it("keeps a bundle with no change that day, at zero", () => {
    // Dropping it would make the rectangle vanish rather than empty, and the packing is of
    // the workspace whichever day is being looked at.
    expect(bundlesForDay(bundles, activity, "2026-03-01")).toEqual([
      { id: "b1", name: "One", cards: 3 },
      { id: "b2", name: "Two", cards: 0 },
    ]);
  });

  it("carries the rest of each row through untouched", () => {
    const [first] = bundlesForDay(bundles, activity, "2026-03-01");
    expect(first.name).toBe("One");
  });
});

describe("tagHitsForDay", () => {
  const cardHit = (cardId: string) => ({
    tag: "perf",
    source: { kind: "card" as const, cardId },
    excerpt: "…",
  });
  const fileHit = {
    tag: "perf",
    source: { kind: "file" as const, taskspaceId: "t1", path: "notes.md", line: 3 },
    excerpt: "…",
  };
  const hits = [cardHit("c1"), cardHit("c2"), fileHit];
  const tagCards = {
    c1: { projectId: "p", bundleId: "b", updatedDay: "2026-03-01" },
    c2: { projectId: "p", bundleId: "b", updatedDay: "2026-03-02" },
  };

  it("leaves the hits alone when no day is chosen", () => {
    expect(tagHitsForDay(hits, tagCards, null)).toBe(hits);
  });

  it("keeps the cards whose text changed on the day", () => {
    expect(tagHitsForDay(hits, tagCards, "2026-03-01")).toEqual([cardHit("c1")]);
  });

  it("drops a card the snapshot has no change day for", () => {
    expect(tagHitsForDay([cardHit("unknown")], tagCards, "2026-03-01")).toEqual([]);
  });

  it("drops file hits, which have no change day to be asked about", () => {
    // Keeping them would count them on every day at once; see the note on the function.
    expect(tagHitsForDay([fileHit], tagCards, "2026-03-01")).toEqual([]);
    expect(tagHitsForDay([fileHit], tagCards, null)).toEqual([fileHit]);
  });
});

describe("activityRangeLabel", () => {
  it("spans the first real day to the last, skipping the week's placeholders", () => {
    const cells = activityCells([{ day: "2026-03-01", cards: 1 }], "2026-03-05");
    const days = cells.flatMap(({ day }) => (day ? [day] : []));

    expect(activityRangeLabel(cells)).toBe(`${days[0]} ~ ${days.at(-1)}`);
    expect(activityRangeLabel(cells)).toMatch(/^\d{4}-\d{2}-\d{2} ~ \d{4}-\d{2}-\d{2}$/);
  });
});
