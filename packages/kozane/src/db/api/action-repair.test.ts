import { expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createTestDB } from "../../test-utils/db.js";
import type { DB, Tx } from "../../../../core/src/database.js";
import * as tables from "../../../../core/src/schema.js";
import { INVENTORY_COLUMNS } from "../../../../core/src/constants/index.js";
import { findInventoryConflicts } from "../../../../core/src/api/inventory.js";
import { createServiceContext } from "../../../../core/src/services/context.js";
import { ValidationError } from "../../../../core/src/errors.js";
import {
  createActionBindings,
  type ActionBindingMap,
} from "../../../../core/src/actions/bindings.js";
import {
  composeActions,
  replayComposition,
  type CompositionAccess,
} from "../../../../core/src/actions/composition.js";
import {
  runActionGroup,
  type ActionFrameAccess,
  type ActionGroupResult,
} from "../../../../core/src/actions/execution.js";
import {
  createServiceActionRegistryV1,
  type LocalRecoveryHandlersV1,
} from "../../../../core/src/actions/service-registry.js";
import { runRequestedRepairInTx } from "../../../../core/src/actions/repair.js";
import { defineActionRegistry } from "../../../../core/src/actions/registry.js";
import { withActionReplayTransaction } from "../../../../core/src/actions/replay.js";

const value = createServiceContext();
const stamp = new Date(1600000000000);
const request = { args: {}, body: { target: "inventories" as const } };
async function fixture(completionFailure?: Error) {
  // Both adapter configurations resolve this package-typed fixture to core source.
  const db = (await createTestDB()) as unknown as DB;
  await db.insert(tables.namespaceTable).values([
    { id: "n", name: "Main" },
    { id: "other", name: "Other" },
  ]);
  await db.insert(tables.partitionTable).values([
    { id: "p", namespaceId: "n", name: "Inbox", isDefault: true },
    { id: "other-p", namespaceId: "other", name: "Inbox", isDefault: true },
  ]);
  await db.insert(tables.layerTable).values([
    { id: "l", namespaceId: "n", name: "Base", isDefault: true },
    { id: "other-l", namespaceId: "other", name: "Base", isDefault: true },
  ]);
  await db.insert(tables.inventoryTable).values([
    { id: "i", namespaceId: "n", name: "Box" },
    { id: "other-i", namespaceId: "other", name: "Other box" },
  ]);
  const row = (id: string, content: string, inventorySlot: number | null, other = false) => ({
    id,
    content,
    inventorySlot,
    inventoryId: inventorySlot === null ? null : other ? "other-i" : "i",
    partitionId: other ? "other-p" : "p",
    layerId: other ? "other-l" : "l",
    createdAt: stamp,
    updatedAt: stamp,
  });
  await db
    .insert(tables.cardTable)
    .values([
      row("a", "word ".repeat(40), 0),
      row("b", "Below", INVENTORY_COLUMNS),
      row("c", "Glued", 1),
      row("d", "Partner", null),
      row("e", "word ".repeat(40), 0, true),
      row("f", "Below", INVENTORY_COLUMNS, true),
      row("h1", "Half one", null),
      row("h2", "Half two", null),
    ]);
  await db.insert(tables.scopeTable).values({ id: "s", name: "Scope" });
  await db.insert(tables.scopeRelTable).values([
    { scopeId: "s", cardId: "a" },
    { scopeId: "s", cardId: "b" },
  ]);
  await db.insert(tables.glueTable).values({ id: "g" });
  await db.insert(tables.glueRelTable).values([
    { glueId: "g", cardId: "c" },
    { glueId: "g", cardId: "d" },
  ]);
  await db.run(sql`CREATE TABLE repair_history(input TEXT,generated TEXT,executions TEXT)`);
  const recover = vi.fn(async () => {
    throw new Error("Unexpected filesystem recovery");
  });
  const host = {
    "taskspaces.create": { recover },
    "taskspaces.rename": { recover },
    "taskspaces.remove": { recover },
    "taskspaces.createFile": { recover },
    "taskspaces.saveFile": { recover },
    "taskspaces.createDirectory": { recover },
    "taskspaces.renameEntry": { recover },
    "taskspaces.removeEntry": { recover },
  } satisfies LocalRecoveryHandlersV1;
  const registry = createServiceActionRegistryV1(host);
  const allocate = vi.fn((): string => {
    throw new Error("Repair allocated an ID");
  });
  const now = vi.fn((): number => {
    throw new Error("Repair read the wall clock");
  });
  const complete = async (tx: Tx, group: ActionGroupResult) => {
    await tx.run(
      sql`INSERT INTO repair_history VALUES(${JSON.stringify(group.invocation.input)},${JSON.stringify(group.generated)},${JSON.stringify(group.executions)})`,
    );
    if (completionFailure) throw completionFailure;
  };
  const options = (input: unknown = request, generated?: ActionBindingMap) => ({
    registry,
    schemaVersion: 19,
    invocation: { id: "repair-root", kind: "system.repair", contractVersion: 1, input },
    bindings:
      generated === undefined
        ? createActionBindings({ mode: "record", allocateId: allocate, now })
        : createActionBindings({ mode: "replay", bindings: generated }),
    createContext: (actions: ActionFrameAccess, db: Tx) => ({ actions, db, value }),
    complete,
  });
  const run = (input: unknown = request, generated?: ActionBindingMap) =>
    runActionGroup({ db, ...options(input, generated) });
  const history = () =>
    db
      .select({
        input: sql<string>`input`,
        generated: sql<string>`generated`,
        executions: sql<string>`executions`,
      })
      .from(sql`repair_history`);
  return { db, registry, options, run, complete, history, allocate, now, recover };
}
async function snapshot(db: DB | Tx) {
  return {
    cards: await db.select().from(tables.cardTable).orderBy(tables.cardTable.id),
    inventories: await db.select().from(tables.inventoryTable).orderBy(tables.inventoryTable.id),
    scopes: await db.select().from(tables.scopeRelTable).orderBy(tables.scopeRelTable.cardId),
    glues: await db.select().from(tables.glueTable).orderBy(tables.glueTable.id),
    members: await db.select().from(tables.glueRelTable).orderBy(tables.glueRelTable.cardId),
  };
}

