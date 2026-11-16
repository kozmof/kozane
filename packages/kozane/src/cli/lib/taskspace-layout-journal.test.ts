import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createTestDB } from "../../test-utils/db.js";
import { createNamespace } from "../../db/api/namespace.js";
import { addTaskspace, getTaskspace, updateTaskspaceLocation } from "../../db/api/taskspace.js";
import { localFileOperationTable } from "../../db/schema.js";
import { taskspaceMarkerText, TASKSPACE_MARKER_FILE } from "../../lib/taskspace-marker.js";
import * as disk from "../../lib/server/taskspace-directory.js";
import { inspectTaskspaceDirectoryOperation } from "../../lib/server/taskspace-directory-operations.js";
import { abandonLocalOperation } from "../../lib/server/taskspace-service/abandon-operation.js";
import { captureApplicationRows } from "../../test-utils/action-tables.js";
import type { DB as CoreDB } from "../../../../core/src/database.js";
import { applyTaskspaceLayout, planTaskspaceLayout } from "./taskspace-layout.js";
import { applyLayoutMove } from "./taskspace-layout-operation.js";
import { readConfig } from "./config.js";

let db: Awaited<ReturnType<typeof createTestDB>>;
let root: string;
let namespaceId: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "kozane-layout-journal-"));
  mkdirSync(join(root, ".kozane"));
  writeFileSync(
    join(root, ".kozane", "config.json"),
    JSON.stringify({ name: "Test", taskspace: { defaultDir: ".", searchRoots: ["."] } }),
  );
  db = await createTestDB(join(root, "database.sqlite"));
  namespaceId = await createNamespace({ db, name: "main", isDefault: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});
async function owned(path: string) {
  const id = await addTaskspace({
    db,
    namespaceId,
    name: path,
    path,
    lastSeenAt: new Date(123000),
  });
  mkdirSync(join(root, path), { recursive: true });
  writeFileSync(
    join(root, path, TASKSPACE_MARKER_FILE),
    taskspaceMarkerText(id, namespaceId, true),
  );
  writeFileSync(join(root, path, "notes.txt"), "Original content");
  return id;
}
const plan = () => planTaskspaceLayout(db, root, readConfig(root));
const rows = () => db.select().from(localFileOperationTable);
// Source aliases share this adapter with the host package during filesystem integration tests.
const shared = () => captureApplicationRows(db as unknown as CoreDB);

it.each(["notes", "taskspaces"])(
  "journals every planned path for %s and changes only local attachment",
  async (path) => {
    const id = await owned(path);
    const before = await shared();
    const original = (await getTaskspace({ db, taskspaceId: id }))!;
    const planned = await plan();
    const callback = vi.spyOn(disk, "moveTaskspaceDirectory");
    expect(await applyTaskspaceLayout(db, root, planned)).toMatchObject({
      config: "updated",
      failed: [],
    });
    const [row] = await rows();
    const intent = JSON.parse(row.intent);
    expect(intent).toMatchObject({ operation: "layout", targetPath: planned.moves[0].to });
    expect(intent.paths).toHaveLength(path === "taskspaces" ? 3 : 2);
    expect(callback).toHaveBeenCalledTimes(intent.paths.length - 1);
    expect(row.state).toBe("confirmed");
    expect(inspectTaskspaceDirectoryOperation(row, root)).toBe("target-only");
    expect(await shared()).toEqual(before);
    expect(await getTaskspace({ db, taskspaceId: id })).toEqual({
      ...original,
      path: planned.moves[0].to,
    });
  },
);

it("persists the full path plan before the first directory move", async () => {
  await owned("taskspaces");
  const original = disk.moveTaskspaceDirectory;
  vi.spyOn(disk, "moveTaskspaceDirectory").mockImplementation((request) => {
    const reader = new DatabaseSync(join(root, "database.sqlite"), { readOnly: true });
    try {
      const record = reader.prepare("SELECT state,intent FROM local_file_operation").get();
      expect(record?.state).toBe("pending");
      expect(JSON.parse(String(record?.intent)).paths).toHaveLength(3);
      expect(reader.prepare("SELECT path FROM taskspace_local").get()).toMatchObject({
        path: "taskspaces",
      });
    } finally {
      reader.close();
    }
    return original(request);
  });
  expect((await applyTaskspaceLayout(db, root, await plan())).failed).toEqual([]);
});

