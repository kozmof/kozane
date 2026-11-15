import { expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createTestDB } from "../../test-utils/db.js";
import {
  captureApplicationRows,
  capturedTables,
  installCapturePrototype,
} from "../../test-utils/action-capture.js";
import type { DB, Tx } from "../../../../core/src/database.js";
import * as tables from "../../../../core/src/schema.js";
import { createServiceContext } from "../../../../core/src/services/context.js";
import * as cards from "../../../../core/src/services/cards.js";
import * as scopes from "../../../../core/src/services/scopes.js";
import {
  createActionBindings,
  type ActionBindingMap,
} from "../../../../core/src/actions/bindings.js";
import {
  composeActions,
  defineCompositionReader,
} from "../../../../core/src/actions/composition.js";
import { runActionGroup, type ActionFrameAccess } from "../../../../core/src/actions/execution.js";
import {
  defineActionRegistry,
  type ActionHandlerContext,
} from "../../../../core/src/actions/registry.js";
import {
  createServiceActionRegistryV1,
  type LocalRecoveryHandlersV1,
} from "../../../../core/src/actions/service-registry.js";
import { RowEncodingError } from "../../../../core/src/actions/row-codec.js";
import type { ActionInputsV1 } from "../../../../core/src/actions/contracts.js";
import { ProjectionError } from "../../../../core/src/actions/projection.js";
import { withActionReplayTransaction } from "../../../../core/src/actions/replay.js";

