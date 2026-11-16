import { expect, it, vi } from "vitest";
import { getTableName, sql } from "drizzle-orm";
import { createTestDB } from "../../test-utils/db.js";
import type { DB, Tx } from "../../../../core/src/database.js";
import * as tables from "../../../../core/src/schema.js";
import {
  createServiceContext,
  type ServiceContext,
} from "../../../../core/src/services/context.js";
import {
  createActionBindings,
  type ActionBindingMap,
} from "../../../../core/src/actions/bindings.js";
import {
  actionContractsV1,
  type ActionInputsV1,
  type ActionKindV1,
  type SyncableActionKindV1,
} from "../../../../core/src/actions/contracts.js";
import {
  composeActions,
  replayComposition,
  type CompositionAccess,
} from "../../../../core/src/actions/composition.js";
import { runActionGroup } from "../../../../core/src/actions/execution.js";
import {
  defineActionRegistry,
  type ActionHandlerContext,
} from "../../../../core/src/actions/registry.js";
import { ActionScopeRequiredError } from "../../../../core/src/actions/allocations.js";
import { withActionReplayTransaction } from "../../../../core/src/actions/replay.js";
import {
  createServiceActionRegistryV1,
  type LocalRecoveryHandlersV1,
  type ServiceActionContext,
} from "../../../../core/src/actions/service-registry.js";

