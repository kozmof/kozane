import { expect, expectTypeOf, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDB } from "../../test-utils/db.js";
import {
  captureApplicationRows,
  installCapturePrototype,
} from "../../test-utils/action-capture.js";
import { withTx, type DB } from "../../../../core/src/database.js";
import * as tables from "../../../../core/src/schema.js";
import * as taskspaces from "../../../../core/src/services/taskspaces.js";
import { getTaskspace, getAllTaskspaceLocalMetadata } from "../../../../core/src/api/taskspace.js";
import { createServiceContext } from "../../../../core/src/services/context.js";
import { actionContractsV1 } from "../../../../core/src/actions/contracts.js";
import {
  actionContractsV2,
  type ActionInputsV2,
  type SyncableActionKindV2,
} from "../../../../core/src/actions/contracts-v2.js";
import {
  createActionBindings,
  type ActionBindingMap,
} from "../../../../core/src/actions/bindings.js";
import {
  createServiceActionRegistryV1,
  createServiceActionRegistryV2,
  type LocalRecoveryHandlersV2,
  type ServiceActionContext,
} from "../../../../core/src/actions/service-registry.js";
import {
  createActionRegistryCatalog,
  defineActionRegistry,
} from "../../../../core/src/actions/registry.js";
import { runActionGroup, type ActionFrameAccess } from "../../../../core/src/actions/execution.js";
import { ActionScopeRequiredError } from "../../../../core/src/actions/allocations.js";
import { composeActionsV2 } from "../../../../core/src/actions/composition-v2.js";
import {
  replayComposition,
  composeActions,
  type CompositionAccess,
} from "../../../../core/src/actions/composition.js";

const value = createServiceContext();
const stamp = new Date(1600000000000);
const createDatabase = async () => (await createTestDB()) as unknown as DB;
async function fixture() {
  const db = await createDatabase();
  await db.insert(tables.namespaceTable).values([
    { id: "n", name: "Main" },
    { id: "other", name: "Other" },
  ]);
  await db.insert(tables.scopeTable).values({ id: "s", name: "Scope" });
  await db
    .insert(tables.partitionTable)
    .values({ id: "p", namespaceId: "n", name: "Inbox", isDefault: true });
  await db
    .insert(tables.layerTable)
    .values({ id: "l", namespaceId: "n", name: "Base", isDefault: true });
  await db.insert(tables.taskspaceTable).values([
    { id: "t", namespaceId: "n", scopeId: "s", name: "Before", createdAt: stamp, updatedAt: stamp },
    { id: "unplaced", scopeId: "s", name: "Unplaced", createdAt: stamp, updatedAt: stamp },
  ]);
  await db.insert(tables.taskspaceLocalTable).values([
    { taskspaceId: "t", path: "local/original", lastSeenAt: stamp },
    {
      taskspaceId: "allocated-1",
      path: "local/retained",
      pathKind: "absolute",
      lastSeenAt: new Date(0),
    },
  ]);
  await db.insert(tables.cardTable).values({
    id: "c",
    partitionId: "p",
    layerId: "l",
    taskspaceId: "t",
    content: "Card",
    createdAt: stamp,
    updatedAt: stamp,
  });
  const capture = await installCapturePrototype(db);
  const recover = vi.fn(async () => "local recovery");
  const recovery = {
    "taskspaces.createFile": { recover },
    "taskspaces.saveFile": { recover },
    "taskspaces.createDirectory": { recover },
    "taskspaces.renameEntry": { recover },
    "taskspaces.removeEntry": { recover },
  } satisfies LocalRecoveryHandlersV2;
  const registry = createServiceActionRegistryV2(recovery);
  const v1 = createServiceActionRegistryV1({
    ...recovery,
    "taskspaces.create": { recover },
    "taskspaces.rename": { recover },
    "taskspaces.remove": { recover },
  });
  let nextId = 0;
  let nextRun = 0;
  const allocateId = vi.fn(() => `allocated-${++nextId}`);
  const now = vi.fn(() => 1700000000);
  const bindings = (generated?: ActionBindingMap) =>
    generated === undefined
      ? createActionBindings({ mode: "record", allocateId, now })
      : createActionBindings({ mode: "replay", bindings: generated });
  const run = (kind: string, input: unknown, generated?: ActionBindingMap) =>
    runActionGroup({
      db,
      registry,
      schemaVersion: 20,
      invocation: { id: "root", kind, contractVersion: 2, input },
      bindings: bindings(generated),
      createContext: (actions, db) => ({ actions, db, value }),
      ...capture.hooks(`run-${++nextRun}`),
    });
  return { db, capture, recovery, registry, v1, run, bindings, allocateId, now, recover };
}
const createInput = {
  args: { namespaceId: "n" },
  body: { name: "  Created / label  ", scopeId: "s" },
};

