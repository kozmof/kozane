import { expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { layers, createServiceContext } from "../../../../core/src/services.js";
import { layerTable } from "../../../../core/src/schema.js";
import { createNamespace } from "../../../../core/src/api/namespace.js";
import { createTestDB } from "../../test-utils/db.js";
import type { DB, Tx } from "../../../../core/src/database.js";
import {
  createActionBindings,
  type ActionBindingMap,
} from "../../../../core/src/actions/bindings.js";
import { runActionGroup, type ActionFrameAccess } from "../../../../core/src/actions/execution.js";
import { defineActionRegistry, type ActionHandler } from "../../../../core/src/actions/registry.js";

type Inputs = {
  root: { value?: number };
  write: { id: string; value: number };
  noop: { label: string };
  nested: { id: string };
  file: { path: string };
};
interface Context {
  db: Tx;
  actions: ActionFrameAccess;
  undoSavepoint(): Promise<void>;
}
type Handlers = { [K in keyof Inputs]: ActionHandler<Inputs[K], Context> };
const prepare = <T>(input: unknown) => input as T;
async function fixture(
  handlers: Partial<Handlers> = {},
  completionFailure?: Error,
  afterComplete?: (tx: Tx) => Promise<void>,
) {
  // Both Vitest configs resolve the package-typed fixture to the core source adapter.
  const db = (await createTestDB()) as unknown as DB;
  await db.run(sql`CREATE TABLE execution_value (id TEXT PRIMARY KEY,value INTEGER)`);
  await db.run(sql`CREATE TABLE execution_marker (singleton INTEGER PRIMARY KEY,action_id TEXT)`);
  await db.run(sql`INSERT INTO execution_marker VALUES(1,NULL)`);
  await db.run(
    sql`CREATE TABLE execution_entry (action_id TEXT,parent_id TEXT,kind TEXT,ord INTEGER,input TEXT)`,
  );
  await db.run(sql`CREATE TABLE execution_group(root_id TEXT,generated TEXT,executions TEXT)`);
  let raw: Tx;
  const registry = defineActionRegistry<Inputs, Context>({
    contractVersion: 1,
    schemaVersions: [19],
    definitions: {
      root: {
        eligibility: "syncable",
        prepare: prepare<Inputs["root"]>,
        replay: handlers.root ?? (async () => "root"),
      },
      write: {
        eligibility: "syncable",
        prepare: prepare<Inputs["write"]>,
        replay:
          handlers.write ??
          (async (input, { context }) => {
            await context.db.run(
              sql`INSERT INTO execution_value VALUES(${input.id},${input.value})`,
            );
            return input.id;
          }),
      },
      noop: {
        eligibility: "syncable",
        prepare: prepare<Inputs["noop"]>,
        replay: handlers.noop ?? (async (input) => input.label),
      },
      nested: {
        eligibility: "syncable",
        prepare: prepare<Inputs["nested"]>,
        replay:
          handlers.nested ??
          (async (input, { context }) =>
            context.actions.child([input.id], "write", { id: input.id, value: 1 })),
      },
      file: {
        eligibility: "local-only",
        prepare: prepare<Inputs["file"]>,
        recover:
          handlers.file ??
          (async () => {
            throw new Error("File recovery must be explicit");
          }),
      },
    },
  });
  const execute = (
    mode: "record" | "replay" = "record",
    generated: ActionBindingMap = {},
    input: Inputs["root"] = {},
    contractVersion = 1,
  ) => {
    let next = 0;
    return runActionGroup({
      db,
      schemaVersion: 19,
      registry,
      invocation: { id: "root-id", kind: "root", contractVersion, input },
      bindings:
        mode === "record"
          ? createActionBindings({ mode, allocateId: () => `allocated-${++next}`, now: () => 123 })
          : createActionBindings({ mode, bindings: generated }),
      createContext: (actions, handle) => ({
        db: handle,
        actions,
        undoSavepoint: async () => {
          await raw.run(sql`ROLLBACK TO child_work`);
          await raw.run(sql`RELEASE child_work`);
        },
      }),
      enter: async (tx, entry) => {
        raw = tx;
        await tx.run(
          sql`INSERT INTO execution_entry VALUES(${entry.id},${entry.parentId},${entry.kind},${entry.executionOrd},${JSON.stringify(entry.input)})`,
        );
        await tx.run(sql`UPDATE execution_marker SET action_id=${entry.id}`);
      },
      leave: async (tx, _id, parentId) => {
        await tx.run(sql`UPDATE execution_marker SET action_id=${parentId}`);
      },
      complete: async (tx, group) => {
        await tx.run(
          sql`INSERT INTO execution_group VALUES(${group.invocation.id},${JSON.stringify(group.generated)},${JSON.stringify(group.executions)})`,
        );
        if (completionFailure) throw completionFailure;
        await afterComplete?.(tx);
      },
    });
  };
  return { db, execute };
}
async function stored(f: Awaited<ReturnType<typeof fixture>>) {
  // Mapped selects keep the test independent of raw driver row shapes.
  return f.db
    .select({ id: sql<string>`id`, value: sql<number>`value` })
    .from(sql`execution_value`)
    .orderBy(sql`id`);
}
async function audit(f: Awaited<ReturnType<typeof fixture>>) {
  return f.db
    .select({
      id: sql<string>`action_id`,
      parentId: sql<string | null>`parent_id`,
      kind: sql<string>`kind`,
      ord: sql<number>`ord`,
    })
    .from(sql`execution_entry`)
    .orderBy(sql`ord`);
}
async function marker(f: Awaited<ReturnType<typeof fixture>>) {
  return f.db.select({ id: sql<string | null>`action_id` }).from(sql`execution_marker`);
}

it("attributes nested and effect-free children in handler-entry order", async () => {
  const f = await fixture({
    root: async (_input, { context }) => {
      await context.actions.child(["audit-only"], "noop", { label: "none" });
      await context.actions.child(["entity-a"], "nested", { id: "a" });
      await context.actions.child(["entity-b"], "write", { id: "b", value: 2 });
    },
  });
  const output = await f.execute();
  expect(
    output.executions.map(({ kind, executionOrd, parentId }) => ({ kind, executionOrd, parentId })),
  ).toEqual([
    { kind: "root", executionOrd: 0, parentId: null },
    { kind: "noop", executionOrd: 1, parentId: "root-id" },
    { kind: "nested", executionOrd: 2, parentId: "root-id" },
    { kind: "write", executionOrd: 3, parentId: "allocated-2" },
    { kind: "write", executionOrd: 4, parentId: "root-id" },
  ]);
  expect((await audit(f)).map(({ kind, ord }) => [kind, ord])).toEqual([
    ["root", 0],
    ["noop", 1],
    ["nested", 2],
    ["write", 3],
    ["write", 4],
  ]);
  expect(await stored(f)).toEqual([
    { id: "a", value: 1 },
    { id: "b", value: 2 },
  ]);
  expect(await marker(f)).toEqual([{ id: null }]);
});

it("rolls back a root even if its handler catches a child failure and undoes its savepoint", async () => {
  const failure = new Error("child failed");
  let shouldFail = true;
  const f = await fixture({
    root: async (_input, { context }) => {
      await context.db.run(sql`INSERT INTO execution_value VALUES('parent',1)`);
      await context.db.run(sql`SAVEPOINT child_work`);
      try {
        await context.actions.child(["child"], "write", { id: "child", value: 2 });
      } catch {
        await context.undoSavepoint();
      }
    },
    write: async (input, { context }) => {
      await context.db.run(sql`INSERT INTO execution_value VALUES(${input.id},${input.value})`);
      if (shouldFail) throw failure;
    },
  });
  await expect(f.execute()).rejects.toBe(failure);
  expect(await stored(f)).toEqual([]);
  expect(await audit(f)).toEqual([]);
  expect(await marker(f)).toEqual([{ id: null }]);
  shouldFail = false;
  await expect(f.execute()).resolves.toBeDefined();
  expect(await stored(f)).toEqual([
    { id: "child", value: 2 },
    { id: "parent", value: 1 },
  ]);
});

it("latches caught SQL failures even after raw savepoint rollback", async () => {
  const f = await fixture({
    root: async (_input, { context }) => {
      await context.db.run(sql`INSERT INTO execution_value VALUES('same',1)`);
      await context.db.run(sql`SAVEPOINT child_work`);
      try {
        await context.db.run(sql`INSERT INTO execution_value VALUES('same',2)`);
      } catch {
        await context.undoSavepoint();
      }
    },
  });
  await expect(f.execute()).rejects.toThrow();
  expect(await stored(f)).toEqual([]);
  expect(await audit(f)).toEqual([]);
});

it("refuses overlapping children and drains the first child before rollback", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const began = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let settled = false;
  const f = await fixture({
    root: async (_input, { context }) => {
      const first = context.actions.child(["first"], "write", { id: "a", value: 1 });
      await began;
      const second = context.actions.child(["second"], "noop", { label: "overlap" });
      await Promise.allSettled([first, second]);
    },
    write: async () => {
      entered();
      await held;
      settled = true;
    },
  });
  const running = f.execute();
  await began;
  let completed = false;
  void running.then(
    () => {
      completed = true;
    },
    () => {
      completed = true;
    },
  );
  await Promise.resolve();
  expect(completed).toBe(false);
  release();
  await expect(running).rejects.toThrow("does not own");
  expect(settled).toBe(true);
  expect(await audit(f)).toEqual([]);
});

