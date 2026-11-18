import { prepareActionInputV1 } from "../../../../core/src/actions/invocation.js";
import { expect, expectTypeOf, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDB } from "../../test-utils/db.js";
import type { DB } from "../../../../core/src/database.js";
import { createActionBindings } from "../../../../core/src/actions/bindings.js";
import {
  actionContractsV1,
  type ActionInputsV1,
  type CompositionChildV1,
} from "../../../../core/src/actions/contracts.js";
import {
  composeActions,
  createCompositionRegistryV1,
  defineCompositionReader,
  replayComposition,
  type CompositionAccess,
  type CompositionContext,
  type CompositionReadHandle,
} from "../../../../core/src/actions/composition.js";
import type { ActionGroupResult } from "../../../../core/src/actions/execution.js";
import {
  withActionReplayTransaction,
  type ActionReplaySession,
} from "../../../../core/src/actions/replay.js";
import type { ActionHandlersV1 } from "../../../../core/src/actions/registry.js";

type Handlers = {
  -readonly [K in Exclude<
    keyof ActionHandlersV1<CompositionContext<undefined>>,
    "system.compose"
  >]: ActionHandlersV1<CompositionContext<undefined>>[K];
};

const create = { args: { namespaceId: "n" }, body: { partitionId: "p", content: "initial" } };
async function fixture() {
  // Both adapter configs resolve the package-typed fixture to the core source module.
  const db = (await createTestDB()) as unknown as DB;
  await db.run(sql`CREATE TABLE composition_card(id TEXT PRIMARY KEY,content TEXT)`);
  await db.run(sql`CREATE TABLE composition_log(input TEXT,generated TEXT,executions TEXT)`);
  const handlers = Object.fromEntries(
    Object.entries(actionContractsV1)
      .filter(([kind]) => kind !== "system.compose")
      .map(([kind, eligibility]) => [
        kind,
        eligibility === "syncable"
          ? {
              replay: vi.fn(async () => {
                throw new Error(`Unexpected action: ${kind}`);
              }),
            }
          : {
              recover: vi.fn(async () => {
                throw new Error(`File recovery invoked: ${kind}`);
              }),
            },
      ]),
  ) as unknown as Handlers;
  const created = vi.fn(
    async (
      input: ActionInputsV1["cards.create"],
      execution: Parameters<(typeof handlers)["cards.create"]["replay"]>[1],
    ) => {
      const id = execution.bindings.entityId("card");
      await execution.context.db.run(
        sql`INSERT INTO composition_card VALUES(${id},${input.body.content})`,
      );
      return { id };
    },
  );
  handlers["cards.create"] = { replay: created };
  const updated = vi.fn(
    async (
      input: ActionInputsV1["cards.update"],
      execution: Parameters<(typeof handlers)["cards.update"]["replay"]>[1],
    ) => {
      await execution.context.db.run(
        sql`UPDATE composition_card SET content=${input.body.content} WHERE id=${input.args.cardId}`,
      );
    },
  );
  handlers["cards.update"] = { replay: updated };
  handlers["cards.move"] = {
    replay: async (input, { context }) => {
      for (const id of input.body.cardIds)
        await context.actions.child([id], "cards.update", {
          args: { namespaceId: input.body.targetNamespaceId, cardId: id },
          body: { content: "moved" },
        });
    },
  };
  const read = vi.fn(async (reader: CompositionReadHandle, input: { content: string }) =>
    reader
      .select({ id: sql<string>`id` })
      .from(sql`composition_card`)
      .where(sql`content=${input.content}`),
  );
  const readers = {
    find: defineCompositionReader({
      prepare: (input: unknown) => {
        const object = input as { content?: unknown };
        if (typeof object?.content !== "string") throw new Error("content required");
        return { content: object.content };
      },
      read,
    }),
  };
  const registry = createCompositionRegistryV1([19], handlers);
  const complete = async (
    handle: Parameters<NonNullable<Parameters<typeof composeActions>[0]["complete"]>>[0],
    group: ActionGroupResult,
  ) => {
    await handle.run(
      sql`INSERT INTO composition_log VALUES(${JSON.stringify(group.invocation.input)},${JSON.stringify(group.generated)},${JSON.stringify(group.executions)})`,
    );
  };
  const record = (operation: (access: CompositionAccess<typeof readers>) => Promise<unknown>) => {
    let counter = 0;
    return composeActions({
      db,
      id: "composition",
      schemaVersion: 19,
      registry,
      value: undefined,
      readers,
      operation,
      bindings: createActionBindings({
        mode: "record",
        allocateId: () => `id-${++counter}`,
        now: () => 123,
      }),
      complete,
    });
  };
  const replay = (group: ActionGroupResult, session?: ActionReplaySession) =>
    replayComposition({
      ...(session ? { session } : { db }),
      schemaVersion: 19,
      registry,
      value: undefined,
      invocation: group.invocation,
      generated: group.generated,
      complete,
    });
  const rows = () =>
    db
      .select({ id: sql<string>`id`, content: sql<string>`content` })
      .from(sql`composition_card`)
      .orderBy(sql`id`);
  const logs = () =>
    db
      .select({
        input: sql<string>`input`,
        generated: sql<string>`generated`,
        executions: sql<string>`executions`,
      })
      .from(sql`composition_log`);
  return { db, record, replay, rows, logs, created, updated, read, handlers, registry, readers };
}

