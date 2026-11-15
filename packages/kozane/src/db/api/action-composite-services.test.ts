import { expect, it, vi } from "vitest";
import { eq, getTableName, sql } from "drizzle-orm";
import { createTestDB } from "../../test-utils/db.js";
import { createDatabaseAdapter, withTx, type DB, type Tx } from "../../../../core/src/database.js";
import { createNamespace } from "../../../../core/src/api/namespace.js";
import { squashNamespaceCard } from "../../../../core/src/api/composite.js";
import * as tables from "../../../../core/src/schema.js";
import {
  cards,
  layers,
  partitions,
  scopes,
  namespaces,
  createServiceContext,
} from "../../../../core/src/services.js";
import {
  createActionBindings,
  ActionBindingError,
  type ActionBindingMap,
} from "../../../../core/src/actions/bindings.js";
import { runActionGroup } from "../../../../core/src/actions/execution.js";
import { defineActionRegistry } from "../../../../core/src/actions/registry.js";

const context = createServiceContext();
const stamp = new Date(1600000000000);
type Operation = (tx: Tx) => Promise<unknown>;
const squash: Operation = (tx) => cards.squashInTx(tx, context, "n", { cardId: "source" });
function delayedDatabase(db: DB) {
  let resume!: () => void;
  const ready = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const queued = createDatabaseAdapter(new Proxy(db, {}), {
    write: async (operation) => {
      await ready;
      return withTx(db, operation);
    },
    read: async () => {
      throw new Error("Fixture does not use read transactions");
    },
  });
  return { db: queued, resume };
}
async function fixture(operation: Operation = squash) {
  // Both adapter configurations resolve this package-typed fixture to core source.
  const db = (await createTestDB()) as unknown as DB;
  await db.insert(tables.namespaceTable).values([
    { id: "n", name: "Main", isDefault: true },
    { id: "other", name: "Other" },
  ]);
  await db.insert(tables.partitionTable).values([
    { id: "p", namespaceId: "n", name: "Inbox", isDefault: true },
    { id: "alt-p", namespaceId: "n", name: "Alternate" },
    { id: "other-p", namespaceId: "other", name: "Inbox", isDefault: true },
  ]);
  await db.insert(tables.layerTable).values([
    { id: "l", namespaceId: "n", name: "Base", isDefault: true },
    { id: "alt-l", namespaceId: "n", name: "Alternate", position: 1 },
    { id: "other-l", namespaceId: "other", name: "Base", isDefault: true },
  ]);
  await db.insert(tables.scopeTable).values({ id: "scope", name: "Shared" });
  await db.insert(tables.cardTable).values([
    {
      id: "source",
      partitionId: "alt-p",
      layerId: "alt-l",
      content: "Alpha. Beta",
      posX: 100,
      posY: 100,
      zIndex: 2,
      width: 300,
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: "above",
      partitionId: "alt-p",
      layerId: "alt-l",
      content: "Above",
      zIndex: 4,
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: "partner",
      partitionId: "p",
      layerId: "l",
      content: "Partner",
      zIndex: 1,
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: "neighbor",
      partitionId: "p",
      layerId: "l",
      content: "Neighbor",
      zIndex: 10,
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: "remote",
      partitionId: "other-p",
      layerId: "other-l",
      content: "Remote",
      createdAt: stamp,
      updatedAt: stamp,
    },
  ]);
  await db.insert(tables.scopeRelTable).values([
    { scopeId: "scope", cardId: "source" },
    { scopeId: "scope", cardId: "remote" },
  ]);
  await db.insert(tables.scopeAreaTable).values([
    { id: "area", namespaceId: "n", scopeId: "scope", posX: 0, posY: 0, width: 100, height: 100 },
    {
      id: "other-area",
      namespaceId: "other",
      scopeId: "scope",
      posX: 0,
      posY: 0,
      width: 100,
      height: 100,
    },
  ]);
  await db.insert(tables.glueTable).values({ id: "glue" });
  await db.insert(tables.glueRelTable).values([
    { glueId: "glue", cardId: "source" },
    { glueId: "glue", cardId: "partner" },
  ]);
  await db
    .insert(tables.inventoryTable)
    .values({ id: "inventory", namespaceId: "n", name: "Squash 7" });
  await db.run(sql`CREATE TABLE composite_history(generated TEXT,executions TEXT)`);
  const registry = defineActionRegistry<{ root: Record<string, never> }, { db: Tx }>({
    contractVersion: 1,
    schemaVersions: [19],
    definitions: {
      root: {
        eligibility: "syncable",
        prepare: () => ({}),
        replay: async (_input, { context }) => operation(context.db),
      },
    },
  });
  let next = 0;
  const allocate = vi.fn(() => `generated-${++next}`);
  const now = vi.fn(() => 1700000000);
  const run = (generated?: ActionBindingMap) =>
    runActionGroup({
      db,
      registry,
      schemaVersion: 19,
      invocation: { id: "root", kind: "root", contractVersion: 1, input: {} },
      bindings:
        generated === undefined
          ? createActionBindings({ mode: "record", allocateId: allocate, now })
          : createActionBindings({ mode: "replay", bindings: generated }),
      createContext: (_actions, db) => ({ db }),
      complete: async (tx, group) => {
        await tx.run(
          sql`INSERT INTO composite_history VALUES(${JSON.stringify(group.generated)},${JSON.stringify(group.executions)})`,
        );
      },
    });
  return { db, run, allocate, now };
}
async function snapshot(db: DB | Tx) {
  const result: Record<string, unknown> = {};
  for (const table of [
    tables.namespaceTable,
    tables.partitionTable,
    tables.layerTable,
    tables.cardTable,
    tables.scopeTable,
    tables.scopeAreaTable,
    tables.scopeRelTable,
    tables.glueTable,
    tables.glueRelTable,
    tables.inventoryTable,
  ]) {
    result[getTableName(table)] = (await db.select().from(table)).sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    );
  }
  return result;
}
const mutations = [
  { name: "card squash", run: squash },
  {
    name: "card stacking",
    run: (tx: Tx) =>
      cards.setStackingInTx(tx, context, "n", { cardIds: ["partner"], direction: "front" }),
  },
  { name: "layer removal", run: (tx: Tx) => layers.removeInTx(tx, context, "n", "alt-l") },
  { name: "partition removal", run: (tx: Tx) => partitions.removeInTx(tx, context, "n", "alt-p") },
  { name: "board scope removal", run: (tx: Tx) => scopes.removeInTx(tx, context, "n", "scope") },
  {
    name: "namespace creation",
    run: (tx: Tx) => namespaces.createInTx(tx, context, { name: "Created" }),
  },
  {
    name: "namespace rename",
    run: (tx: Tx) => namespaces.renameInTx(tx, context, "n", { name: "Renamed" }),
  },
  { name: "namespace removal", run: (tx: Tx) => namespaces.removeInTx(tx, context, "n") },
  {
    name: "default namespace change",
    run: (tx: Tx) => namespaces.setDefaultInTx(tx, context, "other"),
  },
];
it.each(mutations)(
  "keeps $name and all indirect writes inside the caller's rollback boundary",
  async ({ run }) => {
    const f = await fixture();
    const before = await snapshot(f.db);
    const failure = new Error("Abort enclosing transaction");
    await expect(
      withTx(f.db, async (tx) => {
        await run(tx);
        expect(await snapshot(tx)).not.toEqual(before);
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(await snapshot(f.db)).toEqual(before);
  },
);

const failures = [
  {
    name: "card squash",
    run: (tx: Tx) => cards.squashInTx(tx, context, "n", { cardId: "partner" }),
  },
  {
    name: "card stacking",
    run: (tx: Tx) =>
      cards.setStackingInTx(tx, context, "n", { cardIds: ["partner"], direction: "sideways" }),
  },
  { name: "default layer removal", run: (tx: Tx) => layers.removeInTx(tx, context, "n", "l") },
  {
    name: "default partition removal",
    run: (tx: Tx) => partitions.removeInTx(tx, context, "n", "p"),
  },
  { name: "missing board scope", run: (tx: Tx) => scopes.removeInTx(tx, context, "n", "missing") },
  { name: "namespace creation", run: (tx: Tx) => namespaces.createInTx(tx, context, { name: "" }) },
  {
    name: "namespace rename",
    run: (tx: Tx) => namespaces.renameInTx(tx, context, "n", { name: "" }),
  },
  { name: "namespace removal", run: (tx: Tx) => namespaces.removeInTx(tx, context, "missing") },
  {
    name: "default namespace change",
    run: (tx: Tx) => namespaces.setDefaultInTx(tx, context, "missing"),
  },
];
it.each(failures)(
  "latches a caught $name failure and rolls back earlier writes",
  async ({ run }) => {
    let caught: unknown;
    const f = await fixture(async (tx) => {
      await tx
        .update(tables.cardTable)
        .set({ posX: 123 })
        .where(eq(tables.cardTable.id, "partner"));
      try {
        await run(tx);
      } catch (cause) {
        caught = cause;
      }
    });
    const before = await snapshot(f.db);
    const running = f.run();
    await expect(running).rejects.toBeInstanceOf(Error);
    await expect(running).rejects.toBe(caught);
    expect(await snapshot(f.db)).toEqual(before);
    expect(
      await f.db.select({ generated: sql<string>`generated` }).from(sql`composite_history`),
    ).toEqual([]);
  },
);

it("replays squash with bound inventory and piece IDs, timestamps and all related rows", async () => {
  const origin = await fixture();
  const recorded = await origin.run();
  const result = recorded.result as Awaited<ReturnType<typeof cards.squashInTx>>;
  expect(result.inventory).toMatchObject({ id: "generated-1", name: "Squash 8" });
  expect(result.cards.map(({ id }) => id)).toEqual(["generated-2", "generated-3"]);
  expect(
    result.cards.every(
      ({ createdAt, updatedAt }) =>
        createdAt.getTime() === 1700000000000 && updatedAt.getTime() === 1700000000000,
    ),
  ).toBe(true);
  expect(origin.allocate).toHaveBeenCalledTimes(3);
  expect(origin.now).toHaveBeenCalledOnce();
  const target = await fixture();
  target.allocate.mockImplementation(() => {
    throw new Error("Fresh replay ID");
  });
  target.now.mockImplementation(() => {
    throw new Error("Fresh replay clock");
  });
  const replay = await target.run(recorded.generated);
  expect(replay.result).toEqual(recorded.result);
  expect(replay.generated).toEqual(recorded.generated);
  expect(await snapshot(target.db)).toEqual(await snapshot(origin.db));
  expect(await target.db.select().from(tables.glueTable)).toEqual([]);
  expect(
    (await target.db.select().from(tables.scopeRelTable)).map(({ cardId }) => cardId).sort(),
  ).toEqual(["generated-2", "generated-3", "remote"]);
  expect(target.allocate).not.toHaveBeenCalled();
  expect(target.now).not.toHaveBeenCalled();
});

it("rolls back squash completely when changed source text needs an unbound piece", async () => {
  const origin = await fixture();
  const recorded = await origin.run();
  const target = await fixture(async (tx) => {
    try {
      return await squash(tx);
    } catch {
      return "caught";
    }
  });
  await target.db
    .update(tables.cardTable)
    .set({ content: "Alpha. Beta. Gamma" })
    .where(eq(tables.cardTable.id, "source"));
  const before = await snapshot(target.db);
  await expect(target.run(recorded.generated)).rejects.toBeInstanceOf(ActionBindingError);
  expect(await snapshot(target.db)).toEqual(before);
  expect(
    await target.db.select({ generated: sql<string>`generated` }).from(sql`composite_history`),
  ).toEqual([]);
  expect(target.allocate).not.toHaveBeenCalled();
  expect(target.now).not.toHaveBeenCalled();
});

it("preserves unused piece bindings when replay resolves fewer segments", async () => {
  const origin = await fixture();
  await origin.db
    .update(tables.cardTable)
    .set({ content: "Alpha. Beta. Gamma" })
    .where(eq(tables.cardTable.id, "source"));
  const recorded = await origin.run();
  const target = await fixture();
  const replay = await target.run(recorded.generated);
  const first = recorded.result as Awaited<ReturnType<typeof cards.squashInTx>>;
  const later = replay.result as typeof first;
  expect(later.cards.map(({ id }) => id)).toEqual(first.cards.slice(0, 2).map(({ id }) => id));
  expect(replay.generated).toEqual(recorded.generated);
  expect(replay.invocation).toEqual(recorded.invocation);
  expect(target.allocate).not.toHaveBeenCalled();
});

it("restores source, pieces, stacking, memberships and glue after a late squash SQL failure", async () => {
  const f = await fixture(async (tx) => {
    try {
      return await squash(tx);
    } catch {
      return "caught";
    }
  });
  await f.db
    .run(sql`CREATE TRIGGER refuse_squash_delete BEFORE DELETE ON card WHEN OLD.id='source' BEGIN
    SELECT RAISE(ABORT,'late squash failure');
  END`);
  const before = await snapshot(f.db);
  await expect(f.run()).rejects.toBeInstanceOf(Error);
  expect(await snapshot(f.db)).toEqual(before);
  expect(
    await f.db.select({ generated: sql<string>`generated` }).from(sql`composite_history`),
  ).toEqual([]);
});

it("refuses to reuse squash allocations for a different source card", async () => {
  const origin = await fixture();
  const recorded = await origin.run();
  const target = await fixture((tx) => cards.squashInTx(tx, context, "n", { cardId: "different" }));
  await target.db.insert(tables.cardTable).values({
    id: "different",
    partitionId: "p",
    layerId: "l",
    content: "Alpha. Beta",
    createdAt: stamp,
    updatedAt: stamp,
  });
  const before = await snapshot(target.db);
  await expect(target.run(recorded.generated)).rejects.toBeInstanceOf(ActionBindingError);
  expect(await snapshot(target.db)).toEqual(before);
  expect(target.allocate).not.toHaveBeenCalled();
});

it("recomputes the squash inventory name and layout while preserving original bindings", async () => {
  const origin = await fixture();
  const recorded = await origin.run();
  const target = await fixture();
  await target.db.update(tables.inventoryTable).set({ name: "Squash 99" });
  await target.db
    .update(tables.cardTable)
    .set({ posX: 1200 })
    .where(eq(tables.cardTable.id, "source"));
  const replay = await target.run(recorded.generated);
  const first = recorded.result as Awaited<ReturnType<typeof cards.squashInTx>>;
  const later = replay.result as typeof first;
  expect(later.inventory).toMatchObject({ id: first.inventory.id, name: "Squash 100", posX: 1200 });
  expect(later.cards.map(({ id }) => id)).toEqual(first.cards.map(({ id }) => id));
  expect(later.cards.map(({ posX, posY }) => ({ posX, posY }))).not.toEqual(
    first.cards.map(({ posX, posY }) => ({ posX, posY })),
  );
  expect(replay.generated).toEqual(recorded.generated);
});

it("creates a namespace and both default rows through bound service allocations during replay", async () => {
  const operation: Operation = (tx) => namespaces.createInTx(tx, context, { name: "Created" });
  const origin = await fixture(operation);
  const recorded = await origin.run();
  const target = await fixture(operation);
  await target.run(recorded.generated);
  expect(await snapshot(target.db)).toEqual(await snapshot(origin.db));
  expect(origin.allocate).toHaveBeenCalledTimes(3);
  expect(target.allocate).not.toHaveBeenCalled();
});

it("captures namespace arguments before waiting for the adapter transaction", async () => {
  const f = await fixture();
  const queued = delayedDatabase(f.db);
  const input = { db: queued.db, name: "Requested" };
  const running = createNamespace(input);
  input.name = "Changed while waiting";
  queued.resume();
  const id = await running;
  expect(
    (await f.db.select().from(tables.namespaceTable).where(eq(tables.namespaceTable.id, id)))[0]
      .name,
  ).toBe("Requested");
});

it("captures the squash source before waiting for the adapter transaction", async () => {
  const f = await fixture();
  const queued = delayedDatabase(f.db);
  const input = { db: queued.db, namespaceId: "n", cardId: "source", ...context };
  const running = squashNamespaceCard(input);
  input.cardId = "partner";
  queued.resume();
  expect(await running).toMatchObject({ ok: true });
  expect(
    await f.db.select().from(tables.cardTable).where(eq(tables.cardTable.id, "source")),
  ).toEqual([]);
  expect(
    await f.db.select().from(tables.cardTable).where(eq(tables.cardTable.id, "partner")),
  ).toHaveLength(1);
});
