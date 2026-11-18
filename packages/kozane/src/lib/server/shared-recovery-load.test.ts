import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { migrations } from "@kozane/core/migrations";
import {
  captureLocalRecoveryCheckpoint,
  rememberLocalRecoveryCheckpoint,
  parseSharedRecoveryProjection,
  describeSharedRecoveryHistory,
  rememberSharedRecoveryCheckpoint,
} from "@kozane/core/recovery";
import { createTestDB } from "../../test-utils/db.js";
import { openDb } from "../../db/client.js";
import {
  saveRegisteredSharedRecoveryPayload,
  loadRegisteredSharedRecoveryPayload,
} from "./shared-recovery-payload.js";
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));
let root: string;
let db: Awaited<ReturnType<typeof createTestDB>>;
let local: Awaited<ReturnType<typeof captureLocalRecoveryCheckpoint>>;
let shared: Awaited<ReturnType<typeof describeSharedRecoveryHistory>>;
const identity = {
  workspaceId: "workspace",
  deviceId: "device",
  epochId: "epoch",
  checkpointId: "checkpoint",
  schemaId: migrations.at(-1)!.id,
};
const factory = () => createTestDB();
const directory = () => join(root, ".kozane", "recovery", "shared-history");
const published = () => join(directory(), `${shared.checkpoint.sha256}.json`);
const temporary = () => join(directory(), `.pending-${shared.checkpoint.sha256}.json`);
const bytes = () => Buffer.from(JSON.stringify(shared.payload));
const options = () => ({
  root,
  db,
  expected: identity,
  maxBytes: shared.checkpoint.byteLength,
  createValidationDatabase: factory,
});
const load = (createValidationDatabase = factory) =>
  loadRegisteredSharedRecoveryPayload({ ...options(), createValidationDatabase });