it("records complete direct calls and resolved read arguments, then replays without the callback", async () => {
  const f = await fixture();
  const callback = vi.fn(async (access: CompositionAccess<typeof f.readers>) => {
    const result = await access.dispatch(["create"], "cards.create", create);
    const [card] = await access.read("find", { content: "initial" });
    await access.dispatch(["edit", card.id], "cards.update", {
      args: { namespaceId: "n", cardId: card.id },
      body: { content: "edited" },
    });
    return result;
  });
  const origin = await f.record(callback);
  const input = origin.invocation.input as ActionInputsV1["system.compose"];
  expect(input.body.children).toEqual([
    { id: "id-1", path: ["create"], kind: "cards.create", input: create },
    {
      id: "id-3",
      path: ["edit", "id-2"],
      kind: "cards.update",
      input: { args: { namespaceId: "n", cardId: "id-2" }, body: { content: "edited" } },
    },
  ]);
  expect(origin.result).toEqual({ id: "id-2" });
  expect(origin.executions[0].input).toEqual(input);
  expect(JSON.parse((await f.logs())[0].input)).toEqual(input);
  expect(await f.rows()).toEqual([{ id: "id-2", content: "edited" }]);
  expect(Object.isFrozen(input.body.children)).toBe(true);
  await f.db.run(sql`DELETE FROM composition_card`);
  const replay = await f.replay(origin);
  expect(callback).toHaveBeenCalledOnce();
  expect(f.read).toHaveBeenCalledOnce();
  expect(replay.invocation).toEqual(origin.invocation);
  expect(replay.generated).toEqual(origin.generated);
  expect(await f.rows()).toEqual([{ id: "id-2", content: "edited" }]);
});

it("replays a composition and its named descendants inside a recoverable root savepoint", async () => {
  const f = await fixture();
  const callback = vi.fn(async (access: CompositionAccess<typeof f.readers>) => {
    const { id } = (await access.dispatch(["create"], "cards.create", create)) as { id: string };
    await access.read("find", { content: "initial" });
    await access.dispatch(["move", id], "cards.move", {
      args: { namespaceId: "n" },
      body: { cardIds: [id], targetNamespaceId: "other" },
    });
  });
  const origin = await f.record(callback);
  await f.db.run(sql`DELETE FROM composition_card`);
  await f.db.run(sql`DELETE FROM composition_log`);
  const failure = new Error("descendant failed");
  f.updated.mockImplementationOnce(async (input, { context }) => {
    await context.db.run(
      sql`UPDATE composition_card SET content='partial' WHERE id=${input.args.cardId}`,
    );
    throw failure;
  });
  await withActionReplayTransaction(f.db, async (session) => {
    await expect(f.replay(origin, session)).rejects.toBe(failure);
    expect(await session.db.select({ id: sql<string>`id` }).from(sql`composition_card`)).toEqual(
      [],
    );
    expect(
      await session.db.select({ input: sql<string>`input` }).from(sql`composition_log`),
    ).toEqual([]);
    const result = await f.replay(origin, session);
    expect(result.executions.map(({ kind }) => kind)).toEqual([
      "system.compose",
      "cards.create",
      "cards.move",
      "cards.update",
    ]);
    expect(result.generated).toEqual(origin.generated);
  });
  expect(await f.rows()).toEqual([{ id: "id-2", content: "moved" }]);
  expect(await f.logs()).toHaveLength(1);
  expect(callback).toHaveBeenCalledOnce();
  expect(f.read).toHaveBeenCalledOnce();
  expect(f.created).toHaveBeenCalledTimes(3);
  expect(f.updated).toHaveBeenCalledTimes(3);
});