it("records requested repairs across namespaces without allocating IDs or timestamps", async () => {
  const f = await fixture();
  expect((await findInventoryConflicts({ db: f.db })).overlapping.sort()).toEqual([
    "a",
    "b",
    "e",
    "f",
  ]);
  const result = await f.run();
  expect(result.result).toEqual({
    moved: [
      { cardId: "b", inventoryId: "i", slot: INVENTORY_COLUMNS + 1 },
      { cardId: "f", inventoryId: "other-i", slot: INVENTORY_COLUMNS + 1 },
    ],
    unglued: ["c"],
    cleared: [],
  });
  expect(await findInventoryConflicts({ db: f.db })).toEqual({
    overlapping: [],
    glued: [],
    halfPlaced: [],
  });
  expect(
    (await snapshot(f.db)).cards.every(
      ({ createdAt, updatedAt }) =>
        createdAt.getTime() === stamp.getTime() && updatedAt.getTime() === stamp.getTime(),
    ),
  ).toBe(true);
  expect(result.generated).toEqual({});
  expect(result.invocation.input).toEqual(request);
  expect(result.executions.map(({ kind, executionOrd }) => ({ kind, executionOrd }))).toEqual([
    { kind: "system.repair", executionOrd: 0 },
  ]);
  expect(JSON.parse((await f.history())[0].input)).toEqual(request);
  expect(f.allocate).not.toHaveBeenCalled();
  expect(f.now).not.toHaveBeenCalled();
  expect(f.recover).not.toHaveBeenCalled();
});

it("replays the repair on equivalent starting rows with the original envelope and bindings", async () => {
  const origin = await fixture();
  const recorded = await origin.run();
  const target = await fixture();
  const replay = await target.run(request, recorded.generated);
  expect(await snapshot(target.db)).toEqual(await snapshot(origin.db));
  expect(replay.result).toEqual(recorded.result);
  expect(replay.invocation).toEqual(recorded.invocation);
  expect(replay.generated).toEqual(recorded.generated);
  expect(target.allocate).not.toHaveBeenCalled();
  expect(target.now).not.toHaveBeenCalled();
});

