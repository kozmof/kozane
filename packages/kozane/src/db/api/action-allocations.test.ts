import { expect, it, vi } from "vitest";
import { eq, inArray, notInArray, sql } from "drizzle-orm";
import { createTestDB } from "../../test-utils/db.js";
import type { DB, Tx } from "../../../../core/src/database.js";
import * as schema from "../../../../core/src/schema.js";
import {
  cards,
  glues,
  inventories,
  layers,
  partitions,
  scopes,
  warps,
  createServiceContext,
} from "../../../../core/src/services.js";
import { addNamespace } from "../../../../core/src/api/namespace.js";
import { addLayer } from "../../../../core/src/api/layer.js";
import { addPartition } from "../../../../core/src/api/partition.js";
import { addWarp } from "../../../../core/src/api/warp.js";
import { addCardInTx, addCardsInTx, updateCardInTx } from "../../../../core/src/api/card.js";
import {
  ActionBindingError,
  createActionBindings,
  type ActionBindingMap,
  type ActionBindings,
} from "../../../../core/src/actions/bindings.js";
import { runActionGroup, type ActionFrameAccess } from "../../../../core/src/actions/execution.js";
import { defineActionRegistry, type ActionHandler } from "../../../../core/src/actions/registry.js";

type Input = Record<string, unknown>;
type Inputs = { root: Input; create: Input };
interface Context {
  db: Tx;
  actions: ActionFrameAccess;
}
const context = createServiceContext();
const initialDate = new Date(1600000000000);
const seedIds = ["first", "second"];
function hasDefault(column: {
  readonly defaultFn?: unknown;
}): column is { defaultFn: () => unknown } {
  return typeof column.defaultFn === "function";
}
function forbidDefault(column: { readonly defaultFn?: unknown }) {
  if (!hasDefault(column)) throw new Error("Expected an ORM default");
  return vi.spyOn(column, "defaultFn").mockImplementation(() => {
    throw new Error("Unbound ORM default");
  });
}
async function fixture(root: ActionHandler<Input, Context>) {
  // Both adapter configurations resolve the package-typed fixture to core source.
  const db = (await createTestDB()) as unknown as DB;
  await db.insert(schema.namespaceTable).values({ id: "n", name: "Main" });
  await db
    .insert(schema.partitionTable)
    .values({ id: "p", namespaceId: "n", name: "Inbox", isDefault: true });
  await db
    .insert(schema.layerTable)
    .values({ id: "l", namespaceId: "n", name: "Base", isDefault: true });
  await db.insert(schema.scopeTable).values({ id: "s", name: "Scope" });
  await db.insert(schema.cardTable).values(
    seedIds.map((id) => ({
      id,
      partitionId: "p",
      layerId: "l",
      content: id,
      createdAt: initialDate,
      updatedAt: initialDate,
    })),
  );
  await db.run(sql`CREATE TABLE allocation_log(generated TEXT)`);
  const registry = defineActionRegistry<Inputs, Context>({
    contractVersion: 1,
    schemaVersions: [19],
    definitions: {
      root: { eligibility: "syncable", prepare: (input) => input as Input, replay: root },
      create: {
        eligibility: "syncable",
        prepare: (input) => input as Input,
        replay: (input, { context: execution }) =>
          cards.createInTx(execution.db, context, "n", {
            partitionId: "p",
            content: input.content,
          }),
      },
    },
  });
  let next = 0;
  const allocate = vi.fn(() => `allocated-${++next}`);
  const now = vi.fn(() => 1700000000);
  const run = (input: Input = {}, generated?: ActionBindingMap, provider?: ActionBindings) =>
    runActionGroup({
      db,
      registry,
      schemaVersion: 19,
      invocation: { id: "root-id", kind: "root", contractVersion: 1, input },
      bindings:
        provider ??
        (generated === undefined
          ? createActionBindings({ mode: "record", allocateId: allocate, now })
          : createActionBindings({ mode: "replay", bindings: generated })),
      createContext: (actions, db) => ({ actions, db }),
      complete: async (tx, group) => {
        await tx.run(sql`INSERT INTO allocation_log VALUES(${JSON.stringify(group.generated)})`);
      },
    });
  return { db, run, allocate, now };
}
async function cardRows(db: DB | Tx) {
  return db.select().from(schema.cardTable).orderBy(schema.cardTable.id);
}