it("pins changed taskspace lifecycle semantics to version 2 and schema 20", async () => {
  const f = await fixture();
  const catalog = createActionRegistryCatalog([f.v1, f.registry]);
  expect(catalog.select(1, 19)).toBe(f.v1);
  expect(catalog.select(1, 20)).toBe(f.v1);
  expect(catalog.select(2, 20)).toBe(f.registry);
  expect(catalog.select(1, 21)).toBe(f.v1);
  expect(catalog.select(2, 21)).toBe(f.registry);
  expect(catalog.select(1, 22)).toBe(f.v1);
  expect(catalog.select(2, 22)).toBe(f.registry);
  expect(catalog.select(1, 23)).toBe(f.v1);
  expect(catalog.select(2, 23)).toBe(f.registry);
  expect(catalog.select(1, 24)).toBe(f.v1);
  expect(catalog.select(2, 24)).toBe(f.registry);
  expect(catalog.select(1, 25)).toBe(f.v1);
  expect(catalog.select(2, 25)).toBe(f.registry);
  expect(catalog.select(1, 27)).toBe(f.v1);
  expect(catalog.select(2, 27)).toBe(f.registry);
  expect(catalog.select(1, 28)).toBe(f.v1);
  expect(catalog.select(2, 28)).toBe(f.registry);
  expect(catalog.select(1, 29)).toBe(f.v1);
  expect(catalog.select(2, 29)).toBe(f.registry);
  expect(() => catalog.select(2, 30)).toThrow();
  expect(() => catalog.select(2, 19)).toThrow();
  for (const kind of ["taskspaces.create", "taskspaces.rename", "taskspaces.remove"] as const) {
    expect(actionContractsV1[kind]).toBe("local-only");
    expect(actionContractsV2[kind]).toBe("syncable");
  }
  expect(
    Object.entries(actionContractsV2)
      .filter(([, eligibility]) => eligibility === "local-only")
      .map(([kind]) => kind),
  ).toEqual(Object.keys(f.recovery));
  expectTypeOf<
    Extract<SyncableActionKindV2, "taskspaces.create" | "taskspaces.rename" | "taskspaces.remove">
  >().toEqualTypeOf<"taskspaces.create" | "taskspaces.rename" | "taskspaces.remove">();
});

it("creates shared identity with recorded allocations while retaining a local attachment for the same ID", async () => {
  const f = await fixture();
  const local = await getAllTaskspaceLocalMetadata({ db: f.db });
  const origin = await f.run("taskspaces.create", createInput);
  expect(origin.result).toEqual({
    id: "allocated-1",
    name: "Created / label",
    namespaceId: "n",
    scopeId: "s",
    createdAt: new Date(1700000000000),
    updatedAt: new Date(1700000000000),
  });
  expect(origin.invocation.input).toEqual(createInput);
  expect((origin.result as Record<string, unknown>).path).toBeUndefined();
  expect(await getTaskspace({ db: f.db, taskspaceId: "allocated-1" })).toMatchObject({
    path: "local/retained",
  });
  expect(await getAllTaskspaceLocalMetadata({ db: f.db })).toEqual(local);
  await f.capture.restore(createDatabase, []);
  const replay = await f.run("taskspaces.create", origin.invocation.input, origin.generated);
  expect(replay.result).toEqual(origin.result);
  expect(replay.generated).toEqual(origin.generated);
  expect(f.allocateId).toHaveBeenCalledOnce();
  expect(f.now).toHaveBeenCalledOnce();
  expect(f.recover).not.toHaveBeenCalled();
  await f.capture.verify();
});

