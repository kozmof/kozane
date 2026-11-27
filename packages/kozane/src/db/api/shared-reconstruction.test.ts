import { expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDB } from "../../test-utils/db.js";
import {
  capturedTables,
  captureApplicationRows,
  installCapturePrototype,
} from "../../test-utils/action-capture.js";
import { migrations } from "../../../../core/src/generated/migrations.js";
import {
  parseSharedRecoveryProjection,
  reconstructSharedRecoveryProjection,
  validateSharedRecoveryProjection,
  type SharedRecoverySelection,
  type SharedRecoveryEffect,
} from "../../../../core/src/actions/shared-recovery.js";
import type { DB } from "../../../../core/src/database.js";
import type { ProjectionRow } from "../../../../core/src/actions/projection.js";
import type { TaggedRow } from "../../../../core/src/actions/row-codec.js";
import { runActionGroup } from "../../../../core/src/actions/execution.js";
import { createActionBindings } from "../../../../core/src/actions/bindings.js";
import { createServiceContext } from "../../../../core/src/services/context.js";
import { createServiceActionRegistryV1 } from "../../../../core/src/actions/service-registry.js";

const database = async () => (await createTestDB()) as unknown as DB;
const projection = (rows: readonly ProjectionRow[]) =>
  parseSharedRecoveryProjection({
    version: 1,
    rowEncodingVersion: 1,
    schemaId: migrations.at(-1)!.id,
    tables: capturedTables.map(({ name }) => ({
      name,
      rows: rows.filter(({ table }) => table === name).map(({ row }) => row),
    })),
  });
const namespace = (name: string): TaggedRow => ({
  id: ["text", "n"],
  name: ["text", name],
  is_default: ["integer", "0"],
});
const warp: TaggedRow = {
  id: ["text", "w"],
  namespace_id: ["text", "n"],
  pos_x: ["integer", "9007199254740993"],
  pos_y: ["real", "3ff8000000000000"],
};
function update(ord: number, before: string, after: string): SharedRecoveryEffect {
  return {
    ord,
    table: "namespace",
    key: { id: ["text", "n"] },
    op: "U",
    before: namespace(before),
    after: namespace(after),
  };
}
function fixture() {
  const baseline = projection([
    { table: "namespace", row: namespace("original") },
    { table: "warp", row: warp },
  ]);
  const history = {
    baseline: { id: "baseline", projection: baseline },
    effectSets: [
      { id: "first", effects: [update(0, "original", "middle"), update(1, "middle", "first")] },
      { id: "empty", effects: [] as SharedRecoveryEffect[] },
      { id: "second", effects: [update(0, "first", "\ufefffinal\0🪁")] },
    ],
  };
  const selected: SharedRecoverySelection = {
    baselineId: "baseline",
    effectSets: [
      { id: "first", effectCount: 2 },
      { id: "empty", effectCount: 0 },
      { id: "second", effectCount: 1 },
    ],
  };
  return { baseline, history, selected };
}

it("applies selected sets in materialization order, independent of transport order", () => {
  const f = fixture();
  const before = JSON.stringify(f.history);
  const result = reconstructSharedRecoveryProjection(
    { ...f.history, effectSets: [...f.history.effectSets].reverse() },
    f.selected,
  );
  expect(result.tables.find(({ name }) => name === "namespace")!.rows).toEqual([
    namespace("\ufefffinal\0🪁"),
  ]);
  expect(result.tables.find(({ name }) => name === "warp")!.rows).toEqual([warp]);
  expect(Object.isFrozen(result.tables[0].rows)).toBe(true);
  expect(
    Object.isFrozen(result.tables.find(({ name }) => name === "namespace")!.rows[0].name),
  ).toBe(true);
  expect(JSON.stringify(f.history)).toBe(before);
});

it("reconstructs the baseline alone and requires an explicit record for an empty selected set", () => {
  const f = fixture();
  expect(
    reconstructSharedRecoveryProjection(
      { baseline: f.history.baseline, effectSets: [] },
      { baselineId: "baseline", effectSets: [] },
    ),
  ).toEqual(f.baseline);
  expect(() =>
    reconstructSharedRecoveryProjection(
      { ...f.history, effectSets: f.history.effectSets.filter(({ id }) => id !== "empty") },
      f.selected,
    ),
  ).toThrow("Missing selected");
});