it.each([" ", "entity\0id", "bad\ud800", "bad\udc00", "x".repeat(1001)])(
  "rolls back a caught unrecoverable service ID before insert: %j",
  async (id) => {
    const caught = vi.fn();
    const f = await fixture(async (_input, { context: execution }) => {
      await execution.db
        .update(schema.cardTable)
        .set({ content: "pending edit" })
        .where(eq(schema.cardTable.id, "first"));
      try {
        await layers.createInTx(execution.db, context, "n", { name: "Invalid" });
      } catch (cause) {
        caught(cause);
      }
    });
    f.allocate.mockReturnValue(id);
    const before = await cardRows(f.db);
    await expect(f.run()).rejects.toThrow("Invalid allocation");
    expect(caught).toHaveBeenCalledOnce();
    expect(await cardRows(f.db)).toEqual(before);
    expect((await f.db.select().from(schema.layerTable)).map(({ id }) => id)).toEqual(["l"]);
    expect(await f.db.all(sql`SELECT * FROM allocation_log`)).toEqual([]);
  },
);

it("rolls back caught replay allocations after provider options change while SQL is awaited", async () => {
  const options = { mode: "replay" as const, bindings: {} };
  const provider = createActionBindings(options);
  const allocateId = vi.fn(() => "unexpected-id");
  const now = vi.fn(() => 1700000000);
  const caught = vi.fn();
  const f = await fixture(async (_input, { context: execution, bindings }) => {
    await execution.db
      .update(schema.cardTable)
      .set({ content: "pending edit" })
      .where(eq(schema.cardTable.id, "first"));
    Reflect.set(options, "mode", "record");
    Reflect.set(options, "allocateId", allocateId);
    Reflect.set(options, "now", now);
    try {
      bindings.entityId("new-branch");
    } catch (cause) {
      caught(cause);
    }
  });
  const before = await cardRows(f.db);
  await expect(f.run({}, undefined, provider)).rejects.toThrow("Unbound replay allocation");
  expect(caught).toHaveBeenCalledOnce();
  expect(allocateId).not.toHaveBeenCalled();
  expect(now).not.toHaveBeenCalled();
  expect(provider.snapshot()).toEqual({});
  expect(await cardRows(f.db)).toEqual(before);
  expect(await f.db.all(sql`SELECT * FROM allocation_log`)).toEqual([]);
});

it("keeps recorded service IDs and clocks tied to the initial sources across awaited SQL", async () => {
  const allocateId = vi.fn(() => "original-id");
  const now = vi.fn(() => 1700000000);
  const options = { mode: "record" as const, allocateId, now };
  const provider = createActionBindings(options);
  const replacementId = vi.fn(() => "replacement-id");
  const replacementTime = vi.fn(() => 1800000000);
  const f = await fixture(async (_input, { context: execution }) => {
    await execution.db.select().from(schema.namespaceTable);
    Reflect.set(options, "mode", "replay");
    options.allocateId = replacementId;
    options.now = replacementTime;
    return cards.createInTx(execution.db, context, "n", { partitionId: "p", content: "Created" });
  });
  const result = await f.run({}, undefined, provider);
  expect(result.result).toMatchObject({ id: "original-id" });
  expect((await cardRows(f.db)).find(({ id }) => id === "original-id")).toMatchObject({
    createdAt: new Date(1700000000000),
    updatedAt: new Date(1700000000000),
  });
  expect(provider.mode).toBe("record");
  expect(allocateId).toHaveBeenCalledOnce();
  expect(now).toHaveBeenCalledOnce();
  expect(replacementId).not.toHaveBeenCalled();
  expect(replacementTime).not.toHaveBeenCalled();
});

const cases = [
  {
    name: "layer",
    table: schema.layerTable,
    create: (db: Tx) => layers.createInTx(db, context, "n", { name: "New" }),
  },
  {
    name: "partition",
    table: schema.partitionTable,
    create: (db: Tx) => partitions.createInTx(db, context, "n", { name: "New" }),
  },
  {
    name: "scope",
    table: schema.scopeTable,
    create: (db: Tx) => scopes.createInTx(db, context, { name: "New" }),
  },
  {
    name: "scope_area",
    table: schema.scopeAreaTable,
    create: (db: Tx) =>
      scopes.createAreaInTx(db, context, "n", "s", { posX: 0, posY: 0, width: 100, height: 100 }),
  },
  {
    name: "warp",
    table: schema.warpTable,
    create: (db: Tx) => warps.createInTx(db, context, "n", { posX: 10, posY: 20 }),
  },
  {
    name: "inventory",
    table: schema.inventoryTable,
    create: (db: Tx) =>
      inventories.createInTx(db, context, "n", { name: "New", posX: 10, posY: 20 }),
  },
];
it.each(cases)(
  "binds and reuses the $name service ID instead of its ORM default",
  async ({ table, create }) => {
    const f = await fixture((_input, { context }) => create(context.db));
    const origin = await f.run();
    expect(origin.result).toMatchObject({ id: "allocated-1" });
    const before = await f.db.select().from(table).where(eq(table.id, "allocated-1"));
    await f.db.delete(table).where(eq(table.id, "allocated-1"));
    const ormDefault = forbidDefault(table.id);
    try {
      const replay = await f.run({}, origin.generated);
      expect(replay.result).toEqual(origin.result);
      expect(replay.generated).toEqual(origin.generated);
      expect(await f.db.select().from(table).where(eq(table.id, "allocated-1"))).toEqual(before);
      expect(f.allocate).toHaveBeenCalledOnce();
      expect(f.now).not.toHaveBeenCalled();
      expect(ormDefault).not.toHaveBeenCalled();
    } finally {
      ormDefault.mockRestore();
    }
  },
);

