import { expect, it } from "vitest";
import { matrixOperations } from "../../../scripts/backend-contract-matrix.mjs";

it("reads the same operations before and after Markdown table alignment", () => {
  const compact = [
    "| Method | Input |",
    "| --- | --- |",
    "| `subscribe` | listener |",
    "| `cards.create` | body |",
    "| `cards.updatePositions` | body |",
  ].join("\n");
  const aligned = [
    "| Method                  | Input    |",
    "| ----------------------- | -------- |",
    "| `subscribe`             | listener |",
    "| `cards.create`          | body     |",
    "| `cards.updatePositions` | body     |",
  ].join("\r\n");
  expect(matrixOperations(compact)).toEqual(["subscribe", "cards.create", "cards.updatePositions"]);
  expect(matrixOperations(aligned)).toEqual(matrixOperations(compact));
});

it("accepts indentation, tabs and unpadded table cells", () => {
  expect(matrixOperations("  |\t`cards.create`\t| input |\n|`snapshot`| input |")).toEqual([
    "cards.create",
    "snapshot",
  ]);
});

it("preserves duplicate and unknown names so coverage validation can reject them", () => {
  expect(
    matrixOperations("| `cards.create` |\n| `cards.create`   |\n| `unknown.method` |"),
  ).toEqual(["cards.create", "cards.create", "unknown.method"]);
});

it("ignores inline mentions, header rows and method names outside the first column", () => {
  expect(
    matrixOperations("Mention `cards.create`.\n| Method |\n| --- |\n| Input | `cards.create` |"),
  ).toEqual([]);
});