it("checks insert, update and delete images even when the final projection is unchanged", () => {
  const empty = projection([]);
  const effects: SharedRecoveryEffect[] = [
    {
      ord: 0,
      table: "namespace",
      key: { id: ["text", "n"] },
      op: "I",
      before: null,
      after: namespace("created"),
    },
    update(1, "created", "edited"),
    {
      ord: 2,
      table: "namespace",
      key: { id: ["text", "n"] },
      op: "D",
      before: namespace("edited"),
      after: null,
    },
  ];
  const history = {
    baseline: { id: "baseline", projection: empty },
    effectSets: [{ id: "round-trip", effects }],
  };
  const selected = { baselineId: "baseline", effectSets: [{ id: "round-trip", effectCount: 3 }] };
  expect(reconstructSharedRecoveryProjection(history, selected)).toEqual(empty);
  history.effectSets[0].effects[1] = update(1, "created", "different");
  expect(() => reconstructSharedRecoveryProjection(history, selected)).toThrow(
    "Before image mismatch",
  );
});

it.each(["baseline", "missing", "duplicate", "unselected"])(
  "refuses %s history records",
  (change) => {
    const f = fixture();
    if (change === "baseline") f.history.baseline.id = "other";
    if (change === "missing") f.history.effectSets.pop();
    if (change === "duplicate") f.history.effectSets.push(f.history.effectSets[0]);
    if (change === "unselected") f.history.effectSets.push({ id: "superseded", effects: [] });
    expect(() => reconstructSharedRecoveryProjection(f.history, f.selected)).toThrow();
  },
);

it.each(["truncated-first", "truncated-last", "extra-effect"])(
  "refuses %s effects against separately retained expected counts",
  (change) => {
    const f = fixture();
    if (change === "truncated-first") f.history.effectSets[0].effects.shift();
    if (change === "truncated-last") f.history.effectSets[0].effects.pop();
    if (change === "extra-effect")
      f.history.effectSets[0].effects.push(update(2, "first", "extra"));
    expect(() => reconstructSharedRecoveryProjection(f.history, f.selected)).toThrow(
      "effect count mismatch",
    );
  },
);

it.each([-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])(
  "refuses invalid trusted count %s",
  (effectCount) => {
    const f = fixture();
    expect(() =>
      reconstructSharedRecoveryProjection(f.history, {
        ...f.selected,
        effectSets: [{ id: "first", effectCount }],
      }),
    ).toThrow("expected shared recovery effect count");
  },
);

it("refuses repeated selection IDs and a materialization order that does not match before images", () => {
  const f = fixture();
  expect(() =>
    reconstructSharedRecoveryProjection(f.history, {
      ...f.selected,
      effectSets: [f.selected.effectSets[0], f.selected.effectSets[0]],
    }),
  ).toThrow("Duplicate selected");
  expect(() =>
    reconstructSharedRecoveryProjection(f.history, {
      ...f.selected,
      effectSets: [...f.selected.effectSets].reverse(),
    }),
  ).toThrow("Before image mismatch");
});

it.each([-1, 0, 3, 0.5, Infinity])(
  "refuses repeated, missing or invalid effect ordinal %s",
  (ord) => {
    const f = fixture();
    f.history.effectSets[0].effects[1] = { ...f.history.effectSets[0].effects[1], ord };
    expect(() => reconstructSharedRecoveryProjection(f.history, f.selected)).toThrow(
      "consecutive ordinals",
    );
  },
);

it("does not return or retain partial reconstruction after a later group fails", () => {
  const f = fixture();
  f.history.effectSets[2].effects[0] = update(0, "wrong", "failed");
  const before = JSON.stringify(f.history);
  expect(() => reconstructSharedRecoveryProjection(f.history, f.selected)).toThrow(
    "Before image mismatch",
  );
  expect(JSON.stringify(f.history)).toBe(before);
  expect(f.baseline.tables.find(({ name }) => name === "namespace")!.rows).toEqual([
    namespace("original"),
  ]);
  f.history.effectSets[2].effects[0] = update(0, "first", "repaired");
  expect(
    reconstructSharedRecoveryProjection(f.history, f.selected).tables.find(
      ({ name }) => name === "namespace",
    )!.rows,
  ).toEqual([namespace("repaired")]);
});

