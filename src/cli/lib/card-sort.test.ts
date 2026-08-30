import { describe, it, expect } from "vitest";
import {
  CARD_SORT_KEYS,
  formatGap,
  isCardSortKey,
  sortCards,
  sortColumn,
  type CardTimes,
} from "./card-sort.js";

const at = (iso: string): Date => new Date(iso);

/** A card named by its id, so an assertion reads as the order the ids come back in. */
function card(id: string, created: string, updated: string): CardTimes {
  return { id, createdAt: at(created), updatedAt: at(updated) };
}

// Written so that no two of the three orders agree: `a` is the oldest but the most recently
// rewritten, `c` is the newest but was never touched again, and `b` sits between them on
// both counts while holding the longest interval of the three.
const a = card("a", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"); // gap 1d
const b = card("b", "2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z"); // gap 28d
const c = card("c", "2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z"); // gap 0
const ids = (cards: CardTimes[]): string[] => cards.map(({ id }) => id);

describe("isCardSortKey", () => {
  it("accepts every key the CLI advertises", () => {
    for (const key of CARD_SORT_KEYS) expect(isCardSortKey(key)).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isCardSortKey("gaps")).toBe(false);
    expect(isCardSortKey("")).toBe(false);
  });
});

describe("sortCards", () => {
  it("orders oldest first by created", () => {
    expect(ids(sortCards([c, a, b], "created"))).toEqual(["a", "b", "c"]);
  });

  it("orders least recently rewritten first by updated", () => {
    expect(ids(sortCards([c, a, b], "updated"))).toEqual(["a", "b", "c"]);
  });

  it("orders shortest interval first by gap, which is neither of the other two orders", () => {
    expect(ids(sortCards([a, b, c], "gap"))).toEqual(["c", "a", "b"]);
  });

  it("reverses the whole listing, ties included", () => {
    expect(ids(sortCards([a, b, c], "gap", true))).toEqual(["b", "a", "c"]);
  });

  it("breaks ties by id", () => {
    const first = card("z", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
    const second = card("y", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
    expect(ids(sortCards([first, second], "created"))).toEqual(["y", "z"]);
    expect(ids(sortCards([first, second], "created", true))).toEqual(["z", "y"]);
  });

  it("breaks ties the way SQLite orders ids, not the way a locale does", () => {
    // `"a".localeCompare("B")` is negative in every locale ICU knows, while SQLite's binary
    // `ORDER BY id` puts "B" first — an uppercase letter is the lower codepoint. The ids the
    // app writes are UUIDv7, on which the two agree; the ids an import or a fixture can put
    // in the column are not, and the listing must not change with `LANG`.
    const upper = card("B", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
    const lower = card("a", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
    expect(ids(sortCards([lower, upper], "created"))).toEqual(["B", "a"]);
  });

  it("leaves the caller's array alone", () => {
    const cards = [c, a, b];
    sortCards(cards, "created");
    expect(ids(cards)).toEqual(["c", "a", "b"]);
  });
});

describe("formatGap", () => {
  it("names the interval in its largest whole unit", () => {
    expect(formatGap(0)).toBe("0s");
    expect(formatGap(45_000)).toBe("45s");
    expect(formatGap(12 * 60_000)).toBe("12m");
    expect(formatGap(3 * 3_600_000)).toBe("3h");
    expect(formatGap(5 * 86_400_000)).toBe("5d");
  });

  it("truncates rather than rounds, so it never claims time that has not passed", () => {
    expect(formatGap(20 * 3_600_000)).toBe("20h");
    expect(formatGap(119 * 60_000)).toBe("1h");
    expect(formatGap(999)).toBe("0s");
  });
});

describe("sortColumn", () => {
  it("prints the timestamp it ordered by, to the second", () => {
    expect(sortColumn(a, "created")).toBe("2026-01-01T00:00:00Z");
    expect(sortColumn(a, "updated")).toBe("2026-01-02T00:00:00Z");
  });

  it("prints the interval for gap", () => {
    expect(sortColumn(a, "gap")).toBe("1d");
    expect(sortColumn(c, "gap")).toBe("0s");
  });
});