it("waits for an unawaited child to settle and fails the root", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const began = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let settled = false;
  const f = await fixture({
    root: async (_input, { context }) => {
      void context.actions.child(["first"], "write", { id: "a", value: 1 });
      await began;
    },
    write: async () => {
      entered();
      await held;
      settled = true;
    },
  });
  const running = f.execute();
  await began;
  let completed = false;
  void running.then(
    () => {
      completed = true;
    },
    () => {
      completed = true;
    },
  );
  await Promise.resolve();
  expect(completed).toBe(false);
  release();
  await expect(running).rejects.toThrow("outstanding work");
  expect(settled).toBe(true);
  expect(await stored(f)).toEqual([]);
});

it("refuses parent SQL while a child owns the frame, including prebuilt queries", async () => {
  for (const prebuilt of [false, true]) {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture({
      root: async (_input, { context }) => {
        const query = context.db.select({ one: sql<number>`1` }).from(sql`execution_value`);
        const child = context.actions.child(["child"], "write", { id: "child", value: 1 });
        try {
          if (prebuilt) await query;
          else await context.db.run(sql`INSERT INTO execution_value VALUES('parent',1)`);
        } catch {}
        release();
        await child;
      },
      write: async () => {
        await held;
      },
    });
    await expect(f.execute()).rejects.toThrow("does not own");
    expect(await stored(f)).toEqual([]);
  }
});

