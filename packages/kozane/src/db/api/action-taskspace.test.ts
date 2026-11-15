import { expect, it, vi } from "vitest";
import { createTestDB } from "../../test-utils/db.js";
import {
  captureApplicationRows,
  installCapturePrototype,
} from "../../test-utils/action-capture.js";
import type { DB, Tx } from "../../../../core/src/database.js";
import * as schema from "../../../../core/src/schema.js";
import * as taskspaces from "../../../../core/src/api/taskspace.js";
import { runActionGroup, type ActionFrameAccess } from "../../../../core/src/actions/execution.js";
import { defineActionRegistry, type ActionHandler } from "../../../../core/src/actions/registry.js";
import {
  ActionBindingError,
  createActionBindings,
  type ActionBindingMap,
} from "../../../../core/src/actions/bindings.js";
import { NAME_MAX } from "../../../../core/src/constants/index.js";

type Input = Record<string, unknown>;
type Context = { db: Tx; actions: ActionFrameAccess };
const stamp = new Date(1600000000000);
function hasDefault(column: {
  readonly defaultFn?: unknown;
}): column is { defaultFn: () => unknown } {
  return typeof column.defaultFn === "function";
}
async function fixture(handler: ActionHandler<Input, Context>) {
  const db = (await createTestDB()) as unknown as DB;
  await db.insert(schema.namespaceTable).values({ id: "n", name: "Main" });
  await db.insert(schema.scopeTable).values({ id: "s", name: "Scope" });
  await db.insert(schema.taskspaceTable).values({
    id: "seed",
    namespaceId: "n",
    scopeId: "s",
    name: "Before",
    path: "original",
    pathKind: "workspace_relative",
    lastSeenAt: stamp,
    createdAt: stamp,
    updatedAt: stamp,
  });
  const capture = await installCapturePrototype(db);
  const registry = defineActionRegistry<{ root: Input }, Context>({
    contractVersion: 1,
    schemaVersions: [19],
    definitions: {
      root: { eligibility: "syncable", prepare: (input) => input as Input, replay: handler },
    },
  });
  const allocateId = vi.fn(() => "taskspace-id");
  const now = vi.fn(() => 1700000000);
  let nextRun = 0;
  const run = (input: Input = {}, generated?: ActionBindingMap) =>
    runActionGroup({
      db,
      registry,
      schemaVersion: 19,
      invocation: { id: "root", kind: "root", contractVersion: 1, input },
      bindings:
        generated === undefined
          ? createActionBindings({ mode: "record", allocateId, now })
          : createActionBindings({ mode: "replay", bindings: generated }),
      createContext: (actions, db) => ({ actions, db }),
      ...capture.hooks(`run-${++nextRun}`),
    });
  const row = () => taskspaces.getTaskspace({ db, taskspaceId: "seed" });
  return { db, capture, run, row, allocateId, now };
}
const createDatabase = async () => (await createTestDB()) as unknown as DB;

it("binds taskspace identity and one shared creation timestamp and reuses both during replay", async () => {
  const f = await fixture((_input, { context }) =>
    taskspaces.addTaskspaceInTx({
      db: context.db,
      namespaceId: "n",
      scopeId: "s",
      name: "Created",
    }),
  );
  const origin = await f.run();
  expect(origin.result).toBe("taskspace-id");
  const created = await taskspaces.getTaskspace({ db: f.db, taskspaceId: "taskspace-id" });
  expect(created).toMatchObject({
    id: "taskspace-id",
    name: "Created",
    path: null,
    lastSeenAt: null,
    createdAt: new Date(1700000000000),
    updatedAt: new Date(1700000000000),
  });
  expect(
    Object.values(origin.generated)
      .map(({ type }) => type)
      .sort(),
  ).toEqual(["clock", "entity-id"]);
  await f.capture.restore(createDatabase, []);
  const defaults = [
    schema.taskspaceTable.id,
    schema.taskspaceTable.createdAt,
    schema.taskspaceTable.updatedAt,
  ].map((column) => {
    if (!hasDefault(column)) throw new Error("Expected an ORM default");
    return vi.spyOn(column, "defaultFn").mockImplementation(() => {
      throw new Error("Unbound default");
    });
  });
  try {
    const replay = await f.run({}, origin.generated);
    expect(replay.generated).toEqual(origin.generated);
    expect(await taskspaces.getTaskspace({ db: f.db, taskspaceId: "taskspace-id" })).toEqual(
      created,
    );
    expect(f.allocateId).toHaveBeenCalledOnce();
    expect(f.now).toHaveBeenCalledOnce();
    for (const fallback of defaults) expect(fallback).not.toHaveBeenCalled();
  } finally {
    for (const fallback of defaults) fallback.mockRestore();
  }
  await f.capture.verify();
});

