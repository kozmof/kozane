import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createTestDB } from "../../../test-utils/db.js";
import type { DB } from "../../../db/database.js";
import { addNamespace } from "../../../db/api/namespace.js";
import { addScope } from "../../../db/api/scope.js";
import { getAllTaskspaces, deleteTaskspace } from "../../../db/api/taskspace.js";
import { localFileOperationTable } from "../../../db/schema.js";
import { TASKSPACE_MARKER_FILE } from "../../taskspace-marker.js";
import { contentHash, inspectLocalClaim, pendingLocalClaims } from "../local-file-operations.js";
import * as directories from "../taskspace-directory.js";
import { claimRecordedTaskspace } from "./claim.js";

let db: DB;
let root: string;
let namespaceId: string;
let scopeId: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "kozane-claim-journal-"));
  db = await createTestDB(join(root, "database.sqlite"));
  namespaceId = await addNamespace({ db, name: "Namespace" });
  scopeId = await addScope({ db, name: "Scope" });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});
function claim(adoptExisting = false, ownIfCreated = true) {
  return claimRecordedTaskspace(
    {
      db,
      namespaceId,
      scopeId,
      name: "Label",
      path: "target",
      pathKind: "workspace_relative",
      lastSeenAt: new Date(123000),
    },
    {
      workspaceRoot: root,
      targetDir: join(root, "target"),
      adoptExisting,
      parentsInside: true,
      ownIfCreated,
    },
  );
}
async function operation() {
  const rows = await db.select().from(localFileOperationTable);
  expect(rows).toHaveLength(1);
  return rows[0];
}

it.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])("confirms creation and exact marker hash atomically (adopt=%s, own=%s)", async (adopt, own) => {
  if (adopt) mkdirSync(join(root, "target"));
  const original = directories.claimTaskspaceDirectory;
  let touched = false;
  vi.spyOn(directories, "claimTaskspaceDirectory").mockImplementation((request) => {
    const reader = new DatabaseSync(join(root, "database.sqlite"), { readOnly: true });
    try {
      expect(reader.prepare("SELECT state FROM local_file_operation").get()).toMatchObject({
        state: "pending",
      });
      expect(reader.prepare("SELECT id FROM taskspace").get()).toMatchObject({
        id: request.taskspaceId,
      });
      expect(reader.prepare("SELECT count(*) AS total FROM taskspace_local").get()).toMatchObject({
        total: 0,
      });
    } finally {
      reader.close();
    }
    touched = true;
    return original(request);
  });
  const id = await claim(adopt, own);
  expect(touched).toBe(true);
  const row = await operation();
  expect(row).toMatchObject({ taskspaceId: id, namespaceId, state: "confirmed", error: null });
  expect(row.confirmedAt).toBeInstanceOf(Date);
  expect(JSON.parse(row.intent).markerHashes).toContain(
    contentHash(readFileSync(join(root, "target", TASKSPACE_MARKER_FILE))),
  );
  expect(inspectLocalClaim(row, root)).toBe("matching-marker");
  expect((await getAllTaskspaces({ db }))[0]).toMatchObject({
    id,
    path: "target",
    lastSeenAt: new Date(123000),
  });
  expect(await pendingLocalClaims(db, root)).toEqual({ total: 0, named: [] });
  await deleteTaskspace({ db, taskspaceId: id });
  expect(await operation()).toEqual(row);
});

it("rolls back shared creation and touches no disk when intent cannot commit", async () => {
  await db.run(
    sql`CREATE TRIGGER reject_intent BEFORE INSERT ON local_file_operation BEGIN SELECT RAISE(ABORT,'intent failure'); END`,
  );
  await expect(claim()).rejects.toThrow();
  expect(await getAllTaskspaces({ db })).toEqual([]);
  expect(await db.select().from(localFileOperationTable)).toEqual([]);
  expect(existsSync(join(root, "target"))).toBe(false);
});