it("refuses local-only children and preserves the first failure after later dispatch attempts", async () => {
  const recover = vi.fn(async () => "should not run");
  let later: unknown;
  const f = await fixture({
    file: recover,
    root: async (_input, { context }) => {
      try {
        await context.actions.child(["file"], "file", { path: "local.md" });
      } catch {}
      try {
        await context.actions.child(["later"], "write", { id: "later", value: 1 });
      } catch (error) {
        later = error;
      }
    },
  });
  const failure = await f.execute().then(
    () => {
      throw new Error("Unexpected commit");
    },
    (error: unknown) => error,
  );
  expect(failure).toBe(later);
  expect(String(later)).toContain("local-only");
  expect(recover).not.toHaveBeenCalled();
  expect(await stored(f)).toEqual([]);
});

it("preserves origin inputs and bindings while replay records changed child arguments", async () => {
  let resolvedValue = 1;
  const f = await fixture({
    root: async (input, { context, bindings }) => {
      const id = bindings.entityId("entity");
      const time = bindings.clock("clock");
      await context.actions.child(["stable"], "noop", { label: `${id}:${time}:${resolvedValue}` });
    },
  });
  const origin = await f.execute("record", {}, { value: 1 });
  resolvedValue = 2;
  const replay = await f.execute("replay", origin.generated, { value: 1 });
  expect(replay.invocation.input).toEqual(origin.invocation.input);
  expect(origin.executions[1].input).toEqual({ label: "allocated-1:123:1" });
  expect(replay.executions[1].input).toEqual({ label: "allocated-1:123:2" });
  expect(replay.executions[1].id).toBe(origin.executions[1].id);
  expect(replay.generated).toEqual(origin.generated);
  expect(Object.isFrozen(origin.executions[1].input)).toBe(true);
});

