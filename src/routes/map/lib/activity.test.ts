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
});

describe("validActivityDay", () => {
  it("accepts real ISO calendar days and rejects malformed or impossible ones", () => {
    expect(validActivityDay("2026-09-05")).toBe(true);
    expect(validActivityDay("2026-02-29")).toBe(false);
    expect(validActivityDay("09/05/2026")).toBe(false);
  });
});
