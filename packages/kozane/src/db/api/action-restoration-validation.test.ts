import { expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createTestDB } from "../../test-utils/db.js";
import {
  captureApplicationRows,
  capturedTables,
  installCapturePrototype,
} from "../../test-utils/action-capture.js";
import { validateApplicationProjection } from "../../test-utils/action-validation.js";
import { createRowProjection, ProjectionError } from "../../../../core/src/actions/projection.js";
import type { TaggedRow } from "../../../../core/src/actions/row-codec.js";
import type { DB } from "../../../../core/src/database.js";
import * as tables from "../../../../core/src/schema.js";
import { runActionGroup } from "../../../../core/src/actions/execution.js";
import { createActionBindings } from "../../../../core/src/actions/bindings.js";
import {
  createServiceActionRegistryV1,
  type LocalRecoveryHandlersV1,
} from "../../../../core/src/actions/service-registry.js";
import { createServiceContext } from "../../../../core/src/services/context.js";
import { canonicalSchemaManifest } from "../../../../core/src/generated/schema-manifest.js";
import { readSchemaManifest } from "../../../../core/src/migrations/schema-reader.js";
import { compareSchemaManifests } from "../../../../core/src/migrations/schema.js";

const createDatabase = async () => (await createTestDB()) as unknown as DB;
async function fixture() {
  const db = await createDatabase();
  await db.insert(tables.namespaceTable).values({ id: "n", name: "Namespace", isDefault: true });
  await db
    .insert(tables.partitionTable)
    .values({ id: "p", namespaceId: "n", name: "Inbox", isDefault: true });
  await db
    .insert(tables.layerTable)
    .values({ id: "l", namespaceId: "n", name: "Base", isDefault: true });
  await db.insert(tables.scopeTable).values({ id: "s", name: "Scope" });
  await db.insert(tables.taskspaceTable).values({
    id: "t",
    namespaceId: "n",
    scopeId: "s",
    name: "Taskspace",
    path: "local-folder",
    createdAt: new Date(1000),
    updatedAt: new Date(2000),
  });
  await db.insert(tables.inventoryTable).values({ id: "i", namespaceId: "n", name: "Inventory" });
  await db.insert(tables.cardTable).values([
    {
      id: "stored",
      partitionId: "p",
      layerId: "l",
      inventoryId: "i",
      inventorySlot: 0,
      content: "Stored",
      createdAt: new Date(1000),
      updatedAt: new Date(2000),
    },
    {
      id: "canvas",
      partitionId: "p",
      layerId: "l",
      taskspaceId: "t",
      content: "\ufeffText\u0000🪁",
      createdAt: new Date(1000),
      updatedAt: new Date(2000),
    },
  ]);
  await db
    .update(tables.cardTable)
    .set({ createdAt: new Date(0), updatedAt: new Date(0) })
    .where(eq(tables.cardTable.id, "canvas"));
  await db.run(
    sql`UPDATE card SET pos_x=CAST('9007199254740993' AS INTEGER),width=1.5 WHERE id='canvas'`,
  );
  await db.insert(tables.glueTable).values({ id: "g" });
  await db.insert(tables.glueRelTable).values([
    { glueId: "g", cardId: "stored" },
    { glueId: "g", cardId: "canvas" },
  ]);
  await db.insert(tables.scopeRelTable).values({ scopeId: "s", cardId: "canvas" });
  await db
    .insert(tables.scopeAreaTable)
    .values({ id: "a", scopeId: "s", namespaceId: "n", posX: 0, posY: 0, width: 100, height: 100 });
  await db.insert(tables.warpTable).values({ id: "w", namespaceId: "n" });
  const rows = await captureApplicationRows(db);
  const target = createRowProjection(capturedTables, rows);
  return { db, rows, target };
}

async function schemaMatches(db: DB) {
  return compareSchemaManifests(
    await readSchemaManifest(async (query) =>
      (await db.values(sql.raw(query))).map((row) => Array.from(row)),
    ),
    canonicalSchemaManifest,
  ).matches;
}

it("validates populated application rows in a separate database without timestamp normalization or integer rounding", async () => {
  const f = await fixture();
  const validation = await validateApplicationProjection(createDatabase, f.target);
  const loaded = await captureApplicationRows(validation);
  expect(loaded).toEqual(f.rows);
  expect(
    loaded.find(({ table, row }) => table === "card" && row.id[1] === "canvas")!.row,
  ).toMatchObject({
    pos_x: ["integer", "9007199254740993"],
    width: ["real", "3ff8000000000000"],
    created_at: ["integer", "0"],
    updated_at: ["integer", "0"],
    content: ["text", "\ufeffText\u0000🪁"],
  });
  expect(await captureApplicationRows(f.db)).toEqual(f.rows);
  expect(await schemaMatches(f.db)).toBe(true);
});

