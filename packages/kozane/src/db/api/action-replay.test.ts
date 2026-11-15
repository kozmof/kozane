import { expect, it, vi } from "vitest";
import { sql, type SQL } from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import { createTestDB } from "../../test-utils/db.js";
import { createDatabaseAdapter, withTx, type DB, type Tx } from "../../../../core/src/database.js";
import { actionBindingPath, createActionBindings } from "../../../../core/src/actions/bindings.js";
import {
  type ActionFrameAccess,
  type ActionGroupOptions,
} from "../../../../core/src/actions/execution.js";
import {
  ActionReplayCleanupError,
  withActionReplayTransaction,
  type ActionReplaySession,
} from "../../../../core/src/actions/replay.js";
import { defineActionRegistry, type ActionHandler } from "../../../../core/src/actions/registry.js";

type Input = { id: string; value: number; fail?: boolean };
type Inputs = { root: Input; child: Input };
interface Context {
  db: Tx;
  actions: ActionFrameAccess;
  rollbackWork(): Promise<void>;
}
const failure = new Error("root failed");
const prepare = (input: unknown) => input as Input;
async function write(input: Input, tx: Tx) {
  await tx.run(sql`INSERT INTO replay_value VALUES(${input.id},${input.value})`);
}
async function fixture(
  root: ActionHandler<Input, Context> = async (input, { context }) => {
    await write(input, context.db);
    if (input.fail) throw failure;
    return input.id;
  },
  complete?: (tx: Tx) => Promise<void>,
) {
  // Both test configs resolve this package-typed fixture to the core source adapter.
  const db = (await createTestDB()) as unknown as DB;
  await db.run(sql`CREATE TABLE replay_value(id TEXT PRIMARY KEY,value INTEGER)`);
  await db.run(sql`CREATE TABLE replay_entry(id TEXT,parent_id TEXT,ord INTEGER)`);
  await db.run(sql`CREATE TABLE replay_group(id TEXT PRIMARY KEY)`);
  await db.run(sql`CREATE TABLE replay_marker(id TEXT)`);
  await db.run(sql`INSERT INTO replay_marker VALUES(NULL)`);
  let raw: Tx;
  const registry = defineActionRegistry<Inputs, Context>({
    contractVersion: 1,
    schemaVersions: [19],
    definitions: {
      root: { eligibility: "syncable", prepare, replay: root },
      child: {
        eligibility: "syncable",
        prepare,
        replay: async (input, { context }) => {
          await write(input, context.db);
          if (input.fail) throw failure;
          return input.id;
        },
      },
    },
  });
  function options(id: string, fail = false): ActionGroupOptions<Inputs, Context> {
    return {
      schemaVersion: 19,
      registry,
      invocation: { id, kind: "root", contractVersion: 1, input: { id, value: 1, fail } },
      bindings: createActionBindings({
        mode: "replay",
        bindings: {
          [actionBindingPath("child", "root", "root", "child", "one")]: {
            type: "child-id",
            value: `${id}:child`,
          },
        },
      }),
      createContext: (actions, db) => ({
        actions,
        db,
        rollbackWork: async () => {
          await raw.run(sql`ROLLBACK TO SAVEPOINT handler_work`);
          await raw.run(sql`RELEASE SAVEPOINT handler_work`);
        },
      }),
      enter: async (tx, entry) => {
        raw = tx;
        await tx.run(
          sql`INSERT INTO replay_entry VALUES(${entry.id},${entry.parentId},${entry.executionOrd})`,
        );
        await tx.run(sql`UPDATE replay_marker SET id=${entry.id}`);
      },
      leave: async (tx, _id, parentId) => {
        await tx.run(sql`UPDATE replay_marker SET id=${parentId}`);
      },
      complete: async (tx, group) => {
        await tx.run(sql`INSERT INTO replay_group VALUES(${group.invocation.id})`);
        await complete?.(tx);
      },
    };
  }
  return { db, options };
}
async function values(db: Tx | DB) {
  return db
    .select({ id: sql<string>`id`, value: sql<number>`value` })
    .from(sql`replay_value`)
    .orderBy(sql`id`);
}
async function groups(db: Tx | DB) {
  return db
    .select({ id: sql<string>`id` })
    .from(sql`replay_group`)
    .orderBy(sql`id`);
}
async function marker(db: Tx | DB) {
  return db.select({ id: sql<string | null>`id` }).from(sql`replay_marker`);
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function faultingDatabase(db: DB, reject: (statement: string) => boolean, cause: Error) {
  const dialect = new SQLiteAsyncDialect();
  const handle = new Proxy(db, {});
  return createDatabaseAdapter(handle, {
    write: (operation) =>
      withTx(db, async (tx) =>
        operation(
          new Proxy(tx, {
            get(target, property) {
              if (property === "run")
                return (query: SQL) => {
                  if (reject(dialect.sqlToQuery(query).sql)) return Promise.reject(cause);
                  return target.run(query);
                };
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
        ),
      ),
    read: async () => {
      throw new Error("Fault fixture does not use read transactions");
    },
  });
}

it("discards a failed root and commits surrounding roots and reconciliation state atomically", async () => {
  const f = await fixture();
  const output = await withActionReplayTransaction(f.db, async ({ db, replay }) => {
    await write({ id: "before", value: 2 }, db);
    expect((await replay(f.options("a"))).result).toBe("a");
    await expect(replay(f.options("b", true))).rejects.toBe(failure);
    expect(await values(db)).toEqual([
      { id: "a", value: 1 },
      { id: "before", value: 2 },
    ]);
    expect(await groups(db)).toEqual([{ id: "a" }]);
    expect(await marker(db)).toEqual([{ id: null }]);
    await replay(f.options("b"));
    await write({ id: "after", value: 3 }, db);
    return "finished";
  });
  expect(output).toBe("finished");
  expect(await values(f.db)).toEqual([
    { id: "a", value: 1 },
    { id: "after", value: 3 },
    { id: "b", value: 1 },
    { id: "before", value: 2 },
  ]);
  expect(await groups(f.db)).toEqual([{ id: "a" }, { id: "b" }]);
});

it("keeps caught child failures latched through handler savepoints and gives the next root a fresh scope", async () => {
  const f = await fixture(async (input, { context }) => {
    await write(input, context.db);
    await context.db.run(sql`SAVEPOINT handler_work`);
    try {
      await context.actions.child(["one"], "child", {
        id: `${input.id}-child`,
        value: 2,
        fail: input.fail,
      });
    } catch (error) {
      expect(error).toBe(failure);
    }
    await context.rollbackWork();
    return "caught";
  });
  await withActionReplayTransaction(f.db, async ({ db, replay }) => {
    await expect(replay(f.options("bad", true))).rejects.toBe(failure);
    expect(await values(db)).toEqual([]);
    expect(await marker(db)).toEqual([{ id: null }]);
    const group = await replay(f.options("good"));
    expect(
      group.executions.map(({ id, executionOrd, parentId }) => ({ id, executionOrd, parentId })),
    ).toEqual([
      { id: "good", executionOrd: 0, parentId: null },
      { id: "good:child", executionOrd: 1, parentId: "good" },
    ]);
  });
  expect(await values(f.db)).toEqual([{ id: "good", value: 1 }]);
  expect(await groups(f.db)).toEqual([{ id: "good" }]);
});

it.each([undefined, null, false, 0, ""])(
  "preserves a falsy root failure (%s) and permits a later independent root",
  async (cause) => {
    const f = await fixture(async (input, { context }) => {
      await write(input, context.db);
      if (input.fail) {
        try {
          context.actions.fail(cause);
        } catch {
          /* The root latch still owns the failure. */
        }
      }
    });
    await withActionReplayTransaction(f.db, async ({ replay }) => {
      await expect(replay(f.options("bad", true))).rejects.toBe(cause);
      await replay(f.options("good"));
    });
    expect(await values(f.db)).toEqual([{ id: "good", value: 1 }]);
  },
);

it("rolls back completed roots if orchestration fails", async () => {
  const f = await fixture();
  await expect(
    withActionReplayTransaction(f.db, async ({ replay }) => {
      await replay(f.options("a"));
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(await values(f.db)).toEqual([]);
  expect(await groups(f.db)).toEqual([]);
});

it("rolls back an earlier success if a later root failure escapes orchestration", async () => {
  const f = await fixture();
  await expect(
    withActionReplayTransaction(f.db, async ({ replay }) => {
      await replay(f.options("a"));
      await replay(f.options("b", true));
    }),
  ).rejects.toBe(failure);
  expect(await values(f.db)).toEqual([]);
  expect(await groups(f.db)).toEqual([]);
});

it("rolls back data and completion records when a root completion hook fails", async () => {
  let reject = true;
  const f = await fixture(undefined, async () => {
    if (reject) throw failure;
  });
  await withActionReplayTransaction(f.db, async ({ db, replay }) => {
    await expect(replay(f.options("bad"))).rejects.toBe(failure);
    expect(await groups(db)).toEqual([]);
    reject = false;
    await replay(f.options("good"));
  });
  expect(await values(f.db)).toEqual([{ id: "good", value: 1 }]);
});

it("aborts the outer transaction after savepoint cleanup fails even when orchestration catches it", async () => {
  let completions = 0;
  const f = await fixture(undefined, async (tx) => {
    if (++completions === 1) return;
    // Simulate a lost savepoint after the root wrote its data and completion record.
    await tx.run(sql`RELEASE SAVEPOINT kozane_action_replay_2`);
    throw failure;
  });
  let caught: unknown;
  await expect(
    withActionReplayTransaction(f.db, async ({ replay }) => {
      await replay(f.options("earlier"));
      try {
        await replay(f.options("bad"));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ActionReplayCleanupError);
      expect(caught).toMatchObject({ cause: failure });
      await expect(replay(f.options("later"))).rejects.toBe(caught);
    }),
  ).rejects.toBeInstanceOf(ActionReplayCleanupError);
  expect(await values(f.db)).toEqual([]);
  expect(await groups(f.db)).toEqual([]);
});

it.each(["SAVEPOINT", "RELEASE SAVEPOINT"])(
  "aborts the outer transaction if %s fails even after successful cleanup",
  async (statement) => {
    const f = await fixture();
    const infrastructure = new Error("savepoint driver failure");
    let injected = false;
    const db = faultingDatabase(
      f.db,
      (query) => {
        if (injected || query !== `${statement} kozane_action_replay_2`) return false;
        injected = true;
        return true;
      },
      infrastructure,
    );
    await expect(
      withActionReplayTransaction(db, async ({ replay }) => {
        await replay(f.options("earlier"));
        await expect(replay(f.options("bad"))).rejects.toBe(infrastructure);
        await expect(replay(f.options("later"))).rejects.toBe(infrastructure);
      }),
    ).rejects.toBe(infrastructure);
    expect(injected).toBe(true);
    expect(await values(f.db)).toEqual([]);
    expect(await groups(f.db)).toEqual([]);
  },
);

it("refuses overlapping roots and drains the active root before outer rollback", async () => {
  const began = gate();
  const held = gate();
  const calls = vi.fn();
  const f = await fixture(async (input, { context }) => {
    calls(input.id);
    await write(input, context.db);
    began.resolve();
    await held.promise;
  });
  const running = withActionReplayTransaction(f.db, async ({ replay }) => {
    const first = replay(f.options("a"));
    await began.promise;
    const second = replay(f.options("b"));
    await expect(second).rejects.toThrow("sequentially");
    held.resolve();
    await expect(first).rejects.toThrow("sequentially");
  });
  await expect(running).rejects.toThrow("sequentially");
  expect(calls.mock.calls).toEqual([["a"]]);
  expect(await values(f.db)).toEqual([]);
  expect(await groups(f.db)).toEqual([]);
});

it("waits for an unawaited root before rolling back and rejects retained sessions", async () => {
  const began = gate();
  const held = gate();
  const returned = gate();
  const f = await fixture(async (input, { context }) => {
    await write(input, context.db);
    began.resolve();
    await held.promise;
  });
  let retained!: ActionReplaySession;
  let settled = false;
  const running = withActionReplayTransaction(f.db, async (session) => {
    retained = session;
    void session.replay(f.options("a"));
    await began.promise;
    returned.resolve();
  });
  void running.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await returned.promise;
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  held.resolve();
  await expect(running).rejects.toThrow("outstanding root");
  await expect(retained.replay(f.options("later"))).rejects.toThrow("closed");
  expect(await values(f.db)).toEqual([]);
  expect(await groups(f.db)).toEqual([]);
});

it("rejects retained sessions after successful commit without running more SQL", async () => {
  const f = await fixture();
  let retained!: ActionReplaySession;
  await withActionReplayTransaction(f.db, async (session) => {
    retained = session;
    await session.replay(f.options("a"));
  });
  await expect(retained.replay(f.options("b"))).rejects.toThrow("closed");
  expect(await values(f.db)).toEqual([{ id: "a", value: 1 }]);
});

it("preserves a falsy orchestration failure while draining an active root", async () => {
  const began = gate();
  const held = gate();
  const returned = gate();
  const f = await fixture(async (input, { context }) => {
    await write(input, context.db);
    began.resolve();
    await held.promise;
  });
  const running = withActionReplayTransaction(f.db, async ({ replay }) => {
    void replay(f.options("a"));
    await began.promise;
    returned.resolve();
    throw undefined;
  });
  await returned.promise;
  held.resolve();
  await expect(running).rejects.toBeUndefined();
  expect(await values(f.db)).toEqual([]);
  expect(await groups(f.db)).toEqual([]);
});

it("verifies connection settings after reconciliation bookkeeping before committing", async () => {
  const f = await fixture();
  await expect(
    withActionReplayTransaction(f.db, async ({ db, replay }) => {
      await replay(f.options("a"));
      await db.run(sql`PRAGMA recursive_triggers=OFF`);
    }),
  ).rejects.toMatchObject({ code: "action-connection-required", pragma: "recursive_triggers" });
  expect(await values(f.db)).toEqual([]);
  expect(await groups(f.db)).toEqual([]);
});

it("requires replay bindings and rejects incompatible contracts before handlers", async () => {
  const root = vi.fn(
    async (input: Input, { context }: Parameters<ActionHandler<Input, Context>>[1]) =>
      write(input, context.db),
  );
  const f = await fixture(root);
  await withActionReplayTransaction(f.db, async ({ replay }) => {
    const record = {
      ...f.options("record"),
      bindings: createActionBindings({
        mode: "record",
        allocateId: () => "forbidden",
        now: () => 0,
      }),
    };
    await expect(replay(record)).rejects.toThrow("recorded bindings");
    const incompatible = { ...f.options("bad"), schemaVersion: 20 };
    await expect(replay(incompatible)).rejects.toMatchObject({ code: "action-contract-required" });
    expect(root).not.toHaveBeenCalled();
    await replay(f.options("good"));
  });
  expect(root).toHaveBeenCalledOnce();
});

it("rejects an outer deferred commit failure without preserving released root savepoints", async () => {
  const f = await fixture();
  await f.db.run(sql`CREATE TABLE replay_parent(id TEXT PRIMARY KEY)`);
  await f.db.run(
    sql`CREATE TABLE replay_deferred(parent_id TEXT REFERENCES replay_parent(id) DEFERRABLE INITIALLY DEFERRED)`,
  );
  await expect(
    withActionReplayTransaction(f.db, async ({ db, replay }) => {
      await replay(f.options("a"));
      await db.run(sql`INSERT INTO replay_deferred VALUES('missing')`);
    }),
  ).rejects.toBeDefined();
  expect(await values(f.db)).toEqual([]);
  expect(await groups(f.db)).toEqual([]);
});
