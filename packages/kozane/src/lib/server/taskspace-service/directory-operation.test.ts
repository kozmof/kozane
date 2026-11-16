import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createTestDB } from "../../../test-utils/db.js";
import type { DB } from "../../../db/database.js";
import type { DB as CoreDB } from "../../../../../core/src/database.js";
import { addNamespace } from "../../../db/api/namespace.js";
import { addTaskspace, getTaskspace, updateTaskspaceName } from "../../../db/api/taskspace.js";
import {
  cardTable,
  layerTable,
  partitionTable,
  localFileOperationTable,
} from "../../../db/schema.js";
import { _resetWorkspaceRootForTest } from "../../../db/internal/config.js";
import { captureApplicationRows } from "../../../test-utils/action-tables.js";
import { TASKSPACE_MARKER_FILE, taskspaceMarkerText } from "../../taskspace-marker.js";
import * as disk from "../taskspace-directory.js";
import {
  directoryEvidence,
  inspectTaskspaceDirectoryOperation,
  pendingTaskspaceDirectoryOperations,
} from "../taskspace-directory-operations.js";
import { createLocalClaimStartupCheck } from "../local-claim-startup.js";
import { recoverLocalClaim } from "./recover-claim.js";
import { journalTaskspaceDirectoryChange } from "./directory-operation.js";
import { removeTaskspace, renameTaskspace } from "./mutate.js";

let db: DB;
let root: string;
let params: { namespaceId: string; taskspaceId: string };
let previousRoot: string | undefined;
const path = join("tasks", "draft");
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "kozane-directory-journal-"));
  mkdirSync(join(root, ".kozane"));
  writeFileSync(
    join(root, ".kozane", "config.json"),
    JSON.stringify({ name: "Test", taskspace: { defaultDir: "tasks", namespaceDirs: false } }),
  );
  mkdirSync(join(root, path, "notes"), { recursive: true });
  writeFileSync(join(root, path, "notes", "a.md"), "Retained content");
  db = await createTestDB(join(root, "database.sqlite"));
  const namespaceId = await addNamespace({ db, name: "Namespace" });
  const taskspaceId = await addTaskspace({
    db,
    namespaceId,
    name: "draft",
    path,
    lastSeenAt: new Date(123000),
  });
  params = { namespaceId, taskspaceId };
  writeFileSync(
    join(root, path, TASKSPACE_MARKER_FILE),
    taskspaceMarkerText(taskspaceId, namespaceId, true),
  );
  await db.insert(partitionTable).values({ id: "p", namespaceId, name: "Inbox", isDefault: true });
  await db.insert(layerTable).values({ id: "l", namespaceId, name: "Base", isDefault: true });
  await db
    .insert(cardTable)
    .values({ id: "card", partitionId: "p", layerId: "l", taskspaceId, content: "Linked" });
  previousRoot = process.env.KOZANE_WORKSPACE_ROOT;
  process.env.KOZANE_WORKSPACE_ROOT = root;
  _resetWorkspaceRootForTest();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  if (previousRoot === undefined) delete process.env.KOZANE_WORKSPACE_ROOT;
  else process.env.KOZANE_WORKSPACE_ROOT = previousRoot;
  _resetWorkspaceRootForTest();
  rmSync(root, { recursive: true, force: true });
});
const record = () => getTaskspace({ db, taskspaceId: params.taskspaceId });
const rows = () => db.select().from(localFileOperationTable);
// The source alias and host adapter share their runtime handle in these filesystem tests.
const shared = () => captureApplicationRows(db as unknown as CoreDB);
function change(operation: "move" | "remove") {
  return operation === "move"
    ? renameTaskspace({ db }, params, { name: "final" })
    : removeTaskspace({ db }, params);
}

it("refuses unrepresentable shared timestamps before recording intent or touching disk", async () => {
  await db.run(
    sql`UPDATE taskspace SET created_at=8640000000001 WHERE id=${params.taskspaceId}`,
  );
  const callback = vi.spyOn(disk, "removeTaskspaceDirectory");
  await expect(change("remove")).rejects.toMatchObject({ status: 409 });
  expect(await rows()).toEqual([]);
  expect(callback).not.toHaveBeenCalled();
  expect(readFileSync(join(root, path, "notes", "a.md"), "utf8")).toBe("Retained content");
});

