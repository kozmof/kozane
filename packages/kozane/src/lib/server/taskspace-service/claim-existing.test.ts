import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sql } from "drizzle-orm";
import { createTestDB } from "../../../test-utils/db.js";
import type { DB } from "../../../db/database.js";
import { addNamespace } from "../../../db/api/namespace.js";
import { localFileOperationTable, taskspaceLocalTable } from "../../../db/schema.js";
import { TASKSPACE_MARKER_FILE, taskspaceMarkerText } from "../../taskspace-marker.js";
import * as directories from "../taskspace-directory.js";
import { inspectLocalClaim } from "../local-file-operations.js";
import { claimExistingTaskspace } from "./claim-existing.js";
import { recoverLocalClaim } from "./recover-claim.js";

let db: DB;
let root: string;
let namespaceId: string;
const taskspaceId = "12345678-1234-4234-8234-123456789abc";
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "kozane-existing-claim-"));
  db = await createTestDB(join(root, "database.sqlite"));
  namespaceId = await addNamespace({ db, name: "Namespace" });
  await db.run(sql`INSERT INTO taskspace(id,namespace_id,name,created_at,updated_at)
    VALUES(${taskspaceId},${namespaceId},'Existing',123,456)`);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});
function inputs() {
  return {
    record: {
      db,
      taskspaceId,
      namespaceId,
      path: "target",
      pathKind: "workspace_relative" as const,
      lastSeenAt: new Date(123000),
    },
    directory: {
      workspaceRoot: root,
      targetDir: join(root, "target"),
      adoptExisting: true,
      parentsInside: false,
      ownIfCreated: false,
    },
  };
}
function claim() {
  const { record, directory } = inputs();
  return claimExistingTaskspace(record, directory);
}
async function operation() {
  const rows = await db.select().from(localFileOperationTable);
  expect(rows).toHaveLength(1);
  return rows[0];
}
async function shared() {
  return (
    await db.values(sql`SELECT id,namespace_id,name,scope_id,
    CAST(created_at AS TEXT),CAST(updated_at AS TEXT) FROM taskspace`)
  ).map((row) => Array.from(row));
}
function externalWrite(statement: string) {
  const writer = new DatabaseSync(join(root, "database.sqlite"));
  try {
    writer.exec(statement);
  } finally {
    writer.close();
  }
}

it.each([false, true])(
  "attaches an existing identity after committing intent (adopt=%s)",
  async (adopt) => {
    if (adopt) {
      mkdirSync(join(root, "target"));
      writeFileSync(join(root, "target", "user.txt"), "Retained");
    }
    await db.run(sql`UPDATE taskspace SET created_at=9007199254740993,updated_at=9007199254740995`);
    const before = await shared();
    for (const event of ["INSERT", "UPDATE", "DELETE"])
      await db.run(
        sql.raw(`CREATE TRIGGER reject_shared_${event} BEFORE ${event} ON taskspace
      BEGIN SELECT RAISE(ABORT,'shared write'); END`),
      );
    const original = directories.claimTaskspaceDirectory;
    const spy = vi.spyOn(directories, "claimTaskspaceDirectory").mockImplementation((request) => {
      const reader = new DatabaseSync(join(root, "database.sqlite"), { readOnly: true });
      try {
        expect(reader.prepare("SELECT state FROM local_file_operation").get()).toMatchObject({
          state: "pending",
        });
        expect(reader.prepare("SELECT count(*) AS total FROM taskspace_local").get()).toMatchObject(
          { total: 0 },
        );
      } finally {
        reader.close();
      }
      return original(request);
    });
    expect(await claim()).toBe(taskspaceId);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await shared()).toEqual(before);
    expect(await db.select().from(taskspaceLocalTable)).toMatchObject([
      { taskspaceId, path: "target", pathKind: "workspace_relative", lastSeenAt: new Date(123000) },
    ]);
    const row = await operation();
    expect(row).toMatchObject({ state: "confirmed", error: null, taskspaceId, namespaceId });
    expect(inspectLocalClaim(row, root)).toBe("matching-marker");
    expect(readFileSync(join(root, "target", TASKSPACE_MARKER_FILE), "utf8")).toBe(
      taskspaceMarkerText(taskspaceId, namespaceId, false),
    );
    if (adopt) expect(readFileSync(join(root, "target", "user.txt"), "utf8")).toBe("Retained");
  },
);

