import { describe, expect, it } from "vitest";
import { plural } from "./plural";

describe("plural", () => {
  it("counts the noun with it", () => {
    expect(plural(1, "card")).toBe("1 card");
    expect(plural(2, "card")).toBe("2 cards");
  });

  // The two copies this replaced disagreed on exactly this: one returned the noun alone and
  // its callers wrote the count themselves, the other returned both. Pinned so a caller can
  // read one answer off the name.
  it("includes the count, so a caller never writes it twice", () => {
    expect(plural(3, "name")).toBe("3 names");
    expect(plural(3, "name")).not.toBe("names");
  });

  it("pluralises nothing and negatives, which are not one", () => {
    expect(plural(0, "row")).toBe("0 rows");
    expect(plural(-1, "row")).toBe("-1 rows");
  });
});