it.each(["intent", "confirmation"])(
  "retains the correct durable boundary after %s commit failure",
  async (phase) => {
    await db.run(sql`CREATE TABLE deferred_parent(id TEXT PRIMARY KEY)`);
    await db.run(
      sql`CREATE TABLE deferred_child(parent_id TEXT REFERENCES deferred_parent(id) DEFERRABLE INITIALLY DEFERRED)`,
    );
    await db.run(
      sql.raw(
        `CREATE TRIGGER fail_commit AFTER ${phase === "intent" ? "INSERT" : "UPDATE"} ON local_file_operation BEGIN INSERT INTO deferred_child VALUES('missing'); END`,
      ),
    );
    await expect(claim()).rejects.toThrow();
    if (phase === "intent") {
      expect(await getAllTaskspaces({ db })).toEqual([]);
      expect(await db.select().from(localFileOperationTable)).toEqual([]);
      expect(existsSync(join(root, "target"))).toBe(false);
    } else {
      expect(await getAllTaskspaces({ db })).toMatchObject([{ path: null }]);
      expect(await operation()).toMatchObject({ state: "pending", confirmedAt: null });
      expect(inspectLocalClaim(await operation(), root)).toBe("matching-marker");
    }
    expect(await db.values(sql`SELECT * FROM deferred_child`)).toEqual([]);
  },
);

it("retains failed claim evidence after compensating shared creation", async () => {
  mkdirSync(join(root, "target"));
  writeFileSync(join(root, "target", "user.txt"), "Keep");
  await expect(claim()).rejects.toMatchObject({ phase: "claim" });
  expect(await getAllTaskspaces({ db })).toEqual([]);
  expect(await operation()).toMatchObject({
    state: "pending",
    confirmedAt: null,
    error: expect.any(String),
  });
  expect((await pendingLocalClaims(db, root)).named[0].observation).toBe(
    "directory-without-marker",
  );
  expect(readFileSync(join(root, "target", "user.txt"), "utf8")).toBe("Keep");
});

it("retains both errors and pending intent if compensation fails", async () => {
  await db.run(
    sql`CREATE TRIGGER reject_compensation BEFORE DELETE ON taskspace BEGIN SELECT RAISE(ABORT,'compensation failure'); END`,
  );
  mkdirSync(join(root, "target"));
  await expect(claim()).rejects.toMatchObject({
    phase: "claim",
    cause: expect.any(AggregateError),
  });
  expect(await getAllTaskspaces({ db })).toMatchObject([{ path: null }]);
  expect(await operation()).toMatchObject({ state: "pending", confirmedAt: null });
});

it("keeps disk and rolls back attachment when confirmation fails, and inspection never retries", async () => {
  await db.run(
    sql`CREATE TRIGGER reject_confirmation BEFORE UPDATE ON local_file_operation BEGIN SELECT RAISE(ABORT,'confirmation failure'); END`,
  );
  const spy = vi.spyOn(directories, "claimTaskspaceDirectory");
  await expect(claim()).rejects.toMatchObject({ phase: "attach" });
  const row = await operation();
  expect(row).toMatchObject({ state: "pending", confirmedAt: null });
  expect(await getAllTaskspaces({ db })).toMatchObject([
    { id: row.taskspaceId, path: null, lastSeenAt: null },
  ]);
  const marker = readFileSync(join(root, "target", TASKSPACE_MARKER_FILE));
  for (let i = 0; i < 2; i++)
    expect(await pendingLocalClaims(db, root)).toMatchObject({
      total: 1,
      named: [{ id: row.id, observation: "matching-marker" }],
    });
  expect(spy).toHaveBeenCalledTimes(1);
  expect(readFileSync(join(root, "target", TASKSPACE_MARKER_FILE))).toEqual(marker);
  expect(await operation()).toEqual(row);
});

it("classifies missing, partial, changed and unsafe evidence without modifying disk", async () => {
  await claim();
  const row = await operation();
  const target = join(root, "target");
  const marker = join(target, TASKSPACE_MARKER_FILE);
  writeFileSync(marker, "unrelated");
  expect(inspectLocalClaim(row, root)).toBe("different-marker");
  rmSync(marker);
  expect(inspectLocalClaim(row, root)).toBe("directory-without-marker");
  symlinkSync(join(root, "unrelated"), marker);
  expect(inspectLocalClaim(row, root)).toBe("different-marker");
  rmSync(target, { recursive: true });
  expect(inspectLocalClaim(row, root)).toBe("absent");
  mkdirSync(join(root, "unrelated"));
  symlinkSync(join(root, "unrelated"), target);
  expect(inspectLocalClaim(row, root)).toBe("unsafe-path");
  expect(inspectLocalClaim({ ...row, path: "../escape" }, root)).toBe("unsafe-path");
  expect(inspectLocalClaim({ ...row, intent: "{}" }, root)).toBe("invalid-intent");
  expect(inspectLocalClaim({ ...row, intent: "invalid" }, root)).toBe("invalid-intent");
});
