import { expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createTestDB } from "../../test-utils/db.js";
import {
  captureApplicationRows,
  installCapturePrototype,
} from "../../test-utils/action-capture.js";
import type { DB } from "../../../../core/src/database.js";
import * as tables from "../../../../core/src/schema.js";
import { getTaskspace, getAllTaskspaceLocalMetadata } from "../../../../core/src/api/taskspace.js";
import { runActionGroup } from "../../../../core/src/actions/execution.js";
import { createActionBindings } from "../../../../core/src/actions/bindings.js";
import {
  createServiceActionRegistryV1,
  type LocalRecoveryHandlersV1,
} from "../../../../core/src/actions/service-registry.js";
import { createServiceContext } from "../../../../core/src/services/context.js";

const createDatabase = async () => (await createTestDB()) as unknown as DB;
const emptyMarker = [
  { mode: "record", runId: null, actionId: null, executionOrd: null, nextEffectOrd: 0 },
];
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
  await db.insert(tables.inventoryTable).values({ id: "i", namespaceId: "n", name: "Box" });
  await db.insert(tables.taskspaceTable).values({
    id: "t",
    namespaceId: "n",
    scopeId: "s",
    name: "Taskspace",
    createdAt: new Date(1000),
    updatedAt: new Date(2000),
  });
  await db.insert(tables.taskspaceLocalTable).values([
    { taskspaceId: "t", path: "local/original", lastSeenAt: new Date(3000) },
    { taskspaceId: "absent", path: "local/retained", pathKind: "workspace_relative" },
  ]);
  await db.insert(tables.cardTable).values({
    id: "c",
    partitionId: "p",
    layerId: "l",
    inventoryId: "i",
    inventorySlot: 0,
    content: "\ufeffContent\u0000🪁",
    createdAt: new Date(1000),
    updatedAt: new Date(1000),
  });
  await db
    .update(tables.cardTable)
    .set({ createdAt: new Date(0), updatedAt: new Date(0) })
    .where(eq(tables.cardTable.id, "c"));
  await db.insert(tables.scopeRelTable).values({ scopeId: "s", cardId: "c" });
  const capture = await installCapturePrototype(db);
  const recover = vi.fn(async () => {
    throw new Error("Unexpected recovery");
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
  const allocateId = vi.fn(() => {
    throw new Error("Unexpected ID");
  });
  const now = vi.fn(() => {
    throw new Error("Unexpected clock");
  });
  const run = (id: string, kind: string, input: unknown) =>
    runActionGroup({
      db,
      registry,
      schemaVersion: 19,
      invocation: { id: `${id}-root`, kind, contractVersion: 1, input },
      bindings: createActionBindings({ mode: "record", allocateId, now }),
      createContext: (actions, db) => ({ actions, db, value: createServiceContext() }),
      ...capture.hooks(id),
    });
  await run("inventory", "inventories.remove", { args: { namespaceId: "n", inventoryId: "i" } });
  const afterInventory = await captureApplicationRows(db);
  await run("namespace", "namespaces.remove", { args: { namespaceId: "n" } });
  const afterNamespace = await captureApplicationRows(db);
  const history = async () => ({
    runs: await capture.runs(),
    inventory: {
      effects: await capture.effects("inventory"),
      executions: await capture.executions("inventory"),
    },
    namespace: {
      effects: await capture.effects("namespace"),
      executions: await capture.executions("namespace"),
    },
  });
  return { db, capture, run, history, afterInventory, afterNamespace, allocateId, now, recover };
}

it("restores selected complete groups into populated rows without new effects, actions, clocks or timestamp normalization", async () => {
  const f = await fixture();
  const history = await f.history();
  await f.capture.restore(createDatabase, []);
  expect(await captureApplicationRows(f.db)).toEqual(f.capture.baseline);
  expect(await f.capture.selection()).toEqual([]);
  expect(await f.capture.marker()).toEqual(emptyMarker);
  await f.capture.verify();
  await f.capture.restore(createDatabase, ["inventory"]);
  expect(await captureApplicationRows(f.db)).toEqual(f.afterInventory);
  expect(await f.capture.selection()).toEqual(["inventory"]);
  await f.capture.restore(createDatabase, ["inventory", "namespace"]);
  expect(await captureApplicationRows(f.db)).toEqual(f.afterNamespace);
  expect(await f.capture.selection()).toEqual(["inventory", "namespace"]);
  expect(await f.history()).toEqual(history);
  expect(await f.capture.marker()).toEqual(emptyMarker);
  expect(f.allocateId).not.toHaveBeenCalled();
  expect(f.now).not.toHaveBeenCalled();
  expect(f.recover).not.toHaveBeenCalled();
  await expect(f.db.run(sql`DELETE FROM scope WHERE id='s'`)).rejects.toBeInstanceOf(Error);
  await f.capture.verify();
});

it("preserves current local metadata for present and absent taskspaces through shared restoration", async () => {
  const f = await fixture();
  expect(await getTaskspace({ db: f.db, taskspaceId: "t" })).toBeUndefined();
  await f.db
    .update(tables.taskspaceLocalTable)
    .set({ path: "local/changed", lastSeenAt: new Date(9000) })
    .where(eq(tables.taskspaceLocalTable.taskspaceId, "t"));
  const local = await getAllTaskspaceLocalMetadata({ db: f.db });
  await f.db.insert(tables.localFileOperationTable).values({
    id: "pending-local",
    kind: "taskspace.claim",
    version: 1,
    taskspaceId: "absent",
    namespaceId: "absent-namespace",
    path: "local/pending",
    pathKind: "workspace_relative",
    state: "pending",
    intent: "{}",
    createdAt: new Date(1000),
  });
  await f.db.insert(tables.localFileOperationTable).values({
    id: "pending-file",
    kind: "taskspace.file",
    version: 1,
    taskspaceId: "absent",
    namespaceId: "absent-namespace",
    path: "local/pending.txt",
    pathKind: "workspace_relative",
    state: "pending",
    intent: "{}",
    createdAt: new Date(1000),
  });
  await f.db.insert(tables.localFileOperationTable).values({
    id: "pending-directory",
    kind: "taskspace.directory",
    version: 1,
    taskspaceId: "absent",
    namespaceId: "absent-namespace",
    path: "local/directory",
    pathKind: "workspace_relative",
    state: "pending",
    intent: "{}",
    createdAt: new Date(1000),
  });
  await f.db.insert(tables.localFileOperationTable).values({
    id: "abandoned-local",
    kind: "taskspace.directory",
    version: 1,
    taskspaceId: "absent",
    namespaceId: "absent-namespace",
    path: "local/reviewed",
    pathKind: "workspace_relative",
    state: "abandoned",
    intent: "{}",
    error: "Original failure",
    createdAt: new Date(1000),
    abandonedAt: new Date(2000),
    abandonReason: "Reviewed evidence",
  });
  const operations = await f.db.select().from(tables.localFileOperationTable);
  await f.capture.restore(createDatabase, []);
  expect(await getTaskspace({ db: f.db, taskspaceId: "t" })).toMatchObject({
    path: "local/changed",
    lastSeenAt: new Date(9000),
  });
  expect(await getTaskspace({ db: f.db, taskspaceId: "absent" })).toBeUndefined();
  expect(await getAllTaskspaceLocalMetadata({ db: f.db })).toEqual(local);
  await f.capture.restore(createDatabase, ["inventory", "namespace"]);
  expect(await getTaskspace({ db: f.db, taskspaceId: "t" })).toBeUndefined();
  expect(await getAllTaskspaceLocalMetadata({ db: f.db })).toEqual(local);
  await f.capture.verify();
  expect(await f.db.select().from(tables.localFileOperationTable)).toEqual(operations);
});

it("records new actions after restoration against the selected state while retaining unselected origin history", async () => {
  const f = await fixture();
  const history = await f.history();
  await f.capture.restore(createDatabase, ["inventory"]);
  await f.run("rename", "namespaces.rename", {
    args: { namespaceId: "n" },
    body: { name: "After restore" },
  });
  expect(await f.capture.selection()).toEqual(["inventory", "rename"]);
  expect((await f.capture.runs()).map(({ id }) => id)).toEqual([
    "inventory",
    "namespace",
    "rename",
  ]);
  expect(await f.capture.effects("namespace")).toEqual(history.namespace.effects);
  expect((await f.capture.runs())[1]).toEqual(history.runs[1]);
  await f.capture.verify();
  await f.capture.restore(createDatabase, []);
  await f.capture.restore(createDatabase, ["inventory", "rename"]);
  expect((await f.db.select().from(tables.namespaceTable))[0].name).toBe("After restore");
  expect(await f.capture.marker()).toEqual(emptyMarker);
});

it.each([["missing"], ["inventory", "inventory"], ["namespace"], ["namespace", "inventory"]])(
  "refuses invalid history selection %j before changing application rows or markers",
  async (...selected) => {
    const f = await fixture();
    const history = await f.history();
    const createValidation = vi.fn(createDatabase);
    await expect(f.capture.restore(createValidation, selected)).rejects.toBeInstanceOf(Error);
    expect(createValidation).not.toHaveBeenCalled();
    expect(await captureApplicationRows(f.db)).toEqual(f.afterNamespace);
    expect(await f.capture.selection()).toEqual(["inventory", "namespace"]);
    expect(await f.history()).toEqual(history);
    expect(await f.capture.marker()).toEqual(emptyMarker);
  },
);

it("leaves the destination untouched if isolated validation refuses a projection", async () => {
  const f = await fixture();
  const history = await f.history();
  const invalid = await createDatabase();
  await invalid.run(sql`DROP TRIGGER card_inventory_pair_insert`);
  await expect(f.capture.restore(async () => invalid, [])).rejects.toThrow("canonical schema");
  expect(await captureApplicationRows(f.db)).toEqual(f.afterNamespace);
  expect(await f.capture.selection()).toEqual(["inventory", "namespace"]);
  expect(await f.history()).toEqual(history);
  expect(await f.capture.marker()).toEqual(emptyMarker);
});

it.each([
  {
    name: "SQL error",
    statement: sql`CREATE TRIGGER restore_failure AFTER INSERT ON card WHEN (SELECT mode FROM capture_context)='restore' BEGIN SELECT RAISE(ABORT,'restore failed'); END`,
  },
  {
    name: "read-back mismatch",
    statement: sql`CREATE TRIGGER restore_failure AFTER INSERT ON card WHEN (SELECT mode FROM capture_context)='restore' BEGIN UPDATE card SET pos_x=123 WHERE id=NEW.id; END`,
  },
])(
  "rolls back partial installation, selection and restore context after $name",
  async ({ statement }) => {
    const f = await fixture();
    await f.capture.restore(createDatabase, ["inventory"]);
    const history = await f.history();
    await f.db.run(statement);
    await expect(f.capture.restore(createDatabase, [])).rejects.toBeInstanceOf(Error);
    expect(await captureApplicationRows(f.db)).toEqual(f.afterInventory);
    expect(await f.capture.selection()).toEqual(["inventory"]);
    expect(await f.history()).toEqual(history);
    expect(await f.capture.marker()).toEqual(emptyMarker);
    await expect(f.db.run(sql`UPDATE card SET pos_x=1 WHERE id='c'`)).rejects.toBeInstanceOf(Error);
    await f.db.run(sql`DROP TRIGGER restore_failure`);
    await f.capture.restore(createDatabase, []);
    expect(await captureApplicationRows(f.db)).toEqual(f.capture.baseline);
    await f.capture.verify();
  },
);