it("keeps an interrupted intermediate directory and refuses to repeat its callbacks", async () => {
  await owned("taskspaces");
  const original = disk.moveTaskspaceDirectory;
  const callback = vi.spyOn(disk, "moveTaskspaceDirectory").mockImplementation((request) => {
    if (callback.mock.calls.length === 2) throw new Error("Interrupted before second move");
    return original(request);
  });
  const config = readFileSync(join(root, ".kozane", "config.json"));
  const result = await applyTaskspaceLayout(db, root, await plan());
  expect(result).toMatchObject({ config: "kept", failed: [expect.anything()] });
  const pending = await rows();
  const intent = JSON.parse(pending[0].intent);
  expect(pending[0]).toMatchObject({
    state: "pending",
    error: expect.stringContaining("Interrupted"),
  });
  expect(readFileSync(join(root, intent.paths[1], "notes.txt"), "utf8")).toBe("Original content");
  expect(inspectTaskspaceDirectoryOperation(pending[0], root)).toBe("intermediate-only");
  expect(await applyTaskspaceLayout(db, root, await plan())).toMatchObject({
    blocked: expect.stringContaining("pending"),
    config: "kept",
  });
  expect(callback).toHaveBeenCalledTimes(2);
  expect(await rows()).toEqual(pending);
  expect(readFileSync(join(root, ".kozane", "config.json"))).toEqual(config);
});

it("detects replacement of the intermediate directory before the second step", async () => {
  await owned("taskspaces");
  const original = disk.moveTaskspaceDirectory;
  const callback = vi.spyOn(disk, "moveTaskspaceDirectory").mockImplementation((request) => {
    const result = original(request);
    if (callback.mock.calls.length === 1) {
      const intermediate = join(root, request.nextStored);
      const marker = readFileSync(join(intermediate, TASKSPACE_MARKER_FILE));
      renameSync(intermediate, join(root, "retained-original"));
      mkdirSync(intermediate);
      writeFileSync(join(intermediate, TASKSPACE_MARKER_FILE), marker);
    }
    return result;
  });
  expect((await applyTaskspaceLayout(db, root, await plan())).failed).toHaveLength(1);
  expect(callback).toHaveBeenCalledOnce();
  expect(readFileSync(join(root, "retained-original", "notes.txt"), "utf8")).toBe(
    "Original content",
  );
  expect((await rows())[0].state).toBe("pending");
});

it.each([false, true])(
  "rolls back attachment after confirmation failure (commit=%s) and supports reviewed abandonment",
  async (commit) => {
    const id = await owned("notes");
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
    const planned = await plan();
    const callback = vi.spyOn(disk, "moveTaskspaceDirectory");
    expect((await applyTaskspaceLayout(db, root, planned)).failed).toHaveLength(1);
    expect(await shared()).toEqual(before);
    expect(await getTaskspace({ db, taskspaceId: id })).toMatchObject({ path: "notes" });
    const [operation] = await rows();
    expect(inspectTaskspaceDirectoryOperation(operation, root)).toBe("target-only");
    expect(await applyTaskspaceLayout(db, root, planned)).toMatchObject({
      blocked: expect.any(String),
    });
    expect(callback).toHaveBeenCalledOnce();
    await db.run(sql`DROP TRIGGER reject_confirmation`);
    await updateTaskspaceLocation({ db, taskspaceId: id, path: planned.moves[0].to });
    await abandonLocalOperation(db, operation.id, "Reviewed disk and repaired attachment", true);
    expect((await applyTaskspaceLayout(db, root, await plan())).config).toBe("updated");
    expect(callback).toHaveBeenCalledOnce();
    expect((await rows())[0]).toMatchObject({
      state: "abandoned",
      abandonReason: "Reviewed disk and repaired attachment",
    });
  },
);

it("refuses a new pending operation even when an earlier global pending check was clear", async () => {
  const id = await owned("notes");
  const planned = await plan();
  await db.insert(localFileOperationTable).values({
    id: "pending",
    kind: "taskspace.file",
    version: 1,
    taskspaceId: id,
    namespaceId,
    path: "notes/file.txt",
    pathKind: "workspace_relative",
    state: "pending",
    intent: "{}",
    createdAt: new Date(),
  });
  const callback = vi.spyOn(disk, "moveTaskspaceDirectory");
  await expect(applyLayoutMove(db, root, planned.moves[0], new Set())).rejects.toThrow("pending");
  expect(callback).not.toHaveBeenCalled();
  expect(existsSync(join(root, "notes", TASKSPACE_MARKER_FILE))).toBe(true);
  expect(await rows()).toHaveLength(1);
});

it("does not place dependent taskspaces in a source whose move finished on disk but failed to commit", async () => {
  await owned("taskspaces");
  await owned("notes");
  await db.run(
    sql`CREATE TRIGGER reject_first_confirmation BEFORE UPDATE ON local_file_operation WHEN NEW.path='taskspaces' BEGIN SELECT RAISE(ABORT,'first confirmation refused'); END`,
  );
  const callback = vi.spyOn(disk, "moveTaskspaceDirectory");
  const result = await applyTaskspaceLayout(db, root, await plan());
  expect(result.moved).toEqual([]);
  expect(result.failed.map(({ move }) => move.from)).toEqual(["taskspaces", "notes"]);
  expect(result.failed[1].reason).toContain("whose move did not finish");
  expect(callback).toHaveBeenCalledTimes(2);
  expect(readFileSync(join(root, "notes", "notes.txt"), "utf8")).toBe("Original content");
  expect(existsSync(join(root, "taskspaces", "main", "notes"))).toBe(false);
  expect(await rows()).toHaveLength(1);
});
