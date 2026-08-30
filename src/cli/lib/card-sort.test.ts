import { describe, it, expect } from "vitest";
import {
  CARD_SORT_KEYS,
  CARD_STAMP_EARLIEST,
  CARD_STAMP_LATEST,
  formatGap,
  isCardSortKey,
  namesAMoment,
  sortCards,
  sortColumn,
  type CardStamps,
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

/**
 * A card whose columns hold an integer too large for a `Date` — which is what drizzle hands
 * back for a row a hand-written `INSERT` put a nonsense number in, and what `kozane doctor`
 * reports. Built the way the driver builds it, seconds times a thousand, rather than as a
 * bare `new Date(NaN)`: the point is that this is reachable from the column.
 */
const unreadable: CardTimes = {
  id: "u",
  createdAt: new Date(9_000_000_000_000_000 * 1000),
  updatedAt: new Date(9_000_000_000_000_000 * 1000),
};

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

  it("orders a backwards interval where it prints, not ahead of everything", () => {
    // Only a hand-edited database or a doctored import holds `updated_at` before
    // `created_at`. It prints `0s`, so it has to sort among the other `0s` cards rather
    // than ahead of them on a negative nobody can see — the id is then what separates them.
    const backwards = card("d", "2026-03-01T00:00:00Z", "2026-01-01T00:00:00Z");
    expect(sortColumn(backwards, "gap")).toBe("0s");
    expect(ids(sortCards([a, backwards, c], "gap"))).toEqual(["c", "d", "a"]);
  });

  it("puts a timestamp that names no moment last, and first when reversed", () => {
    // Last rather than wherever a NaN comparison happened to leave it: the card that cannot
    // be placed is put where a reader will see it. `--reverse` carries it along like
    // everything else, since the whole comparison is flipped.
    expect(ids(sortCards([b, unreadable, a, c], "created"))).toEqual(["a", "b", "c", "u"]);
    expect(ids(sortCards([b, unreadable, a, c], "created", true))).toEqual(["u", "c", "b", "a"]);
    expect(ids(sortCards([b, unreadable, a, c], "gap"))).toEqual(["c", "a", "b", "u"]);
  });

  it("orders the same however the unreadable card arrives, so the comparator stays total", () => {
    // NaN is neither less nor greater, so subtracting leaves two readable cards each
    // comparing equal to the unreadable one while ordering against each other — an
    // inconsistent comparator, whose result depends on the order the sort walked the array.
    const expected = ["a", "b", "c", "u"];
    expect(ids(sortCards([unreadable, a, b, c], "created"))).toEqual(expected);
    expect(ids(sortCards([a, unreadable, b, c], "created"))).toEqual(expected);
    expect(ids(sortCards([a, b, unreadable, c], "created"))).toEqual(expected);
    expect(ids(sortCards([c, b, a, unreadable], "created"))).toEqual(expected);
  });

  it("keeps two unreadable cards apart by id", () => {
    const other: CardTimes = { ...unreadable, id: "t" };
    expect(ids(sortCards([unreadable, other], "created"))).toEqual(["t", "u"]);
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

  it("says so rather than reading 0s when the interval is not a number", () => {
    // `0s` would claim the card was rewritten the second it was written.
    expect(formatGap(Number.NaN)).toBe("invalid");
    expect(formatGap(Number.POSITIVE_INFINITY)).toBe("invalid");
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

  it("names a timestamp it cannot read rather than throwing on it", () => {
    // `toISOString` throws `RangeError: Invalid time value` on such a date, which reached
    // the user as one line of error in place of the whole listing — every sound card in the
    // project hidden to report a problem with one of them.
    for (const key of CARD_SORT_KEYS) expect(sortColumn(unreadable, key)).toBe("invalid");
  });

  it("prints the largest date a listing can hold, which is readable", () => {
    const far = { ...c, createdAt: CARD_STAMP_LATEST };
    expect(sortColumn(far, "created")).toBe("+275760-09-13T00:00:00Z");
  });
});

/**
 * The range `kozane doctor` reports against is the range this module reads by, and the two
 * used to be written out separately — the same fact in two files, agreeing by inspection.
 * These tie the boundary the check draws to the boundary the listing can actually print, so
 * moving one without the other fails here rather than in a user's terminal.
 */
describe("what a card timestamp may hold", () => {
  const stamps = (at: Date): CardStamps => ({ createdAt: at, updatedAt: at });

  it("can print the last instant inside the range, and no instant past it", () => {
    expect(namesAMoment(CARD_STAMP_LATEST)).toBe(true);
    expect(sortColumn(stamps(CARD_STAMP_LATEST), "created")).not.toBe("invalid");

    const past = new Date(CARD_STAMP_LATEST.getTime() + 1);
    expect(namesAMoment(past)).toBe(false);
    expect(sortColumn(stamps(past), "created")).toBe("invalid");
    // The matching negative, which is the other way a hand-written integer leaves the range.
    expect(namesAMoment(new Date(-CARD_STAMP_LATEST.getTime() - 1))).toBe(false);
  });

  it("draws its low end above the epoch a defaulted row lands on, not at readability", () => {
    // The two ends are two rules. A row left at the epoch by an `INSERT` naming neither
    // column reads perfectly well — as 1970 — so it is reported rather than printed
    // `invalid`, and the low bound has to sit above it for the report to catch it.
    expect(CARD_STAMP_EARLIEST.getTime()).toBeGreaterThan(0);
    expect(namesAMoment(new Date(0))).toBe(true);
    expect(sortColumn(stamps(new Date(0)), "created")).toBe("1970-01-01T00:00:00Z");
  });
});