const value = createServiceContext();
type Execution = ActionHandlerContext<ServiceActionContext>;
function runNamed(
  f: Awaited<ReturnType<typeof fixture>>,
  operation: (execution: Execution) => Promise<unknown>,
  enter?: (tx: Tx) => Promise<void>,
) {
  const registry = defineActionRegistry<{ named: unknown }, ServiceActionContext>({
    contractVersion: 1,
    schemaVersions: [19],
    definitions: {
      named: {
        eligibility: "syncable",
        prepare: (input) => input,
        replay: (_input, execution) => operation(execution),
      },
    },
  });
  return runActionGroup({
    db: f.db,
    registry,
    schemaVersion: 19,
    invocation: { id: "named", kind: "named", contractVersion: 1, input: {} },
    bindings: createActionBindings({ mode: "record", allocateId: f.allocate, now: f.now }),
    createContext: (actions, db) => ({ actions, db, value }),
    enter,
    complete: f.complete,
  });
}
const stamp = new Date(1600000000000);
function recoveryHandlers() {
  const recover = vi.fn(async () => {
    throw new Error("Local recovery must be explicit");
  });
  const handlers = {
    "taskspaces.create": { recover },
    "taskspaces.rename": { recover },
    "taskspaces.remove": { recover },
    "taskspaces.createFile": { recover },
    "taskspaces.saveFile": { recover },
    "taskspaces.createDirectory": { recover },
    "taskspaces.renameEntry": { recover },
    "taskspaces.removeEntry": { recover },
  } satisfies LocalRecoveryHandlersV1;
  return { handlers, recover };
}
async function fixture() {
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
  await db.insert(tables.scopeTable).values({ id: "s", name: "Scope" });
  await db.insert(tables.scopeAreaTable).values([
    { id: "area", namespaceId: "n", scopeId: "s", posX: 0, posY: 0, width: 100, height: 100 },
    {
      id: "other-area",
      namespaceId: "other",
      scopeId: "s",
      posX: 0,
      posY: 0,
      width: 100,
      height: 100,
    },
  ]);
  await db.insert(tables.warpTable).values({ id: "w", namespaceId: "n", posX: 5, posY: 5 });
  await db.insert(tables.inventoryTable).values({ id: "i", namespaceId: "n", name: "Box" });
  await db.insert(tables.cardTable).values([
    {
      id: "c1",
      partitionId: "alt-p",
      layerId: "alt-l",
      content: "One. Two",
      zIndex: 1,
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: "c2",
      partitionId: "alt-p",
      layerId: "alt-l",
      content: "Second",
      zIndex: 2,
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: "c3",
      partitionId: "p",
      layerId: "l",
      content: "Stored",
      inventoryId: "i",
      inventorySlot: 0,
      createdAt: stamp,
      updatedAt: stamp,
    },
  ]);
  await db.insert(tables.scopeRelTable).values({ scopeId: "s", cardId: "c1" });
  await db.insert(tables.glueTable).values({ id: "g" });
  await db.insert(tables.glueRelTable).values([
    { glueId: "g", cardId: "c1" },
    { glueId: "g", cardId: "c2" },
  ]);
  await db.run(sql`CREATE TABLE service_history(input TEXT,generated TEXT,executions TEXT)`);
  const recovery = recoveryHandlers();
  const registry = createServiceActionRegistryV1(recovery.handlers);
  let next = 0;
  const allocate = vi.fn(() => `bound-${++next}`);
  const now = vi.fn(() => 1700000000);
  const complete = async (tx: Tx, group: Awaited<ReturnType<typeof runActionGroup>>) => {
    await tx.run(
      sql`INSERT INTO service_history VALUES(${JSON.stringify(group.invocation.input)},${JSON.stringify(group.generated)},${JSON.stringify(group.executions)})`,
    );
  };
  const run = (
    kind: string,
    input: unknown,
    generated?: ActionBindingMap,
    limits: ServiceContext = value,
    schemaVersion = 19,
  ) =>
    runActionGroup({
      db,
      registry,
      schemaVersion,
      invocation: { id: "root", kind, contractVersion: 1, input },
      bindings:
        generated === undefined
          ? createActionBindings({ mode: "record", allocateId: allocate, now })
          : createActionBindings({ mode: "replay", bindings: generated }),
      createContext: (actions, db) => ({ actions, db, value: limits }),
      complete,
    });
  const history = () =>
    db
      .select({
        input: sql<string>`input`,
        generated: sql<string>`generated`,
        executions: sql<string>`executions`,
      })
      .from(sql`service_history`);
  return { db, registry, run, complete, history, allocate, now, ...recovery };
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
    tables.warpTable,
    tables.taskspaceTable,
  ]) {
    result[getTableName(table)] = (await db.select().from(table)).sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    );
  }
  return result;
}
type ServiceKind = Exclude<SyncableActionKindV1, "system.compose">;
const namespace = { namespaceId: "n" };
const requests = {
  "system.repair": { args: {}, body: { target: "inventories" } },
  "cards.create": {
    args: namespace,
    body: { partitionId: "p", content: "  Created  ", posX: -12.5 },
  },
  "cards.update": {
    args: { ...namespace, cardId: "c1" },
    body: { content: "Edited", width: null },
  },
  "cards.updatePositions": {
    args: namespace,
    body: { positions: [{ cardId: "c1", posX: 17.5, posY: 22 }] },
  },
  "cards.remove": { args: namespace, body: { cardIds: ["c1"] } },
  "cards.removeOne": { args: { ...namespace, cardId: "c1" } },
  "cards.move": { args: namespace, body: { cardIds: ["c1", "c2"], targetNamespaceId: "other" } },
  "cards.setLayer": { args: namespace, body: { cardIds: ["c1"], layerId: "l" } },
  "cards.setPartition": { args: namespace, body: { cardIds: ["c1"], partitionId: "p" } },
  "cards.setStacking": { args: namespace, body: { cardIds: ["c1"], direction: "front" } },
  "cards.squash": { args: namespace, body: { cardId: "c1" } },
  "glues.create": { args: namespace, body: { cardIds: ["c1", "c2"] } },
  "glues.remove": { args: namespace, body: { cardIds: ["c1"] } },
  "layers.create": { args: namespace, body: { name: "  Created  " } },
  "layers.rename": { args: { ...namespace, layerId: "alt-l" }, body: { name: "Renamed" } },
  "layers.remove": { args: { ...namespace, layerId: "alt-l" } },
  "layers.reorder": { args: namespace, body: { layerIds: ["alt-l", "l"] } },
  "partitions.create": { args: namespace, body: { name: "Created" } },
  "partitions.rename": { args: { ...namespace, partitionId: "alt-p" }, body: { name: "Renamed" } },
  "partitions.remove": { args: { ...namespace, partitionId: "alt-p" } },
  "scopes.create": { args: namespace, body: { name: "Created" } },
  "scopes.rename": { args: { ...namespace, scopeId: "s" }, body: { name: "Renamed" } },
  "scopes.remove": { args: { ...namespace, scopeId: "s" } },
  "scopes.addMembers": { args: { ...namespace, scopeId: "s" }, body: { cardIds: ["c2"] } },
  "scopes.removeMembers": { args: { ...namespace, scopeId: "s" }, body: { cardIds: ["c1"] } },
  "scopes.createArea": {
    args: { ...namespace, scopeId: "s" },
    body: { posX: 20, posY: 30, width: 100, height: 100 },
  },
  "scopes.updateArea": {
    args: { ...namespace, scopeId: "s", areaId: "area" },
    body: { posX: 20, posY: 30, width: 100, height: 100 },
  },
  "scopes.removeArea": { args: { ...namespace, scopeId: "s", areaId: "area" } },
  "scopes.removeWorkspace": { args: { scopeId: "s" } },
  "warps.create": { args: namespace, body: { posX: 12, posY: 34 } },
  "warps.update": { args: { ...namespace, warpId: "w" }, body: { posX: 12, posY: 34 } },
  "warps.remove": { args: { ...namespace, warpId: "w" } },
  "inventories.create": { args: namespace, body: { name: "Created", posX: 12, posY: 34 } },
  "inventories.update": { args: { ...namespace, inventoryId: "i" }, body: { name: "Renamed" } },
  "inventories.remove": { args: { ...namespace, inventoryId: "i" } },
  "inventories.stow": { args: { ...namespace, inventoryId: "i" }, body: { cardIds: ["c2"] } },
  "inventories.take": { args: namespace, body: { cards: [{ cardId: "c3", posX: 12, posY: 34 }] } },
  "namespaces.create": { args: {}, body: { name: "Created" } },
  "namespaces.rename": { args: namespace, body: { name: "Renamed" } },
  "namespaces.remove": { args: namespace },
  "namespaces.setDefault": { args: { namespaceId: "other" } },
} satisfies { [K in ServiceKind]: ActionInputsV1[K] };

