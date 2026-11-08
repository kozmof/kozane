import { describe, expect, it } from "vitest";
import { prepareInput, INPUT_MAX_DEPTH } from "../../../core/src/services/prepare-input.js";
import { ValidationError } from "../../../core/src/services/errors.js";

function nested(depth: number, array: boolean): unknown {
  let value: unknown = null;
  for (let i = 0; i < depth; i++) value = array ? [value] : { value };
  return value;
}
describe("input nesting limits", () => {
  for (const array of [false, true]) {
    it(`bounds nested ${array ? "arrays" : "objects"}`, () => {
      expect(prepareInput(nested(INPUT_MAX_DEPTH, array))).toEqual(nested(INPUT_MAX_DEPTH, array));
      expect(() => prepareInput(nested(INPUT_MAX_DEPTH + 1, array))).toThrow(ValidationError);
      expect(() => prepareInput(nested(10000, array))).toThrow(ValidationError);
    });
  }
});