it("renames only the shared label and removes shared identity without changing local observations", async () => {
  const f = await fixture();
  const local = await getAllTaskspaceLocalMetadata({ db: f.db });
  const renamed = await f.run("taskspaces.rename", {
    args: { namespaceId: "n", taskspaceId: "t" },
    body: { name: "  Label / remains a label  " },
  });
  expect(renamed.result).toEqual({
    id: "t",
    name: "Label / remains a label",
    namespaceId: "n",
    scopeId: "s",
    createdAt: stamp,
    updatedAt: new Date(1700000000000),
  });
  await f.run("taskspaces.remove", { args: { namespaceId: "n", taskspaceId: "t" } });
  expect(await getTaskspace({ db: f.db, taskspaceId: "t" })).toBeUndefined();
  expect((await f.db.select().from(tables.cardTable))[0]).toMatchObject({
    taskspaceId: null,
    createdAt: stamp,
    updatedAt: stamp,
  });
  expect(await getAllTaskspaceLocalMetadata({ db: f.db })).toEqual(local);
  expect((await f.capture.effects("run-2")).map(({ table, op }) => ({ table, op }))).toEqual([
    { table: "taskspace", op: "D" },
    { table: "card", op: "U" },
  ]);
  expect(f.recover).not.toHaveBeenCalled();
});

it("executes all shared lifecycle handlers without a local metadata table", async () => {
  const f = await fixture();
  await f.db.run(sql`DROP TABLE taskspace_local`);
  const created = await f.run("taskspaces.create", createInput);
  const { id } = created.result as { id: string };
  await f.run("taskspaces.rename", {
    args: { namespaceId: "n", taskspaceId: id },
    body: { name: "Renamed" },
  });
  await f.run("taskspaces.remove", { args: { namespaceId: "n", taskspaceId: id } });
  await f.capture.verify();
});

it("records and replays version 2 composition children without rerunning the callback or file recovery", async () => {
  const f = await fixture();
  const local = await getAllTaskspaceLocalMetadata({ db: f.db });
  const operation = vi.fn(
    async (access: CompositionAccess<{}, ActionInputsV2, SyncableActionKindV2>) => {
      const created = (await access.dispatch(["taskspace"], "taskspaces.create", createInput)) as {
        id: string;
      };
      await access.dispatch(["label"], "taskspaces.rename", {
        args: { namespaceId: "n", taskspaceId: created.id },
        body: { name: "Composed" },
      });
      await access.dispatch(["card"], "cards.create", {
        args: { namespaceId: "n" },
        body: { partitionId: "p", content: `Created with ${created.id}` },
      });
      await access.dispatch(["remove"], "taskspaces.remove", {
        args: { namespaceId: "n", taskspaceId: created.id },
      });
      return created.id;
    },
  );
  const origin = await composeActionsV2({
    db: f.db,
    id: "composition",
    schemaVersion: 20,
    registry: f.registry,
    value,
    bindings: f.bindings(),
    readers: {},
    operation,
    ...f.capture.hooks("composed"),
  });
  const rows = await captureApplicationRows(f.db);
  expect(origin.executions.map(({ contractVersion }) => contractVersion)).toEqual([2, 2, 2, 2, 2]);
  const input = origin.invocation.input as ActionInputsV2["system.compose"];
  expect(input.body.children.map(({ kind }) => kind)).toEqual([
    "taskspaces.create",
    "taskspaces.rename",
    "cards.create",
    "taskspaces.remove",
  ]);
  expect((await f.capture.effects("composed")).every(({ executionOrd }) => executionOrd > 0)).toBe(
    true,
  );
  const calls = { allocate: f.allocateId.mock.calls.length, now: f.now.mock.calls.length };
  await f.capture.restore(createDatabase, []);
  await replayComposition({
    db: f.db,
    schemaVersion: 20,
    registry: f.registry,
    invocation: origin.invocation,
    generated: origin.generated,
    value,
    ...f.capture.hooks("replayed"),
  });
  expect(await captureApplicationRows(f.db)).toEqual(rows);
  expect(await getAllTaskspaceLocalMetadata({ db: f.db })).toEqual(local);
  expect(operation).toHaveBeenCalledOnce();
  expect(f.allocateId).toHaveBeenCalledTimes(calls.allocate);
  expect(f.now).toHaveBeenCalledTimes(calls.now);
  expect(f.recover).not.toHaveBeenCalled();
});