it("preserves unsafe integers and REAL bits and compares full before images without coercion", () => {
  const f = fixture();
  const effect: SharedRecoveryEffect = {
    ord: 0,
    table: "warp",
    key: { id: ["text", "w"] },
    op: "U",
    before: warp,
    after: { ...warp, pos_x: ["integer", "9007199254740995"], pos_y: ["real", "8000000000000000"] },
  };
  const history = { baseline: f.history.baseline, effectSets: [{ id: "warp", effects: [effect] }] };
  const selected = { baselineId: "baseline", effectSets: [{ id: "warp", effectCount: 1 }] };
  const result = reconstructSharedRecoveryProjection(history, selected);
  expect(result.tables.find(({ name }) => name === "warp")!.rows).toEqual([effect.after]);
  for (const pos_x of [
    ["integer", "9007199254740992"],
    ["text", "9007199254740993"],
  ] as const) {
    history.effectSets[0].effects = [{ ...effect, before: { ...warp, pos_x } }];
    expect(() => reconstructSharedRecoveryProjection(history, selected)).toThrow(
      "Before image mismatch",
    );
  }
});

it("uses complete composite primary keys without conflating rows", () => {
  const first: TaggedRow = { scope_id: ["text", "s1"], card_id: ["text", "c"] };
  const second: TaggedRow = { scope_id: ["text", "s2"], card_id: ["text", "c"] };
  const baseline = projection([
    { table: "scope_rel", row: first },
    { table: "scope_rel", row: second },
  ]);
  const effect: SharedRecoveryEffect = {
    ord: 0,
    table: "scope_rel",
    key: first,
    op: "D",
    before: first,
    after: null,
  };
  const history = {
    baseline: { id: "baseline", projection: baseline },
    effectSets: [{ id: "remove", effects: [effect] }],
  };
  const selected = { baselineId: "baseline", effectSets: [{ id: "remove", effectCount: 1 }] };
  expect(
    reconstructSharedRecoveryProjection(history, selected).tables.find(
      ({ name }) => name === "scope_rel",
    )!.rows,
  ).toEqual([second]);
  history.effectSets[0].effects = [{ ...effect, key: { card_id: ["text", "c"] } }];
  expect(() => reconstructSharedRecoveryProjection(history, selected)).toThrow(
    "Incomplete effect key",
  );
});

it.each([
  "incomplete-before",
  "incomplete-after",
  "changed-key",
  "null-key",
  "local-table",
  "unknown-op",
  "extra-field",
  "sparse-effects",
])("refuses %s effect transport", (change) => {
  const f = fixture();
  const history = JSON.parse(JSON.stringify(f.history));
  const effect = history.effectSets[0].effects[0];
  if (change === "incomplete-before") delete effect.before.name;
  if (change === "incomplete-after") delete effect.after.name;
  if (change === "changed-key") effect.after.id = ["text", "other"];
  if (change === "null-key") effect.key.id = ["null"];
  if (change === "local-table") effect.table = "taskspace_local";
  if (change === "unknown-op") effect.op = "X";
  if (change === "extra-field") effect.unexpected = true;
  if (change === "sparse-effects") delete history.effectSets[0].effects[0];
  expect(() => reconstructSharedRecoveryProjection(history, f.selected)).toThrow();
});

it("rejects effect and expectation accessors without invoking them", () => {
  const f = fixture();
  const getter = vi.fn(() => namespace("original"));
  Object.defineProperty(f.history.effectSets[0].effects[0], "before", {
    enumerable: true,
    get: getter,
  });
  expect(() => reconstructSharedRecoveryProjection(f.history, f.selected)).toThrow("plain data");
  expect(getter).not.toHaveBeenCalled();
  const selected = { ...f.selected };
  const selectionGetter = vi.fn(() => f.selected.effectSets);
  Object.defineProperty(selected, "effectSets", { enumerable: true, get: selectionGetter });
  expect(() => reconstructSharedRecoveryProjection(f.history, selected)).toThrow("plain data");
  expect(selectionGetter).not.toHaveBeenCalled();
});

it("allows transient relationally invalid images and validates only the final reconstructed rows", async () => {
  const f = fixture();
  const effects: SharedRecoveryEffect[] = [
    {
      ord: 0,
      table: "namespace",
      key: { id: ["text", "n"] },
      op: "D",
      before: namespace("original"),
      after: null,
    },
    { ord: 1, table: "warp", key: { id: ["text", "w"] }, op: "D", before: warp, after: null },
  ];
  const result = reconstructSharedRecoveryProjection(
    { baseline: f.history.baseline, effectSets: [{ id: "remove", effects }] },
    { baselineId: "baseline", effectSets: [{ id: "remove", effectCount: 2 }] },
  );
  expect(result.tables.every(({ rows }) => rows.length === 0)).toBe(true);
  const target = await database();
  expect(await validateSharedRecoveryProjection(async () => target, result)).toEqual(result);
  expect(await captureApplicationRows(target)).toEqual([]);
});