it("retains an execution record when replay finds nothing left to repair", async () => {
  const f = await fixture();
  const recorded = await f.run();
  const before = await snapshot(f.db);
  const firstHistory = (await f.history())[0];
  const replay = await f.run(request, recorded.generated);
  expect(replay.result).toEqual({ moved: [], unglued: [], cleared: [] });
  expect(await snapshot(f.db)).toEqual(before);
  expect(replay.executions).toHaveLength(1);
  expect((await f.history())[0]).toEqual(firstHistory);
  expect(await f.history()).toHaveLength(2);
});

it("recomputes repairs when replay sees additional conflicts without extending bindings", async () => {
  const origin = await fixture();
  const recorded = await origin.run();
  const target = await fixture();
  await target.db.insert(tables.cardTable).values({
    id: "new",
    partitionId: "other-p",
    layerId: "other-l",
    content: "Another overlap",
    inventoryId: "other-i",
    inventorySlot: INVENTORY_COLUMNS * 2,
    createdAt: stamp,
    updatedAt: stamp,
  });
  const replay = await target.run(request, recorded.generated);
  expect(
    (replay.result as { moved: { cardId: string }[] }).moved.map(({ cardId }) => cardId),
  ).toContain("new");
  expect(await findInventoryConflicts({ db: target.db })).toEqual({
    overlapping: [],
    glued: [],
    halfPlaced: [],
  });
  expect(replay.generated).toEqual(recorded.generated);
  expect(replay.invocation).toEqual(recorded.invocation);
});

it("clears legacy half placements explicitly while preserving card timestamps", async () => {
  const f = await fixture();
  await f.db.run(sql`DROP TRIGGER card_inventory_pair_update`);
  await f.db
    .update(tables.cardTable)
    .set({ inventoryId: "i" })
    .where(eq(tables.cardTable.id, "h1"));
  await f.db
    .update(tables.cardTable)
    .set({ inventorySlot: 2 })
    .where(eq(tables.cardTable.id, "h2"));
  const repaired = await f.run();
  expect((repaired.result as { cleared: string[] }).cleared.sort()).toEqual(["h1", "h2"]);
  expect(await findInventoryConflicts({ db: f.db })).toEqual({
    overlapping: [],
    glued: [],
    halfPlaced: [],
  });
  expect(
    (await snapshot(f.db)).cards.every(
      ({ createdAt, updatedAt }) =>
        createdAt.getTime() === stamp.getTime() && updatedAt.getTime() === stamp.getTime(),
    ),
  ).toBe(true);
});

it.each([
  null,
  [],
  {},
  "inventories",
  { target: "taskspaces" },
  { target: "inventories", extra: true },
  { target: null },
])("refuses unsupported repair input %j without changing rows or history", async (body) => {
  const f = await fixture();
  const before = await snapshot(f.db);
  await expect(f.run({ args: {}, body })).rejects.toBeInstanceOf(ValidationError);
  expect(await snapshot(f.db)).toEqual(before);
  expect(await f.history()).toEqual([]);
});

it.each([
  { body: { target: "inventories" } },
  { args: { namespaceId: "n" }, body: { target: "inventories" } },
  { args: {} },
  { args: {}, body: { target: "inventories" }, extra: true },
])("refuses incomplete or extra repair envelope fields", async (input) => {
  const f = await fixture();
  const before = await snapshot(f.db);
  await expect(f.run(input)).rejects.toBeInstanceOf(ValidationError);
  expect(await snapshot(f.db)).toEqual(before);
  expect(await f.history()).toEqual([]);
});

it("latches repair validation failures caught by a named handler", async () => {
  const f = await fixture();
  const before = await snapshot(f.db);
  const registry = defineActionRegistry<{ root: unknown }, { db: Tx }>({
    contractVersion: 1,
    schemaVersions: [19],
    definitions: {
      root: {
        eligibility: "syncable",
        prepare: (input) => input,
        replay: async (_input, { context }) => {
          await context.db
            .update(tables.cardTable)
            .set({ posX: 123 })
            .where(eq(tables.cardTable.id, "d"));
          try {
            await runRequestedRepairInTx(context.db, value, { target: "unknown" });
          } catch {
            /* The root latch survives the catch. */
          }
        },
      },
    },
  });
  await expect(
    runActionGroup({
      db: f.db,
      registry,
      schemaVersion: 19,
      invocation: { id: "root", kind: "root", contractVersion: 1, input: {} },
      bindings: createActionBindings({ mode: "record", allocateId: f.allocate, now: f.now }),
      createContext: (_actions, db) => ({ db }),
    }),
  ).rejects.toBeInstanceOf(ValidationError);
  expect(await snapshot(f.db)).toEqual(before);
});