it("covers every syncable version 1 kind with real service handlers or system.compose", () => {
  const expected = Object.keys(actionContractsV1)
    .filter((kind) => actionContractsV1[kind as ActionKindV1] === "syncable")
    .sort();
  expect([...Object.keys(requests), "system.compose"].sort()).toEqual(expected);
});

it("refuses direct service registry dispatch through an unscoped transaction", async () => {
  const f = await fixture();
  const before = await snapshot(f.db);
  let raw!: Tx;
  await expect(
    runNamed(
      f,
      async (execution) => {
        await execution.context.db.run(sql`UPDATE card SET pos_x=123 WHERE id='c1'`);
        try {
          await f.registry.execute("cards.create", requests["cards.create"], {
            ...execution,
            context: { ...execution.context, db: raw },
          });
        } catch {
          /* The binding provider still identifies the failed owning scope. */
        }
      },
      async (tx) => {
        raw = tx;
      },
    ),
  ).rejects.toBeInstanceOf(ActionScopeRequiredError);
  expect(await snapshot(f.db)).toEqual(before);
  expect(f.allocate).not.toHaveBeenCalled();
  expect(f.now).not.toHaveBeenCalled();
});

it("latches a mismatched binding provider even if a named handler catches it", async () => {
  const f = await fixture();
  const before = await snapshot(f.db);
  await expect(
    runNamed(f, async (execution) => {
      await execution.context.db.run(sql`UPDATE card SET pos_x=123 WHERE id='c1'`);
      try {
        await f.registry.execute("cards.create", requests["cards.create"], {
          ...execution,
          bindings: createActionBindings({ mode: "record", allocateId: f.allocate, now: f.now }),
        });
      } catch {
        /* Scope identity failures remain latched. */
      }
    }),
  ).rejects.toBeInstanceOf(ActionScopeRequiredError);
  expect(await snapshot(f.db)).toEqual(before);
  expect(await f.history()).toEqual([]);
  expect(f.allocate).not.toHaveBeenCalled();
});