it("refuses duplicate child paths and unsupported contract versions", async () => {
  const f = await fixture({
    root: async (_input, { context }) => {
      await context.actions.child(["same"], "noop", { label: "first" });
      await context.actions.child(["same"], "noop", { label: "second" });
    },
  });
  await expect(f.execute()).rejects.toThrow("used twice");
  expect(await audit(f)).toEqual([]);
  await expect(f.execute("record", {}, {}, 2)).rejects.toMatchObject({
    code: "action-contract-required",
  });
  expect(await audit(f)).toEqual([]);
});

it("refuses child entry while a parent SQL operation is still outstanding", async () => {
  const child = vi.fn(async () => "not entered");
  const f = await fixture({
    root: async (_input, { context }) => {
      const writing = context.db.run(sql`INSERT INTO execution_value VALUES('pending',1)`);
      try {
        await context.actions.child(["child"], "noop", { label: "blocked" });
      } catch {}
      await writing;
    },
    noop: child,
  });
  await expect(f.execute()).rejects.toThrow("parent SQL is outstanding");
  expect(child).not.toHaveBeenCalled();
  expect(await stored(f)).toEqual([]);
});

it("refuses escaped transaction handles after their execution frame closes", async () => {
  let escaped!: Tx;
  const f = await fixture({
    root: async (_input, { context }) => {
      escaped = context.db;
    },
  });
  await f.execute();
  expect(() => escaped.run(sql`INSERT INTO execution_value VALUES('late',1)`)).toThrow(
    "does not own",
  );
  await expect(f.execute()).resolves.toBeDefined();
  expect(await stored(f)).toEqual([]);
});

it("rolls back a caught unbound replay allocation without altering recorded bindings", async () => {
  let changed = false;
  const f = await fixture({
    root: async (_input, { context, bindings }) => {
      bindings.entityId("existing");
      if (changed) {
        await context.db.run(sql`INSERT INTO execution_value VALUES('partial',1)`);
        try {
          bindings.entityId("new-branch");
        } catch {}
      }
    },
  });
  const origin = await f.execute();
  const before = JSON.stringify(origin.generated);
  const originAudit = await audit(f);
  changed = true;
  await expect(f.execute("replay", origin.generated)).rejects.toThrow("Unbound replay allocation");
  expect(JSON.stringify(origin.generated)).toBe(before);
  expect(await stored(f)).toEqual([]);
  expect(await audit(f)).toEqual(originAudit);
});

it("reuses stable child IDs when replay changes query order or skips a branch", async () => {
  let keys = ["a", "b"];
  const f = await fixture({
    root: async (_input, { context }) => {
      for (const key of keys) await context.actions.child([key], "noop", { label: key });
    },
  });
  const origin = await f.execute();
  keys = ["b", "a"];
  const reordered = await f.execute("replay", origin.generated);
  expect(reordered.executions.map(({ id }) => id)).toEqual([
    "root-id",
    "allocated-2",
    "allocated-1",
  ]);
  keys = ["b"];
  const skipped = await f.execute("replay", origin.generated);
  expect(skipped.executions.map(({ id, executionOrd }) => [id, executionOrd])).toEqual([
    ["root-id", 0],
    ["allocated-2", 1],
  ]);
  expect(skipped.generated).toEqual(origin.generated);
  expect(origin.executions).toHaveLength(3);
});

it("supports transaction-bound resource services and relational reads through the guarded handle", async () => {
  const f = await fixture({
    root: async (_input, { context }) => {
      const created = await layers.createInTx(context.db, createServiceContext(), namespaceId, {
        name: "Scoped layer",
      });
      const rows = await context.db.query.layerTable.findMany({
        where: eq(layerTable.id, created.id),
      });
      expect(rows).toMatchObject([{ id: created.id, name: "Scoped layer" }]);
    },
  });
  const namespaceId = await createNamespace({ db: f.db, name: "main" });
  await f.execute();
  expect((await f.db.select().from(layerTable)).map(({ name }) => name)).toContain("Scoped layer");
});

