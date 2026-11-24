import { beforeEach, afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as sync from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { sql } from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import { createDatabaseAdapter, withReadTx, type DatabaseHandle } from "@kozane/core/database";
import * as recovery from "@kozane/core/recovery";
import { openDb, type OpenedDb } from "../../db/client.js";
import { migrateNodeDatabase } from "../../db/tx.js";
import { identity } from "../../test-utils/retained-recovery-assets.js";
import { stagedRecoveryFileOperations } from "../../test-utils/recovery-file-operations.js";
import { inspectStagedRecoveryFileOperations } from "./recovery-file-operations.js";
import { contentHash, localClaimIntent } from "./local-file-operations.js";
import { TASKSPACE_MARKER_FILE, taskspaceMarkerText } from "../taskspace-marker.js";
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs") & { default: typeof import("node:fs") }>();
  const overrides = {
    openSync: vi.fn(actual.openSync),
    lstatSync: vi.fn(actual.lstatSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    mkdirSync: vi.fn(actual.mkdirSync),
    renameSync: vi.fn(actual.renameSync),
    unlinkSync: vi.fn(actual.unlinkSync),
    rmSync: vi.fn(actual.rmSync),
  };
  return { ...actual, ...overrides, default: { ...actual.default, ...overrides } };
});
let root: string;
const opened: OpenedDb[] = [];
beforeEach(async () => {
  vi.clearAllMocks();
  if (!crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
  root = await fs.mkdtemp(join(tmpdir(), "kozane-staged-file-inspection-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const db of opened.splice(0)) db.close();
  await fs.rm(root, { recursive: true, force: true });
});
const factory = async (url = ":memory:") => {
  const value = await openDb(url);
  opened.push(value);
  await migrateNodeDatabase(value.db, { migrationsFolder: resolve("drizzle") });
  return value.db;
};
async function fixture(destinationUrl?: string) {
  let created = 0;
  await fs.mkdir(join(root, "claim"));
  await fs.writeFile(
    join(root, "claim", TASKSPACE_MARKER_FILE),
    taskspaceMarkerText("claim-task", "missing-namespace", true),
  );
  await fs.mkdir(join(root, "files"));
  await fs.writeFile(join(root, "files", "note.txt"), "Expected content");
  const f = await stagedRecoveryFileOperations(
    () => factory(++created === 2 ? destinationUrl : undefined),
    async (db) => {
      for (const [id, kind, path, intent, created, error] of [
        [
          "claim",
          "taskspace.claim",
          "claim",
          localClaimIntent("claim-task", "missing-namespace", {
            adoptExisting: false,
            parentsInside: false,
            ownIfCreated: true,
          }),
          "9223372036854775807",
          "retained error",
        ],
        [
          "directory",
          "taskspace.directory",
          "removed",
          JSON.stringify({
            operation: "remove",
            before: {},
            directory: { dev: "0", ino: "0", markerHash: "a".repeat(64) },
          }),
          "9007199254740993",
          null,
        ],
        [
          "file",
          "taskspace.file",
          "files/note.txt",
          JSON.stringify({
            operation: "save-file",
            requestedPath: "note.txt",
            contentHash: contentHash("Expected content"),
            signature: null,
          }),
          "-9223372036854775808",
          null,
        ],
      ] as const)
        await db.run(
          sql`INSERT INTO local_file_operation(id,kind,version,taskspace_id,namespace_id,path,path_kind,state,intent,created_at,error) VALUES(${id},${kind},1,'claim-task','missing-namespace',${path},'workspace_relative','pending',${intent},CAST(${created} AS INTEGER),${error})`,
        );
    },
  );
  const options = { db: f.destination, root, checkpoint: f.checkpoint, expected: identity };
  return { ...f, options, inspect: () => inspectStagedRecoveryFileOperations(options) };
}
it("inspects restored claims, files and directories without writes or automatic confirmation", async () => {
  const f = await fixture(),
    before = await recovery.inspectPendingRecoveryFileOperations(
      f.destination,
      f.checkpoint,
      identity,
    );
  const write = vi.fn(() => {
      throw Error("Unexpected database write");
    }),
    wrapped = createDatabaseAdapter(new Proxy(f.destination, {}), {
      read: (work) => withReadTx(f.destination, (tx) => work(tx as unknown as DatabaseHandle)),
      write,
    });
  const mutators = ["writeFileSync", "mkdirSync", "renameSync", "unlinkSync", "rmSync"] as const,
    spies = mutators.map((name) => vi.mocked(sync[name]));
  const open = vi.mocked(sync.openSync);
  const report = await inspectStagedRecoveryFileOperations({ ...f.options, db: wrapped });
  expect(report.observations.map((entry) => [entry.record.id, entry.observation])).toEqual([
    [["text", "claim"], "matching-marker"],
    [["text", "directory"], "source-absent"],
    [["text", "file"], "matching-content"],
  ]);
  expect(report.observations[0].record.created_at).toEqual(["integer", "9223372036854775807"]);
  expect(report.observations[0].record.error).toEqual(["text", "retained error"]);
  expect(write).not.toHaveBeenCalled();
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  expect(
    open.mock.calls.every(
      (call) =>
        typeof call[1] === "number" &&
        (call[1] & (sync.constants.O_WRONLY | sync.constants.O_RDWR)) === 0,
    ),
  ).toBe(true);
  expect(
    await recovery.inspectPendingRecoveryFileOperations(f.destination, f.checkpoint, identity),
  ).toEqual(before);
  expect(await fs.readFile(join(root, "files", "note.txt"), "utf8")).toBe("Expected content");
  expect(await fs.readdir(root)).toEqual(["claim", "files"]);
  expect(Object.isFrozen(report)).toBe(true);
  expect(Object.isFrozen(report.observations)).toBe(true);
  expect(Object.isFrozen(report.observations[0])).toBe(true);
});
it("reports changed file contents without changing retained pending evidence", async () => {
  const f = await fixture();
  await fs.writeFile(join(root, "files", "note.txt"), "Later content");
  const report = await f.inspect();
  expect(report.observations.at(-1)!.observation).toBe("different-content");
  expect(report.observations.at(-1)!.record.state).toEqual(["text", "pending"]);
  expect(await fs.readFile(join(root, "files", "note.txt"), "utf8")).toBe("Later content");
});
it("bounds each report and leaves later pending evidence for another page", async () => {
  const f = await fixture(),
    first = await inspectStagedRecoveryFileOperations({ ...f.options, limit: 1 }),
    second = await inspectStagedRecoveryFileOperations({
      ...f.options,
      limit: 1,
      offset: first.nextOffset!,
    });
  expect(first.total).toBe("3");
  expect(first.observations).toHaveLength(1);
  expect(first.observations[0].record.id).toEqual(["text", "claim"]);
  expect(second.observations[0].record.id).toEqual(["text", "directory"]);
  expect(second.nextOffset).toBe(2);
});
it("does not inspect absolute paths unless the host explicitly enables them", async () => {
  const f = await fixture(),
    absolute = join(root, "absolute.txt");
  await fs.writeFile(absolute, "Expected content");
  await f.destination.run(
    sql`UPDATE local_file_operation SET path=${absolute},path_kind='absolute' WHERE id='file'`,
  );
  const open = vi.mocked(sync.openSync);
  let report = await f.inspect();
  expect(report.observations.at(-1)!.observation).toBe("absolute-path-not-inspected");
  expect(open.mock.calls.some((call) => call[0] === absolute)).toBe(false);
  report = await inspectStagedRecoveryFileOperations({ ...f.options, allowAbsolutePaths: true });
  expect(report.observations.at(-1)!.observation).toBe("matching-content");
  expect(open.mock.calls.some((call) => call[0] === absolute)).toBe(true);
});
it("refuses symlink evidence without reading its target", async () => {
  const f = await fixture();
  await fs.unlink(join(root, "files", "note.txt"));
  await fs.writeFile(join(root, "target.txt"), "Expected content");
  await fs.symlink(join(root, "target.txt"), join(root, "files", "note.txt"));
  const open = vi.mocked(sync.openSync),
    report = await f.inspect();
  expect(report.observations.at(-1)!.observation).toBe("unsafe-path");
  expect(
    open.mock.calls.some(
      (call) => call[0] === join(root, "target.txt") || call[0] === join(root, "files", "note.txt"),
    ),
  ).toBe(false);
});
it("reports malformed intents and preserves their exact bytes", async () => {
  const f = await fixture();
  await f.destination.run(
    sql`UPDATE local_file_operation SET intent=char(65279)||'opaque'||char(0)||'🪁' WHERE id='file'`,
  );
  const report = await f.inspect();
  expect(report.observations.at(-1)!.observation).toBe("invalid-intent");
  expect(report.observations.at(-1)!.record.intent).toEqual(["text", "\ufeffopaque\0🪁"]);
});
it("returns unsupported storage classes as evidence without inventing an operation", async () => {
  const f = await fixture();
  await f.destination.run(sql`UPDATE local_file_operation SET path=x'ff' WHERE id='file'`);
  const report = await f.inspect();
  expect(report.observations.at(-1)!.observation).toBe("unsupported-record");
  expect(report.observations.at(-1)!.record.path).toEqual(["blob", "ff"]);
});
it("requires matching local staging and host identity before any filesystem reads", async () => {
  const f = await fixture(),
    empty = await factory(),
    open = vi.mocked(sync.openSync),
    stat = vi.mocked(sync.lstatSync);
  await expect(inspectStagedRecoveryFileOperations({ ...f.options, db: empty })).rejects.toThrow(
    "matching local installation",
  );
  await expect(
    inspectStagedRecoveryFileOperations({
      ...f.options,
      expected: { ...identity, deviceId: "other" },
    }),
  ).rejects.toThrow("identity mismatch");
  await expect(
    inspectStagedRecoveryFileOperations({
      ...f.options,
      checkpoint: { ...f.checkpoint, sha256: "b".repeat(64) },
    }),
  ).rejects.toThrow("matching local installation");
  expect(open).not.toHaveBeenCalled();
  expect(stat).not.toHaveBeenCalled();
});
it("refuses stale observations after journal evidence changes between read snapshots", async () => {
  const f = await fixture();
  let reads = 0;
  const wrapped = createDatabaseAdapter(new Proxy(f.destination, {}), {
    read: async (work) => {
      if (++reads === 2)
        await f.destination.run(
          sql`UPDATE local_file_operation SET error='Concurrent new evidence' WHERE id='file'`,
        );
      return withReadTx(f.destination, (tx) => work(tx as unknown as DatabaseHandle));
    },
    write: () => {
      throw Error("Unexpected inspection write");
    },
  });
  await expect(inspectStagedRecoveryFileOperations({ ...f.options, db: wrapped })).rejects.toThrow(
    "changed during inspection",
  );
  expect(
    (
      await recovery.inspectPendingRecoveryFileOperations(f.destination, f.checkpoint, identity)
    ).operations.at(-1)!.error,
  ).toEqual(["text", "Concurrent new evidence"]);
  expect(await fs.readFile(join(root, "files", "note.txt"), "utf8")).toBe("Expected content");
});
it("owns root, identity, descriptor, page and absolute-path policy before database reads yield", async () => {
  const f = await fixture(),
    absolute = join(root, "files", "note.txt");
  await f.destination.run(
    sql`UPDATE local_file_operation SET path=${absolute},path_kind='absolute' WHERE id='file'`,
  );
  const input = {
    ...f.options,
    expected: { ...identity },
    checkpoint: structuredClone(f.checkpoint) as any,
    limit: 3,
    offset: 0,
    allowAbsolutePaths: false,
  };
  const wrapped = createDatabaseAdapter(new Proxy(f.destination, {}), {
    read: (work) => {
      input.root = join(root, "elsewhere");
      input.expected.deviceId = "Changed";
      input.checkpoint.sha256 = "b".repeat(64);
      input.limit = 0;
      input.offset = 3;
      input.allowAbsolutePaths = true;
      return withReadTx(f.destination, (tx) => work(tx as unknown as DatabaseHandle));
    },
    write: () => {
      throw Error("Unexpected inspection write");
    },
  });
  input.db = wrapped;
  const report = await inspectStagedRecoveryFileOperations(input);
  expect(report.limit).toBe(3);
  expect(report.offset).toBe(0);
  expect(report.observations[0].observation).toBe("matching-marker");
  expect(report.observations.at(-1)!.observation).toBe("absolute-path-not-inspected");
});
it("refuses success if the final read boundary fails", async () => {
  const f = await fixture();
  let reads = 0;
  const wrapped = createDatabaseAdapter(new Proxy(f.destination, {}), {
    read: async (work) => {
      const result = await withReadTx(f.destination, (tx) => work(tx as unknown as DatabaseHandle));
      if (++reads === 2) throw Error("Read completion failed");
      return result;
    },
    write: () => {
      throw Error("Unexpected write");
    },
  });
  await expect(inspectStagedRecoveryFileOperations({ ...f.options, db: wrapped })).rejects.toThrow(
    "Read completion failed",
  );
  expect((await f.inspect()).total).toBe("3");
});
it.each([
  { root: "" },
  { root: "bad\0root" },
  { allowAbsolutePaths: "yes" },
  { allowAbsolutePaths: null },
  { limit: 101 },
])("refuses invalid host options before disk observations %j", async (invalid) => {
  const f = await fixture(),
    open = vi.mocked(sync.openSync);
  await expect(
    inspectStagedRecoveryFileOperations({ ...f.options, ...invalid } as any),
  ).rejects.toThrow();
  expect(open).not.toHaveBeenCalled();
});
it("captures pending count and rows from one consistent snapshot during a competing commit", async () => {
  const url = `file:${join(root, "destination.sqlite")}`,
    f = await fixture(url),
    second = await openDb(url);
  opened.push(second);
  const dialect = new SQLiteAsyncDialect();
  let changed = false;
  const wrapped = createDatabaseAdapter(new Proxy(f.destination, {}), {
    read: (work) =>
      withReadTx(f.destination, (tx) =>
        work({
          ...tx,
          values: async (query: Parameters<typeof tx.values>[0]) => {
            const rows = await tx.values(query),
              statement =
                typeof query === "string" ? query : dialect.sqlToQuery(query.getSQL()).sql;
            if (!changed && statement.startsWith("SELECT CAST(count(*) AS TEXT)")) {
              changed = true;
              await second.db.run(
                sql`INSERT INTO local_file_operation(id,kind,version,taskspace_id,namespace_id,path,path_kind,state,intent,created_at) VALUES('later','taskspace.file',1,'absent','missing','later','workspace_relative','pending','{}',1)`,
              );
            }
            return rows;
          },
        } as unknown as DatabaseHandle),
      ),
    write: () => {
      throw Error("Unexpected write");
    },
  });
  const captured = await recovery.inspectPendingRecoveryFileOperations(
    wrapped,
    f.checkpoint,
    identity,
  );
  expect(changed).toBe(true);
  expect(captured.total).toBe("3");
  expect(captured.operations).toHaveLength(3);
  expect(
    (await recovery.inspectPendingRecoveryFileOperations(f.destination, f.checkpoint, identity))
      .total,
  ).toBe("4");
});
