import { afterEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { alias, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createTestDB } from "../../test-utils/db.js";
import type { DB, Tx } from "../../../../core/src/database.js";
import * as tables from "../../../../core/src/schema.js";
import { createActionBindings } from "../../../../core/src/actions/bindings.js";
import { runActionGroup } from "../../../../core/src/actions/execution.js";
import { defineActionRegistry } from "../../../../core/src/actions/registry.js";
import { ActionWriteError } from "../../../../core/src/actions/write-policy.js";

const stamp = new Date(1700000000000);
const runtimeClock = vi.fn(() => new Date(stamp));
const generated = sqliteTable("policy_generated", {
  id: integer().primaryKey({ autoIncrement: true }),
  label: text().notNull(),
  touchedAt: integer("touched_at", { mode: "timestamp" }).$onUpdateFn(runtimeClock),
});
afterEach(() => vi.restoreAllMocks());
function callableDefault(column: {
  readonly defaultFn?: unknown;
}): column is { defaultFn: () => unknown } {
  return typeof column.defaultFn === "function";
}
function forbidDefault(column: { readonly defaultFn?: unknown }) {
  if (!callableDefault(column)) throw new Error("Expected a runtime default");
  return vi.spyOn(column, "defaultFn").mockImplementation(() => {
    throw new Error("Unexpected ORM allocation");
  });
}
type Operation = (db: Tx) => Promise<unknown>;
async function fixture(operation: Operation = async () => {}) {
  // Both adapter configurations resolve the package-typed fixture to core source.
  const db = (await createTestDB()) as unknown as DB;
  await db.insert(tables.namespaceTable).values({ id: "n", name: "Main" });
  await db
    .insert(tables.partitionTable)
    .values({ id: "p", namespaceId: "n", name: "Inbox", isDefault: true });
  await db
    .insert(tables.layerTable)
    .values({ id: "l", namespaceId: "n", name: "Base", isDefault: true });
  await db.insert(tables.cardTable).values(
    ["seed", "other"].map((id) => ({
      id,
      partitionId: "p",
      layerId: "l",
      content: id,
      createdAt: stamp,
      updatedAt: stamp,
    })),
  );
  await db.insert(tables.scopeTable).values([
    { id: "s", name: "Scope" },
    { id: "other-s", name: "Other" },
  ]);
  await db.insert(tables.scopeRelTable).values({ scopeId: "s", cardId: "seed" });
  await db.insert(tables.glueTable).values([{ id: "g" }, { id: "other-g" }]);
  await db.insert(tables.glueRelTable).values({ glueId: "g", cardId: "seed" });
  await db.run(
    sql`CREATE TABLE policy_generated(id INTEGER PRIMARY KEY AUTOINCREMENT,label TEXT NOT NULL,touched_at INTEGER)`,
  );
  await db.run(sql`INSERT INTO policy_generated VALUES(1,'Seed',1600000000)`);
  await db.run(sql`CREATE TABLE policy_marker(value INTEGER)`);
  await db.run(sql`INSERT INTO policy_marker VALUES(0)`);
  await db.run(sql`CREATE TABLE policy_history(root_id TEXT)`);
  runtimeClock.mockClear();
  const registry = defineActionRegistry<{ root: unknown }, { db: Tx }>({
    contractVersion: 1,
    schemaVersions: [19],
    definitions: {
      root: {
        eligibility: "syncable",
        prepare: (input) => input,
        replay: async (_input, { context }) => {
          await context.db.run(sql`UPDATE policy_marker SET value=1`);
          try {
            return await operation(context.db);
          } catch {
            return "caught";
          }
        },
      },
    },
  });
  const run = () =>
    runActionGroup({
      db,
      registry,
      schemaVersion: 19,
      invocation: { id: "root", kind: "root", contractVersion: 1, input: {} },
      bindings: createActionBindings({
        mode: "record",
        allocateId: () => "bound-id",
        now: () => 1700000000,
      }),
      createContext: (_frame, db) => ({ db }),
      complete: async (tx) => {
        await tx.run(sql`INSERT INTO policy_history VALUES('root')`);
      },
    });
  return { db, run };
}
async function snapshot(db: DB) {
  return {
    layers: await db.select().from(tables.layerTable).orderBy(tables.layerTable.id),
    cards: await db.select().from(tables.cardTable).orderBy(tables.cardTable.id),
    scopes: await db.select().from(tables.scopeRelTable).orderBy(tables.scopeRelTable.cardId),
    glues: await db.select().from(tables.glueRelTable).orderBy(tables.glueRelTable.cardId),
    generated: await db.select().from(generated).orderBy(generated.id),
    marker: await db.select({ value: sql<number>`value` }).from(sql`policy_marker`),
    history: await db.select({ id: sql<string>`root_id` }).from(sql`policy_history`),
  };
}
const card = {
  id: "new",
  partitionId: "p",
  layerId: "l",
  content: "New",
  createdAt: stamp,
  updatedAt: stamp,
};
const violations: { name: string; run: Operation }[] = [
  {
    name: "omitted ORM ID",
    run: async (db) => db.insert(tables.layerTable).values({ namespaceId: "n", name: "New" }),
  },
  {
    name: "undefined ORM ID",
    run: async (db) =>
      db.insert(tables.layerTable).values({ id: undefined, namespaceId: "n", name: "New" }),
  },
  {
    name: "ID SQL expression",
    run: async (db) =>
      db.insert(tables.layerTable).values({ id: sql`'new'`, namespaceId: "n", name: "New" }),
  },
  {
    name: "omitted creation clock",
    run: async (db) => db.insert(tables.cardTable).values({ ...card, createdAt: undefined }),
  },
  {
    name: "omitted edit clock",
    run: async (db) => db.insert(tables.cardTable).values({ ...card, updatedAt: undefined }),
  },
  {
    name: "zero card timestamp",
    run: async (db) => db.insert(tables.cardTable).values({ ...card, createdAt: new Date(0) }),
  },
  {
    name: "subsecond zero card timestamp",
    run: async (db) => db.insert(tables.cardTable).values({ ...card, updatedAt: new Date(999) }),
  },
  {
    name: "invalid card timestamp",
    run: async (db) => db.insert(tables.cardTable).values({ ...card, createdAt: new Date(NaN) }),
  },
  {
    name: "SQL card clock",
    run: async (db) => db.insert(tables.cardTable).values({ ...card, createdAt: sql`unixepoch()` }),
  },
  {
    name: "later batch row with an omitted ID",
    run: async (db) =>
      db.insert(tables.layerTable).values([
        { id: "new", namespaceId: "n", name: "New" },
        { namespaceId: "n", name: "Bad" },
      ]),
  },
  {
    name: "skipped-insert conflict clause",
    run: async (db) =>
      db
        .insert(tables.layerTable)
        .values({ id: "new", namespaceId: "n", name: "New" })
        .onConflictDoNothing(),
  },
  {
    name: "upsert conflict clause",
    run: async (db) =>
      db
        .insert(tables.layerTable)
        .values({ id: "new", namespaceId: "n", name: "New" })
        .onConflictDoUpdate({ target: tables.layerTable.id, set: { name: "Changed" } }),
  },
  {
    name: "insert-select",
    run: async (db) => db.insert(tables.layerTable).select(sql`SELECT 'new','n','New',0,1`),
  },
  {
    name: "single-column primary key assignment",
    run: async (db) =>
      db.update(tables.layerTable).set({ id: "changed" }).where(eq(tables.layerTable.id, "l")),
  },
  {
    name: "first composite primary key assignment",
    run: async (db) => db.update(tables.scopeRelTable).set({ scopeId: "other-s" }),
  },
  {
    name: "second composite primary key assignment",
    run: async (db) => db.update(tables.scopeRelTable).set({ cardId: "other" }),
  },
  {
    name: "default through with builder",
    run: async (db) =>
      db.with().insert(tables.layerTable).values({ namespaceId: "n", name: "New" }),
  },
  {
    name: "primary key through with builder",
    run: async (db) => db.with().update(tables.layerTable).set({ id: "changed" }),
  },
  {
    name: "implicit update clock",
    run: async (db) => db.update(generated).set({ label: "Changed" }).where(eq(generated.id, 1)),
  },
  {
    name: "explicit value with an ORM update generator",
    run: async (db) => db.update(generated).set({ touchedAt: new Date(stamp) }),
  },
  {
    name: "aliased single primary key assignment",
    run: async (db) => db.update(alias(tables.layerTable, "renamed")).set({ id: "changed" }),
  },
  {
    name: "aliased composite primary key assignment",
    run: async (db) => db.update(alias(tables.scopeRelTable, "renamed")).set({ cardId: "other" }),
  },
  {
    name: "implicit SQLite autoincrement",
    run: async (db) => db.insert(generated).values({ label: "New", touchedAt: null }),
  },
  {
    name: "implicit insert update-clock fallback",
    run: async (db) => db.insert(generated).values({ id: 2, label: "New" }),
  },
];
it.each(violations)(
  "rejects $name before SQL and keeps a caught failure latched",
  async ({ run }) => {
    const f = await fixture(run);
    const before = await snapshot(f.db);
    const defaults = [
      tables.layerTable.id,
      tables.cardTable.id,
      tables.cardTable.createdAt,
      tables.cardTable.updatedAt,
    ].map(forbidDefault);
    await expect(f.run()).rejects.toBeInstanceOf(ActionWriteError);
    expect(await snapshot(f.db)).toEqual(before);
    expect(defaults.every((mock) => mock.mock.calls.length === 0)).toBe(true);
    expect(runtimeClock).not.toHaveBeenCalled();
  },
);

it("rejects row accessors without invoking them or allocating defaults", async () => {
  const getter = vi.fn(() => "new");
  const f = await fixture(async (db) =>
    db.insert(tables.layerTable).values({
      get id() {
        return getter();
      },
      namespaceId: "n",
      name: "New",
    }),
  );
  await expect(f.run()).rejects.toBeInstanceOf(ActionWriteError);
  expect(getter).not.toHaveBeenCalled();
});

it("copies explicit Dates before a caller can mutate the pending insert", async () => {
  const original = new Date(stamp);
  const f = await fixture(async (db) => {
    const query = db
      .insert(tables.cardTable)
      .values({ ...card, createdAt: original, updatedAt: original })
      .returning();
    original.setTime(0);
    return query;
  });
  const defaults = [
    tables.cardTable.id,
    tables.cardTable.createdAt,
    tables.cardTable.updatedAt,
  ].map(forbidDefault);
  await f.run();
  expect(
    (await f.db.select().from(tables.cardTable).where(eq(tables.cardTable.id, "new")))[0],
  ).toMatchObject({ createdAt: stamp, updatedAt: stamp });
  expect(defaults.every((mock) => mock.mock.calls.length === 0)).toBe(true);
});

it("allows non-key foreign key updates and explicit null insert clocks", async () => {
  const f = await fixture(async (db) => {
    await db.update(tables.glueRelTable).set({ glueId: "other-g" });
    await db.insert(generated).values({ id: 2, label: "Explicit", touchedAt: null });
  });
  await f.run();
  expect(await f.db.select().from(tables.glueRelTable)).toEqual([
    { cardId: "seed", glueId: "other-g" },
  ]);
  expect(await f.db.select().from(generated).where(eq(generated.id, 2))).toMatchObject([
    { id: 2, label: "Explicit", touchedAt: null },
  ]);
  expect(runtimeClock).not.toHaveBeenCalled();
});

it("leaves default clocks and autoincrement available in ordinary transactions", async () => {
  const f = await fixture();
  const [row] = await f.db.insert(generated).values({ label: "Ordinary" }).returning();
  await f.db.update(generated).set({ label: "Updated" }).where(eq(generated.id, 1));
  expect(row.id).toBe(2);
  expect(row.touchedAt).toEqual(stamp);
  expect(runtimeClock).toHaveBeenCalledTimes(2);
});
