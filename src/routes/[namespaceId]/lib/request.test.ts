import { describe, expect, it } from "vitest";
import {
  optionalNumber,
  optionalString,
  readJsonObject,
  requireFiniteNumber,
  requireObjectArray,
  requireString,
  requireStringArray,
  requireTrimmedString,
  requireUniqueStrings,
  requireWithinBatchLimit,
} from "./request.js";
import { BATCH_MAX } from "$lib/constants";

function expectHttpError(fn: () => unknown, status: number, message: string) {
  expect(fn).toThrow(expect.objectContaining({ status, body: { message } }));
}

async function expectHttpRejection(promise: Promise<unknown>, status: number, message: string) {
  await expect(promise).rejects.toMatchObject({ status, body: { message } });
}

describe("readJsonObject", () => {
  const json = { "content-type": "application/json" };

  it("returns parsed JSON objects", async () => {
    const request = new Request("http://localhost", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ title: "Card" }),
    });

    await expect(readJsonObject(request)).resolves.toEqual({ title: "Card" });
  });

  it("accepts parameters and any casing on the content type", async () => {
    const request = new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "Application/JSON; charset=utf-8" },
      body: "{}",
    });

    await expect(readJsonObject(request)).resolves.toEqual({});
  });

  it("refuses a body not sent as application/json, CORS-simple ones above all", async () => {
    // Test absent and text/plain content types, which cross-origin simple requests can send.
    const unsent = new Request("http://localhost", {
      method: "POST",
      body: new Blob(['{"title":"Card"}']),
    });
    expect(unsent.headers.get("content-type")).toBeNull();
    const plain = new Request("http://localhost", { method: "POST", body: '{"title":"Card"}' });

    for (const request of [unsent, plain])
      await expectHttpRejection(
        readJsonObject(request),
        415,
        "Request body must be sent as application/json",
      );
  });

  it("rejects invalid JSON", async () => {
    const request = new Request("http://localhost", {
      method: "POST",
      headers: json,
      body: "{nope",
    });

    await expectHttpRejection(readJsonObject(request), 400, "Request body must be valid JSON");
  });

  it("rejects non-object JSON bodies", async () => {
    for (const body of ["null", "[]", '"text"']) {
      const request = new Request("http://localhost", { method: "POST", headers: json, body });
      await expectHttpRejection(readJsonObject(request), 400, "Request body must be a JSON object");
    }
  });
});

describe("requireTrimmedString", () => {
  it("returns a trimmed string value", () => {
    expect(requireTrimmedString({ name: "  General  " }, "name")).toBe("General");
  });

  it("throws when the value is missing, blank, or not a string", () => {
    expectHttpError(() => requireTrimmedString({}, "name"), 400, "name is required");
    expectHttpError(() => requireTrimmedString({ name: "   " }, "name"), 400, "name is required");
    expectHttpError(
      () => requireTrimmedString({ name: 1 }, "name", "Name must be text"),
      400,
      "Name must be text",
    );
  });
});

describe("requireString", () => {
  it("returns a non-empty string without trimming it", () => {
    expect(requireString({ content: "  keep spaces  " }, "content")).toBe("  keep spaces  ");
  });

  it("throws when the value is empty or not a string", () => {
    expectHttpError(() => requireString({ content: "" }, "content"), 400, "content is required");
    expectHttpError(() => requireString({ content: null }, "content"), 400, "content is required");
  });
});

describe("optionalString", () => {
  it("returns undefined when the key is absent", () => {
    expect(optionalString({}, "tag")).toBeUndefined();
  });

  it("returns the string value when present", () => {
    expect(optionalString({ tag: "hello" }, "tag")).toBe("hello");
  });

  it("throws when the value is not a string", () => {
    expectHttpError(() => optionalString({ tag: 42 }, "tag"), 400, "tag must be a string");
  });
});