beforeEach(async () => {
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
  root = await fs.mkdtemp(join(tmpdir(), "kozane-shared-load-"));
  db = await createTestDB(join(root, "db.sqlite"));
  const name = "\ufeffstored\0🪁";
  await db.run(sql`INSERT INTO namespace(id,name) VALUES('n',${name})`);
  await db.run(
    sql`INSERT INTO warp(id,namespace_id,pos_x,pos_y) VALUES('w','n',9007199254740993,1.5)`,
  );
  local = await captureLocalRecoveryCheckpoint(db, identity, async () => ({
    baselineId: "baseline",
    effectSetIds: [],
  }));
  await rememberLocalRecoveryCheckpoint(db, local.checkpoint);
  const projection = parseSharedRecoveryProjection({
    version: 1,
    rowEncodingVersion: 1,
    schemaId: identity.schemaId,
    tables: [
      "namespace",
      "partition",
      "layer",
      "scope",
      "taskspace",
      "inventory",
      "card",
      "glue",
      "glue_rel",
      "scope_rel",
      "scope_area",
      "warp",
    ].map((table) => ({
      name: table,
      rows:
        table === "namespace"
          ? [{ id: ["text", "n"], name: ["text", name], is_default: ["integer", "0"] }]
          : table === "warp"
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
  shared = await describeSharedRecoveryHistory(
    { baseline: { id: "baseline", projection }, effectSets: [] },
    identity,
    { baselineId: "baseline", effectSets: [] },
  );
  await rememberSharedRecoveryCheckpoint(db, shared.checkpoint);
  await saveRegisteredSharedRecoveryPayload({ ...options(), input: shared.payload });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await fs.rm(root, { recursive: true, force: true });
});

it("reopens exact shared history and its original binding without filesystem writes or installation", async () => {
  const reopened = await openDb(`file:${join(root, "db.sqlite")}`);
  const before = await db.values(
    sql`SELECT descriptor,local_descriptor,CAST(created_at AS TEXT) FROM local_recovery_shared_history`,
  );
  const mkdir = vi.spyOn(fs, "mkdir");
  const link = vi.spyOn(fs, "link");
  const unlink = vi.spyOn(fs, "unlink");
  const open = vi.spyOn(fs, "open");
  try {
    const result = await loadRegisteredSharedRecoveryPayload({ ...options(), db: reopened.db });
    expect(result).toEqual({
      payload: shared.payload,
      projection: shared.projection,
      binding: { checkpoint: shared.checkpoint, localCheckpoint: local.checkpoint },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.payload.history.baseline.projection.tables[0])).toBe(true);
  } finally {
    reopened.close();
  }
  expect(mkdir).not.toHaveBeenCalled();
  expect(link).not.toHaveBeenCalled();
  expect(unlink).not.toHaveBeenCalled();
  expect(
    open.mock.calls.every(
      (call) =>
        typeof call[1] === "number" && (call[1] & (constants.O_WRONLY | constants.O_RDWR)) === 0,
    ),
  ).toBe(true);
  expect(await fs.readFile(published())).toEqual(bytes());
  expect(
    await db.values(
      sql`SELECT descriptor,local_descriptor,CAST(created_at AS TEXT) FROM local_recovery_shared_history`,
    ),
  ).toEqual(before);
});

it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])(
  "refuses invalid input limit %s before opening files",
  async (maxBytes) => {
    const open = vi.spyOn(fs, "open");
    const create = vi.fn(factory);
    await expect(
      loadRegisteredSharedRecoveryPayload({
        ...options(),
        maxBytes,
        createValidationDatabase: create,
      }),
    ).rejects.toThrow("positive safe integer");
    expect(open).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  },
);

it("refuses a registered payload above the host size limit before file allocation", async () => {
  const open = vi.spyOn(fs, "open");
  const create = vi.fn(factory);
  await expect(
    loadRegisteredSharedRecoveryPayload({
      ...options(),
      maxBytes: shared.checkpoint.byteLength - 1,
      createValidationDatabase: create,
    }),
  ).rejects.toThrow("exceeds read limit");
  expect(open).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});

it.each(["temporary-only", "both"])("leaves %s data untouched for review", async (state) => {
  if (state === "temporary-only") await fs.rename(published(), temporary());
  else await fs.writeFile(temporary(), bytes());
  const open = vi.spyOn(fs, "open");
  await expect(load()).rejects.toThrow("needs review");
  expect(open).not.toHaveBeenCalled();
  expect(await fs.readFile(temporary())).toEqual(bytes());
});

it.each(["missing-shared", "missing-local", "changed-local"])(
  "refuses %s expectations before file reads",
  async (change) => {
    if (change === "missing-shared") await db.run(sql`DELETE FROM local_recovery_shared_history`);
    if (change === "missing-local") await db.run(sql`DELETE FROM local_recovery_checkpoint`);
    if (change === "changed-local")
      await db.run(
        sql`UPDATE local_recovery_checkpoint SET descriptor=${JSON.stringify({ ...local.checkpoint, sha256: "b".repeat(64) })}`,
      );
    const open = vi.spyOn(fs, "open");
    const create = vi.fn(factory);
    await expect(load(create)).rejects.toThrow();
    expect(open).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  },
);

it.each(["missing", "corrupt", "symlink", "unsafe-parent"])(
  "refuses %s bytes before SQL validation",
  async (state) => {
    if (state === "missing") await fs.unlink(published());
    if (state === "corrupt") await fs.writeFile(published(), Buffer.alloc(bytes().length, 120));
    if (state === "symlink") {
      await fs.rename(published(), join(root, "outside"));
      await fs.symlink(join(root, "outside"), published());
    }
    if (state === "unsafe-parent") {
      await fs.rename(directory(), join(root, "outside"));
      await fs.symlink(join(root, "outside"), directory());
    }
    const create = vi.fn(factory);
    await expect(load(create)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  },
);

async function replaceBytes(content: Buffer) {
  const checkpoint = {
    ...shared.checkpoint,
    sha256: createHash("sha256").update(content).digest("hex"),
    byteLength: content.byteLength,
  };
  await db.run(
    sql`UPDATE local_recovery_shared_history SET descriptor=${JSON.stringify(checkpoint)}`,
  );
  await fs.writeFile(join(directory(), `${checkpoint.sha256}.json`), content);
}
it.each(["utf8", "json", "noncanonical"])(
  "refuses hash-matching invalid %s without SQL allocation",
  async (state) => {
    await replaceBytes(
      state === "utf8"
        ? Buffer.from([255, 254])
        : state === "json"
          ? Buffer.from("{invalid")
          : Buffer.from(JSON.stringify(shared.payload, null, 2)),
    );
    const create = vi.fn(factory);
    await expect(
      loadRegisteredSharedRecoveryPayload({
        ...options(),
        maxBytes: 100000,
        createValidationDatabase: create,
      }),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  },
);

it("still checks SQL affinity after a canonical file hash matches", async () => {
  const input = JSON.parse(JSON.stringify(shared.payload));
  input.history.baseline.projection.tables.find(
    (table: { name: string }) => table.name === "warp",
  ).rows[0].pos_y = ["real", "3ff0000000000000"];
  const changed = await describeSharedRecoveryHistory(
    input.history,
    identity,
    shared.payload.selection,
  );
  await replaceBytes(Buffer.from(JSON.stringify(changed.payload)));
  const target = await factory();
  const create = vi.fn(async () => target);
  await expect(
    loadRegisteredSharedRecoveryPayload({
      ...options(),
      maxBytes: 100000,
      createValidationDatabase: create,
    }),
  ).rejects.toThrow("differs from projection");
  expect(create).toHaveBeenCalledTimes(1);
  expect(await target.values(sql`SELECT 1 FROM namespace`)).toEqual([]);
  expect(await target.values(sql`SELECT 1 FROM warp`)).toEqual([]);
});

it.each([
  "removed",
  "rewritten",
  "replaced",
  "new-temporary",
  "coherent-binding-replacement",
  "shared-removed",
])("refuses %s during isolated SQL validation", async (change) => {
  const target = await factory();
  const create = vi.fn(async () => {
    if (change === "removed") await fs.unlink(published());
    if (change === "rewritten") {
      await fs.writeFile(published(), bytes());
      await fs.utimes(published(), new Date(2000), new Date(2000));
    }
    if (change === "replaced") {
      const next = join(directory(), "next.json");
      await fs.writeFile(next, bytes());
      await fs.rename(next, published());
    }
    if (change === "new-temporary") await fs.writeFile(temporary(), bytes());
    if (change === "coherent-binding-replacement") {
      const replacement = JSON.stringify({ ...local.checkpoint, sha256: "b".repeat(64) });
      await db.run(sql`UPDATE local_recovery_checkpoint SET descriptor=${replacement}`);
      await db.run(sql`UPDATE local_recovery_shared_history SET local_descriptor=${replacement}`);
    }
    if (change === "shared-removed") await db.run(sql`DELETE FROM local_recovery_shared_history`);
    return target;
  });
  await expect(load(create)).rejects.toThrow();
  expect(create).toHaveBeenCalledTimes(1);
  expect(await target.values(sql`SELECT 1 FROM namespace`)).toEqual([]);
});

it("keeps SQL validation outside source writer boundaries and owns the expected identity", async () => {
  const expected = { ...identity };
  const result = await loadRegisteredSharedRecoveryPayload({
    ...options(),
    expected,
    createValidationDatabase: async () => {
      expected.deviceId = "changed";
      const later = await captureLocalRecoveryCheckpoint(
        db,
        { ...identity, checkpointId: "later" },
        async () => ({ baselineId: "baseline", effectSetIds: [] }),
      );
      await rememberLocalRecoveryCheckpoint(db, later.checkpoint);
      return factory();
    },
  });
  expect(result.payload).toEqual(shared.payload);
});
