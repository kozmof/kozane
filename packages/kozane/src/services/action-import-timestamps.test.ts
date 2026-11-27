import { expect, it, vi } from "vitest";
import { actionBindingPath, createActionBindings } from "../../../core/src/actions/bindings.js";
import { resolveImportedCardTimestamps } from "../../../core/src/actions/import-timestamps.js";

function recording() {
  const now = vi.fn(() => 1_800_000_000);
  const bindings = createActionBindings({
    mode: "record",
    now,
    allocateId: () => {
      throw new Error("Unexpected ID allocation");
    },
  });
  return { now, bindings };
}

it.each([
  [{ id: "card" }, { created_at: 1_800_000_000, updated_at: 1_800_000_000 }, true],
  [
    { id: "card", created_at: 0, updated_at: 0 },
    { created_at: 1_800_000_000, updated_at: 1_800_000_000 },
    true,
  ],
  [{ id: "card", created_at: 100 }, { created_at: 100, updated_at: 100 }, false],
  [{ id: "card", created_at: 100, updated_at: 0 }, { created_at: 100, updated_at: 100 }, false],
  [
    { id: "card", created_at: 0, updated_at: 200 },
    { created_at: 1_800_000_000, updated_at: 200 },
    true,
  ],
  [{ id: "card", created_at: -100, updated_at: 200 }, { created_at: -100, updated_at: 200 }, false],
])(
  "preserves supplied import timestamps and binds only missing creation time %s",
  (input, expected, allocates) => {
    const f = recording();
    const original = structuredClone(input);
    expect(resolveImportedCardTimestamps(input, f.bindings)).toEqual(expected);
    expect(f.now).toHaveBeenCalledTimes(allocates ? 1 : 0);
    expect(input).toEqual(original);
  },
);

it("replays timestamps by card ID after import row order changes", () => {
  const f = recording();
  const a = resolveImportedCardTimestamps({ id: "a" }, f.bindings);
  const b = resolveImportedCardTimestamps({ id: "b" }, f.bindings);
  const snapshot = f.bindings.snapshot();
  const replay = createActionBindings({ mode: "replay", bindings: snapshot });
  expect(resolveImportedCardTimestamps({ id: "b" }, replay)).toEqual(b);
  expect(resolveImportedCardTimestamps({ id: "a" }, replay)).toEqual(a);
  expect(Object.keys(snapshot)).toEqual([
    actionBindingPath("system.import", "card", "a", "created_at"),
    actionBindingPath("system.import", "card", "b", "created_at"),
  ]);
  expect(() => resolveImportedCardTimestamps({ id: "new" }, replay)).toThrow(
    "Unbound replay allocation",
  );
  expect(replay.snapshot()).toEqual(snapshot);
});

it.each([NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  "validates supplied timestamps before allocating a missing one %s",
  (updated_at) => {
    const f = recording();
    expect(() => resolveImportedCardTimestamps({ id: "a", updated_at }, f.bindings)).toThrow(
      "Invalid imported card a.updated_at",
    );
    expect(f.now).not.toHaveBeenCalled();
    expect(f.bindings.snapshot()).toEqual({});
  },
);

it("refuses zero clock bindings without altering supplied historical values", () => {
  const bindings = createActionBindings({ mode: "record", allocateId: () => "id", now: () => 0 });
  expect(() => resolveImportedCardTimestamps({ id: "a" }, bindings)).toThrow("nonzero timestamp");
  expect(
    resolveImportedCardTimestamps({ id: "a", created_at: 10, updated_at: 20 }, bindings),
  ).toEqual({ created_at: 10, updated_at: 20 });
});
