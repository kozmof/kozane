import { expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDB } from "../../test-utils/db.js";
import {
  createDatabaseAdapter,
  withReadTx,
  type DB,
  type DatabaseHandle,
} from "../../../../core/src/database.js";
import { migrations } from "../../../../core/src/generated/migrations.js";
import { localTableNames } from "../../../../core/src/actions/local-tables.js";
import {
  captureLocalRecoverySnapshot,
  parseLocalRecoverySnapshot,
  requireLocalRecoveryIdentity,
  type LocalRecoveryIdentity,
} from "../../../../core/src/actions/local-recovery.js";
type MutableSnapshot = {
  version: number;
  rowEncodingVersion: number;
  identity: { -readonly [K in keyof LocalRecoveryIdentity]: LocalRecoveryIdentity[K] };
  selection: { baselineId: string; effectSetIds: string[] };
  tables: { name: string; rows: Record<string, unknown>[] }[];
};
const keys: LocalRecoveryIdentity = {
  workspaceId: "workspace",
  deviceId: "device",
  epochId: "epoch",
  checkpointId: "checkpoint",
  schemaId: migrations.at(-1)!.id,
};
const selected = { baselineId: "baseline", effectSetIds: ["origin-a", "origin-b"] };
const database = async () => (await createTestDB()) as unknown as DB;
async function seeded() {
  const db = await database();
  await db.run(
    sql`INSERT INTO taskspace_local VALUES('absent','local/🪁' || char(0) || 'file','workspace_relative',9223372036854775807)`,
  );
  await db.run(sql`INSERT INTO taskspace_local VALUES('blob',X'00ff','workspace_relative',1.5)`);
  await db.run(
    sql`INSERT INTO local_file_operation(id,kind,version,taskspace_id,namespace_id,path,path_kind,state,intent,created_at,error) VALUES('pending','taskspace.file',1,'absent','absent-namespace','local/file','workspace_relative','pending','{}',-9223372036854775808,'Original error' || char(0) || '🪁')`,
  );
  await db.run(
    sql`INSERT INTO local_file_operation(id,kind,version,taskspace_id,namespace_id,path,path_kind,state,intent,created_at,abandoned_at,abandon_reason,error) VALUES('abandoned','taskspace.directory',1,'absent','absent-namespace','local/old','workspace_relative','abandoned','{}',0,9007199254740993,'Reviewed','Original failure')`,
  );
  await db.run(
    sql`INSERT INTO local_image_upload(filename,byte_length,sha256,state,created_at,error) VALUES('00000000-0000-4000-8000-000000000001.svg',3,${"a".repeat(64)},'pending',9007199254740993,'Upload interrupted')`,
  );
  await db.run(
    sql`INSERT INTO local_asset_manifest(owner_kind,owner_id,manifest,state,created_at,released_at,release_reason) VALUES('recovery','old-checkpoint','{"version":1,"entries":[]}','released',0,9007199254740993,'Retired')`,
  );
  return db;
}
const capture = (db: DB) => captureLocalRecoverySnapshot(db, keys, async () => selected);
it("captures every local table and retains absent metadata and exact SQLite values", async () => {
  const db = await seeded();
  const snapshot = await capture(db);
  expect(snapshot.identity).toEqual(keys);
  expect(snapshot.selection).toEqual(selected);
  expect(snapshot.tables.map((table) => table.name).sort()).toEqual([...localTableNames].sort());
  const table = (name: string) => snapshot.tables.find((table) => table.name === name)!.rows;
  expect(table("taskspace_local")).toEqual([
    {
      taskspace_id: ["text", "absent"],
      path: ["text", "local/🪁\0file"],
      path_kind: ["text", "workspace_relative"],
      last_seen_at: ["integer", "9223372036854775807"],
    },
    {
      taskspace_id: ["text", "blob"],
      path: ["blob", "00ff"],
      path_kind: ["text", "workspace_relative"],
      last_seen_at: ["real", "3ff8000000000000"],
    },
  ]);
  expect(table("local_file_operation").find((row) => row.id[1] === "pending")).toMatchObject({
    created_at: ["integer", "-9223372036854775808"],
    confirmed_at: ["null"],
    error: ["text", "Original error\0🪁"],
  });
  expect(table("local_file_operation").find((row) => row.id[1] === "abandoned")).toMatchObject({
    abandoned_at: ["integer", "9007199254740993"],
    abandon_reason: ["text", "Reviewed"],
  });
  expect(table("local_image_upload")[0].created_at).toEqual(["integer", "9007199254740993"]);
  expect(table("local_asset_manifest")[0].released_at).toEqual(["integer", "9007199254740993"]);
  expect(requireLocalRecoveryIdentity(JSON.parse(JSON.stringify(snapshot)), keys)).toEqual(
    snapshot,
  );
});

it("includes empty local tables before the first local write", async () => {
  const snapshot = await capture(await database());
  expect(snapshot.tables).toHaveLength(11);
  expect(snapshot.tables.every((table) => table.rows.length === 0)).toBe(true);
});

it("reads the checkpoint and local tables inside exactly one adapter read boundary", async () => {
  const db = await seeded();
  let reads = 0;
  let active = false;
  const reader = vi.fn(async () => {
    expect(active).toBe(true);
    return selected;
  });
  const wrapped = createDatabaseAdapter(new Proxy(db, {}), {
    write: async () => {
      throw new Error("Unexpected write");
    },
    read: (operation) => {
      reads++;
      return withReadTx(db, async (tx) => {
        active = true;
        try {
          return await operation(tx as unknown as DatabaseHandle);
        } finally {
          active = false;
        }
      });
    },
  });
  const input = { ...keys };
  const pending = captureLocalRecoverySnapshot(wrapped, input, reader);
  input.deviceId = "changed";
  const snapshot = await pending;
  expect(snapshot.identity).toEqual(keys);
  expect(reads).toBe(1);
  expect(reader).toHaveBeenCalledTimes(1);
});

