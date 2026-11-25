import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDB } from "../../test-utils/db.js";
import { capturedTables } from "../../test-utils/action-tables.js";
import {
  withReadTx,
  createDatabaseAdapter,
  type DB,
  type ReadTx,
  type DatabaseHandle,
} from "../../../../core/src/database.js";
import { migrations } from "../../../../core/src/generated/migrations.js";
import type { TaggedRow } from "../../../../core/src/actions/row-codec.js";
import { captureRecoveryCheckpoint } from "../../../../core/src/actions/recovery-checkpoint-capture.js";
import { captureLocalRecoveryCheckpoint } from "../../../../core/src/actions/local-recovery-checkpoint.js";
import { describeSharedRecoveryHistory } from "../../../../core/src/actions/shared-recovery-checkpoint.js";
import {
  parseSharedRecoveryProjection,
  type SharedRecoveryEffect,
} from "../../../../core/src/actions/shared-recovery.js";
import { rememberLocalRecoveryCheckpoint } from "../../../../core/src/actions/local-recovery-store.js";
import {
  rememberSharedRecoveryCheckpoint,
  inspectSharedRecoveryCheckpoint,
} from "../../../../core/src/actions/shared-recovery-store.js";

beforeEach(async () => {
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const identity = {
  workspaceId: "workspace🪁",
  deviceId: "device",
  epochId: "epoch",
  checkpointId: "checkpoint",
  schemaId: migrations.at(-1)!.id,
};
const selection = {
  baselineId: "baseline",
  effectSets: [
    { id: "first", effectCount: 1 },
    { id: "empty", effectCount: 0 },
    { id: "last", effectCount: 1 },
  ],
};
const localSelection = {
  baselineId: selection.baselineId,
  effectSetIds: selection.effectSets.map((set) => set.id),
};
const initial = "\ufeffstart\u0000🪁";
const row = (name: string): TaggedRow => ({
  id: ["text", "n"],
  name: ["text", name],
  is_default: ["integer", "0"],
});
const update = (before: string, after: string): SharedRecoveryEffect => ({
  ord: 0,
  table: "namespace",
  key: { id: ["text", "n"] },
  op: "U",
  before: row(before),
  after: row(after),
});
async function fixture() {
  const db = (await createTestDB()) as unknown as DB;
  await db.run(sql`INSERT INTO namespace(id,name,is_default) VALUES('n','final',0)`);
  await db.run(
    sql`INSERT INTO warp(id,namespace_id,pos_x,pos_y) VALUES('w','n',9007199254740993,CAST('1.5' AS REAL))`,
  );
  await db.run(
    sql`INSERT INTO taskspace_local VALUES('absent',${"local/🪁\0before"},'workspace_relative',9007199254740993)`,
  );
  await db.run(
    sql`INSERT INTO local_file_operation(id,kind,version,taskspace_id,namespace_id,path,path_kind,state,intent,created_at) VALUES('pending','taskspace.directory',1,'absent','missing','local/path','workspace_relative','pending','{"opaque":"🪁"}',9007199254740993)`,
  );
  const projection = parseSharedRecoveryProjection({
    version: 1,
    rowEncodingVersion: 1,
    schemaId: identity.schemaId,
    tables: capturedTables.map((table) => ({
      name: table.name,
      rows:
        table.name === "namespace"
          ? [row(initial)]
          : table.name === "warp"
            ? [
                {
                  id: ["text", "w"],
                  namespace_id: ["text", "n"],
                  pos_x: ["integer", "9007199254740993"],
                  pos_y: ["real", "3ff8000000000000"],
                },
              ]
            : [],
    })),
  });
  const history = {
    baseline: { id: selection.baselineId, projection },
    effectSets: [
      { id: "last", effects: [update("middle", "final")] },
      { id: "empty", effects: [] },
      { id: "first", effects: [update(initial, "middle")] },
    ],
  };
  await db.run(
    sql`CREATE TABLE checkpoint_history(singleton INTEGER PRIMARY KEY,history TEXT NOT NULL,selection TEXT NOT NULL)`,
  );
  await db.run(
    sql`INSERT INTO checkpoint_history VALUES(1,${JSON.stringify(history)},${JSON.stringify(selection)})`,
  );
  const read = async (tx: ReadTx) => {
    const [value] = await tx.values(sql`SELECT history,selection FROM checkpoint_history`);
    return { history: JSON.parse(String(value[0])), selection: JSON.parse(String(value[1])) };
  };
  return { db, history, read };
}
it("captures exact local rows and reconstructed shared history with matching unchanged descriptors", async () => {
  const f = await fixture();
  const expectedLocal = await captureLocalRecoveryCheckpoint(
    f.db,
    identity,
    async () => localSelection,
  );
  const expectedShared = await describeSharedRecoveryHistory(f.history, identity, selection);
  const result = await captureRecoveryCheckpoint(f.db, identity, f.read);
  expect(result).toEqual({ local: expectedLocal, shared: expectedShared });
  expect(result.local.snapshot.selection.effectSetIds).toEqual(["first", "empty", "last"]);
  expect(result.shared.payload.history.effectSets.map((set) => set.id)).toEqual([
    "first",
    "empty",
    "last",
  ]);
  expect(
    result.local.snapshot.tables.find((table) => table.name === "taskspace_local")!.rows[0],
  ).toMatchObject({
    path: ["text", "local/🪁\0before"],
    last_seen_at: ["integer", "9007199254740993"],
  });
  expect(
    result.local.snapshot.tables.find((table) => table.name === "local_file_operation")!.rows[0]
      .created_at,
  ).toEqual(["integer", "9007199254740993"]);
  expect(Object.isFrozen(result.shared.payload.history.effectSets)).toBe(true);
  expect(Object.isFrozen(result.local.snapshot.tables)).toBe(true);
  expect(
    await f.db.values(
      sql`SELECT 1 FROM local_recovery_checkpoint UNION ALL SELECT 1 FROM local_recovery_shared_history`,
    ),
  ).toEqual([]);
});
it("captures an initial populated baseline without selected effects", async () => {
  const f = await fixture();
  const current = await describeSharedRecoveryHistory(f.history, identity, selection);
  const source = {
    history: { baseline: { id: "initial", projection: current.projection }, effectSets: [] },
    selection: { baselineId: "initial", effectSets: [] },
  };
  await f.db.run(
    sql`UPDATE checkpoint_history SET history=${JSON.stringify(source.history)},selection=${JSON.stringify(source.selection)}`,
  );
  const captured = await captureRecoveryCheckpoint(f.db, identity, f.read);
  expect(captured.local.snapshot.selection).toEqual({ baselineId: "initial", effectSetIds: [] });
  expect(captured.shared.payload.history.effectSets).toEqual([]);
  expect(captured.shared.projection).toEqual(current.projection);
  expect(
    captured.local.snapshot.tables.find((table) => table.name === "taskspace_local")!.rows,
  ).toHaveLength(1);
});
it("uses one restricted read boundary and starts both hashes only after successful read completion", async () => {
  const f = await fixture();
  let active = false,
    reads = 0,
    hashes = 0;
  const wrapped = createDatabaseAdapter(new Proxy(f.db, {}), {
    write: async () => {
      throw Error("Unexpected write");
    },
    read: (work) =>
      withReadTx(f.db, async (tx) => {
        reads++;
        active = true;
        try {
          return await work(tx as unknown as DatabaseHandle);
        } finally {
          active = false;
        }
      }),
  });
  const digest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
  vi.spyOn(globalThis.crypto.subtle, "digest").mockImplementation((algorithm, data) => {
    expect(active).toBe(false);
    hashes++;
    return digest(algorithm, data);
  });
  const read = vi.fn(async (tx: ReadTx) => {
    expect(active).toBe(true);
    expect(Object.isFrozen(tx)).toBe(true);
    for (const method of ["insert", "update", "delete", "run", "transaction", "$client"])
      expect(tx).not.toHaveProperty(method);
    return f.read(tx);
  });
  await captureRecoveryCheckpoint(wrapped, identity, read);
  expect(reads).toBe(1);
  expect(read).toHaveBeenCalledTimes(1);
  expect(hashes).toBe(2);
});
it("owns the host identity before awaiting and reader values before adapter completion", async () => {
  const f = await fixture(),
    expected = await captureRecoveryCheckpoint(f.db, identity, f.read);
  let returned: any;
  const wrapped = createDatabaseAdapter(new Proxy(f.db, {}), {
    write: async () => {
      throw Error("Unexpected write");
    },
    read: (work) =>
      withReadTx(f.db, async (tx) => {
        const result = await work(tx as unknown as DatabaseHandle);
        returned.history.baseline.projection.tables.length = 0;
        returned.selection.effectSets.reverse();
        return result;
      }),
  });
  const input = { ...identity };
  const pending = captureRecoveryCheckpoint(
    wrapped,
    input,
    async (tx) => (returned = await f.read(tx)),
  );
  input.deviceId = "changed";
  expect(await pending).toEqual(expected);
});
it("registers the captured pair through existing immutable catalogs after capture finishes", async () => {
  const f = await fixture(),
    result = await captureRecoveryCheckpoint(f.db, identity, f.read);
  await rememberLocalRecoveryCheckpoint(f.db, result.local.checkpoint);
  const registered = await rememberSharedRecoveryCheckpoint(f.db, result.shared.checkpoint);
  expect(registered.binding).toEqual({
    checkpoint: result.shared.checkpoint,
    localCheckpoint: result.local.checkpoint,
  });
  expect(
    await inspectSharedRecoveryCheckpoint(f.db, {
      workspaceId: identity.workspaceId,
      deviceId: identity.deviceId,
      epochId: identity.epochId,
      checkpointId: identity.checkpointId,
    }),
  ).toEqual(registered.binding);
  expect(
    result.local.snapshot.tables.find((table) => table.name === "local_recovery_checkpoint")!.rows,
  ).toEqual([]);
});
it.each(["stale projection", "extra live row", "unsafe integer", "REAL bits"])(
  "refuses %s without hashing a mismatched checkpoint",
  async (defect) => {
    const f = await fixture();
    if (defect === "stale projection")
      await f.db.run(sql`UPDATE namespace SET name='different' WHERE id='n'`);
    if (defect === "extra live row")
      await f.db.run(sql`INSERT INTO scope(id,name) VALUES('extra','extra')`);
    if (defect === "unsafe integer")
      await f.db.run(sql`UPDATE warp SET pos_x=9007199254740995 WHERE id='w'`);
    if (defect === "REAL bits")
      await f.db.run(sql`UPDATE warp SET pos_y=CAST('1.5000000000000002' AS REAL) WHERE id='w'`);
    const digest = vi.spyOn(globalThis.crypto.subtle, "digest");
    await expect(captureRecoveryCheckpoint(f.db, identity, f.read)).rejects.toThrow();
    expect(digest).not.toHaveBeenCalled();
  },
);
it.each(["missing effect set", "wrong count", "wrong before image", "wrong order"])(
  "refuses %s from the trusted reader before hashing",
  async (defect) => {
    const f = await fixture(),
      digest = vi.spyOn(globalThis.crypto.subtle, "digest");
    await expect(
      captureRecoveryCheckpoint(f.db, identity, async (tx) => {
        const value = await f.read(tx);
        if (defect === "missing effect set") value.history.effectSets.pop();
        if (defect === "wrong count") value.selection.effectSets[0].effectCount++;
        if (defect === "wrong before image")
          value.history.effectSets.find((set: any) => set.id === "first").effects[0].before =
            row("wrong");
        if (defect === "wrong order") value.selection.effectSets.reverse();
        return value;
      }),
    ).rejects.toThrow();
    expect(digest).not.toHaveBeenCalled();
  },
);
it.each(["managed shared schema", "managed local schema", "migration history"])(
  "refuses altered %s before invoking the history reader",
  async (defect) => {
    const f = await fixture();
    if (defect === "managed shared schema")
      await f.db.run(sql`CREATE INDEX unexpected_namespace ON namespace(name)`);
    if (defect === "managed local schema")
      await f.db.run(sql`ALTER TABLE taskspace_local ADD COLUMN extra TEXT`);
    if (defect === "migration history")
      await f.db.run(
        sql`DELETE FROM __drizzle_migrations WHERE created_at=(SELECT max(created_at) FROM __drizzle_migrations)`,
      );
    const read = vi.fn(f.read);
    await expect(captureRecoveryCheckpoint(f.db, identity, read)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  },
);
it("refuses temporary schema objects before any reader can shadow managed rows", async () => {
  const f = await fixture(),
    read = vi.fn(f.read);
  const wrapped = createDatabaseAdapter(new Proxy(f.db, {}), {
    write: async () => {
      throw Error("Unexpected write");
    },
    read: (work) =>
      withReadTx(f.db, async (tx) => {
        await tx.values(sql`CREATE TEMP TABLE namespace(id TEXT,name TEXT,is_default INTEGER)`);
        return work(tx as unknown as DatabaseHandle);
      }),
  });
  await expect(captureRecoveryCheckpoint(wrapped, identity, read)).rejects.toThrow(
    "temporary schema",
  );
  expect(read).not.toHaveBeenCalled();
});
it("refuses accessors and serialization hooks in reader results without invoking them", async () => {
  const f = await fixture(),
    getter = vi.fn(() => {
      throw Error("Getter invoked");
    });
  for (const input of [
    Object.defineProperty({ selection }, "history", { enumerable: true, get: getter }),
    { history: f.history, selection, toJSON: getter },
  ])
    await expect(
      captureRecoveryCheckpoint(f.db, identity, async () => input as any),
    ).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
});
it("rejects failed reader and read completion boundaries before hashing, then permits another capture", async () => {
  const f = await fixture(),
    digest = vi.spyOn(globalThis.crypto.subtle, "digest");
  await expect(
    captureRecoveryCheckpoint(f.db, identity, async () => {
      throw Error("Reader failed");
    }),
  ).rejects.toThrow("Reader failed");
  const wrapped = createDatabaseAdapter(new Proxy(f.db, {}), {
    write: async () => {
      throw Error("Unexpected write");
    },
    read: (work) =>
      withReadTx(f.db, async (tx) => {
        await work(tx as unknown as DatabaseHandle);
        throw Error("Read completion failed");
      }),
  });
  await expect(captureRecoveryCheckpoint(wrapped, identity, f.read)).rejects.toThrow(
    "Read completion failed",
  );
  expect(digest).not.toHaveBeenCalled();
  await captureRecoveryCheckpoint(f.db, identity, f.read);
  expect(digest).toHaveBeenCalledTimes(2);
});
it("refuses invalid host identities and a missing reader before opening a database boundary", async () => {
  const f = await fixture();
  let reads = 0;
  const wrapped = createDatabaseAdapter(new Proxy(f.db, {}), {
    write: async () => {
      throw Error("Unexpected write");
    },
    read: async () => {
      reads++;
      throw Error("Unexpected read");
    },
  });
  await expect(
    captureRecoveryCheckpoint(wrapped, { ...identity, schemaId: "unsupported" }, f.read),
  ).rejects.toThrow("schema");
  await expect(captureRecoveryCheckpoint(wrapped, identity, null as any)).rejects.toThrow(
    "history reader",
  );
  expect(reads).toBe(0);
});
