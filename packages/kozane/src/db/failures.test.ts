import { expect, it } from "vitest";
import { classifyLibsqlFailure } from "./internal/classify-failure";
import { databaseFailureKind, normalizeDatabaseFailure } from "./failures";
import { ConflictError, UnavailableError, ValidationError } from "../services/errors";

it("classifies codes through cyclic cause chains without inspecting messages", () => {
  const cause = Object.assign(new Error("not corrupt"), { code: "SQLITE_CORRUPT" });
  const wrapped = new Error("query", { cause });
  cause.cause = wrapped;
  expect(classifyLibsqlFailure(wrapped).kind).toBe("database_content");
  expect(classifyLibsqlFailure(new Error("SQLITE_CORRUPT")).kind).toBe("unknown");
});
it("preserves domain identity and separates constraints from stored-data defects", () => {
  const domain = new ValidationError("invalid");
  expect(normalizeDatabaseFailure(domain, { kind: "unknown", constraint: "other" })).toBe(domain);
  const cause = Object.assign(new Error("driver details"), {
    extendedCode: "SQLITE_CONSTRAINT_UNIQUE",
  });
  const result = normalizeDatabaseFailure(cause, classifyLibsqlFailure(cause));
  expect(result).toBeInstanceOf(ConflictError);
  expect(result.cause).toBe(cause);
  expect(databaseFailureKind(result)).toBe("unknown");
});
it("retains both failures when rollback fails and does not establish corrupt data", () => {
  const cause = new Error("write");
  const rollback = new Error("rollback");
  const result = normalizeDatabaseFailure(
    cause,
    { kind: "database_content", constraint: "unique" },
    { cause: rollback },
  );
  expect(result).toBeInstanceOf(UnavailableError);
  expect((result.cause as AggregateError).errors).toEqual([cause, rollback]);
  expect(databaseFailureKind(result)).toBe("unknown");
});
it.each(["SQLITE_BUSY", "SQLITE_LOCKED"])("classifies %s as transient", (code) => {
  expect(classifyLibsqlFailure(Object.assign(new Error(), { code })).kind).toBe("transient");
});
