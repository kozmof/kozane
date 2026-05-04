import { describe, expect, it } from "vitest";
import {
  optionalNumber,
  readJsonObject,
  requireString,
  requireStringArray,
  requireTrimmedString,
} from "./request.js";

function expectHttpError(fn: () => unknown, status: number, message: string) {
  expect(fn).toThrow(expect.objectContaining({ status, body: { message } }));
}

async function expectHttpRejection(promise: Promise<unknown>, status: number, message: string) {
  await expect(promise).rejects.toMatchObject({ status, body: { message } });
}

describe("readJsonObject", () => {
  it("returns parsed JSON objects", async () => {
    const request = new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({ title: "Card" }),
    });

    await expect(readJsonObject(request)).resolves.toEqual({ title: "Card" });
  });

  it("rejects invalid JSON", async () => {
    const request = new Request("http://localhost", {
      method: "POST",
      body: "{nope",
    });

    await expectHttpRejection(readJsonObject(request), 400, "Request body must be valid JSON");
  });

  it("rejects non-object JSON bodies", async () => {
    for (const body of ["null", "[]", '"text"']) {
      const request = new Request("http://localhost", { method: "POST", body });
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

  it("throws when the value is not an acceptable string array", () => {
    expectHttpError(
      () => requireStringArray({ cardIds: "card-1" }, "cardIds"),
      400,
      "cardIds is required",
    );
    expectHttpError(
      () => requireStringArray({ cardIds: [] }, "cardIds"),
      400,
      "cardIds is required",
    );
    expectHttpError(
      () => requireStringArray({ cardIds: ["card-1"] }, "cardIds", 2),
      400,
      "cardIds is required",
    );
    expectHttpError(
      () => requireStringArray({ cardIds: ["card-1", ""] }, "cardIds"),
      400,
      "cardIds is required",
    );
    expectHttpError(
      () => requireStringArray({ cardIds: ["card-1", 2] }, "cardIds"),
      400,
      "cardIds is required",
    );
  });
});