it.each(["routing", "mode"] as const)(
  "latches a caught registry %s failure inside a named handler",
  async (kind) => {
    const f = await fixture();
    const before = await snapshot(f.db);
    await expect(
      runNamed(f, async (execution) => {
        await execution.context.db.run(sql`UPDATE card SET pos_x=123 WHERE id='c1'`);
        try {
          if (kind === "routing")
            await f.registry.execute(
              "cards.update",
              { args: namespace, body: { content: "Changed" } },
              execution,
            );
          else await f.registry.replay("cards.create", requests["cards.create"], execution);
        } catch {
          /* Registry failures must not commit earlier SQL. */
        }
      }),
    ).rejects.toThrow(kind === "routing" ? "routing arguments" : "recorded bindings");
    expect(await snapshot(f.db)).toEqual(before);
    expect(await f.history()).toEqual([]);
  },
);

it("refuses retained execution contexts after their owning frame closes", async () => {
  const f = await fixture();
  const before = await snapshot(f.db);
  let retained!: Execution;
  await runNamed(f, async (execution) => {
    retained = execution;
  });
  await expect(
    f.registry.execute("cards.create", requests["cards.create"], retained),
  ).rejects.toThrow("does not own");
  expect(await snapshot(f.db)).toEqual(before);
  expect(f.allocate).not.toHaveBeenCalled();
  expect(await f.history()).toHaveLength(1);
});
it.each(Object.entries(requests))(
  "records and replays %s through real services and bound allocations",
  async (kind, input) => {
    const origin = await fixture();
    const before = await snapshot(origin.db);
    const recorded = await origin.run(kind, input);
    if (kind === "system.repair") {
      expect(await snapshot(origin.db)).toEqual(before);
      expect(recorded.result).toEqual({ moved: [], unglued: [], cleared: [] });
    } else expect(await snapshot(origin.db)).not.toEqual(before);
    expect(recorded.invocation.input).toEqual(input);
    expect(recorded.executions).toHaveLength(1);
    const target = await fixture();
    const replay = await target.run(kind, input, recorded.generated);
    expect(await snapshot(target.db)).toEqual(await snapshot(origin.db));
    expect(replay.result).toEqual(recorded.result);
    expect(replay.generated).toEqual(recorded.generated);
    expect(replay.invocation).toEqual(recorded.invocation);
    expect(JSON.parse((await target.history())[0].input)).toEqual(input);
    expect(target.allocate).not.toHaveBeenCalled();
    expect(target.now).not.toHaveBeenCalled();
    expect(target.recover).not.toHaveBeenCalled();
  },
);

it.each([
  "cards.create",
  "cards.update",
  "cards.updatePositions",
  "cards.remove",
  "cards.removeOne",
  "cards.move",
  "cards.setLayer",
  "cards.setPartition",
  "cards.setStacking",
  "cards.squash",
  "glues.create",
  "glues.remove",
  "layers.rename",
  "layers.remove",
  "layers.reorder",
  "partitions.rename",
  "partitions.remove",
  "scopes.addMembers",
  "scopes.removeMembers",
  "scopes.updateArea",
  "scopes.removeArea",
  "warps.update",
  "warps.remove",
  "inventories.update",
  "inventories.remove",
  "inventories.stow",
  "inventories.take",
] as const)("preserves namespace ownership when dispatching %s", async (kind) => {
  const f = await fixture();
  const before = await snapshot(f.db);
  const original = requests[kind];
  const input = { ...original, args: { ...original.args, namespaceId: "other" } };
  await expect(f.run(kind, input)).rejects.toBeInstanceOf(Error);
  expect(await snapshot(f.db)).toEqual(before);
  expect(await f.history()).toEqual([]);
});