it("canonicalizes table, row and column order while preserving materialization order", async () => {
  const snapshot = await capture(await seeded());
  const input = JSON.parse(JSON.stringify(snapshot));
  input.tables.reverse();
  for (const table of input.tables) {
    table.rows.reverse();
    table.rows = table.rows.map((row: object) => Object.fromEntries(Object.entries(row).reverse()));
  }
  const parsed = parseLocalRecoverySnapshot(input);
  expect(JSON.stringify(parsed)).toBe(JSON.stringify(snapshot));
  input.identity.workspaceId = "changed";
  input.selection.effectSetIds.reverse();
  input.tables.length = 0;
  expect(parsed).toEqual(snapshot);
  expect(Object.isFrozen(parsed.tables[0].rows[0])).toBe(true);
  expect(parsed.selection.effectSetIds).toEqual(["origin-a", "origin-b"]);
});

it.each(["workspaceId", "deviceId", "epochId", "checkpointId", "schemaId"] as const)(
  "refuses a mismatched %s before local installation is considered",
  async (field) => {
    const snapshot = await capture(await database());
    expect(() => requireLocalRecoveryIdentity(snapshot, { ...keys, [field]: "other" })).toThrow();
  },
);

it.each([
  (value: MutableSnapshot) => {
    value.version = 2;
  },
  (value: MutableSnapshot) => {
    value.rowEncodingVersion = 2;
  },
  (value: MutableSnapshot) => {
    value.identity.checkpointId = " ";
  },
  (value: MutableSnapshot) => {
    value.identity.deviceId = "bad\0id";
  },
  (value: MutableSnapshot) => {
    value.identity.workspaceId = "\ud800";
  },
  (value: MutableSnapshot) => {
    value.tables.pop();
  },
  (value: MutableSnapshot) => {
    value.tables.push(value.tables[0]);
  },
  (value: MutableSnapshot) => {
    value.tables[0].name = "namespace";
  },
  (value: MutableSnapshot) => {
    const table = value.tables.find((table) => table.rows.length)!;
    table.rows.push(table.rows[0]);
  },
  (value: MutableSnapshot) => {
    delete value.tables[0].rows[0].created_at;
  },
  (value: MutableSnapshot) => {
    value.tables[0].rows[0].extra = ["null"];
  },
  (value: MutableSnapshot) => {
    value.tables[0].rows[0].owner_id = ["null"];
  },
  (value: MutableSnapshot) => {
    value.tables[0].rows[0].created_at = ["integer", "1\n"];
  },
  (value: MutableSnapshot) => {
    value.selection.effectSetIds.push("origin-a");
  },
  (value: MutableSnapshot) => {
    value.selection.effectSetIds.push("");
  },
] as const)(
  "refuses incomplete or malformed transport %# without changing its source",
  async (corrupt) => {
    const db = await seeded();
    const before = await capture(db);
    const value = JSON.parse(JSON.stringify(before));
    corrupt(value);
    expect(() => parseLocalRecoverySnapshot(value)).toThrow();
    expect(await capture(db)).toEqual(before);
  },
);

it("refuses accessors and serialization hooks without invoking them", async () => {
  const snapshot = await capture(await seeded());
  const hook = vi.fn();
  const getter = Object.defineProperty({ ...snapshot }, "identity", {
    enumerable: true,
    get: hook,
  });
  expect(() => parseLocalRecoverySnapshot(getter)).toThrow();
  expect(() => parseLocalRecoverySnapshot({ ...snapshot, toJSON: hook })).toThrow();
  const entry = Object.defineProperty([snapshot.tables[0]], "0", { enumerable: true, get: hook });
  expect(() => parseLocalRecoverySnapshot({ ...snapshot, tables: entry })).toThrow();
  expect(hook).not.toHaveBeenCalled();
});

it.each(["missing", "extra-column", "malformed-text"] as const)(
  "refuses %s source data without returning a partial snapshot",
  async (failure) => {
    const db = await seeded();
    if (failure === "missing") await db.run(sql`DROP TABLE local_asset_manifest`);
    if (failure === "extra-column")
      await db.run(sql`ALTER TABLE taskspace_local ADD COLUMN unrecorded TEXT`);
    if (failure === "malformed-text")
      await db.run(
        sql`UPDATE taskspace_local SET path=CAST(X'80' AS TEXT) WHERE taskspace_id='absent'`,
      );
    const before = await db.values(
      sql`SELECT taskspace_id,hex(path),CAST(last_seen_at AS TEXT) FROM taskspace_local ORDER BY taskspace_id`,
    );
    await expect(capture(db)).rejects.toThrow();
    expect(
      await db.values(
        sql`SELECT taskspace_id,hex(path),CAST(last_seen_at AS TEXT) FROM taskspace_local ORDER BY taskspace_id`,
      ),
    ).toEqual(before);
  },
);

it("preserves local state and permits a later capture after a checkpoint reader fails", async () => {
  const db = await seeded();
  const before = await capture(db);
  await expect(
    captureLocalRecoverySnapshot(db, keys, async () => {
      throw new Error("Checkpoint unavailable");
    }),
  ).rejects.toThrow("Checkpoint unavailable");
  expect(await capture(db)).toEqual(before);
});
