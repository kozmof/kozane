import { expect, it } from "vitest";
import {
  createRestorationPlan,
  RestorationSchemaError,
} from "../../../core/src/actions/restoration-plan.js";
import { canonicalSchemaManifest } from "../../../core/src/generated/schema-manifest.js";
import { localTableNames } from "../../../core/src/actions/local-tables.js";
import type { SchemaObject } from "../../../core/src/schema-types.js";

const table = (name: string, parents: string[] = []): SchemaObject => ({
  type: "table",
  name,
  table: name,
  sql: null,
  columns: [[0, "id", ["TEXT"], 1, null, 1, 0]],
  foreignKeys: parents.map((parent, index) => [
    index,
    0,
    parent,
    "id",
    "id",
    "CASCADE",
    "CASCADE",
    "NONE",
  ]),
});

it("plans the current application schema with parents before children and complete composite keys", () => {
  const names = canonicalSchemaManifest
    .filter(
      ({ type, name }) =>
        type === "table" && name !== "__drizzle_migrations" && !localTableNames.includes(name),
    )
    .map(({ name }) => name);
  const original = JSON.stringify(canonicalSchemaManifest);
  const plan = createRestorationPlan(canonicalSchemaManifest, names.reverse());
  expect(plan.loadOrder).toHaveLength(12);
  const order = plan.loadOrder.map(({ name }) => name);
  for (const object of canonicalSchemaManifest.filter(({ name }) => order.includes(name)))
    for (const key of object.foreignKeys ?? [])
      expect(order.indexOf(String(key[2]))).toBeLessThan(order.indexOf(object.name));
  expect(plan.loadOrder.find(({ name }) => name === "scope_rel")!.primaryKey).toEqual([
    "scope_id",
    "card_id",
  ]);
  expect(plan.deleteOrder).toEqual([...order].reverse());
  expect(JSON.stringify(canonicalSchemaManifest)).toBe(original);
  expect(Object.isFrozen(plan.loadOrder[0].columns)).toBe(true);
  expect(createRestorationPlan(canonicalSchemaManifest, [...names].reverse())).toEqual(plan);
});

it("copies the schema and orders composite primary keys by ordinal", () => {
  const source = table("t");
  const columns = [
    [0, "a", ["TEXT"], 1, null, 2, 0],
    [1, "b", ["TEXT"], 1, null, 1, 0],
  ] as const;
  const plan = createRestorationPlan([{ ...source, columns }], ["t"]);
  expect(plan.loadOrder[0].primaryKey).toEqual(["b", "a"]);
});

it.each([
  { schema: [table("a", ["b"]), table("b", ["a"])], names: ["a", "b"] },
  { schema: [table("a", ["a"])], names: ["a"] },
  { schema: [table("a", ["missing"])], names: ["a"] },
  { schema: [table("a", ["b"]), table("b")], names: ["a"] },
  { schema: [table("a"), table("local", ["a"])], names: ["a"] },
  { schema: [table("a")], names: [] },
  { schema: [table("a")], names: ["missing"] },
  { schema: [table("a")], names: ["a", "a"] },
  { schema: [table("a"), table("a")], names: ["a"] },
  { schema: [{ ...table("a"), columns: undefined }], names: ["a"] },
  { schema: [{ ...table("a"), foreignKeys: undefined }], names: ["a"] },
  { schema: [{ ...table("a"), columns: [[0, "id", ["TEXT"], 1, null, 0, 0]] }], names: ["a"] },
  { schema: [{ ...table("a"), columns: [[0, "id", ["TEXT"], 1, null, 1, 2]] }], names: ["a"] },
  { schema: [{ ...table("a"), columns: [[0, "id", ["TEXT"], 1, null, 2, 0]] }], names: ["a"] },
  {
    schema: [
      { ...table("a"), foreignKeys: [[0, 0, "b", "missing", "id", "CASCADE", "CASCADE", "NONE"]] },
      table("b"),
    ],
    names: ["a", "b"],
  },
] satisfies { schema: SchemaObject[]; names: string[] }[])(
  "refuses an unsupported restoration graph before producing a load plan %#",
  ({ schema, names }) => {
    expect(() => createRestorationPlan(schema, names)).toThrow(RestorationSchemaError);
  },
);