const value = createServiceContext();
const stamp = new Date(1600000000000);
type Context = { db: Tx; actions: ActionFrameAccess };
type Operation = (execution: ActionHandlerContext<Context>) => Promise<unknown>;
async function fixture() {
  // Both adapter configurations resolve the package-typed fixture to core source.
  const db = (await createTestDB()) as unknown as DB;
  await db.insert(tables.namespaceTable).values([
    { id: "n", name: "Main", isDefault: true },
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
  await db.insert(tables.scopeTable).values({ id: "s", name: "Scope" });
  await db.insert(tables.scopeAreaTable).values({
    id: "area",
    namespaceId: "n",
    scopeId: "s",
    posX: 0,
    posY: 0,
    width: 100,
    height: 100,
  });
  await db.insert(tables.taskspaceTable).values([
    {
      id: "placed",
      namespaceId: "n",
      scopeId: "s",
      name: "Placed",
      createdAt: stamp,
      updatedAt: stamp,
    },
    { id: "unplaced", scopeId: "s", name: "Unplaced", createdAt: stamp, updatedAt: stamp },
  ]);
  await db.insert(tables.inventoryTable).values({ id: "i", namespaceId: "n", name: "Box" });
  await db.insert(tables.cardTable).values([
    {
      id: "own",
      partitionId: "p",
      layerId: "l",
      taskspaceId: "placed",
      content: "\ufeffSeed\u0000🪁",
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: "foreign",
      partitionId: "other-p",
      layerId: "other-l",
      taskspaceId: "unplaced",
      content: "Foreign",
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: "stored",
      partitionId: "p",
      layerId: "l",
      content: "Stored",
      inventoryId: "i",
      inventorySlot: 0,
      createdAt: stamp,
      updatedAt: stamp,
    },
  ]);
  // Historical zero timestamps must survive unrelated action writes unchanged.
  await db
    .update(tables.cardTable)
    .set({ createdAt: new Date(0), updatedAt: new Date(0) })
    .where(eq(tables.cardTable.id, "stored"));
  await db.insert(tables.scopeRelTable).values({ scopeId: "s", cardId: "own" });
  await db.insert(tables.glueTable).values({ id: "g" });
  await db.insert(tables.glueRelTable).values([
    { glueId: "g", cardId: "own" },
    { glueId: "g", cardId: "foreign" },
  ]);
  const capture = await installCapturePrototype(db);
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
  let next = 0;
  const bindings = () =>
    createActionBindings({
      mode: "record",
      allocateId: () => `allocation-${++next}`,
      now: () => 1700000000,
    });
  const run = (runId: string, kind: string, input: unknown) =>
    runActionGroup({
      db,
      registry,
      schemaVersion: 19,
      invocation: { id: `${runId}-root`, kind, contractVersion: 1, input },
      bindings: bindings(),
      createContext: (actions, db) => ({ actions, db, value }),
      ...capture.hooks(runId),
    });
  const customOptions = (
    runId: string,
    operation: Operation,
    child: Operation = async () => "noop",
    generated?: ActionBindingMap,
  ) => {
    const registry = defineActionRegistry<{ named: unknown; child: unknown }, Context>({
      contractVersion: 1,
      schemaVersions: [19],
      definitions: {
        named: {
          eligibility: "syncable",
          prepare: (input) => input,
          replay: (_input, execution) => operation(execution),
        },
        child: {
          eligibility: "syncable",
          prepare: (input) => input,
          replay: (_input, execution) => child(execution),
        },
      },
    });
    return {
      registry,
      schemaVersion: 19,
      invocation: { id: `${runId}-root`, kind: "named", contractVersion: 1, input: {} },
      bindings:
        generated === undefined
          ? bindings()
          : createActionBindings({ mode: "replay", bindings: generated }),
      createContext: (actions: ActionFrameAccess, db: Tx) => ({ actions, db }),
      ...capture.hooks(runId),
    };
  };
  const custom = (runId: string, operation: Operation, child?: Operation) =>
    runActionGroup({ db, ...customOptions(runId, operation, child) });
  return { db, capture, registry, bindings, run, custom, customOptions, recover };
}
const emptyMarker = [{ runId: null, actionId: null, executionOrd: null, nextEffectOrd: 0 }];

it("reconstructs all application tables from real service composition effects and finalized invocations", async () => {
  const f = await fixture();
  const defaults = defineCompositionReader({
    prepare: (input: unknown) => input as { namespaceId: string },
    read: async (db, input) => {
      const [partition] = await db
        .select({ id: tables.partitionTable.id })
        .from(tables.partitionTable)
        .where(eq(tables.partitionTable.namespaceId, input.namespaceId));
      const [layer] = await db
        .select({ id: tables.layerTable.id })
        .from(tables.layerTable)
        .where(eq(tables.layerTable.namespaceId, input.namespaceId));
      return { partitionId: partition.id, layerId: layer.id };
    },
  });
  const group = await composeActions({
    db: f.db,
    registry: f.registry,
    schemaVersion: 19,
    id: "composition",
    value,
    readers: { defaults },
    bindings: f.bindings(),
    ...f.capture.hooks("composition-run"),
    operation: async (access) => {
      const namespace = (await access.dispatch(["namespace"], "namespaces.create", {
        args: {},
        body: { name: "Created" },
      })) as { id: string };
      const args = { namespaceId: namespace.id };
      const placement = await access.read("defaults", args);
      const scope = (await access.dispatch(["scope"], "scopes.create", {
        args,
        body: { name: "Created scope" },
      })) as { id: string };
      await access.dispatch(["area"], "scopes.createArea", {
        args: { ...args, scopeId: scope.id },
        body: { posX: 1, posY: 2, width: 100, height: 100 },
      });
      await access.dispatch(["warp"], "warps.create", { args, body: { posX: 12, posY: 34 } });
      const inventory = (await access.dispatch(["inventory"], "inventories.create", {
        args,
        body: { name: "Created box", posX: 1, posY: 2 },
      })) as { id: string };
      const first = (await access.dispatch(["first"], "cards.create", {
        args,
        body: { ...placement, content: "One\u0000🪁", scopeId: scope.id },
      })) as { id: string };
      const second = (await access.dispatch(["second"], "cards.create", {
        args,
        body: { ...placement, content: "Two" },
      })) as { id: string };
      await access.dispatch(["glue"], "glues.create", {
        args,
        body: { cardIds: [first.id, second.id] },
      });
      await access.dispatch(["member"], "scopes.addMembers", {
        args: { ...args, scopeId: scope.id },
        body: { cardIds: [second.id] },
      });
      await access.dispatch(["duplicate-member"], "scopes.addMembers", {
        args: { ...args, scopeId: scope.id },
        body: { cardIds: [second.id] },
      });
      await access.dispatch(["store"], "inventories.stow", {
        args: { ...args, inventoryId: inventory.id },
        body: { cardIds: [first.id] },
      });
      await access.dispatch(["remove-seed-scope"], "scopes.removeWorkspace", {
        args: { scopeId: "s" },
      });
    },
  });
  const effects = await f.capture.effects("composition-run");
  expect([...new Set(effects.map(({ table }) => table))].sort()).toEqual(
    capturedTables.map(({ name }) => name),
  );
  expect(effects.map(({ ord }) => ord)).toEqual(effects.map((_effect, index) => index));
  expect(effects.every(({ executionOrd }) => executionOrd > 0)).toBe(true);
  const entries = await f.capture.executions("composition-run");
  expect(entries.map(({ id, executionOrd }) => ({ id, executionOrd }))).toEqual(
    group.executions.map(({ id, executionOrd }) => ({ id, executionOrd })),
  );
  const duplicate = (group.invocation.input as ActionInputsV1["system.compose"]).body.children.find(
    ({ path }) => path[0] === "duplicate-member",
  )!;
  expect(entries).toHaveLength(group.executions.length);
  expect(entries.some(({ id }) => id === duplicate.id)).toBe(true);
  expect(effects.some(({ actionId }) => actionId === duplicate.id)).toBe(false);
  expect(JSON.parse(entries[0].input)).toEqual(group.invocation.input);
  expect(JSON.parse((await f.capture.runs())[0].invocation!)).toEqual(group.invocation);
  expect(await f.capture.marker()).toEqual(emptyMarker);
  await f.capture.verify();
  expect(f.recover).not.toHaveBeenCalled();
});

it("captures inventory deletion before FK and business-trigger intermediate card images", async () => {
  const f = await fixture();
  await f.run("remove-inventory", "inventories.remove", {
    args: { namespaceId: "n", inventoryId: "i" },
  });
  const effects = await f.capture.effects("remove-inventory");
  expect(effects[0]).toMatchObject({ table: "inventory", op: "D", key: { id: ["text", "i"] } });
  const cards = effects.filter(({ table }) => table === "card");
  expect(cards[0].before).toMatchObject({
    inventory_id: ["text", "i"],
    inventory_slot: ["integer", "0"],
  });
  expect(cards[0].after).toMatchObject({
    inventory_id: ["null"],
    inventory_slot: ["integer", "0"],
  });
  expect(cards[1].before).toEqual(cards[0].after);
  expect(cards[1].after).toMatchObject({ inventory_id: ["null"], inventory_slot: ["null"] });
  expect(
    cards.every(
      ({ before, after }) => before?.created_at[1] === "0" && after?.updated_at[1] === "0",
    ),
  ).toBe(true);
  await f.capture.verify();
});

it("captures namespace cascades, orphan glue cleanup and default replacement in one reconstructable group", async () => {
  const f = await fixture();
  await f.run("remove-namespace", "namespaces.remove", { args: { namespaceId: "n" } });
  const effects = await f.capture.effects("remove-namespace");
  expect(effects[0]).toMatchObject({ table: "namespace", op: "D", key: { id: ["text", "n"] } });
  for (const table of [
    "partition",
    "layer",
    "taskspace",
    "card",
    "scope_area",
    "glue",
    "glue_rel",
    "scope_rel",
  ])
    expect(effects.some((effect) => effect.table === table && effect.op === "D")).toBe(true);
  expect(
    effects.some(
      (effect) =>
        effect.table === "namespace" && effect.op === "U" && effect.after?.id[1] === "other",
    ),
  ).toBe(true);
  expect(await f.db.select().from(tables.glueTable)).toEqual([]);
  expect(await f.capture.marker()).toEqual(emptyMarker);
  await f.capture.verify();
});

it("restores parent attribution after child SQL and keeps separate execution and effect counters", async () => {
  const f = await fixture();
  const group = await f.custom(
    "nested",
    async ({ context }) => {
      await cards.updatePositionsInTx(context.db, value, "n", {
        positions: [{ cardId: "own", posX: 1, posY: 2 }],
      });
      await context.actions.child(["rename"], "child", {});
      await cards.updatePositionsInTx(context.db, value, "n", {
        positions: [{ cardId: "own", posX: 3, posY: 4 }],
      });
    },
    async ({ context }) => scopes.renameInTx(context.db, value, "n", "s", { name: "Renamed" }),
  );
  const effects = await f.capture.effects("nested");
  expect(effects.map(({ actionId }) => actionId)).toEqual([
    group.executions[0].id,
    group.executions[1].id,
    group.executions[0].id,
  ]);
  expect(effects.map(({ ord, executionOrd }) => ({ ord, executionOrd }))).toEqual([
    { ord: 0, executionOrd: 0 },
    { ord: 1, executionOrd: 1 },
    { ord: 2, executionOrd: 0 },
  ]);
  await f.capture.verify();
});

it("retains no-op child executions without inventing effects", async () => {
  const f = await fixture();
  await f.custom("noop", async ({ context }) => context.actions.child(["noop"], "child", {}));
  expect(await f.capture.effects("noop")).toEqual([]);
  expect(await f.capture.executions("noop")).toHaveLength(2);
  expect(await f.capture.marker()).toEqual(emptyMarker);
});

it("rejects corrupt before images without changing earlier capture history or poisoning later groups", async () => {
  const f = await fixture();
  await f.run("first", "namespaces.rename", {
    args: { namespaceId: "n" },
    body: { name: "First" },
  });
  const history = {
    effects: await f.capture.effects("first"),
    executions: await f.capture.executions("first"),
    runs: await f.capture.runs(),
  };
  const before = await captureApplicationRows(f.db);
  const options = f.customOptions("corrupt", async ({ context }) => {
    await cards.updatePositionsInTx(context.db, value, "n", {
      positions: [{ cardId: "own", posX: 123, posY: 456 }],
    });
  });
  await expect(
    runActionGroup({
      db: f.db,
      ...options,
      complete: async (tx, group) => {
        await tx.run(
          sql`UPDATE capture_effect SET before_image=after_image WHERE run_id='corrupt'`,
        );
        await options.complete(tx, group);
      },
    }),
  ).rejects.toBeInstanceOf(ProjectionError);
  expect(await captureApplicationRows(f.db)).toEqual(before);
  expect(await f.capture.runs()).toEqual(history.runs);
  expect(await f.capture.marker()).toEqual(emptyMarker);
  await f.run("later", "namespaces.rename", {
    args: { namespaceId: "n" },
    body: { name: "Later" },
  });
  expect(await f.capture.effects("first")).toEqual(history.effects);
  expect(await f.capture.executions("first")).toEqual(history.executions);
  expect((await f.capture.runs())[0]).toEqual(history.runs[0]);
  await f.capture.verify();
});

it.each([
  sql`INSERT INTO warp VALUES('raw','n',0,0)`,
  sql`UPDATE card SET pos_x=123 WHERE id='own'`,
  sql`DELETE FROM scope_rel WHERE scope_id='s' AND card_id='own'`,
])("refuses unstamped raw writes on actual application tables", async (statement) => {
  const f = await fixture();
  await expect(f.db.run(statement)).rejects.toBeInstanceOf(Error);
  expect(await captureApplicationRows(f.db)).toEqual(f.capture.baseline);
  expect(await f.capture.runs()).toEqual([]);
});

it.each([
  sql`UPDATE card SET id='changed' WHERE id='own'`,
  sql`UPDATE scope_rel SET scope_id='missing' WHERE scope_id='s' AND card_id='own'`,
])("refuses raw primary-key changes including composite keys", async (statement) => {
  const f = await fixture();
  await expect(
    f.custom("keys", async ({ context }) => {
      try {
        await context.db.run(statement);
      } catch {
        /* SQL failure remains latched. */
      }
    }),
  ).rejects.toBeInstanceOf(Error);
  expect(await captureApplicationRows(f.db)).toEqual(f.capture.baseline);
  expect(await f.capture.runs()).toEqual([]);
});

it("refuses phantom capture from INSERT OR IGNORE before the group can commit", async () => {
  const f = await fixture();
  await expect(
    f.custom("ignored", async ({ context }) =>
      context.db.run(
        sql`INSERT OR IGNORE INTO warp(id,namespace_id,pos_x,pos_y) VALUES('first','n',0,0),('first','n',1,1)`,
      ),
    ),
  ).rejects.toBeInstanceOf(ProjectionError);
  expect(await captureApplicationRows(f.db)).toEqual(f.capture.baseline);
  expect(await f.capture.runs()).toEqual([]);
});

it("rolls back the whole group when a real service failure is caught after earlier writes", async () => {
  const f = await fixture();
  await expect(
    f.custom("caught", async ({ context }) => {
      await cards.updatePositionsInTx(context.db, value, "n", {
        positions: [{ cardId: "own", posX: 12, posY: 34 }],
      });
      try {
        await scopes.createInTx(context.db, value, { name: "" });
      } catch {
        /* The service frame owns the failure. */
      }
    }),
  ).rejects.toBeInstanceOf(Error);
  expect(await captureApplicationRows(f.db)).toEqual(f.capture.baseline);
  expect(await f.capture.runs()).toEqual([]);
  expect(await f.capture.effects("caught")).toEqual([]);
  expect(await f.capture.marker()).toEqual(emptyMarker);
});

it("refuses unsupported UTF-8 introduced by an AFTER business trigger atomically", async () => {
  const f = await fixture();
  await f.db.run(
    sql`CREATE TRIGGER unsupported_text AFTER INSERT ON card WHEN NEW.content='bad' BEGIN UPDATE card SET content=CAST(X'80' AS TEXT) WHERE id=NEW.id; END`,
  );
  await expect(
    f.run("utf8", "cards.create", {
      args: { namespaceId: "n" },
      body: { partitionId: "p", content: "bad" },
    }),
  ).rejects.toBeInstanceOf(RowEncodingError);
  expect(await captureApplicationRows(f.db)).toEqual(f.capture.baseline);
  expect(await f.capture.runs()).toEqual([]);
  expect(await f.capture.marker()).toEqual(emptyMarker);
});

it("discards effects, executions and markers after a deferred commit failure", async () => {
  const f = await fixture();
  await f.db.run(
    sql`CREATE TABLE deferred_failure(namespace_id TEXT REFERENCES namespace(id) DEFERRABLE INITIALLY DEFERRED)`,
  );
  await expect(
    f.custom("commit", async ({ context }) => {
      await context.db.run(sql`INSERT INTO warp VALUES('uncommitted','n',0,0)`);
      await context.db.run(sql`INSERT INTO deferred_failure VALUES('missing')`);
    }),
  ).rejects.toBeInstanceOf(Error);
  expect(await captureApplicationRows(f.db)).toEqual(f.capture.baseline);
  expect(await f.capture.runs()).toEqual([]);
  expect(await f.capture.effects("commit")).toEqual([]);
  expect(await f.capture.marker()).toEqual(emptyMarker);
  await f.run("after-commit-failure", "warps.create", {
    args: { namespaceId: "n" },
    body: { posX: 1, posY: 2 },
  });
  await f.capture.verify();
});

it("isolates a failed replay before recording an independent root with a fresh capture context", async () => {
  const f = await fixture();
  await withActionReplayTransaction(f.db, async (session) => {
    await expect(
      session.replay(
        f.customOptions(
          "failed",
          async ({ context }) => {
            await context.db.run(sql`UPDATE card SET pos_x=123 WHERE id='own'`);
            throw new Error("replay failed");
          },
          undefined,
          {},
        ),
      ),
    ).rejects.toThrow("replay failed");
    await session.replay({
      registry: f.registry,
      schemaVersion: 19,
      invocation: {
        id: "accepted-root",
        kind: "namespaces.rename",
        contractVersion: 1,
        input: { args: { namespaceId: "n" }, body: { name: "Replayed" } },
      },
      bindings: createActionBindings({ mode: "replay", bindings: {} }),
      createContext: (actions, db) => ({ actions, db, value }),
      ...f.capture.hooks("accepted"),
    });
  });
  expect(await f.capture.runs()).toHaveLength(1);
  expect(await f.capture.effects("failed")).toEqual([]);
  expect(await f.capture.marker()).toEqual(emptyMarker);
  await f.capture.verify();
});