it.each(["move", "remove"] as const)(
  "commits %s shared changes, attachment and confirmation together",
  async (operation) => {
    const original = (await record())!;
    await change(operation);
    const [row] = await rows();
    expect(row).toMatchObject({
      kind: "taskspace.directory",
      version: 1,
      ...params,
      path,
      state: "confirmed",
      error: null,
    });
    expect(row.confirmedAt).toBeInstanceOf(Date);
    expect(inspectTaskspaceDirectoryOperation(row, root)).toBe(
      operation === "move" ? "target-only" : "source-absent",
    );
    if (operation === "move") {
      expect(await record()).toMatchObject({
        name: "final",
        path: join("tasks", "final"),
        createdAt: original.createdAt,
        lastSeenAt: original.lastSeenAt,
      });
      expect(readFileSync(join(root, "tasks", "final", "notes", "a.md"), "utf8")).toBe(
        "Retained content",
      );
    } else {
      expect(await record()).toBeUndefined();
      expect((await db.select().from(cardTable))[0].taskspaceId).toBeNull();
      expect(existsSync(join(root, path))).toBe(false);
    }
  },
);

it("commits intent before invoking the directory callback", async () => {
  const original = disk.renameTaskspaceDirectory;
  vi.spyOn(disk, "renameTaskspaceDirectory").mockImplementation((input) => {
    const reader = new DatabaseSync(join(root, "database.sqlite"), { readOnly: true });
    try {
      expect(reader.prepare("SELECT state,kind FROM local_file_operation").get()).toMatchObject({
        state: "pending",
        kind: "taskspace.directory",
      });
      expect(reader.prepare("SELECT name FROM taskspace").get()).toMatchObject({ name: "draft" });
    } finally {
      reader.close();
    }
    return original(input);
  });
  await change("move");
});

it.each([
  ["move", false],
  ["remove", false],
  ["move", true],
  ["remove", true],
] as const)("leaves disk untouched when %s intent fails (commit=%s)", async (operation, commit) => {
  if (commit) {
    await db.run(sql`CREATE TABLE deferred_parent(id TEXT PRIMARY KEY)`);
    await db.run(
      sql`CREATE TABLE deferred_child(parent_id TEXT REFERENCES deferred_parent(id) DEFERRABLE INITIALLY DEFERRED)`,
    );
    await db.run(
      sql`CREATE TRIGGER reject_intent AFTER INSERT ON local_file_operation BEGIN INSERT INTO deferred_child VALUES('missing'); END`,
    );
  } else
    await db.run(
      sql`CREATE TRIGGER reject_intent BEFORE INSERT ON local_file_operation BEGIN SELECT RAISE(ABORT,'intent refused'); END`,
    );
  const before = await shared();
  const callback = vi.spyOn(
    disk,
    operation === "move" ? "renameTaskspaceDirectory" : "removeTaskspaceDirectory",
  );
  await expect(change(operation)).rejects.toMatchObject({ status: 500 });
  expect(callback).not.toHaveBeenCalled();
  expect(await rows()).toEqual([]);
  expect(await shared()).toEqual(before);
  expect(readFileSync(join(root, path, "notes", "a.md"), "utf8")).toBe("Retained content");
});

it.each([
  ["move", false],
  ["remove", false],
  ["move", true],
  ["remove", true],
] as const)(
  "retains %s after confirmation failure and rolls back all shared changes (commit=%s)",
  async (operation, commit) => {
    if (commit) {
      await db.run(sql`CREATE TABLE deferred_parent(id TEXT PRIMARY KEY)`);
      await db.run(
        sql`CREATE TABLE deferred_child(parent_id TEXT REFERENCES deferred_parent(id) DEFERRABLE INITIALLY DEFERRED)`,
      );
      await db.run(
        sql`CREATE TRIGGER reject_confirmation AFTER UPDATE ON local_file_operation BEGIN INSERT INTO deferred_child VALUES('missing'); END`,
      );
    } else
      await db.run(
        sql`CREATE TRIGGER reject_confirmation BEFORE UPDATE ON local_file_operation BEGIN SELECT RAISE(ABORT,'confirmation refused'); END`,
      );
    const before = await shared();
    const attachment = await record();
    const callback = vi.spyOn(
      disk,
      operation === "move" ? "renameTaskspaceDirectory" : "removeTaskspaceDirectory",
    );
    await expect(change(operation)).rejects.toMatchObject({
      status: 500,
      message: expect.stringContaining("needs recovery"),
    });
    const pending = await rows();
    expect(pending[0]).toMatchObject({ state: "pending", confirmedAt: null });
    expect(await shared()).toEqual(before);
    expect(await record()).toEqual(attachment);
    for (let i = 0; i < 2; i++)
      expect((await pendingTaskspaceDirectoryOperations(db, root)).named[0].observation).toBe(
        operation === "move" ? "target-only" : "source-absent",
      );
    const warn = vi.fn();
    await createLocalClaimStartupCheck(warn)(db, root);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain("pending taskspace directory operation");
    expect(callback).toHaveBeenCalledOnce();
    expect(await rows()).toEqual(pending);
    await expect(recoverLocalClaim(db, root, pending[0].id, true)).rejects.toThrow(
      "not a directory claim",
    );
  },
);

