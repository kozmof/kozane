import { expect, it } from "vitest";
import { combineStyles } from "../../../packages/client/scripts/styles.mjs";
const order = "@layer reset, base, tokens, recipes, utilities;";
it("preserves base, tokens and utilities under one ordered layer declaration", () => {
  const css = combineStyles(
    order + "\n@layer reset { * { margin: 0 } }\n@layer base { body { color: var(--ink) } }",
    order +
      "\n@layer tokens { :root { --ink: #1c1c1c } }\n@layer utilities { .ink { color: var(--ink) } }",
  );
  expect(css.startsWith(order)).toBe(true);
  expect(css.split(order)).toHaveLength(2);
  expect(css).toContain("margin: 0");
  expect(css.indexOf("@layer base")).toBeLessThan(css.indexOf("@layer tokens"));
  expect(css).toContain(".ink { color: var(--ink) }");
});
it.each(["", "@layer utilities, base, reset, tokens, recipes;"])(
  "rejects missing or conflicting generated layer order %#",
  (header) => {
    expect(() => combineStyles(order, header)).toThrow(/layer order/);
  },
);
it("rejects a conflicting base layer order", () => {
  expect(() => combineStyles("@layer base, reset, tokens, recipes, utilities;", order)).toThrow(
    /layer order/,
  );
});
