import { expect, it, vi } from "vitest";
import { prepareInput, INPUT_VALIDATION_MESSAGE } from "./prepare-input";
import { ValidationError } from "./errors";
it("copies nested input, preserves null and omits undefined object properties", () => {
  const source = { content: "original", nested: [{ cleared: null, omitted: undefined }] };
  const prepared = prepareInput(source);
  source.content = "changed";
  expect(prepared).toEqual({ content: "original", nested: [{ cleared: null }] });
  expect(prepared.nested).not.toBe(source.nested);
});
it.each([
  NaN,
  Infinity,
  -Infinity,
  1n,
  () => 1,
  Symbol("x"),
  new Date(),
  new Map(),
  new Set(),
  Object.assign(new Array(2), { 1: 1 }),
  [undefined],
  undefined,
])("rejects unsupported input %s", (value) => {
  expect(() => prepareInput(value)).toThrow(ValidationError);
  expect(() => prepareInput(value)).toThrow(INPUT_VALIDATION_MESSAGE);
});
it("rejects getters and toJSON without invoking either", () => {
  const getter = vi.fn(),
    toJSON = vi.fn();
  const input = Object.defineProperty({}, "value", { get: getter, enumerable: true });
  expect(() => prepareInput(input)).toThrow(ValidationError);
  expect(() => prepareInput({ toJSON })).toThrow(ValidationError);
  expect(getter).not.toHaveBeenCalled();
  expect(toJSON).not.toHaveBeenCalled();
});
it("rejects cycles but permits shared noncyclic objects", () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  expect(() => prepareInput(cycle)).toThrow(ValidationError);
  const shared = { value: 42 };
  expect(prepareInput([shared, shared])).toEqual([{ value: 42 }, { value: 42 }]);
});
it("copies prototype-looking keys without changing the output prototype", () => {
  const value = JSON.parse('{"__proto__":{"polluted":true}}');
  const result = prepareInput(value);
  expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  expect(Object.hasOwn(result, "__proto__")).toBe(true);
});