it("reconstructs real captured cascades without changing source rows, local paths or retained origin history", async () => {
  const source = await database();
  await source.run(sql`INSERT INTO namespace(id,name,is_default) VALUES('n','Main',1)`);
  await source.run(
    sql`INSERT INTO partition(id,namespace_id,name,is_default) VALUES('p','n','Inbox',1)`,
  );
  await source.run(
    sql`INSERT INTO layer(id,namespace_id,name,is_default) VALUES('l','n','Base',1)`,
  );
  await source.run(sql`INSERT INTO inventory(id,namespace_id,name) VALUES('i','n','Stored')`);
  await source.run(
    sql`INSERT INTO card(id,partition_id,layer_id,inventory_id,inventory_slot,content,created_at,updated_at) VALUES('c','p','l','i',0,'Stored',1,1)`,
  );
  await source.run(
    sql`INSERT INTO taskspace_local VALUES('absent','device-only','workspace_relative',0)`,
  );
  const capture = await installCapturePrototype(source);
  const baseline = projection(capture.baseline);
  const recover = async () => {
    throw new Error("Unexpected filesystem recovery");
  };
  const registry = createServiceActionRegistryV1({
    "taskspaces.create": { recover },
    "taskspaces.rename": { recover },
    "taskspaces.remove": { recover },
    "taskspaces.createFile": { recover },
    "taskspaces.saveFile": { recover },
    "taskspaces.createDirectory": { recover },
    "taskspaces.renameEntry": { recover },
    "taskspaces.removeEntry": { recover },
  });
  const run = (id: string, kind: string, input: unknown) =>
    runActionGroup({
      db: source,
      registry,
      schemaVersion: 19,
      invocation: { id, kind, contractVersion: 1, input },
      bindings: createActionBindings({
        mode: "record",
        allocateId: () => {
          throw new Error("Unexpected allocation");
        },
        now: () => {
          throw new Error("Unexpected clock");
        },
      }),
      createContext: (actions, db) => ({ actions, db, value: createServiceContext() }),
      ...capture.hooks(id),
    });
  const effects = async (id: string) =>
    (await capture.effects(id)).map(({ ord, table, key, op, before, after }) => ({
      ord,
      table,
      key,
      op,
      before,
      after,
    }));
  await run("inventory", "inventories.remove", { args: { namespaceId: "n", inventoryId: "i" } });
  const first = await effects("inventory");
  expect(
    first.some(
      ({ after }) =>
        after?.inventory_id?.[0] === "null" && after?.inventory_slot?.[0] === "integer",
    ),
  ).toBe(true);
  const history = {
    baseline: { id: "baseline", projection: baseline },
    effectSets: [{ id: "inventory", effects: first }],
  };
  const selected = {
    baselineId: "baseline",
    effectSets: [{ id: "inventory", effectCount: first.length }],
  };
  const reconstructed = reconstructSharedRecoveryProjection(history, selected);
  expect(reconstructed).toEqual(projection(await captureApplicationRows(source)));
  const target = await database();
  await validateSharedRecoveryProjection(async () => target, reconstructed);
  await run("namespace", "namespaces.remove", { args: { namespaceId: "n" } });
  const second = await effects("namespace");
  history.effectSets.unshift({ id: "namespace", effects: second });
  selected.effectSets.push({ id: "namespace", effectCount: second.length });
  const before = {
    rows: await captureApplicationRows(source),
    runs: await capture.runs(),
    effects: await capture.effects("inventory"),
  };
  const final = reconstructSharedRecoveryProjection(history, selected);
  expect(final).toEqual(projection(before.rows));
  await validateSharedRecoveryProjection(async () => target, final);
  expect(await captureApplicationRows(target)).toEqual([]);
  expect(await captureApplicationRows(source)).toEqual(before.rows);
  expect(await source.values(sql`SELECT path FROM taskspace_local`)).toMatchObject([
    { 0: "device-only" },
  ]);
  expect(await capture.runs()).toEqual(before.runs);
  expect(await capture.effects("inventory")).toEqual(before.effects);
  await capture.verify();
});