it.each(["taskspaces.rename", "taskspaces.remove"])(
  "refuses foreign namespace ownership for %s",
  async (kind) => {
    const f = await fixture();
    const input = {
      args: { namespaceId: "other", taskspaceId: "t" },
      ...(kind === "taskspaces.rename" ? { body: { name: "Foreign" } } : {}),
    };
    await expect(f.run(kind, input)).rejects.toMatchObject({ name: "NotFoundError" });
    expect(await captureApplicationRows(f.db)).toEqual(f.capture.baseline);
    expect(await f.capture.runs()).toEqual([]);
  },
);

it("permits unplaced taskspaces on an existing namespace while refusing a missing namespace", async () => {
  const f = await fixture();
  await expect(
    f.run("taskspaces.rename", {
      args: { namespaceId: "missing", taskspaceId: "unplaced" },
      body: { name: "New" },
    }),
  ).rejects.toMatchObject({ name: "NotFoundError" });
  const renamed = await f.run("taskspaces.rename", {
    args: { namespaceId: "other", taskspaceId: "unplaced" },
    body: { name: "New" },
  });
  expect(renamed.result).toMatchObject({ id: "unplaced", namespaceId: null, name: "New" });
});

it.each([
  { name: "", scopeId: "s" },
  { name: "x", scopeId: "" },
  { name: "x", scopeId: "missing" },
  { name: "x", scopeId: "s", path: "local" },
  { name: "x", scopeId: "s", lastSeenAt: 123 },
  { name: "x", scopeId: "s", pathKind: "absolute" },
  { name: "x", scopeId: "s", createdAt: 123 },
])(
  "refuses invalid or local-only creation fields before allocating shared values %#",
  async (body) => {
    const f = await fixture();
    await expect(
      f.run("taskspaces.create", { args: { namespaceId: "n" }, body }),
    ).rejects.toBeInstanceOf(Error);
    expect(await captureApplicationRows(f.db)).toEqual(f.capture.baseline);
    expect(await f.capture.runs()).toEqual([]);
    expect(f.allocateId).not.toHaveBeenCalled();
    expect(f.now).not.toHaveBeenCalled();
  },
);

it("refuses local metadata fields in label requests", async () => {
  const f = await fixture();
  const before = await getAllTaskspaceLocalMetadata({ db: f.db });
  await expect(
    f.run("taskspaces.rename", {
      args: { namespaceId: "n", taskspaceId: "t" },
      body: { name: "New", path: "local/new" },
    }),
  ).rejects.toBeInstanceOf(Error);
  expect(await captureApplicationRows(f.db)).toEqual(f.capture.baseline);
  expect(await getAllTaskspaceLocalMetadata({ db: f.db })).toEqual(before);
});

it("requires owning action handles for version 2 registry dispatch", async () => {
  const f = await fixture();
  await withTx(f.db, async (db) => {
    await expect(
      f.registry.execute("taskspaces.create", createInput, {
        context: { db, value, actions: {} as ActionFrameAccess },
        bindings: f.bindings(),
      }),
    ).rejects.toBeInstanceOf(ActionScopeRequiredError);
  });
  expect(await captureApplicationRows(f.db)).toEqual(f.capture.baseline);
});

it("rolls back earlier shared writes when a named handler catches taskspace validation failure", async () => {
  const f = await fixture();
  const registry = defineActionRegistry<{ named: unknown }, ServiceActionContext>({
    contractVersion: 2,
    schemaVersions: [20],
    definitions: {
      named: {
        eligibility: "syncable",
        prepare: (input) => input,
        replay: async (_input, { context }) => {
          await taskspaces.renameInTx(context.db, value, "n", "t", { name: "After" });
          try {
            await taskspaces.createInTx(context.db, value, "n", { name: "", scopeId: "s" });
          } catch {
            /* Shared service validation remains latched. */
          }
        },
      },
    },
  });
  await expect(
    runActionGroup({
      db: f.db,
      registry,
      schemaVersion: 20,
      invocation: { id: "named", kind: "named", contractVersion: 2, input: {} },
      bindings: f.bindings(),
      createContext: (actions, db) => ({ actions, db, value }),
      ...f.capture.hooks("caught"),
    }),
  ).rejects.toBeInstanceOf(Error);
  expect(await captureApplicationRows(f.db)).toEqual(f.capture.baseline);
  expect(await f.capture.runs()).toEqual([]);
});

