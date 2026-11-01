import { describe, it, expect } from "vitest";
import { NotFoundError, assertFound, isUniqueConstraintError, isForeignKeyError } from "./utils.js";

describe("NotFoundError", () => {
  it("has name NotFoundError", () => {
    const err = new NotFoundError("card");
    expect(err.name).toBe("NotFoundError");
  });

  it("includes the label in the message", () => {
    const err = new NotFoundError("Card cardId=abc");
    expect(err.message).toBe("Card cardId=abc not found");
  });

  it("is an instance of Error", () => {
    expect(new NotFoundError("x")).toBeInstanceOf(Error);
  });
});

describe("assertFound", () => {
  it("does not throw when array is non-empty", () => {
    expect(() => assertFound([{ id: "1" }], "card")).not.toThrow();
  });

  it("throws NotFoundError when array is empty", () => {
    expect(() => assertFound([], "card")).toThrow(NotFoundError);
  });

  it("throws with the label in the message", () => {
    expect(() => assertFound([], "Partition partitionId=xyz")).toThrow(
      "Partition partitionId=xyz not found",
    );
  });
});

describe("isUniqueConstraintError", () => {
  it("returns true for an Error with UNIQUE constraint message", () => {
    expect(isUniqueConstraintError(new Error("UNIQUE constraint failed: table.col"))).toBe(true);
  });

  it("returns false for an Error with a different message", () => {
    expect(isUniqueConstraintError(new Error("some other error"))).toBe(false);
  });

  it("returns false for a non-Error value", () => {
    expect(isUniqueConstraintError("UNIQUE constraint failed")).toBe(false);
    expect(isUniqueConstraintError(null)).toBe(false);
  });

  it("matches libsql's extended code on a wrapped cause, whatever the message", () => {
    const driver = Object.assign(new Error("reworded"), {
      extendedCode: "SQLITE_CONSTRAINT_UNIQUE",
    });
    expect(isUniqueConstraintError(new Error("Failed query", { cause: driver }))).toBe(true);
  });

  it("treats a duplicate primary key as a unique failure", () => {
    const driver = Object.assign(new Error("reworded"), {
      extendedCode: "SQLITE_CONSTRAINT_PRIMARYKEY",
    });
    expect(isUniqueConstraintError(driver)).toBe(true);
    expect(isForeignKeyError(driver)).toBe(false);
  });

  it("stops on a cause chain that loops back on itself", () => {
    const a = new Error("first");
    const b = new Error("second", { cause: a });
    a.cause = b;
    expect(isUniqueConstraintError(a)).toBe(false);
  });
});

describe("isForeignKeyError", () => {
  it("returns true for an Error with FOREIGN KEY constraint message", () => {
    expect(isForeignKeyError(new Error("FOREIGN KEY constraint failed"))).toBe(true);
  });

  it("returns false for an Error with a different message", () => {
    expect(isForeignKeyError(new Error("some other error"))).toBe(false);
  });

  it("returns false for a non-Error value", () => {
    expect(isForeignKeyError("FOREIGN KEY constraint failed")).toBe(false);
    expect(isForeignKeyError(42)).toBe(false);
  });

  it("matches libsql's extended code on a wrapped cause, whatever the message", () => {
    const driver = Object.assign(new Error("reworded"), {
      extendedCode: "SQLITE_CONSTRAINT_FOREIGNKEY",
    });
    expect(isForeignKeyError(new Error("Failed query", { cause: driver }))).toBe(true);
    expect(isUniqueConstraintError(driver)).toBe(false);
  });
});