it("edits only the label with a recorded clock while preserving creation and local observation fields", async () => {
  const f = await fixture((_input, { context }) =>
    taskspaces.updateTaskspaceNameInTx({ db: context.db, taskspaceId: "seed", name: "After" }),
  );
  const before = (await f.row())!;
  const origin = await f.run();
  expect(await f.row()).toEqual({ ...before, name: "After", updatedAt: new Date(1700000000000) });
  expect(Object.values(origin.generated)).toEqual([{ type: "clock", value: 1700000000 }]);
  await f.capture.restore(createDatabase, []);
  await f.run({}, origin.generated);
  expect(await f.row()).toEqual({ ...before, name: "After", updatedAt: new Date(1700000000000) });
  expect(f.now).toHaveBeenCalledOnce();
  expect(f.allocateId).not.toHaveBeenCalled();
});

it("binds unchanged-label requests for a changed replay branch while preserving the original timestamp", async () => {
  const f = await fixture((input, { context }) =>
    taskspaces.updateTaskspaceNameInTx({
      db: context.db,
      taskspaceId: "seed",
      name: input.name as string,
    }),
  );
  const origin = await f.run({ name: "Before" });
  expect((await f.row())!.updatedAt).toEqual(stamp);
  f.now.mockReturnValue(1800000000);
  await f.run({ name: "Other" });
  await f.run({ name: "Before" }, origin.generated);
  expect((await f.row())!.name).toBe("Before");
  expect((await f.row())!.updatedAt).toEqual(new Date(1700000000000));
  expect(origin.invocation.input).toEqual({ name: "Before" });
  expect(f.now).toHaveBeenCalledTimes(2);
  await f.capture.verify();
});

it("updates local location and observation fields without allocating a clock or changing either shared timestamp", async () => {
  const f = await fixture((_input, { context }) =>
    taskspaces.updateTaskspaceLocationInTx({
      db: context.db,
      taskspaceId: "seed",
      path: "/local/next",
      pathKind: "absolute",
      lastSeenAt: new Date(1800000000000),
    }),
  );
  const before = (await f.row())!;
  const group = await f.run();
  expect(await f.row()).toEqual({
    ...before,
    path: "/local/next",
    pathKind: "absolute",
    lastSeenAt: new Date(1800000000000),
  });
  expect(group.generated).toEqual({});
  expect(f.now).not.toHaveBeenCalled();
  expect(f.allocateId).not.toHaveBeenCalled();
});

it("keeps the legacy combined update atomic and binds only its label clock", async () => {
  const f = await fixture((_input, { context }) =>
    taskspaces.updateTaskspace({
      db: context.db,
      taskspaceId: "seed",
      name: "After",
      path: "next",
      lastSeenAt: new Date(1800000000000),
    }),
  );
  const group = await f.run();
  expect(await f.row()).toMatchObject({
    name: "After",
    path: "next",
    updatedAt: new Date(1700000000000),
    lastSeenAt: new Date(1800000000000),
  });
  expect(await f.capture.effects("run-1")).toHaveLength(1);
  expect(Object.values(group.generated)).toEqual([{ type: "clock", value: 1700000000 }]);
});