it.each(["unknown-kind", "invalid-json", "empty-path"])(
  "latches caught dispatch validation failures: %s",
  async (mode) => {
    const f = await fixture({
      root: async (_input, { context }) => {
        await context.db.run(sql`INSERT INTO execution_value VALUES('parent',1)`);
        try {
          await context.actions.child(
            mode === "empty-path" ? [] : ["child"],
            mode === "unknown-kind" ? "missing" : "noop",
            mode === "invalid-json" ? { label: NaN } : { label: "text" },
          );
        } catch {}
      },
    });
    await expect(f.execute()).rejects.toThrow();
    expect(await stored(f)).toEqual([]);
    expect(await audit(f)).toEqual([]);
  },
);

it("keeps the original envelope when a handler normalizes its private input copy", async () => {
  const input = { value: 7 };
  const f = await fixture({
    root: async (body) => {
      body.value = 99;
    },
  });
  const output = await f.execute("record", {}, input);
  expect(input).toEqual({ value: 7 });
  expect(output.invocation.input).toEqual({ value: 7 });
  expect(output.executions[0].input).toEqual({ value: 7 });
});

it("rolls back when a handler catches a service validation error before SQL", async () => {
  const f = await fixture({
    root: async (_input, { context }) => {
      await context.db.run(sql`INSERT INTO execution_value VALUES('parent',1)`);
      try {
        await layers.createInTx(context.db, createServiceContext(), namespaceId, { name: "" });
      } catch {}
    },
  });
  const namespaceId = await createNamespace({ db: f.db, name: "main" });
  await expect(f.execute()).rejects.toThrow();
  expect(await stored(f)).toEqual([]);
  expect((await f.db.select().from(layerTable)).map(({ name }) => name)).toEqual(["Base"]);
});

it.each([undefined, null, 0, false])(
  "preserves falsy child failures after they are caught: %s",
  async (cause) => {
    const f = await fixture({
      root: async (_input, { context }) => {
        try {
          await context.actions.child(["child"], "write", { id: "partial", value: 1 });
        } catch {}
      },
      write: async (input, { context }) => {
        await context.db.run(sql`INSERT INTO execution_value VALUES(${input.id},1)`);
        throw cause;
      },
    });
    let rejected = false;
    const error = await f.execute().then(
      () => undefined,
      (error: unknown) => {
        rejected = true;
        return error;
      },
    );
    expect(rejected).toBe(true);
    expect(error).toBe(cause);
    expect(await stored(f)).toEqual([]);
  },
);

it("separates hierarchical binding paths from multi-part sibling keys", async () => {
  const f = await fixture({
    root: async (_input, { context }) => {
      await context.actions.child(["a", "nested", "b"], "nested", { id: "left" });
      await context.actions.child(["a"], "nested", { id: "deep" });
    },
    nested: async (input, { context }) => {
      if (input.id === "deep") return context.actions.child(["b"], "nested", { id: "right" });
      return context.actions.child(["c"], "write", { id: input.id, value: 1 });
    },
    write: async (input, { context, bindings }) => {
      const id = bindings.entityId("entity");
      await context.db.run(sql`INSERT INTO execution_value VALUES(${id},${input.value})`);
    },
  });
  const output = await f.execute();
  expect(output.executions).toHaveLength(6);
  expect(await stored(f)).toHaveLength(2);
  expect(new Set(output.executions.map(({ id }) => id)).size).toBe(6);
});

it("observes an unawaited service validation failure and rolls back the root", async () => {
  const f = await fixture({
    root: async (_input, { context }) => {
      await context.db.run(sql`INSERT INTO execution_value VALUES('parent',1)`);
      void layers.createInTx(context.db, createServiceContext(), namespaceId, { name: "" });
    },
  });
  const namespaceId = await createNamespace({ db: f.db, name: "main" });
  await expect(f.execute()).rejects.toThrow();
  expect(await stored(f)).toEqual([]);
  expect(await audit(f)).toEqual([]);
});

it("persists complete execution bindings in the same transaction as data", async () => {
  const f = await fixture({
    root: async (_input, { context, bindings }) => {
      const id = bindings.entityId("entity");
      await context.actions.child(["created"], "write", { id, value: 1 });
    },
  });
  const output = await f.execute();
  const [saved] = await f.db
    .select({ generated: sql<string>`generated`, executions: sql<string>`executions` })
    .from(sql`execution_group`);
  expect(JSON.parse(saved.generated)).toEqual(output.generated);
  expect(JSON.parse(saved.executions)).toEqual(output.executions);
  expect(await stored(f)).toEqual([{ id: "allocated-1", value: 1 }]);
});

