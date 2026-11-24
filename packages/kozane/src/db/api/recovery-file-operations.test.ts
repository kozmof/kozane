import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import {
  createDatabaseAdapter,
  withTx,
  withReadTx,
  type DatabaseHandle,
} from "@kozane/core/database";
import * as recovery from "@kozane/core/recovery";
import { createTestDB } from "../../test-utils/db.js";
import { identity } from "../../test-utils/retained-recovery-assets.js";
import { stagedRecoveryFileOperations } from "../../test-utils/recovery-file-operations.js";
beforeEach(async () => {
  if (!crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function fixture() {
  const f = await stagedRecoveryFileOperations(createTestDB, async (db) => {
    for (const statement of [
      "INSERT INTO taskspace_local VALUES('absent','device/🪁'||char(0)||'path','workspace_relative',9223372036854775807)",
      "INSERT INTO local_file_operation(id,kind,version,taskspace_id,namespace_id,path,path_kind,state,intent,created_at,error) VALUES('a','taskspace.claim',1,'absent','missing','claim','workspace_relative','pending','{}',9223372036854775807,'retained '||char(0)||'error')",
      "INSERT INTO local_file_operation(id,kind,version,taskspace_id,namespace_id,path,path_kind,state,intent,created_at) VALUES('b','taskspace.file',1,'absent','missing','file','absolute','pending','{\"raw\":\"🪁\"}',-9223372036854775808)",
      "INSERT INTO local_file_operation(id,kind,version,taskspace_id,namespace_id,path,path_kind,state,intent,created_at) VALUES('c','taskspace.directory',1,'absent','missing','directory','workspace_relative','pending','{}',1.5)",
      "INSERT INTO local_file_operation(id,kind,version,taskspace_id,namespace_id,path,path_kind,state,intent,created_at,confirmed_at) VALUES('confirmed','taskspace.file',1,'absent','missing','file','workspace_relative','confirmed','{}',1,2)",
      "INSERT INTO local_file_operation(id,kind,version,taskspace_id,namespace_id,path,path_kind,state,intent,created_at,abandoned_at,abandon_reason,error) VALUES('abandoned','taskspace.directory',1,'absent','missing','dir','workspace_relative','abandoned','{}',1,2,'Reviewed','retained')",
    ])
      await db.run(sql.raw(statement));
  });
  const inspect = (
    options: recovery.PendingRecoveryFileOperationOptions = {},
    db = f.destination,
    checkpoint: unknown = f.checkpoint,
    expected = identity,
  ) => recovery.inspectPendingRecoveryFileOperations(db, checkpoint, expected, options);
  return { ...f, inspect };
}
it("reads exact restored pending rows, retained errors and unsafe timestamps without Date conversions", async () => {
  const f = await fixture(),
    page = await f.inspect();
  expect(page.total).toBe("3");
  expect(page.offset).toBe(0);
  expect(page.limit).toBe(25);
  expect(page.nextOffset).toBeNull();
  expect(page.operations.map((row) => row.id)).toEqual([
    ["text", "a"],
    ["text", "b"],
    ["text", "c"],
  ]);
  expect(page.operations.map((row) => row.created_at)).toEqual([
    ["integer", "9223372036854775807"],
    ["integer", "-9223372036854775808"],
    ["real", "3ff8000000000000"],
  ]);
  expect(page.operations[0].error).toEqual(["text", "retained \0error"]);
  expect(page.operations[1].intent).toEqual(["text", '{"raw":"🪁"}']);
  expect(page.operations[0].taskspace_id).toEqual(["text", "absent"]);
});
it("paginates deterministically by journal identity and returns exact totals", async () => {
  const f = await fixture(),
    first = await f.inspect({ limit: 2 }),
    second = await f.inspect({ limit: 2, offset: first.nextOffset! });
  expect(first.nextOffset).toBe(2);
  expect(first.total).toBe("3");
  expect(second.total).toBe("3");
  expect(second.operations.map((row) => row.id)).toEqual([["text", "c"]]);
  expect(second.nextOffset).toBeNull();
  expect((await f.inspect({ offset: 9 })).operations).toEqual([]);
  expect((await f.inspect({ offset: 9 })).nextOffset).toBeNull();
});
it("reflects current journal edits without restoring old pending work", async () => {
  const f = await fixture();
  await f.destination.run(
    sql`UPDATE local_file_operation SET state='confirmed',confirmed_at=3,error=NULL WHERE id='a'`,
  );
  await f.destination.run(
    sql`UPDATE local_file_operation SET intent='Later evidence',error='Retained new error' WHERE id='b'`,
  );
  const page = await f.inspect();
  expect(page.total).toBe("2");
  expect(page.operations[0].intent).toEqual(["text", "Later evidence"]);
  expect(page.operations[0].error).toEqual(["text", "Retained new error"]);
  expect((await f.inspect()).operations).toEqual(page.operations);
});
it("can read within the caller's consistent read transaction", async () => {
  const f = await fixture();
  expect(
    await withReadTx(f.destination, (tx) =>
      recovery.readPendingRecoveryFileOperations(tx, f.checkpoint, identity, { limit: 2 }),
    ),
  ).toEqual(await f.inspect({ limit: 2 }));
});
it("uses only the read hook and preserves all local rows and installation authority", async () => {
  const f = await fixture(),
    write = vi.fn(() => {
      throw Error("Unexpected write");
    }),
    before = await recovery.captureLocalRecoverySnapshot(
      f.destination,
      identity,
      async () => f.snapshot.selection,
    );
  const wrapped = createDatabaseAdapter(new Proxy(f.destination, {}), {
    read: (work) => withReadTx(f.destination, (tx) => work(tx as unknown as DatabaseHandle)),
    write,
  });
  await f.inspect({}, wrapped);
  expect(write).not.toHaveBeenCalled();
  expect(
    await recovery.captureLocalRecoverySnapshot(
      f.destination,
      identity,
      async () => f.snapshot.selection,
    ),
  ).toEqual(before);
  expect(await recovery.inspectLocalRecoveryInstallation(f.destination)).toEqual(f.checkpoint);
});
it.each(["workspaceId", "deviceId", "epochId", "checkpointId", "schemaId"] as const)(
  "refuses mismatched %s before reading journal evidence",
  async (field) => {
    const f = await fixture(),
      expected = { ...identity, [field]: "other" };
    await expect(f.inspect({}, f.destination, f.checkpoint, expected)).rejects.toThrow();
  },
);
it("requires matching complete local staging and refuses another bundle", async () => {
  const f = await fixture(),
    empty = await createTestDB();
  await expect(f.inspect({}, empty)).rejects.toThrow("matching local installation");
  await expect(
    f.inspect({}, f.destination, { ...f.checkpoint, sha256: "b".repeat(64) }),
  ).rejects.toThrow("matching local installation");
});
it.each([
  { limit: 0 },
  { limit: 101 },
  { limit: 1.5 },
  { limit: NaN },
  { offset: -1 },
  { offset: 1.5 },
  { offset: Number.MAX_SAFE_INTEGER + 1 },
  { limit: null },
  { offset: null },
])("refuses invalid page options %j before adapter work", async (options) => {
  const f = await fixture(),
    read = vi.fn(() => {
      throw Error("Unexpected read");
    }),
    wrapped = createDatabaseAdapter(new Proxy(f.destination, {}), {
      read,
      write: () => {
        throw Error("Unexpected write");
      },
    });
  await expect(f.inspect(options as any, wrapped)).rejects.toThrow("limit from 1 to 100");
  expect(read).not.toHaveBeenCalled();
});
it.each(["table", "guard", "history"])("refuses unsupported destination %s", async (kind) => {
  const f = await fixture();
  if (kind === "table") await f.destination.run(sql`CREATE TABLE unsupported(id TEXT)`);
  if (kind === "guard")
    await f.destination.run(sql`DROP TRIGGER local_recovery_installation_no_update`);
  if (kind === "history")
    await f.destination.run(
      sql`DELETE FROM __drizzle_migrations WHERE created_at=(SELECT max(created_at) FROM __drizzle_migrations)`,
    );
  await expect(f.inspect()).rejects.toThrow();
});
it("refuses temporary shadow tables in the inspection transaction", async () => {
  const f = await fixture(),
    wrapped = createDatabaseAdapter(new Proxy(f.destination, {}), {
      read: (work) =>
        withTx(f.destination, async (tx) => {
          await tx.run(sql`CREATE TEMP TABLE local_file_operation(id TEXT)`);
          return work(tx);
        }),
      write: () => {
        throw Error("Unexpected write");
      },
    });
  await expect(f.inspect({}, wrapped)).rejects.toThrow("temporary schema objects");
});
it("owns identity, checkpoint and page options before the adapter yields", async () => {
  const f = await fixture(),
    options = { limit: 1, offset: 0 },
    expected = { ...identity },
    checkpoint = structuredClone(f.checkpoint) as any;
  const wrapped = createDatabaseAdapter(new Proxy(f.destination, {}), {
    read: (work) => {
      options.limit = 0;
      options.offset = 2;
      expected.deviceId = "Changed";
      checkpoint.sha256 = "b".repeat(64);
      return withReadTx(f.destination, (tx) => work(tx as unknown as DatabaseHandle));
    },
    write: () => {
      throw Error("Unexpected write");
    },
  });
  const page = await f.inspect(options, wrapped, checkpoint, expected);
  expect(page.limit).toBe(1);
  expect(page.offset).toBe(0);
  expect(page.operations[0].id).toEqual(["text", "a"]);
  expect(page.checkpoint).toEqual(f.checkpoint);
});
it("refuses success after read boundary completion fails", async () => {
  const f = await fixture(),
    wrapped = createDatabaseAdapter(new Proxy(f.destination, {}), {
      read: async (work) => {
        await withReadTx(f.destination, (tx) => work(tx as unknown as DatabaseHandle));
        throw Error("Read completion failed");
      },
      write: () => {
        throw Error("Unexpected write");
      },
    });
  await expect(f.inspect({}, wrapped)).rejects.toThrow("Read completion failed");
  expect((await f.inspect()).total).toBe("3");
});
it("returns immutable evidence without normalizing opaque intent bytes or non-TEXT identifiers", async () => {
  const f = await fixture();
  await f.destination.run(
    sql`INSERT INTO local_file_operation(id,kind,version,taskspace_id,namespace_id,path,path_kind,state,intent,created_at) VALUES(x'ff','taskspace.file',1,'absent','missing','file','workspace_relative','pending',char(65279)||'opaque'||char(0)||'🪁',1)`,
  );
  const page = await f.inspect();
  expect(page.total).toBe("4");
  expect(page.operations.at(-1)!.id).toEqual(["blob", "ff"]);
  expect(page.operations.at(-1)!.intent).toEqual(["text", "\ufeffopaque\0🪁"]);
  expect(Object.isFrozen(page)).toBe(true);
  expect(Object.isFrozen(page.operations)).toBe(true);
  expect(Object.isFrozen(page.operations[0])).toBe(true);
  expect(Object.isFrozen(page.operations[0].id)).toBe(true);
});