it("keeps board scope removal distinct from workspace scope deletion", async () => {
  const board = await fixture();
  await board.run("scopes.remove", requests["scopes.remove"]);
  expect(await board.db.select().from(tables.scopeTable)).toMatchObject([{ id: "s" }]);
  expect(await board.db.select().from(tables.scopeAreaTable)).toMatchObject([
    { id: "other-area", namespaceId: "other" },
  ]);
  const workspace = await fixture();
  await workspace.run("scopes.removeWorkspace", requests["scopes.removeWorkspace"]);
  expect(await workspace.db.select().from(tables.scopeTable)).toEqual([]);
  expect(await workspace.db.select().from(tables.scopeAreaTable)).toEqual([]);
});

it("retains the unresolved caller envelope while services normalize and clamp values", async () => {
  const f = await fixture();
  const input = requests["cards.create"];
  const recorded = await f.run("cards.create", input);
  expect(recorded.result).toMatchObject({ content: "Created", posX: 0 });
  expect(recorded.invocation.input).toEqual(input);
  expect(JSON.parse((await f.history())[0].input)).toEqual(input);
});

const localRequests = {
  "taskspaces.create": { args: namespace, body: { name: "Taskspace", scopeId: "s" } },
  "taskspaces.rename": { args: { ...namespace, taskspaceId: "t" }, body: { name: "Renamed" } },
  "taskspaces.remove": { args: { ...namespace, taskspaceId: "t" } },
  "taskspaces.createFile": { args: { ...namespace, taskspaceId: "t" }, body: { path: "file.md" } },
  "taskspaces.saveFile": {
    args: { ...namespace, taskspaceId: "t" },
    body: { path: "file.md", content: "text", signature: null },
  },
  "taskspaces.createDirectory": {
    args: { ...namespace, taskspaceId: "t" },
    body: { path: "folder" },
  },
  "taskspaces.renameEntry": {
    args: { ...namespace, taskspaceId: "t" },
    body: { path: "file.md", name: "renamed.md" },
  },
  "taskspaces.removeEntry": { args: { ...namespace, taskspaceId: "t", path: "file.md" } },
} satisfies { [K in Exclude<ActionKindV1, SyncableActionKindV1>]: ActionInputsV1[K] };
it.each(Object.entries(localRequests))(
  "refuses %s during recording and replay without invoking host recovery",
  async (kind, input) => {
    const f = await fixture();
    const before = await snapshot(f.db);
    await expect(f.run(kind, input)).rejects.toThrow("local-only");
    await expect(f.run(kind, input, {})).rejects.toThrow("local-only");
    expect(await snapshot(f.db)).toEqual(before);
    expect(await f.history()).toEqual([]);
    expect(f.recover).not.toHaveBeenCalled();
  },
);

it("refuses missing, incorrectly classified and replacement local recovery registrations", () => {
  const incomplete: Partial<LocalRecoveryHandlersV1> = recoveryHandlers().handlers;
  Reflect.deleteProperty(incomplete, "taskspaces.saveFile");
  expect(() => createServiceActionRegistryV1(incomplete as LocalRecoveryHandlersV1)).toThrow(
    "Missing action handler: taskspaces.saveFile",
  );
  const handlers = recoveryHandlers().handlers;
  expect(() =>
    createServiceActionRegistryV1({
      ...handlers,
      "cards.create": { recover: vi.fn() },
    } as LocalRecoveryHandlersV1),
  ).toThrow("Unexpected local recovery handler: cards.create");
  const extra = { ...handlers, unexpected: { recover: vi.fn() } };
  expect(() => createServiceActionRegistryV1(extra)).toThrow(
    "Unexpected local recovery handler: unexpected",
  );
  const wrong = {
    ...handlers,
    "taskspaces.saveFile": { replay: vi.fn() },
  } as unknown as LocalRecoveryHandlersV1;
  expect(() => createServiceActionRegistryV1(wrong)).toThrow(
    "Missing action handler: taskspaces.saveFile",
  );
});