it("rolls back placement and glue repair together after a late SQL failure", async () => {
  const f = await fixture();
  await f.db
    .run(sql`CREATE TRIGGER refuse_unglue BEFORE DELETE ON glue_rel WHEN OLD.card_id='c' BEGIN
    SELECT RAISE(ABORT,'late repair failure');
  END`);
  const before = await snapshot(f.db);
  await expect(f.run()).rejects.toBeInstanceOf(Error);
  expect(await snapshot(f.db)).toEqual(before);
  expect(await f.history()).toEqual([]);
});

it("rolls back repairs and completed history if persistence fails", async () => {
  const failure = new Error("history failure");
  const f = await fixture(failure);
  const before = await snapshot(f.db);
  await expect(f.run()).rejects.toBe(failure);
  expect(await snapshot(f.db)).toEqual(before);
  expect(await f.history()).toEqual([]);
});

it("records a repair composition once and replays only the serialized child", async () => {
  const origin = await fixture();
  const callback = vi.fn(async (access: CompositionAccess<{}>) =>
    access.dispatch(["repair"], "system.repair", request),
  );
  const recorded = await composeActions({
    db: origin.db,
    registry: origin.registry,
    schemaVersion: 19,
    id: "composition",
    value,
    readers: {},
    operation: callback,
    bindings: createActionBindings({
      mode: "record",
      allocateId: () => "repair-child",
      now: origin.now,
    }),
    complete: origin.complete,
  });
  const target = await fixture();
  const replay = await replayComposition({
    db: target.db,
    registry: target.registry,
    schemaVersion: 19,
    invocation: recorded.invocation,
    generated: recorded.generated,
    value,
    complete: target.complete,
  });
  expect(await snapshot(target.db)).toEqual(await snapshot(origin.db));
  expect(replay.executions.map(({ kind }) => kind)).toEqual(["system.compose", "system.repair"]);
  expect(replay.invocation).toEqual(recorded.invocation);
  expect(callback).toHaveBeenCalledOnce();
});

it("isolates a failed repair savepoint before a fresh repair succeeds in the same transaction", async () => {
  const f = await fixture();
  const before = await snapshot(f.db);
  await f.db.run(sql`CREATE TABLE repair_fault(enabled INTEGER)`);
  await f.db.run(sql`INSERT INTO repair_fault VALUES(1)`);
  await f.db
    .run(sql`CREATE TRIGGER refuse_unglue BEFORE DELETE ON glue_rel WHEN OLD.card_id='c' AND (SELECT enabled FROM repair_fault)=1 BEGIN
    SELECT RAISE(ABORT,'repair fault');
  END`);
  await withActionReplayTransaction(f.db, async (session) => {
    await expect(session.replay(f.options(request, {}))).rejects.toBeInstanceOf(Error);
    expect(await snapshot(session.db)).toEqual(before);
    await session.db.run(sql`UPDATE repair_fault SET enabled=0`);
    await session.replay(f.options(request, {}));
  });
  expect(await findInventoryConflicts({ db: f.db })).toEqual({
    overlapping: [],
    glued: [],
    halfPlaced: [],
  });
  expect(await f.history()).toHaveLength(1);
});

it("leaves unrelated inventory conflicts alone until a repair is requested", async () => {
  const f = await fixture();
  const before = await findInventoryConflicts({ db: f.db });
  const options = f.options();
  await runActionGroup({
    ...options,
    db: f.db,
    invocation: {
      id: "position",
      kind: "cards.updatePositions",
      contractVersion: 1,
      input: {
        args: { namespaceId: "n" },
        body: { positions: [{ cardId: "d", posX: 123, posY: 456 }] },
      },
    },
  });
  expect(await findInventoryConflicts({ db: f.db })).toEqual(before);
  expect(
    JSON.parse((await f.history())[0].executions).map(({ kind }: { kind: string }) => kind),
  ).toEqual(["cards.updatePositions"]);
});