it("rolls back data and execution records when final persistence fails", async () => {
  const failure = new Error("effect-set persistence failed");
  const f = await fixture(
    {
      root: async (_input, { context }) => {
        await context.db.run(sql`INSERT INTO execution_value VALUES('partial',1)`);
      },
    },
    failure,
  );
  await expect(f.execute()).rejects.toBe(failure);
  expect(await stored(f)).toEqual([]);
  expect(await audit(f)).toEqual([]);
  expect(await f.db.select({ id: sql<string>`root_id` }).from(sql`execution_group`)).toEqual([]);
  expect(await marker(f)).toEqual([{ id: null }]);
});

it("reenables recursive triggers on every action transaction, including recycled connections", async () => {
  const f = await fixture({
    root: async (input, { context }) => {
      await context.db.run(sql`UPDATE execution_recursive SET value=1 WHERE id=${input.value}`);
    },
  });
  await f.db.run(sql`CREATE TABLE execution_recursive(id INTEGER PRIMARY KEY,value INTEGER)`);
  await f.db
    .run(sql`CREATE TRIGGER execution_repeat AFTER UPDATE ON execution_recursive WHEN NEW.value<3 BEGIN
    UPDATE execution_recursive SET value=value+1 WHERE id=NEW.id;
  END`);
  for (const id of [1, 2]) {
    await f.db.run(sql`INSERT INTO execution_recursive VALUES(${id},0)`);
    await f.db.run(sql`PRAGMA recursive_triggers=OFF`);
    await f.execute("record", {}, { value: id });
    const [row] = await f.db
      .select({ value: sql<number>`value` })
      .from(sql`execution_recursive`)
      .where(sql`id=${id}`);
    expect(row.value).toBe(3);
  }
});

it("refuses disabled foreign keys before entering handlers or writing execution records", async () => {
  const handler = vi.fn(async () => "must not run");
  const f = await fixture({ root: handler });
  await f.db.run(sql`PRAGMA foreign_keys=OFF`);
  await expect(f.execute()).rejects.toMatchObject({
    code: "action-connection-required",
    pragma: "foreign_keys",
  });
  expect(handler).not.toHaveBeenCalled();
  expect(await audit(f)).toEqual([]);
  expect(await marker(f)).toEqual([{ id: null }]);
  await f.db.run(sql`PRAGMA foreign_keys=ON`);
  await expect(f.execute()).resolves.toBeDefined();
});

it("rolls back data and completed history if a handler disables required connection settings", async () => {
  let disable = true;
  const f = await fixture({
    root: async (_input, { context }) => {
      await context.db.run(sql`INSERT INTO execution_value VALUES('changed',1)`);
      if (disable) await context.db.run(sql`PRAGMA recursive_triggers=OFF`);
    },
  });
  await expect(f.execute()).rejects.toMatchObject({
    code: "action-connection-required",
    pragma: "recursive_triggers",
  });
  expect(await stored(f)).toEqual([]);
  expect(await audit(f)).toEqual([]);
  expect(await f.db.select({ id: sql<string>`root_id` }).from(sql`execution_group`)).toEqual([]);
  disable = false;
  await expect(f.execute()).resolves.toBeDefined();
  expect(await stored(f)).toEqual([{ id: "changed", value: 1 }]);
});

it("checks connection settings after the completion hook before committing data and history", async () => {
  const f = await fixture(
    {
      root: async (_input, { context }) => {
        await context.db.run(sql`INSERT INTO execution_value VALUES('changed',1)`);
      },
    },
    undefined,
    async (tx) => {
      await tx.run(sql`PRAGMA recursive_triggers=OFF`);
    },
  );
  await expect(f.execute()).rejects.toMatchObject({
    code: "action-connection-required",
    pragma: "recursive_triggers",
  });
  expect(await stored(f)).toEqual([]);
  expect(await audit(f)).toEqual([]);
  expect(await f.db.select({ id: sql<string>`root_id` }).from(sql`execution_group`)).toEqual([]);
});