describe("optionalNumber", () => {
  it("returns undefined when the value is absent", () => {
    expect(optionalNumber({}, "posX")).toBeUndefined();
  });

  it("returns finite numeric values", () => {
    expect(optionalNumber({ posX: 24 }, "posX")).toBe(24);
  });

  it("throws when the value is not a finite number", () => {
    expectHttpError(() => optionalNumber({ posX: "24" }, "posX"), 400, "posX must be a number");
    expectHttpError(
      () => optionalNumber({ posX: Number.POSITIVE_INFINITY }, "posX"),
      400,
      "posX must be a number",
    );
  });
});

describe("requireStringArray", () => {
  it("returns string arrays that satisfy the minimum length", () => {
    expect(requireStringArray({ cardIds: ["card-1", "card-2"] }, "cardIds", 2)).toEqual([
      "card-1",
      "card-2",
    ]);
  });

  it("throws when the value is not an array", () => {
    expectHttpError(
      () => requireStringArray({ cardIds: "card-1" }, "cardIds"),
      400,
      "cardIds must be an array",
    );
  });

  it("throws when the array is shorter than minLength", () => {
    expectHttpError(
      () => requireStringArray({ cardIds: [] }, "cardIds"),
      400,
      "cardIds must have at least 1 item",
    );
    expectHttpError(
      () => requireStringArray({ cardIds: ["card-1"] }, "cardIds", 2),
      400,
      "cardIds must have at least 2 items",
    );
  });

  it("throws when the array contains empty or non-string elements", () => {
    expectHttpError(
      () => requireStringArray({ cardIds: ["card-1", ""] }, "cardIds"),
      400,
      "cardIds must contain non-empty strings",
    );
    expectHttpError(
      () => requireStringArray({ cardIds: ["card-1", 2] }, "cardIds"),
      400,
      "cardIds must contain non-empty strings",
    );
  });

  it("throws when the array contains duplicates", () => {
    expectHttpError(
      () => requireStringArray({ cardIds: ["card-1", "card-1"] }, "cardIds"),
      400,
      "cardIds must be unique",
    );
  });
});

describe("requireWithinBatchLimit", () => {
  it("accepts a batch at the limit", () => {
    expect(() => requireWithinBatchLimit(BATCH_MAX, "cardIds")).not.toThrow();
  });

  it("throws one past the limit", () => {
    expectHttpError(
      () => requireWithinBatchLimit(BATCH_MAX + 1, "cardIds"),
      400,
      `cardIds must have at most ${BATCH_MAX} items`,
    );
  });
});

describe("requireStringArray batch limit", () => {
  it("rejects an oversized array before checking its contents", () => {
    // Reject the batch size before scanning invalid elements.
    const cardIds = Array.from({ length: BATCH_MAX + 1 }, () => 42);
    expectHttpError(
      () => requireStringArray({ cardIds }, "cardIds"),
      400,
      `cardIds must have at most ${BATCH_MAX} items`,
    );
  });

  it("accepts an array at the limit", () => {
    const cardIds = Array.from({ length: BATCH_MAX }, (_, i) => `card-${i}`);
    expect(requireStringArray({ cardIds }, "cardIds")).toHaveLength(BATCH_MAX);
  });
});

describe("requireUniqueStrings", () => {
  it("accepts unique string lists", () => {
    expect(() => requireUniqueStrings(["card-1", "card-2"], "cardIds")).not.toThrow();
  });

  it("throws when strings repeat", () => {
    expectHttpError(
      () => requireUniqueStrings(["card-1", "card-1"], "cardIds"),
      400,
      "cardIds must be unique",
    );
  });
});

describe("requireFiniteNumber", () => {
  it("returns a number that is there", () => {
    expect(requireFiniteNumber({ posX: 0 }, "posX")).toBe(0);
    expect(requireFiniteNumber({ posX: -24.5 }, "posX")).toBe(-24.5);
  });

  it("refuses a missing field", () => {
    expectHttpError(() => requireFiniteNumber({}, "posX"), 400, "posX must be a number");
  });

  it("refuses a numeric string", () => {
    expectHttpError(
      () => requireFiniteNumber({ posX: "24" }, "posX"),
      400,
      "posX must be a number",
    );
  });

  it("refuses null, which is how an infinity arrives through JSON", () => {
    expectHttpError(
      () => requireFiniteNumber({ posX: null }, "posX"),
      400,
      "posX must be a number",
    );
  });

  it("refuses NaN and the infinities, which would put a card nowhere on the canvas", () => {
    for (const value of [Number.NaN, Infinity, -Infinity]) {
      expectHttpError(
        () => requireFiniteNumber({ posX: value }, "posX"),
        400,
        "posX must be a number",
      );
    }
  });
});