it("records only direct children and lets a named handler invoke its descendants once", async () => {
  const f = await fixture();
  const origin = await f.record(async (access) => {
    const { id } = (await access.dispatch(["create"], "cards.create", create)) as { id: string };
    await access.dispatch(["move", id], "cards.move", {
      args: { namespaceId: "n" },
      body: { cardIds: [id], targetNamespaceId: "other" },
    });
  });
  expect((origin.invocation.input as ActionInputsV1["system.compose"]).body.children).toHaveLength(
    2,
  );
  expect(origin.executions.map(({ kind }) => kind)).toEqual([
    "system.compose",
    "cards.create",
    "cards.move",
    "cards.update",
  ]);
  expect(f.updated).toHaveBeenCalledOnce();
  await f.db.run(sql`DELETE FROM composition_card`);
  await f.replay(origin);
  expect(f.updated).toHaveBeenCalledTimes(2);
  expect(await f.rows()).toEqual([{ id: "id-2", content: "moved" }]);
});

it("rolls back earlier calls when a local-only child is caught by the callback", async () => {
  const f = await fixture();
  await expect(
    f.record(async (access) => {
      await access.dispatch(["create"], "cards.create", create);
      try {
        // @ts-expect-error Local-only operations cannot be dispatched by a composition.
        await access.dispatch(["file"], "taskspaces.createFile", {
          args: { namespaceId: "n", taskspaceId: "t" },
          body: { path: "x.md" },
        });
      } catch {}
    }),
  ).rejects.toThrow("local-only");
  expect(await f.rows()).toEqual([]);
  expect(await f.logs()).toEqual([]);
  expect(f.handlers["taskspaces.createFile"].recover).not.toHaveBeenCalled();
});

it("rolls back caught reader validation errors after an earlier child write", async () => {
  const f = await fixture();
  await expect(
    f.record(async (access) => {
      await access.dispatch(["create"], "cards.create", create);
      try {
        await access.read("find", { content: NaN } as unknown as { content: string });
      } catch {}
    }),
  ).rejects.toThrow();
  expect(await f.rows()).toEqual([]);
  expect(await f.logs()).toEqual([]);
});

it("rejects overlapping and unawaited composition calls", async () => {
  for (const overlap of [false, true]) {
    const f = await fixture();
    await expect(
      f.record(async (access) => {
        const first = access.dispatch(["first"], "cards.create", create);
        if (overlap) {
          const second = access.dispatch(["second"], "cards.create", create);
          await Promise.allSettled([first, second]);
        }
      }),
    ).rejects.toThrow();
    expect(await f.rows()).toEqual([]);
    expect(await f.logs()).toEqual([]);
  }
});

it("rejects a recorded child ID mismatch before its handler runs", async () => {
  const f = await fixture();
  const origin = await f.record(async (access) => {
    await access.dispatch(["create"], "cards.create", create);
  });
  await f.db.run(sql`DELETE FROM composition_card`);
  f.created.mockClear();
  const input = structuredClone(origin.invocation.input) as ActionInputsV1["system.compose"];
  const children = input.body.children.map((child) => ({ ...child, id: "forged-child" }));
  const corrupted = {
    ...origin,
    invocation: { ...origin.invocation, input: { args: {}, body: { children } } },
  };
  await expect(f.replay(corrupted)).rejects.toThrow("differs from recorded composition");
  expect(f.created).not.toHaveBeenCalled();
  expect(await f.rows()).toEqual([]);
  expect(await f.logs()).toHaveLength(1);
});

it("exposes registered readers and action dispatch without a raw transaction API", async () => {
  const f = await fixture();
  await f.record(async (access) => {
    expect(Object.keys(access)).toEqual(["read", "dispatch"]);
    expect("db" in access).toBe(false);
    expect("run" in access).toBe(false);
    expectTypeOf(await access.read("find", { content: "absent" })).toEqualTypeOf<
      { id: string }[]
    >();
  });
  expect(await f.rows()).toEqual([]);
});

it.each(["db", "run", "insert", "records"])(
  "latches caught raw callback access: %s",
  async (property) => {
    const f = await fixture();
    await expect(
      f.record(async (access) => {
        await access.dispatch(["create"], "cards.create", create);
        try {
          Reflect.get(access, property);
        } catch {}
      }),
    ).rejects.toThrow("registered readers and dispatch");
    expect(await f.rows()).toEqual([]);
    expect(await f.logs()).toEqual([]);
  },
);