it("refuses version 2 local file children and leaves version 1 lifecycle requests local-only", async () => {
  const f = await fixture();
  await expect(
    f.run("system.compose", {
      args: {},
      body: {
        children: [
          {
            id: "file",
            path: ["file"],
            kind: "taskspaces.createFile",
            input: { args: { namespaceId: "n", taskspaceId: "t" }, body: { path: "a.md" } },
          },
        ],
      },
    }),
  ).rejects.toThrow("local-only");
  await expect(
    runActionGroup({
      db: f.db,
      registry: f.v1,
      schemaVersion: 20,
      invocation: { id: "v1", kind: "taskspaces.create", contractVersion: 1, input: createInput },
      bindings: f.bindings(),
      createContext: (actions, db) => ({ actions, db, value }),
      ...f.capture.hooks("v1"),
    }),
  ).rejects.toThrow("local-only");
  expect(await f.capture.runs()).toEqual([]);
  expect(f.recover).not.toHaveBeenCalled();
});

it("refuses schema 19 or a mismatched contract before handlers and preserves missing replay allocations atomically", async () => {
  const f = await fixture();
  for (const [schemaVersion, contractVersion] of [
    [19, 2],
    [20, 1],
  ]) {
    await expect(
      runActionGroup({
        db: f.db,
        registry: f.registry,
        schemaVersion,
        invocation: { id: "bad", kind: "taskspaces.create", contractVersion, input: createInput },
        bindings: f.bindings(),
        createContext: (actions, db) => ({ actions, db, value }),
        ...f.capture.hooks("bad"),
      }),
    ).rejects.toMatchObject({ code: "action-contract-required" });
  }
  await expect(f.run("taskspaces.create", createInput, {})).rejects.toThrow(
    "Unbound replay allocation",
  );
  expect(await captureApplicationRows(f.db)).toEqual(f.capture.baseline);
  expect(await f.capture.runs()).toEqual([]);
  expect(f.allocateId).not.toHaveBeenCalled();
  expect(f.now).not.toHaveBeenCalled();
});

it("requires exactly the five version 2 local recovery registrations", async () => {
  const f = await fixture();
  const missing = { ...f.recovery };
  Reflect.deleteProperty(missing, "taskspaces.saveFile");
  expect(() => createServiceActionRegistryV2(missing)).toThrow(
    "Missing action handler: taskspaces.saveFile",
  );
  expect(() =>
    createServiceActionRegistryV2({
      ...f.recovery,
      "taskspaces.rename": { recover: f.recover },
    } as unknown as LocalRecoveryHandlersV2),
  ).toThrow("Unexpected local recovery handler");
});

it("refuses the wrong composition registry before invoking its callback", async () => {
  const f = await fixture();
  const operation = vi.fn(async () => {});
  const options = {
    db: f.db,
    id: "wrong",
    schemaVersion: 20,
    value,
    bindings: f.bindings(),
    readers: {},
    operation,
  };
  await expect(composeActionsV2({ ...options, registry: f.v1 })).rejects.toThrow("contract 2");
  await expect(composeActions({ ...options, registry: f.registry })).rejects.toThrow("contract 1");
  expect(operation).not.toHaveBeenCalled();
  expect(await f.capture.runs()).toEqual([]);
});

it("validates nested composition children using the selected contract's eligibility map", async () => {
  const f = await fixture();
  const input = {
    args: {},
    body: {
      children: [
        {
          id: "allocated-1",
          path: ["nested"],
          kind: "system.compose",
          input: {
            args: {},
            body: {
              children: [
                {
                  id: "allocated-2",
                  path: ["label"],
                  kind: "taskspaces.rename",
                  input: { args: { namespaceId: "n", taskspaceId: "t" }, body: { name: "Nested" } },
                },
              ],
            },
          },
        },
      ],
    },
  };
  const origin = await f.run("system.compose", input);
  expect(origin.executions.map(({ kind }) => kind)).toEqual([
    "system.compose",
    "system.compose",
    "taskspaces.rename",
  ]);
  expect((await getTaskspace({ db: f.db, taskspaceId: "t" }))!.name).toBe("Nested");
  const duplicate = structuredClone(input);
  duplicate.body.children[0].input.body.children[0].id = "allocated-1";
  await expect(f.run("system.compose", duplicate)).rejects.toThrow(
    "Duplicate composition child ID",
  );
  expect(await f.capture.runs()).toHaveLength(1);
});
