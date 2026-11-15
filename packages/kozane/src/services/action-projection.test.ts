import { expect, it } from "vitest";
import {
  createRowProjection,
  type ProjectionEffect,
  type ProjectionRow,
} from "../../../core/src/actions/projection.js";
import type { TaggedRow } from "../../../core/src/actions/row-codec.js";

const schema = [{ name: "card", columns: ["id", "value"], primaryKey: ["id"] }];
const key: TaggedRow = { id: ["text", "a"] };
const image = (value: string): TaggedRow => ({ ...key, value: ["integer", value] });
const initial: ProjectionRow[] = [{ table: "card", row: image("0") }];
const update = (ord: number, before: string, after: string): ProjectionEffect => ({
  ord,
  table: "card",
  key,
  op: "U",
  before: image(before),
  after: image(after),
});

it("reconstructs in selected materialization order and retains earlier projections", () => {
  const baseline = createRowProjection(schema, initial);
  const remote = baseline.apply([update(0, "0", "2")]);
  const rebased = remote.apply([update(0, "2", "1")]);
  expect(baseline.rows("card")).toEqual([image("0")]);
  expect(remote.rows("card")).toEqual([image("2")]);
  expect(rebased.rows("card")).toEqual([image("1")]);
  expect(() => remote.apply([update(0, "0", "1")])).toThrow("Before image mismatch");
  expect(remote.rows("card")).toEqual([image("2")]);
});

it("discards a partial group on a corrupt before image", () => {
  const baseline = createRowProjection(schema, initial);
  expect(() => baseline.apply([update(0, "0", "1"), update(1, "7", "2")])).toThrow(
    "Before image mismatch",
  );
  expect(baseline.rows("card")).toEqual([image("0")]);
});

it.each([
  { effects: [{ ...update(0, "0", "1"), ord: -1 }] },
  { effects: [{ ...update(0, "0", "1"), ord: 0.5 }] },
  { effects: [update(0, "0", "1"), update(0, "1", "2")] },
  { effects: [update(1, "0", "1"), update(0, "1", "2")] },
])("refuses invalid or repeated effect order", ({ effects }) => {
  expect(() => createRowProjection(schema, initial).apply(effects)).toThrow("ordinals");
});

it.each([
  { ...update(0, "0", "1"), key: {} },
  { ...update(0, "0", "1"), after: { id: ["text", "different"], value: ["integer", "1"] } },
  { ...update(0, "0", "1"), after: { id: ["text", "a"] } },
  { ...update(0, "0", "1"), op: "D", after: image("1") },
  { ...update(0, "0", "1"), op: "I", before: null },
  { ...update(0, "0", "1"), after: null },
  { ...update(0, "0", "1"), op: "unknown" },
  { ...update(0, "0", "1"), table: "unknown" },
] as ProjectionEffect[])("refuses malformed effects and primary-key changes %s", (effect) => {
  expect(() => createRowProjection(schema, initial).apply([effect])).toThrow();
});

it("preserves complete composite keys and historical zeros without normalization", () => {
  const definition = [
    {
      name: "relation",
      columns: ["scope_id", "card_id", "timestamp"],
      primaryKey: ["scope_id", "card_id"],
    },
  ];
  const row: TaggedRow = {
    scope_id: ["text", "s"],
    card_id: ["text", "c"],
    timestamp: ["integer", "0"],
  };
  const baseline = createRowProjection(definition, [{ table: "relation", row }]);
  expect(baseline.rows("relation")).toEqual([row]);
  expect(() =>
    baseline.apply([
      {
        ord: 0,
        table: "relation",
        key: { scope_id: ["text", "s"] },
        op: "D",
        before: row,
        after: null,
      },
    ]),
  ).toThrow("Incomplete effect key");
  const removed = baseline.apply([
    {
      ord: 0,
      table: "relation",
      key: { scope_id: ["text", "s"], card_id: ["text", "c"] },
      op: "D",
      before: row,
      after: null,
    },
  ]);
  expect(removed.rows("relation")).toEqual([]);
  expect(baseline.rows("relation")).toEqual([row]);
});

it("copies baseline rows and rejects unsupported schemas and duplicate keys", () => {
  const source = [{ table: "card", row: image("0") }];
  const baseline = createRowProjection(schema, source);
  source[0].row = image("7");
  expect(baseline.rows("card")).toEqual([image("0")]);
  expect(() => createRowProjection(schema, [...initial, ...initial])).toThrow(
    "Duplicate baseline key",
  );
  expect(() => createRowProjection([...schema, ...schema], [])).toThrow(
    "Duplicate projection table",
  );
  expect(() =>
    createRowProjection([{ name: "x", columns: ["id"], primaryKey: ["missing"] }], []),
  ).toThrow("Invalid projection schema");
  expect(() => baseline.rows("unknown")).toThrow("Unknown projection table");
  expect(Object.isFrozen(baseline.rows("card"))).toBe(true);
});