it("limits compatibility to the audited schema and rejects complete routing errors without writes", async () => {
  const f = await fixture();
  expect(f.registry.supportsSchema(19)).toBe(true);
  expect(f.registry.supportsSchema(20)).toBe(true);
  expect(f.registry.supportsSchema(21)).toBe(true);
  expect(f.registry.supportsSchema(22)).toBe(true);
  expect(f.registry.supportsSchema(23)).toBe(false);
  const before = await snapshot(f.db);
  await expect(
    f.run("cards.create", requests["cards.create"], undefined, value, 23),
  ).rejects.toMatchObject({ code: "action-contract-required" });
  await expect(
    f.run("cards.update", { args: namespace, body: { content: "Changed" } }),
  ).rejects.toThrow("routing arguments");
  expect(await snapshot(f.db)).toEqual(before);
  expect(await f.history()).toEqual([]);
});

it("validates content and resolves coordinates against the executing host's service limits", async () => {
  const origin = await fixture();
  const input = {
    args: namespace,
    body: { partitionId: "p", content: "x".repeat(101), posX: 1500, posY: 1200 },
  };
  const recorded = await origin.run("cards.create", input);
  const target = await fixture();
  const small = createServiceContext({ canvasWidth: 400, canvasHeight: 400 });
  const replay = await target.run("cards.create", input, recorded.generated, small);
  expect(recorded.result).toMatchObject({ id: "bound-1", posX: 1500, posY: 1200 });
  expect(replay.result).toMatchObject({ id: "bound-1", posX: 400, posY: 400 });
  expect(replay.invocation).toEqual(recorded.invocation);
  const strict = await fixture();
  const before = await snapshot(strict.db);
  await expect(
    strict.run(
      "cards.create",
      input,
      recorded.generated,
      createServiceContext({ contentMax: 100 }),
    ),
  ).rejects.toThrow();
  expect(await snapshot(strict.db)).toEqual(before);
  expect(await strict.history()).toEqual([]);
});

it("records real service compositions once and replays them inside a root savepoint", async () => {
  const origin = await fixture();
  const callback = vi.fn(async (access: CompositionAccess<{}>) => {
    const created = (await access.dispatch(
      ["create"],
      "cards.create",
      requests["cards.create"],
    )) as { id: string };
    await access.dispatch(["edit", created.id], "cards.update", {
      args: { ...namespace, cardId: created.id },
      body: { content: "Composed" },
    });
  });
  let next = 0;
  const recorded = await composeActions({
    db: origin.db,
    id: "composition",
    schemaVersion: 19,
    registry: origin.registry,
    value,
    readers: {},
    operation: callback,
    bindings: createActionBindings({
      mode: "record",
      allocateId: () => `composition-${++next}`,
      now: () => 1700000000,
    }),
    complete: origin.complete,
  });
  const target = await fixture();
  await withActionReplayTransaction(target.db, async (session) => {
    const replay = await replayComposition({
      session,
      schemaVersion: 19,
      registry: target.registry,
      value,
      invocation: recorded.invocation,
      generated: recorded.generated,
      complete: target.complete,
    });
    expect(replay.executions.map(({ kind }) => kind)).toEqual([
      "system.compose",
      "cards.create",
      "cards.update",
    ]);
  });
  expect(await snapshot(target.db)).toEqual(await snapshot(origin.db));
  expect(callback).toHaveBeenCalledOnce();
  expect(target.recover).not.toHaveBeenCalled();
});

it("rolls back earlier composition service writes and history after a later validation failure", async () => {
  const f = await fixture();
  const before = await snapshot(f.db);
  let next = 0;
  await expect(
    composeActions({
      db: f.db,
      id: "composition",
      schemaVersion: 19,
      registry: f.registry,
      value,
      readers: {},
      bindings: createActionBindings({
        mode: "record",
        allocateId: () => `composition-${++next}`,
        now: () => 1700000000,
      }),
      complete: f.complete,
      operation: async (access) => {
        await access.dispatch(["create"], "cards.create", requests["cards.create"]);
        try {
          await access.dispatch(["invalid"], "layers.create", {
            args: namespace,
            body: { name: "" },
          });
        } catch {
          /* The root still must roll back. */
        }
      },
    }),
  ).rejects.toThrow();
  expect(await snapshot(f.db)).toEqual(before);
  expect(await f.history()).toEqual([]);
});
