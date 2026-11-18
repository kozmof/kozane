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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { createTestDB } from "../../../test-utils/db.js";
import type { DB } from "../../../db/database.js";
import { addNamespace } from "../../../db/api/namespace.js";
import { addScope } from "../../../db/api/scope.js";
import {
  addTaskspace,
  getTaskspace,
  updateTaskspaceName,
  updateTaskspaceLocation,
} from "../../../db/api/taskspace.js";
import {
  cardTable,
  layerTable,
  partitionTable,
  localFileOperationTable,
  taskspaceTable,
  taskspaceLocalTable,
} from "../../../db/schema.js";
import { _resetWorkspaceRootForTest } from "../../../db/internal/config.js";
import { TASKSPACE_MARKER_FILE, taskspaceMarkerText } from "../../taskspace-marker.js";
import * as disk from "../taskspace-directory.js";
import { removeTaskspace, renameTaskspace } from "./mutate.js";
import { recoverTaskspaceOperation } from "./recover-operation.js";
import { recoverDirectoryOperation } from "./recover-directory.js";
import { oneAtATime } from "./queue.js";

let db: DB;
let root: string;
let taskspaceId: string;
let namespaceId: string;
let previousRoot: string | undefined;
const path = join("tasks", "draft");
const target = join("tasks", "final");
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "kozane-directory-recovery-"));
  mkdirSync(join(root, ".kozane"));
  writeFileSync(
    join(root, ".kozane", "config.json"),
    JSON.stringify({ name: "Test", taskspace: { defaultDir: "tasks", namespaceDirs: false } }),
  );
  mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, path, "a.txt"), "Retained content");
  db = await createTestDB(join(root, "database.sqlite"));
  namespaceId = await addNamespace({ db, name: "Namespace" });
  taskspaceId = await addTaskspace({
    db,
    namespaceId,
    name: "draft",
    path,
    lastSeenAt: new Date(123000),
  });
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
const record = () => getTaskspace({ db, taskspaceId });
const rows = () => db.select().from(localFileOperationTable);
const recover = (id: string, apply = false) => recoverTaskspaceOperation(db, root, id, apply);
async function interrupted(operation: "move" | "remove" = "move") {
  await db.run(
    sql`CREATE TRIGGER reject_confirmation BEFORE UPDATE ON local_file_operation BEGIN SELECT RAISE(ABORT,'interrupted'); END`,
  );
  const params = { namespaceId, taskspaceId };
  await expect(
    operation === "move"
      ? renameTaskspace({ db }, params, { name: "final" })
      : removeTaskspace({ db }, params),
  ).rejects.toMatchObject({ status: 500 });
  await db.run(sql`DROP TRIGGER reject_confirmation`);
  const [row] = await rows();
  expect(row).toMatchObject({ state: "pending", error: null });
  return row;
}

it.each(["move", "remove"] as const)(
  "previews %s read-only and confirms all database changes together without disk callbacks",
  async (operation) => {
    const original = await record();
    const attachment = await db.select().from(taskspaceLocalTable);
    const pending = await interrupted(operation);
    const callbacks = [
      vi.spyOn(disk, "renameTaskspaceDirectory"),
      vi.spyOn(disk, "removeTaskspaceDirectory"),
      vi.spyOn(disk, "moveTaskspaceDirectory"),
      vi.spyOn(disk, "claimTaskspaceDirectory"),
    ];
    const marker =
      operation === "move" ? readFileSync(join(root, target, TASKSPACE_MARKER_FILE)) : null;
    expect((await recover(pending.id)).status).toBe("confirmable");
    expect(await record()).toEqual(original);
    expect(await rows()).toEqual([pending]);
    expect((await db.select().from(cardTable))[0].taskspaceId).toBe(taskspaceId);
    expect((await recover(pending.id, true)).status).toBe("confirmed");
    if (operation === "move") {
      expect(await record()).toMatchObject({
        name: "final",
        path: target,
        createdAt: original!.createdAt,
        lastSeenAt: original!.lastSeenAt,
      });
      expect(readFileSync(join(root, target, TASKSPACE_MARKER_FILE))).toEqual(marker);
      expect(readFileSync(join(root, target, "a.txt"), "utf8")).toBe("Retained content");
    } else {
      expect(await record()).toBeUndefined();
      expect((await db.select().from(cardTable))[0].taskspaceId).toBeNull();
      expect(await db.select().from(taskspaceLocalTable)).toEqual(attachment);
      expect(existsSync(join(root, path))).toBe(false);
    }
    const confirmed = await rows();
    expect(confirmed[0]).toMatchObject({
      ...pending,
      state: "confirmed",
      confirmedAt: expect.any(Date),
    });
    expect((await recover(pending.id, true)).status).toBe("already-confirmed");
    expect(await rows()).toEqual(confirmed);
    callbacks.forEach((callback) => expect(callback).not.toHaveBeenCalled());
  },
);

it.each(["move", "remove"] as const)(
  "rolls back every %s change when recovery confirmation fails at commit",
  async (operation) => {
    const pending = await interrupted(operation);
    const original = await record();
    await db.run(sql`CREATE TABLE deferred_parent(id TEXT PRIMARY KEY)`);
    await db.run(
      sql`CREATE TABLE deferred_child(parent_id TEXT REFERENCES deferred_parent(id) DEFERRABLE INITIALLY DEFERRED)`,
    );
    await db.run(
      sql`CREATE TRIGGER reject_recovery AFTER UPDATE ON local_file_operation BEGIN INSERT INTO deferred_child VALUES('missing'); END`,
    );
    await expect(recover(pending.id, true)).rejects.toThrow();
    expect(await record()).toEqual(original);
    expect((await db.select().from(cardTable))[0].taskspaceId).toBe(taskspaceId);
    expect(await rows()).toEqual([pending]);
    await db.run(sql`DROP TRIGGER reject_recovery`);
    expect((await recover(pending.id, true)).status).toBe("confirmed");
  },
);