it("keeps IDs stable when namespace default rows are created in a different order", async () => {
  let reverse = false;
  const f = await fixture(async (_input, { context }) => {
    const id = await addNamespace({ db: context.db, name: "Other" });
    const partition = () =>
      addPartition({ db: context.db, namespaceId: id, name: "Default", isDefault: true });
    const layer = () =>
      addLayer({ db: context.db, namespaceId: id, name: "Default", isDefault: true });
    if (reverse) {
      await layer();
      await partition();
    } else {
      await partition();
      await layer();
    }
    return id;
  });
  const origin = await f.run();
  const read = async () => ({
    partitions: await f.db
      .select()
      .from(schema.partitionTable)
      .where(eq(schema.partitionTable.namespaceId, origin.result as string)),
    layers: await f.db
      .select()
      .from(schema.layerTable)
      .where(eq(schema.layerTable.namespaceId, origin.result as string)),
  });
  const before = await read();
  await f.db
    .delete(schema.namespaceTable)
    .where(eq(schema.namespaceTable.id, origin.result as string));
  reverse = true;
  const replay = await f.run({}, origin.generated);
  expect(replay.result).toBe(origin.result);
  expect(replay.generated).toEqual(origin.generated);
  expect(await read()).toEqual(before);
  expect(f.allocate).toHaveBeenCalledTimes(3);
});

it("reuses glue IDs through the real service and preserves membership", async () => {
  const f = await fixture((_input, { context: execution }) =>
    glues.createInTx(execution.db, context, "n", { cardIds: seedIds }),
  );
  const origin = await f.run();
  const before = await f.db.select().from(schema.glueRelTable).orderBy(schema.glueRelTable.cardId);
  await f.db.delete(schema.glueTable);
  await f.run({}, origin.generated);
  expect(await f.db.select().from(schema.glueRelTable).orderBy(schema.glueRelTable.cardId)).toEqual(
    before,
  );
  expect(f.allocate).toHaveBeenCalledOnce();
});

it("binds one card ID and one shared creation timestamp before inserting", async () => {
  const f = await fixture((_input, { context: execution }) =>
    cards.createInTx(execution.db, context, "n", { partitionId: "p", content: "Created" }),
  );
  const origin = await f.run();
  const read = () =>
    f.db.select().from(schema.cardTable).where(eq(schema.cardTable.id, "allocated-1"));
  const before = await read();
  expect(before[0]).toMatchObject({
    createdAt: new Date(1700000000000),
    updatedAt: new Date(1700000000000),
  });
  expect(f.now).toHaveBeenCalledOnce();
  await f.db.delete(schema.cardTable).where(eq(schema.cardTable.id, "allocated-1"));
  const defaults = [
    schema.cardTable.id,
    schema.cardTable.createdAt,
    schema.cardTable.updatedAt,
  ].map(forbidDefault);
  try {
    f.now.mockImplementation(() => {
      throw new Error("Unbound wall clock");
    });
    await f.run({}, origin.generated);
    expect(await read()).toEqual(before);
    expect(f.allocate).toHaveBeenCalledOnce();
    expect(f.now).toHaveBeenCalledOnce();
    expect(defaults.every((spy) => spy.mock.calls.length === 0)).toBe(true);
  } finally {
    for (const spy of defaults) spy.mockRestore();
  }
});