const changes: { name: string; table: string; id: string; patch: TaggedRow }[] = [
  {
    name: "foreign key",
    table: "card",
    id: "canvas",
    patch: { partition_id: ["text", "missing"] },
  },
  { name: "NOT NULL", table: "card", id: "canvas", patch: { content: ["null"] } },
  { name: "CHECK", table: "scope", id: "s", patch: { name: ["text", ""] } },
  {
    name: "unique inventory slot",
    table: "card",
    id: "canvas",
    patch: { inventory_id: ["text", "i"], inventory_slot: ["integer", "0"] },
  },
  {
    name: "inventory pair",
    table: "card",
    id: "canvas",
    patch: { inventory_slot: ["integer", "1"] },
  },
];
it.each(changes)(
  "refuses invalid final $name rows while preserving the source and rolling back the validation database",
  async ({ table, id, patch }) => {
    const f = await fixture();
    const changed = f.rows.map((entry) =>
      entry.table === table && entry.row.id[1] === id
        ? { table, row: { ...entry.row, ...patch } }
        : entry,
    );
    const target = createRowProjection(capturedTables, changed);
    let validation!: DB;
    await expect(
      validateApplicationProjection(async () => (validation = await createDatabase()), target),
    ).rejects.toBeInstanceOf(Error);
    expect(await captureApplicationRows(validation)).toEqual([]);
    expect(await schemaMatches(validation)).toBe(true);
    expect(await captureApplicationRows(f.db)).toEqual(f.rows);
  },
);

it.each([
  ["real", "3ff0000000000000"],
  ["real", "8000000000000000"],
  ["text", "1"],
] as const)(
  "refuses affinity coercion of %s %s even when relational constraints pass",
  async (type, value) => {
    const f = await fixture();
    const changed = f.rows.map((entry) =>
      entry.table === "card" && entry.row.id[1] === "canvas"
        ? { table: entry.table, row: { ...entry.row, pos_x: [type, value] as const } }
        : entry,
    );
    let validation!: DB;
    await expect(
      validateApplicationProjection(
        async () => (validation = await createDatabase()),
        createRowProjection(capturedTables, changed),
      ),
    ).rejects.toBeInstanceOf(ProjectionError);
    expect(await captureApplicationRows(validation)).toEqual([]);
    expect(await schemaMatches(validation)).toBe(true);
    expect(await captureApplicationRows(f.db)).toEqual(f.rows);
  },
);

it("refuses a populated validation destination without altering it", async () => {
  const f = await fixture();
  await expect(validateApplicationProjection(async () => f.db, f.target)).rejects.toThrow(
    "empty database",
  );
  expect(await captureApplicationRows(f.db)).toEqual(f.rows);
  expect(await schemaMatches(f.db)).toBe(true);
});

it("refuses an incompatible validation schema before loading any target rows", async () => {
  const f = await fixture();
  const validation = await createDatabase();
  await validation.run(sql`DROP TRIGGER card_inventory_pair_insert`);
  await expect(validateApplicationProjection(async () => validation, f.target)).rejects.toThrow(
    "canonical schema",
  );
  expect(await captureApplicationRows(validation)).toEqual([]);
  expect(await captureApplicationRows(f.db)).toEqual(f.rows);
});

it("validates final cascade states after unconstrained reconstruction and preserves the captured origin history", async () => {
  const f = await fixture();
  const capture = await installCapturePrototype(f.db);
  const recover = async () => {
    throw new Error("Unexpected recovery");
  };
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
  const run = (id: string, kind: string, input: unknown) =>
    runActionGroup({
      db: f.db,
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
  await run("inventory", "inventories.remove", { args: { namespaceId: "n", inventoryId: "i" } });
  const intermediate = await capture.effects("inventory");
  expect(
    intermediate.some(
      ({ after }) =>
        after?.inventory_id?.[0] === "null" && after?.inventory_slot?.[0] === "integer",
    ),
  ).toBe(true);
  const projection = f.target.apply(intermediate);
  const validation = await validateApplicationProjection(createDatabase, projection);
  expect(await captureApplicationRows(validation)).toEqual(await captureApplicationRows(f.db));
  const before = { effects: await capture.effects("inventory"), runs: await capture.runs() };
  await run("namespace", "namespaces.remove", { args: { namespaceId: "n" } });
  const final = projection.apply(await capture.effects("namespace"));
  const emptyBoard = await validateApplicationProjection(createDatabase, final);
  expect(await captureApplicationRows(emptyBoard)).toEqual(await captureApplicationRows(f.db));
  expect(await capture.effects("inventory")).toEqual(before.effects);
  expect((await capture.runs())[0]).toEqual(before.runs[0]);
  await capture.verify();
});