it.each([
  (_input: Input, { context }: Parameters<ActionHandler<Input, Context>>[1]) =>
    taskspaces.addTaskspaceInTx({ db: context.db, name: "New" }),
  (_input: Input, { context }: Parameters<ActionHandler<Input, Context>>[1]) =>
    taskspaces.updateTaskspaceNameInTx({ db: context.db, taskspaceId: "seed", name: "New" }),
])(
  "refuses unbound taskspace replay allocations before committing any row changes",
  async (handler) => {
    const f = await fixture(handler);
    await expect(f.run({}, {})).rejects.toBeInstanceOf(ActionBindingError);
    expect(await captureApplicationRows(f.db)).toEqual(f.capture.baseline);
    expect(await f.capture.runs()).toEqual([]);
  },
);

it.each([
  (db: Tx) => taskspaces.addTaskspaceInTx({ db, name: "x".repeat(NAME_MAX + 1) }),
  (db: Tx) =>
    taskspaces.updateTaskspaceNameInTx({ db, taskspaceId: "seed", name: "x".repeat(NAME_MAX + 1) }),
  (db: Tx) => taskspaces.deleteTaskspaceInTx({ db, taskspaceId: "missing" }),
  (db: Tx) => taskspaces.updateTaskspaceLocationInTx({ db, taskspaceId: "missing", path: "next" }),
])(
  "latches caught taskspace record failures after an earlier successful write",
  async (operation) => {
    const f = await fixture(async (_input, { context }) => {
      await taskspaces.updateTaskspaceNameInTx({
        db: context.db,
        taskspaceId: "seed",
        name: "After",
      });
      try {
        await operation(context.db);
      } catch {
        /* The record frame owns this failure. */
      }
    });
    await expect(f.run()).rejects.toBeInstanceOf(Error);
    expect(await captureApplicationRows(f.db)).toEqual(f.capture.baseline);
    expect(await f.capture.runs()).toEqual([]);
  },
);

it("rejects an unrepresentable taskspace clock even if the handler catches it", async () => {
  const f = await fixture(async (_input, { context }) => {
    try {
      await taskspaces.addTaskspaceInTx({ db: context.db, name: "New" });
    } catch {
      /* Allocation failure is latched. */
    }
  });
  f.now.mockReturnValue(Number.MAX_SAFE_INTEGER);
  await expect(f.run()).rejects.toBeInstanceOf(ActionBindingError);
  expect(await captureApplicationRows(f.db)).toEqual(f.capture.baseline);
});

it("preserves a valid recorded Unix epoch for taskspace creation", async () => {
  const f = await fixture((_input, { context }) =>
    taskspaces.addTaskspaceInTx({ db: context.db, name: "Epoch" }),
  );
  f.now.mockReturnValue(0);
  await f.run();
  expect(await taskspaces.getTaskspace({ db: f.db, taskspaceId: "taskspace-id" })).toMatchObject({
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
});

it("retains zero-effect empty updates and checks that their taskspace exists", async () => {
  const f = await fixture((input, { context }) =>
    taskspaces.updateTaskspaceLocationInTx({ db: context.db, taskspaceId: input.id as string }),
  );
  await f.run({ id: "seed" });
  expect(await f.capture.effects("run-1")).toEqual([]);
  expect(f.now).not.toHaveBeenCalled();
  await expect(f.run({ id: "missing" })).rejects.toBeInstanceOf(Error);
  expect(await f.capture.runs()).toHaveLength(1);
});

it("deletes taskspaces inside the owning root and rolls back a later failure", async () => {
  const f = await fixture(async (_input, { context }) => {
    await taskspaces.deleteTaskspaceInTx({ db: context.db, taskspaceId: "seed" });
    throw new Error("later failure");
  });
  await expect(f.run()).rejects.toThrow("later failure");
  expect(await captureApplicationRows(f.db)).toEqual(f.capture.baseline);
});