it.each(["delete", "intent"] as const)(
  "rolls back shared changes if a trigger alters journal %s during recovery",
  async (changed) => {
    const pending = await interrupted();
    const original = await record();
    await db.run(
      changed === "delete"
        ? sql`CREATE TRIGGER change_intent AFTER UPDATE ON taskspace BEGIN DELETE FROM local_file_operation; END`
        : sql`CREATE TRIGGER change_intent AFTER UPDATE ON taskspace BEGIN UPDATE local_file_operation SET intent='{}'; END`,
    );
    await expect(recover(pending.id, true)).rejects.toThrow("intent changed or is missing");
    expect(await record()).toEqual(original);
    expect(await rows()).toEqual([pending]);
  },
);

it.each([
  "label",
  "attachment",
  "missing-taskspace",
  "namespace",
  "scope",
  "timestamp",
  "invalid-snapshot",
  "invalid-destination",
  "recorded-error",
  "source-only",
  "missing-directory",
  "marker",
  "inode",
  "symlink",
] as const)("preserves evidence and refuses recovery after %s changes", async (changed) => {
  const pending = await interrupted();
  if (changed === "label") await updateTaskspaceName({ db, taskspaceId, name: "Later label" });
  if (changed === "attachment")
    await updateTaskspaceLocation({ db, taskspaceId, path: "elsewhere" });
  if (changed === "missing-taskspace")
    await db.delete(taskspaceTable).where(eq(taskspaceTable.id, taskspaceId));
  if (changed === "namespace")
    await db
      .update(taskspaceTable)
      .set({ namespaceId: null })
      .where(eq(taskspaceTable.id, taskspaceId));
  if (changed === "scope") {
    const scopeId = await addScope({ db, name: "Later scope" });
    await db.update(taskspaceTable).set({ scopeId }).where(eq(taskspaceTable.id, taskspaceId));
  }
  if (changed === "timestamp")
    await db
      .update(taskspaceTable)
      .set({ updatedAt: new Date(1000) })
      .where(eq(taskspaceTable.id, taskspaceId));
  if (changed === "invalid-snapshot" || changed === "invalid-destination") {
    const intent = JSON.parse(pending.intent);
    if (changed === "invalid-snapshot") delete intent.before.createdAt;
    else intent.targetPath = "../outside";
    await db.update(localFileOperationTable).set({ intent: JSON.stringify(intent) });
  }
  if (changed === "recorded-error")
    await db.update(localFileOperationTable).set({ error: "Partial filesystem failure" });
  if (changed === "source-only") renameSync(join(root, target), join(root, path));
  if (changed === "missing-directory") rmSync(join(root, target), { recursive: true });
  if (changed === "marker") writeFileSync(join(root, target, TASKSPACE_MARKER_FILE), "{}");
  if (changed === "inode" || changed === "symlink") {
    renameSync(join(root, target), join(root, "kept"));
    if (changed === "symlink") symlinkSync(join(root, "kept"), join(root, target));
    else {
      mkdirSync(join(root, target));
      writeFileSync(
        join(root, target, TASKSPACE_MARKER_FILE),
        taskspaceMarkerText(taskspaceId, namespaceId, true),
      );
    }
  }
  const original = await record();
  const evidence = await rows();
  expect((await recover(pending.id)).status).toBe("blocked");
  await expect(recover(pending.id, true)).rejects.toThrow("cannot be confirmed");
  expect(await record()).toEqual(original);
  expect(await rows()).toEqual(evidence);
});

it("compares snapshot fields independently of JSON key order", async () => {
  const pending = await interrupted();
  const intent = JSON.parse(pending.intent);
  intent.before = Object.fromEntries(Object.entries(intent.before).reverse());
  await db.update(localFileOperationTable).set({ intent: JSON.stringify(intent) });
  expect((await recover(pending.id, true)).status).toBe("confirmed");
});

it("serializes competing recovery attempts on the actual taskspace queue and rechecks after waiting", async () => {
  const pending = await interrupted();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const earlier = oneAtATime(taskspaceId, async () => {
    entered();
    await gate;
    await updateTaskspaceName({ db, taskspaceId, name: "Later label" });
  });
  await started;
  const attempt = recover(pending.id, true);
  release();
  await earlier;
  await expect(attempt).rejects.toThrow("changed since");
  expect(await rows()).toEqual([pending]);
});

it("confirms once when two recovery attempts race", async () => {
  const pending = await interrupted();
  const results = await Promise.all([recover(pending.id, true), recover(pending.id, true)]);
  expect(results.map((result) => result.status).sort()).toEqual(["already-confirmed", "confirmed"]);
});

it("refuses abandoned operations and directory recovery of another kind without discarding evidence", async () => {
  const pending = await interrupted();
  await db
    .update(localFileOperationTable)
    .set({ state: "abandoned", abandonedAt: new Date(), abandonReason: "Reviewed" });
  await expect(recover(pending.id, true)).rejects.toThrow("abandoned");
  await db.update(localFileOperationTable).set({ kind: "taskspace.file" });
  const evidence = await rows();
  await expect(recoverDirectoryOperation(db, root, pending.id, true)).rejects.toThrow(
    "not a directory mutation",
  );
  expect(await rows()).toEqual(evidence);
  await expect(recover("missing")).rejects.toThrow("not found");
});