it("assigns batch IDs by original input position across SQL chunks and shares one clock", async () => {
  const input = Array.from({ length: 100 }, (_, index) => ({
    content: `Card ${index}`,
    posX: index,
    posY: 0,
  }));
  const f = await fixture((_input, { context }) =>
    addCardsInTx({ db: context.db, partitionId: "p", layerId: "l", cards: input }),
  );
  const origin = await f.run();
  expect(origin.result).toEqual(
    Array.from({ length: 100 }, (_, index) => `allocated-${index + 1}`),
  );
  const before = await cardRows(f.db);
  expect(
    before
      .filter(({ id }) => !seedIds.includes(id))
      .every(
        ({ createdAt, updatedAt }) =>
          createdAt.getTime() === 1700000000000 && updatedAt.getTime() === 1700000000000,
      ),
  ).toBe(true);
  await f.db.delete(schema.cardTable).where(notInArray(schema.cardTable.id, seedIds));
  const replay = await f.run({}, origin.generated);
  expect(replay.result).toEqual(origin.result);
  expect(await cardRows(f.db)).toEqual(before);
  expect(f.allocate).toHaveBeenCalledTimes(100);
  expect(f.now).toHaveBeenCalledOnce();
});

it("keeps child card allocations attached to stable paths when replay changes child order", async () => {
  let reverse = false;
  const f = await fixture(async (_input, { context }) => {
    const keys = reverse ? ["beta", "alpha"] : ["alpha", "beta"];
    for (const key of keys) await context.actions.child([key], "create", { content: key });
  });
  const origin = await f.run();
  const before = await cardRows(f.db);
  await f.db.delete(schema.cardTable).where(notInArray(schema.cardTable.id, seedIds));
  reverse = true;
  const replay = await f.run({}, origin.generated);
  // Stacking follows replay execution order; IDs and clocks remain attached to each child.
  const after = await cardRows(f.db);
  expect(after.map(({ zIndex: _zIndex, ...row }) => row)).toEqual(
    before.map(({ zIndex: _zIndex, ...row }) => row),
  );
  expect(
    after
      .filter(({ id }) => !seedIds.includes(id))
      .map(({ content, zIndex }) => ({ content, zIndex })),
  ).toEqual([
    { content: "alpha", zIndex: 2 },
    { content: "beta", zIndex: 1 },
  ]);
  expect(replay.generated).toEqual(origin.generated);
  expect(replay.executions.slice(1).map(({ id }) => id)).toEqual(
    origin.executions
      .slice(1)
      .map(({ id }) => id)
      .reverse(),
  );
  expect(f.allocate).toHaveBeenCalledTimes(4);
  expect(f.now).toHaveBeenCalledTimes(2);
});

it("recomputes layer position during replay while preserving the bound entity ID", async () => {
  const f = await fixture((_input, { context: execution }) =>
    layers.createInTx(execution.db, context, "n", { name: "Recorded" }),
  );
  const origin = await f.run();
  await f.db.delete(schema.layerTable).where(eq(schema.layerTable.id, "allocated-1"));
  await f.db
    .insert(schema.layerTable)
    .values({ id: "intervening", namespaceId: "n", name: "Remote", position: 10 });
  const replay = await f.run({}, origin.generated);
  expect(origin.result).toMatchObject({ id: "allocated-1", position: 1 });
  expect(replay.result).toMatchObject({ id: "allocated-1", position: 11 });
  expect(replay.generated).toEqual(origin.generated);
});

it("binds the edit clock even when original text is unchanged, then reuses it on a changed replay branch", async () => {
  const f = await fixture((_input, { context: execution }) =>
    cards.updateInTx(execution.db, context, "n", "first", { content: "first" }),
  );
  const origin = await f.run();
  expect((await cardRows(f.db)).find(({ id }) => id === "first")?.updatedAt).toEqual(initialDate);
  await f.db
    .update(schema.cardTable)
    .set({ content: "Remote change" })
    .where(eq(schema.cardTable.id, "first"));
  await f.run({}, origin.generated);
  expect((await cardRows(f.db)).find(({ id }) => id === "first")).toMatchObject({
    content: "first",
    createdAt: initialDate,
    updatedAt: new Date(1700000000000),
  });
  expect(f.now).toHaveBeenCalledOnce();
  expect(f.allocate).not.toHaveBeenCalled();
});

it("preserves timestamps without binding a clock for geometry-only card changes", async () => {
  const f = await fixture((_input, { context: execution }) =>
    cards.updateInTx(execution.db, context, "n", "first", { posX: 42, posY: 7 }),
  );
  const origin = await f.run();
  await f.run({}, origin.generated);
  expect((await cardRows(f.db)).find(({ id }) => id === "first")).toMatchObject({
    posX: 42,
    posY: 7,
    createdAt: initialDate,
    updatedAt: initialDate,
  });
  expect(origin.generated).toEqual({});
  expect(f.now).not.toHaveBeenCalled();
});