it("keeps shared identity and records failure without compensating deletion", async () => {
  const before = await shared();
  vi.spyOn(directories, "claimTaskspaceDirectory").mockImplementation(() => {
    throw Error("disk failure");
  });
  await expect(claim()).rejects.toMatchObject({ phase: "change" });
  expect(await shared()).toEqual(before);
  expect(await operation()).toMatchObject({
    state: "pending",
    error: expect.stringContaining("disk failure"),
  });
  expect(await db.select().from(taskspaceLocalTable)).toEqual([]);
});

it("recovers failed confirmation without repeating disk work or touching shared rows", async () => {
  const before = await shared();
  await db.run(sql`CREATE TRIGGER reject_confirmation BEFORE UPDATE ON local_file_operation
    BEGIN SELECT RAISE(ABORT,'interrupted'); END`);
  const spy = vi.spyOn(directories, "claimTaskspaceDirectory");
  await expect(claim()).rejects.toMatchObject({ phase: "confirm" });
  const row = await operation();
  const bytes = readFileSync(join(root, "target", TASKSPACE_MARKER_FILE));
  expect(row.state).toBe("pending");
  expect(await db.select().from(taskspaceLocalTable)).toEqual([]);
  await db.run(sql`DROP TRIGGER reject_confirmation`);
  expect(await recoverLocalClaim(db, root, row.id)).toMatchObject({ status: "confirmable" });
  expect(await recoverLocalClaim(db, root, row.id, true)).toMatchObject({ status: "confirmed" });
  expect(await recoverLocalClaim(db, root, row.id, true)).toMatchObject({
    status: "already-confirmed",
  });
  expect(spy).toHaveBeenCalledTimes(1);
  expect(readFileSync(join(root, "target", TASKSPACE_MARKER_FILE))).toEqual(bytes);
  expect(await shared()).toEqual(before);
});

it.each(["namespace", "attachment", "marker", "intent"])(
  "refuses stale %s evidence after disk work",
  async (mutation) => {
    const original = directories.claimTaskspaceDirectory;
    vi.spyOn(directories, "claimTaskspaceDirectory").mockImplementation((request) => {
      const result = original(request);
      if (mutation === "namespace") externalWrite("UPDATE taskspace SET namespace_id=NULL");
      if (mutation === "attachment")
        externalWrite(
          `INSERT INTO taskspace_local(taskspace_id,path,path_kind) VALUES('${taskspaceId}','newer','workspace_relative')`,
        );
      if (mutation === "marker")
        writeFileSync(join(root, "target", TASKSPACE_MARKER_FILE), "newer");
      if (mutation === "intent")
        externalWrite(
          "UPDATE local_file_operation SET state='abandoned',abandoned_at=123,abandon_reason='Reviewed'",
        );
      return result;
    });
    await expect(claim()).rejects.toMatchObject({ phase: "confirm" });
    expect((await operation()).state).toBe(mutation === "intent" ? "abandoned" : "pending");
    const local = await db.select().from(taskspaceLocalTable);
    if (mutation === "attachment") expect(local).toMatchObject([{ path: "newer" }]);
    else expect(local).toEqual([]);
    expect(existsSync(join(root, "target", TASKSPACE_MARKER_FILE))).toBe(true);
  },
);

