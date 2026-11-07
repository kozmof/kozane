import { expect, it } from "vitest";
import { createServiceContext } from "./context";
import { ValidationError } from "./errors";

it.each(["canvasWidth", "canvasHeight"] as const)(
  "preserves workspace bounds and validation messages for %s",
  (field) => {
    for (const value of [400, 400.5, 20_000]) {
      expect(createServiceContext({ [field]: value })[field]).toBe(value);
    }
    for (const value of [399, 20_001]) {
      expect(() => createServiceContext({ [field]: value })).toThrow(
        `ui.${field} must be between 400 and 20000`,
      );
    }
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(() => createServiceContext({ [field]: value })).toThrow(
        `ui.${field} must be a number`,
      );
    }
  },
);
it("creates an immutable independent context with workspace defaults", () => {
  expect(createServiceContext()).toEqual({
    contentMax: 200_000,
    canvasWidth: 5600,
    canvasHeight: 4000,
  });
  expect(Object.isFrozen(createServiceContext())).toBe(true);
  const overrides = { contentMax: 280 };
  const context = createServiceContext(overrides);
  overrides.contentMax = 500;
  expect(context.contentMax).toBe(280);
});
it.each([100, 100.5, 1_000_000])("accepts configured content limit %s", (contentMax) => {
  expect(createServiceContext({ contentMax }).contentMax).toBe(contentMax);
});
it.each([99, 1_000_001, NaN, Infinity, -Infinity])(
  "rejects invalid content limit %s",
  (contentMax) => {
    expect(() => createServiceContext({ contentMax })).toThrow(ValidationError);
  },
);