it("refuses unbound record allocations without a UUID fallback even if the handler catches them", async () => {
  let changed = false;
  const f = await fixture(async (_input, { context }) => {
    if (!changed) return addLayer({ db: context.db, namespaceId: "n", name: "Original" });
    await context.db
      .update(schema.cardTable)
      .set({ posX: 100 })
      .where(eq(schema.cardTable.id, "first"));
    try {
      await addWarp({ db: context.db, namespaceId: "n", posX: 0, posY: 0 });
    } catch {
      /* The action must still fail. */
    }
  });
  const origin = await f.run();
  const before = await cardRows(f.db);
  changed = true;
  await expect(f.run({}, origin.generated)).rejects.toBeInstanceOf(ActionBindingError);
  expect(await cardRows(f.db)).toEqual(before);
  expect(await f.db.select().from(schema.warpTable)).toEqual([]);
  expect(f.allocate).toHaveBeenCalledOnce();
});

it.each([0, Number.MAX_SAFE_INTEGER])(
  "rejects bound card clock %s before the timestamp fallback trigger can run",
  async (seconds) => {
    const f = await fixture(async (_input, { context }) => {
      await context.db
        .update(schema.cardTable)
        .set({ posX: 100 })
        .where(eq(schema.cardTable.id, "first"));
      try {
        await addCardInTx({
          db: context.db,
          partitionId: "p",
          layerId: "l",
          content: "Invalid clock",
        });
      } catch {
        /* Validation remains latched outside SQLite. */
      }
    });
    const before = await cardRows(f.db);
    f.now.mockReturnValue(seconds);
    await expect(f.run()).rejects.toBeInstanceOf(ActionBindingError);
    expect(await cardRows(f.db)).toEqual(before);
    expect(
      await f.db.select({ generated: sql<string>`generated` }).from(sql`allocation_log`),
    ).toEqual([]);
  },
);

it("refuses allocations through retained handles without using ordinary defaults", async () => {
  let retained!: Tx;
  const f = await fixture(async (_input, { context }) => {
    retained = context.db;
  });
  await f.run();
  await expect(addLayer({ db: retained, namespaceId: "n", name: "Too late" })).rejects.toThrow(
    "does not own",
  );
  expect(f.allocate).not.toHaveBeenCalled();
  expect(await f.db.select().from(schema.layerTable)).toHaveLength(1);
});

it("refuses an unbound card edit clock without a wall-clock fallback", async () => {
  let edit = false;
  const f = await fixture(async (_input, { context }) => {
    try {
      await updateCardInTx({
        db: context.db,
        cardId: "first",
        partitionId: "p",
        ...(edit ? { content: "Changed branch" } : { posX: 42 }),
      });
    } catch {
      /* A caught missing clock must still abort replay. */
    }
  });
  const origin = await f.run();
  const before = await cardRows(f.db);
  edit = true;
  await expect(f.run({}, origin.generated)).rejects.toBeInstanceOf(ActionBindingError);
  expect(await cardRows(f.db)).toEqual(before);
  expect(origin.generated).toEqual({});
  expect(f.now).not.toHaveBeenCalled();
});

it("preserves bound timestamps before the Unix epoch without invoking the legacy fallback", async () => {
  const f = await fixture((_input, { context }) =>
    addCardInTx({ db: context.db, partitionId: "p", layerId: "l", content: "Historical" }),
  );
  f.now.mockReturnValue(-1);
  const origin = await f.run();
  const read = () =>
    f.db.select().from(schema.cardTable).where(eq(schema.cardTable.id, "allocated-1"));
  expect((await read())[0]).toMatchObject({
    createdAt: new Date(-1000),
    updatedAt: new Date(-1000),
  });
  await f.db.delete(schema.cardTable).where(eq(schema.cardTable.id, "allocated-1"));
  await f.run({}, origin.generated);
  expect((await read())[0]).toMatchObject({
    createdAt: new Date(-1000),
    updatedAt: new Date(-1000),
  });
  expect(f.now).toHaveBeenCalledOnce();
});

it("preserves normal record defaults outside an opted-in action scope", async () => {
  const f = await fixture(async () => {});
  const layer = await layers.create(f.db, context, "n", { name: "Ordinary" });
  const card = await cards.create(f.db, context, "n", { partitionId: "p", content: "Ordinary" });
  expect(layer.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(card.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(
    (
      await f.db
        .select()
        .from(schema.cardTable)
        .where(inArray(schema.cardTable.id, [card.id]))
    )[0].createdAt.getTime(),
  ).toBeGreaterThan(initialDate.getTime());
  expect(f.allocate).not.toHaveBeenCalled();
  expect(f.now).not.toHaveBeenCalled();
});