describe("requireObjectArray", () => {
  /** The shape `PATCH /cards` reads, which is what this guard exists for. */
  const readPosition = (row: Record<string, unknown>) => ({
    cardId: requireString(row, "cardId"),
    posX: requireFiniteNumber(row, "posX"),
  });

  const body = (positions: unknown) => ({ positions });

  it("reads every element through the per-item reader", () => {
    const rows = requireObjectArray(
      body([
        { cardId: "a", posX: 1 },
        { cardId: "b", posX: 2 },
      ]),
      "positions",
      readPosition,
    );
    expect(rows).toEqual([
      { cardId: "a", posX: 1 },
      { cardId: "b", posX: 2 },
    ]);
  });

  it("refuses a field that is not an array", () => {
    expectHttpError(
      () => requireObjectArray(body({}), "positions", readPosition),
      400,
      "positions must be an array",
    );
  });

  it("refuses an empty array, since one item is the default minimum", () => {
    expectHttpError(
      () => requireObjectArray(body([]), "positions", readPosition),
      400,
      "positions must be an array",
    );
  });

  it("uses the caller's wording when it is given one", () => {
    // `PATCH /cards` said "positions is required" before this guard existed, and a caller
    // who sent neither an array nor anything else gets the same answer as before.
    expectHttpError(
      () =>
        requireObjectArray(body(undefined), "positions", readPosition, {
          message: "positions is required",
        }),
      400,
      "positions is required",
    );
  });

  it("honours a minimum above one", () => {
    expectHttpError(
      () =>
        requireObjectArray(body([{ cardId: "a", posX: 1 }]), "positions", readPosition, {
          minLength: 2,
        }),
      400,
      "positions must be an array",
    );
  });

  it("accepts an empty array when the minimum says it may", () => {
    expect(requireObjectArray(body([]), "positions", readPosition, { minLength: 0 })).toEqual([]);
  });

  it("refuses an element that is not an object", () => {
    expectHttpError(
      () => requireObjectArray(body(["a"]), "positions", readPosition),
      400,
      "positions must contain objects",
    );
  });

  it("refuses an element that is null", () => {
    expectHttpError(
      () => requireObjectArray(body([null]), "positions", readPosition),
      400,
      "positions must contain objects",
    );
  });

  it("refuses an element that is an array, which is an object by typeof", () => {
    expectHttpError(
      () => requireObjectArray(body([[]]), "positions", readPosition),
      400,
      "positions must contain objects",
    );
  });

  it("lets the per-item reader's own refusal through", () => {
    expectHttpError(
      () => requireObjectArray(body([{ posX: 1 }]), "positions", readPosition),
      400,
      "cardId is required",
    );
  });

  it("refuses an oversized batch before reading a single item of it", () => {
    // Enforce the batch cap before building a statement that exceeds SQLite's limits.
    let reads = 0;
    const counted = (row: Record<string, unknown>) => {
      reads += 1;
      return readPosition(row);
    };
    const oversized = Array.from({ length: BATCH_MAX + 1 }, (_, i) => ({
      cardId: String(i),
      posX: 0,
    }));
    expectHttpError(
      () => requireObjectArray(body(oversized), "positions", counted),
      400,
      `positions must have at most ${BATCH_MAX} items`,
    );
    expect(reads).toBe(0);
  });

  it("accepts a batch exactly at the cap", () => {
    const atCap = Array.from({ length: BATCH_MAX }, (_, i) => ({ cardId: String(i), posX: 0 }));
    expect(requireObjectArray(body(atCap), "positions", readPosition)).toHaveLength(BATCH_MAX);
  });
});