it("copies child input before a caller can mutate it while dispatch is pending", async () => {
  const f = await fixture();
  const request = structuredClone(create);
  const output = await f.record(async (access) => {
    const pending = access.dispatch(["create"], "cards.create", request);
    request.body.content = "changed";
    await pending;
  });
  const [child] = (output.invocation.input as ActionInputsV1["system.compose"]).body.children;
  expect(child.input).toEqual(create);
  expect(await f.rows()).toEqual([{ id: "id-2", content: "initial" }]);
});

it("rolls back complete composition data when final history persistence fails", async () => {
  const f = await fixture();
  let counter = 0;
  const failure = new Error("history unavailable");
  await expect(
    composeActions({
      db: f.db,
      id: "composition",
      schemaVersion: 19,
      registry: f.registry,
      value: undefined,
      readers: f.readers,
      bindings: createActionBindings({
        mode: "record",
        allocateId: () => `id-${++counter}`,
        now: () => 123,
      }),
      operation: async (access) => {
        await access.dispatch(["create"], "cards.create", create);
      },
      complete: async () => {
        throw failure;
      },
    }),
  ).rejects.toBe(failure);
  expect(await f.rows()).toEqual([]);
});

it("latches a registered reader's caught attempt to access raw SQL", async () => {
  const f = await fixture();
  f.read.mockImplementationOnce(async (reader) => {
    try {
      Reflect.get(reader, "run");
    } catch {}
    return [];
  });
  await expect(
    f.record(async (access) => {
      await access.dispatch(["create"], "cards.create", create);
      await access.read("find", { content: "initial" });
    }),
  ).rejects.toThrow("query builders only");
  expect(await f.rows()).toEqual([]);
});

it("latches a caught reader domain error before SQL", async () => {
  const f = await fixture();
  await expect(
    f.record(async (access) => {
      await access.dispatch(["create"], "cards.create", create);
      try {
        await access.read("find", { content: 42 } as unknown as { content: string });
      } catch {}
    }),
  ).rejects.toThrow("content required");
  expect(await f.rows()).toEqual([]);
});

const serializedChild: CompositionChildV1 = {
  id: "child",
  path: ["update"],
  kind: "cards.update",
  input: { args: { namespaceId: "n", cardId: "c" }, body: { content: "text" } },
};
it.each(
  [
    [{ ...serializedChild, id: "" }],
    [{ ...serializedChild, path: [] }],
    [{ ...serializedChild, path: [""] }],
    [{ ...serializedChild, path: [1] }],
    [{ ...serializedChild, kind: "unknown" }],
    [
      {
        ...serializedChild,
        kind: "taskspaces.remove",
        input: { args: { namespaceId: "n", taskspaceId: "t" } },
      },
    ],
    [{ ...serializedChild, input: { args: { namespaceId: "n" }, body: { content: "text" } } }],
    [{ ...serializedChild, contractVersion: 2 }],
    [serializedChild, { ...serializedChild, path: ["another"] }],
    [serializedChild, { ...serializedChild, id: "other" }],
    [
      {
        id: "nested",
        path: ["nested"],
        kind: "system.compose",
        input: { args: {}, body: { children: [serializedChild] } },
      },
      serializedChild,
    ],
  ].map((children) => ({ children })),
)("refuses malformed serialized composition children: $children", ({ children }) => {
  expect(() => prepareActionInputV1("system.compose", { args: {}, body: { children } })).toThrow();
});

it("accepts empty compositions and validates nested envelopes without flattening them", () => {
  expect(prepareActionInputV1("system.compose", { args: {}, body: { children: [] } })).toEqual({
    args: {},
    body: { children: [] },
  });
  const input = {
    args: {},
    body: {
      children: [
        {
          id: "nested",
          path: ["nested"],
          kind: "system.compose",
          input: { args: {}, body: { children: [serializedChild] } },
        },
      ],
    },
  };
  expect(prepareActionInputV1("system.compose", input)).toEqual(input);
});

it("replays nested serialized compositions without flattening their children", async () => {
  const f = await fixture();
  const origin = await f.record(async (access) => {
    await access.dispatch(["nested"], "system.compose", {
      args: {},
      body: { children: [{ id: "id-2", path: ["create"], kind: "cards.create", input: create }] },
    });
  });
  expect((origin.invocation.input as ActionInputsV1["system.compose"]).body.children).toHaveLength(
    1,
  );
  expect(origin.executions.map(({ kind }) => kind)).toEqual([
    "system.compose",
    "system.compose",
    "cards.create",
  ]);
  await f.db.run(sql`DELETE FROM composition_card`);
  await f.replay(origin);
  expect(f.created).toHaveBeenCalledTimes(2);
  expect(await f.rows()).toEqual([{ id: "id-3", content: "initial" }]);
});