it.each(["attachment", "namespace", "pending", "symlink", "marker"])(
  "refuses %s before recording or touching disk",
  async (condition) => {
    if (condition === "attachment")
      await db.run(
        sql`INSERT INTO taskspace_local(taskspace_id,path,path_kind) VALUES(${taskspaceId},'newer','workspace_relative')`,
      );
    if (condition === "namespace") await db.run(sql`UPDATE taskspace SET namespace_id=NULL`);
    if (condition === "pending") {
      vi.spyOn(directories, "claimTaskspaceDirectory").mockImplementation(() => {
        throw Error("pending");
      });
      await expect(claim()).rejects.toThrow();
      vi.restoreAllMocks();
    }
    if (condition === "symlink") {
      mkdirSync(join(root, "other"));
      symlinkSync(join(root, "other"), join(root, "target"));
    }
    if (condition === "marker") {
      mkdirSync(join(root, "target"));
      writeFileSync(join(root, "target", TASKSPACE_MARKER_FILE), "foreign");
    }
    const before = await db.select().from(localFileOperationTable);
    const spy = vi.spyOn(directories, "claimTaskspaceDirectory");
    await expect(claim()).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
    expect(await db.select().from(localFileOperationTable)).toEqual(before);
  },
);

it("owns caller inputs before entering the queue", async () => {
  const { record, directory } = inputs();
  const result = claimExistingTaskspace(record, directory);
  record.path = "changed";
  record.namespaceId = "changed";
  record.lastSeenAt.setTime(999000);
  directory.targetDir = join(root, "changed");
  directory.ownIfCreated = true;
  await result;
  expect(await db.select().from(taskspaceLocalTable)).toMatchObject([
    { path: "target", lastSeenAt: new Date(123000) },
  ]);
  expect(inspectLocalClaim(await operation(), root)).toBe("matching-marker");
  expect(existsSync(join(root, "changed"))).toBe(false);
});

it("rolls back attachment if a trigger changes the recorded intent during confirmation", async () => {
  await db.run(sql`CREATE TRIGGER change_intent AFTER INSERT ON taskspace_local
    BEGIN UPDATE local_file_operation SET path='different'; END`);
  await expect(claim()).rejects.toMatchObject({ phase: "confirm" });
  expect(await db.select().from(taskspaceLocalTable)).toEqual([]);
  expect(await operation()).toMatchObject({ path: "target", state: "pending" });
  expect(inspectLocalClaim(await operation(), root)).toBe("matching-marker");
});

it("touches no disk when pending intent cannot commit", async () => {
  const before = await shared();
  await db.run(sql`CREATE TRIGGER reject_intent BEFORE INSERT ON local_file_operation
    BEGIN SELECT RAISE(ABORT,'intent failure'); END`);
  const spy = vi.spyOn(directories, "claimTaskspaceDirectory");
  await expect(claim()).rejects.toThrow();
  expect(spy).not.toHaveBeenCalled();
  expect(await shared()).toEqual(before);
  expect(await db.select().from(localFileOperationTable)).toEqual([]);
});

it.each(["intent", "target"])("refuses stale %s before touching disk", async (changed) => {
  if (changed === "intent")
    await db.run(sql`CREATE TRIGGER change_after_record AFTER INSERT ON local_file_operation
      BEGIN UPDATE local_file_operation SET path='different'; END`);
  else
    await db.run(sql`CREATE TRIGGER change_after_record AFTER INSERT ON local_file_operation
      BEGIN UPDATE taskspace SET namespace_id=NULL; END`);
  const spy = vi.spyOn(directories, "claimTaskspaceDirectory");
  if (changed === "intent") await expect(claim()).rejects.toThrow("intent changed");
  else await expect(claim()).rejects.toMatchObject({ phase: "change" });
  expect(spy).not.toHaveBeenCalled();
  if (changed === "intent") expect(await db.select().from(localFileOperationTable)).toEqual([]);
  else expect(await operation()).toMatchObject({ state: "pending", path: "target" });
  expect(await db.select().from(taskspaceLocalTable)).toEqual([]);
  expect(existsSync(join(root, "target"))).toBe(false);
});

it.each(["path", "date"])("refuses invalid %s inputs before queuing disk work", async (field) => {
  const { record, directory } = inputs();
  if (field === "path") record.path = "different";
  else record.lastSeenAt = new Date(NaN);
  await expect(claimExistingTaskspace(record, directory)).rejects.toThrow();
  expect(await db.select().from(localFileOperationTable)).toEqual([]);
  expect(existsSync(join(root, "target"))).toBe(false);
});