it("keeps partial deletion evidence and the marker without retrying deletion", async () => {
  const before = await shared();
  const callback = vi.spyOn(disk, "removeTaskspaceDirectory").mockImplementation(() => {
    rmSync(join(root, path, "notes", "a.md"));
    throw new Error("Partial deletion");
  });
  await expect(change("remove")).rejects.toMatchObject({ status: 500 });
  const [row] = await rows();
  expect(row).toMatchObject({
    state: "pending",
    error: expect.stringContaining("Partial deletion"),
  });
  expect(inspectTaskspaceDirectoryOperation(row, root)).toBe("source-present");
  expect(existsSync(join(root, path, TASKSPACE_MARKER_FILE))).toBe(true);
  expect(await shared()).toEqual(before);
  expect(callback).toHaveBeenCalledOnce();
});

it.each(["marker", "inode", "shared-record"] as const)(
  "refuses a changed %s before invoking directory work",
  async (changed) => {
    const original = (await record())!;
    const callback = vi.fn();
    await expect(
      journalTaskspaceDirectoryChange(
        {
          db,
          namespaceId: params.namespaceId,
          root,
          original,
          request: { operation: "remove" },
          recheck: async () => {
            if (changed === "marker")
              writeFileSync(
                join(root, path, TASKSPACE_MARKER_FILE),
                taskspaceMarkerText(params.taskspaceId, params.namespaceId, true) + " ",
              );
            if (changed === "inode") {
              renameSync(join(root, path), join(root, "kept"));
              mkdirSync(join(root, path));
              writeFileSync(
                join(root, path, TASKSPACE_MARKER_FILE),
                taskspaceMarkerText(params.taskspaceId, params.namespaceId, true),
              );
            }
            if (changed === "shared-record")
              await updateTaskspaceName({
                db,
                taskspaceId: params.taskspaceId,
                name: "Later label",
              });
          },
        },
        callback,
        () => undefined,
      ),
    ).rejects.toMatchObject({ phase: "change" });
    expect(callback).not.toHaveBeenCalled();
    expect((await rows())[0].state).toBe("pending");
  },
);

it("preserves a concurrent shared edit made after the disk move", async () => {
  const original = (await record())!;
  await expect(
    journalTaskspaceDirectoryChange(
      {
        db,
        namespaceId: params.namespaceId,
        root,
        original,
        request: { operation: "move", name: "final" },
        recheck: async () => undefined,
      },
      async () => {
        const target = disk.renameTaskspaceDirectory({
          workspaceRoot: root,
          storedPath: path,
          taskspaceId: params.taskspaceId,
          newName: "final",
        });
        await updateTaskspaceName({ db, taskspaceId: params.taskspaceId, name: "Later label" });
        return target;
      },
      () => {
        throw new Error("Must not overwrite later edit");
      },
    ),
  ).rejects.toMatchObject({ phase: "confirm" });
  expect(await record()).toMatchObject({ name: "Later label", path });
  expect(inspectTaskspaceDirectoryOperation((await rows())[0], root)).toBe("target-only");
});

it("refuses traversal, symlinks, a replaced directory and a different marker during inspection", async () => {
  const evidence = directoryEvidence(root, path, params.taskspaceId);
  expect(evidence.state).toBe("owned");
  await change("move");
  const [row] = await rows();
  const intent = JSON.parse(row.intent);
  expect(
    inspectTaskspaceDirectoryOperation(
      {
        ...row,
        path: "../outside",
        intent: JSON.stringify({ ...intent, targetPath: join("..", "final") }),
      },
      root,
    ),
  ).toBe("unsafe-path");
  expect(
    inspectTaskspaceDirectoryOperation(
      { ...row, intent: JSON.stringify({ ...intent, targetPath: "../outside" }) },
      root,
    ),
  ).toBe("invalid-intent");
  writeFileSync(join(root, "tasks", "final", TASKSPACE_MARKER_FILE), "{}");
  expect(inspectTaskspaceDirectoryOperation(row, root)).toBe("foreign-marker");
  rmSync(join(root, "tasks", "final"), { recursive: true });
  symlinkSync(join(root, "unrelated"), join(root, "tasks", "final"));
  expect(inspectTaskspaceDirectoryOperation(row, root)).toBe("unsafe-path");
});
