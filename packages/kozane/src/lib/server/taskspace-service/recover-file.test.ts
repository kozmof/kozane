import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
import type { DB as CoreDB } from "../../../../../core/src/database.js";
import { captureApplicationRows } from "../../../test-utils/action-tables.js";
import { addNamespace, deleteNamespace } from "../../../db/api/namespace.js";
import {
  addTaskspace,
  updateTaskspaceLocation,
  updateTaskspaceName,
  getAllTaskspaceLocalMetadata,
} from "../../../db/api/taskspace.js";
import { localFileOperationTable, taskspaceTable } from "../../../db/schema.js";
import { _resetWorkspaceRootForTest } from "../../../db/internal/config.js";
import * as disk from "../taskspace-files.js";
import { contentHash } from "../local-file-operations.js";
import { createFile, saveFile } from "./file.js";
import { createDirectory, renameEntry, removeEntry } from "./files.js";
import { recoverTaskspaceOperation } from "./recover-operation.js";
import { recoverFileOperation } from "./recover-file.js";
import { oneAtATime } from "./queue.js";

let db: DB;
let root: string;
let params: { namespaceId: string; taskspaceId: string };
let previousRoot: string | undefined;
const cases = [
  "create-file",
  "save-file",
  "create-directory",
  "rename-entry",
  "remove-entry",
] as const;
type Kind = (typeof cases)[number];
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "kozane-recover-file-"));
  mkdirSync(join(root, ".kozane"));
  writeFileSync(join(root, ".kozane", "config.json"), JSON.stringify({ name: "Test" }));
  mkdirSync(join(root, "demo"));
  writeFileSync(join(root, "demo", "original.txt"), "Original");
  db = await createTestDB(join(root, "database.sqlite"));
  const namespaceId = await addNamespace({ db, name: "Namespace" });
  const taskspaceId = await addTaskspace({
    db,
    namespaceId,
    name: "Demo",
    path: "demo",
    lastSeenAt: new Date(123000),
  });
  params = { namespaceId, taskspaceId };
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
const rows = () => db.select().from(localFileOperationTable);
// Source fixtures and the packaged host adapter use the same runtime database handle.
const shared = () => captureApplicationRows(db as unknown as CoreDB);
const local = () => getAllTaskspaceLocalMetadata({ db });
const recover = (id: string, apply = false) => recoverTaskspaceOperation(db, root, id, apply);
const bytes = () => readFileSync(join(root, "demo", "original.txt"), "utf8");
async function change(operation: Kind, subPath = "original.txt") {
  switch (operation) {
    case "create-file":
      return createFile({ db }, params, { path: "new.txt" });
    case "save-file":
      return saveFile({ db }, params, {
        path: subPath,
        content: "Saved 日本語 🪁\n",
        signature: disk.readTaskspaceFile({ baseDir: join(root, "demo"), subPath }).signature,
      });
    case "create-directory":
      return createDirectory({ db }, params, { path: "new-directory" });
    case "rename-entry":
      return renameEntry({ db }, params, { path: subPath, name: "renamed.txt" });
    case "remove-entry":
      return removeEntry({ db }, params, subPath);
  }
}
async function interrupted(operation: Kind = "save-file", subPath?: string) {
  await db.run(
    sql`CREATE TRIGGER reject_confirmation BEFORE UPDATE ON local_file_operation BEGIN SELECT RAISE(ABORT,'interrupted'); END`,
  );
  await expect(change(operation, subPath)).rejects.toMatchObject({ status: 500 });
  await db.run(sql`DROP TRIGGER reject_confirmation`);
  const [row] = await rows();
  expect(row).toMatchObject({ state: "pending", error: null });
  return row;
}

it.each(cases)(
  "previews and confirms %s without changing files, shared rows or attachments",
  async (operation) => {
    const pending = await interrupted(operation);
    const before = await shared();
    const attachment = await local();
    const listing = readdirSync(join(root, "demo"));
    const spies = [
      vi.spyOn(disk, "createTaskspaceFile"),
      vi.spyOn(disk, "writeTaskspaceFile"),
      vi.spyOn(disk, "createTaskspaceDirectory"),
      vi.spyOn(disk, "renameTaskspaceEntry"),
      vi.spyOn(disk, "deleteTaskspaceEntry"),
    ];
    expect((await recover(pending.id)).status).toBe("confirmable");
    expect(await rows()).toEqual([pending]);
    expect((await recover(pending.id, true)).status).toBe("confirmed");
    const confirmed = await rows();
    expect(confirmed[0]).toMatchObject({
      ...pending,
      state: "confirmed",
      confirmedAt: expect.any(Date),
    });
    expect((await recover(pending.id, true)).status).toBe("already-confirmed");
    expect(await rows()).toEqual(confirmed);
    expect(await shared()).toEqual(before);
    expect(await local()).toEqual(attachment);
    expect(readdirSync(join(root, "demo"))).toEqual(listing);
    if (operation === "create-file")
      expect(readFileSync(join(root, "demo", "new.txt"), "utf8")).toBe("");
    if (operation === "save-file") expect(bytes()).toBe("Saved 日本語 🪁\n");
    if (operation === "rename-entry")
      expect(readFileSync(join(root, "demo", "renamed.txt"), "utf8")).toBe("Original");
    if (operation === "remove-entry")
      expect(existsSync(join(root, "demo", "original.txt"))).toBe(false);
    spies.forEach((spy) => expect(spy).not.toHaveBeenCalled());
  },
);

it.each([false, true])(
  "retains evidence and bytes when confirmation fails (commit=%s)",
  async (commit) => {
    const pending = await interrupted();
    const before = await shared();
    const attachment = await local();
    if (commit) {
      await db.run(sql`CREATE TABLE deferred_parent(id TEXT PRIMARY KEY)`);
      await db.run(
        sql`CREATE TABLE deferred_child(parent_id TEXT REFERENCES deferred_parent(id) DEFERRABLE INITIALLY DEFERRED)`,
      );
      await db.run(
        sql`CREATE TRIGGER reject_recovery AFTER UPDATE ON local_file_operation BEGIN INSERT INTO deferred_child VALUES('missing'); END`,
      );
    } else
      await db.run(
        sql`CREATE TRIGGER reject_recovery BEFORE UPDATE ON local_file_operation BEGIN SELECT RAISE(ABORT,'refused'); END`,
      );
    await expect(recover(pending.id, true)).rejects.toThrow();
    expect(await rows()).toEqual([pending]);
    expect(await shared()).toEqual(before);
    expect(await local()).toEqual(attachment);
    expect(bytes()).toBe("Saved 日本語 🪁\n");
    await db.run(sql`DROP TRIGGER reject_recovery`);
    expect((await recover(pending.id, true)).status).toBe("confirmed");
  },
);

it.each([
  "different-content",
  "missing-file",
  "missing-taskspace",
  "missing-namespace",
  "namespace",
  "attachment",
  "no-attachment",
  "invalid-intent",
  "requested-path",
  "traversal",
  "recorded-error",
  "symlink",
  "base-symlink",
] as const)("blocks %s and preserves pending evidence", async (changed) => {
  const pending = await interrupted();
  if (changed === "different-content")
    writeFileSync(join(root, "demo", "original.txt"), "Newer edit");
  if (changed === "missing-file") rmSync(join(root, "demo", "original.txt"));
  if (changed === "missing-taskspace")
    await db.delete(taskspaceTable).where(eq(taskspaceTable.id, params.taskspaceId));
  if (changed === "missing-namespace")
    await deleteNamespace({ db, namespaceId: params.namespaceId });
  if (changed === "namespace") {
    const namespaceId = await addNamespace({ db, name: "Other" });
    await db
      .update(taskspaceTable)
      .set({ namespaceId })
      .where(eq(taskspaceTable.id, params.taskspaceId));
  }
  if (changed === "attachment")
    await updateTaskspaceLocation({ db, taskspaceId: params.taskspaceId, path: "elsewhere" });
  if (changed === "no-attachment")
    await updateTaskspaceLocation({ db, taskspaceId: params.taskspaceId, path: null });
  if (["invalid-intent", "requested-path", "traversal"].includes(changed)) {
    const intent = JSON.parse(pending.intent);
    if (changed === "invalid-intent") intent.extra = true;
    else intent.requestedPath = changed === "traversal" ? "../demo/original.txt" : "other.txt";
    await db.update(localFileOperationTable).set({ intent: JSON.stringify(intent) });
  }
  if (changed === "recorded-error")
    await db.update(localFileOperationTable).set({ error: "Partial write" });
  if (changed === "symlink") {
    renameSync(join(root, "demo", "original.txt"), join(root, "kept.txt"));
    symlinkSync(join(root, "kept.txt"), join(root, "demo", "original.txt"));
  }
  if (changed === "base-symlink") {
    renameSync(join(root, "demo"), join(root, "kept"));
    symlinkSync(join(root, "kept"), join(root, "demo"));
  }
  const before = await shared();
  const attachment = await local();
  const evidence = await rows();
  expect((await recover(pending.id)).status).toBe("blocked");
  await expect(recover(pending.id, true)).rejects.toThrow("cannot be confirmed");
  expect(await rows()).toEqual(evidence);
  expect(await shared()).toEqual(before);
  expect(await local()).toEqual(attachment);
});

it.each(["source-only", "both-present", "both-absent", "symlink"] as const)(
  "refuses rename recovery with %s evidence",
  async (state) => {
    const pending = await interrupted("rename-entry");
    const source = join(root, "demo", "original.txt");
    const target = join(root, "demo", "renamed.txt");
    if (state === "source-only") renameSync(target, source);
    if (state === "both-present") writeFileSync(source, "Replacement");
    if (state === "both-absent") rmSync(target);
    if (state === "symlink") {
      renameSync(target, join(root, "kept.txt"));
      symlinkSync(join(root, "kept.txt"), target);
    }
    expect((await recover(pending.id)).status).toBe("blocked");
    await expect(recover(pending.id, true)).rejects.toThrow("cannot be confirmed");
    expect(await rows()).toEqual([pending]);
  },
);

it.each(["create-directory", "remove-entry"] as const)(
  "refuses %s when the intended postcondition is absent",
  async (operation) => {
    const pending = await interrupted(operation);
    if (operation === "create-directory") {
      rmSync(join(root, "demo", "new-directory"), { recursive: true });
      writeFileSync(join(root, "demo", "new-directory"), "A file is not a directory");
    } else writeFileSync(join(root, "demo", "original.txt"), "Recreated");
    expect((await recover(pending.id)).status).toBe("blocked");
    expect(await rows()).toEqual([pending]);
  },
);

it("allows unplaced taskspaces and independent label edits without changing their rows", async () => {
  const pending = await interrupted();
  await db
    .update(taskspaceTable)
    .set({ namespaceId: null })
    .where(eq(taskspaceTable.id, params.taskspaceId));
  await updateTaskspaceName({ db, taskspaceId: params.taskspaceId, name: "Later label" });
  const before = await shared();
  expect((await recover(pending.id, true)).status).toBe("confirmed");
  expect(await shared()).toEqual(before);
});

it.each([false, true])(
  "supports already authorized absolute attachments (outside=%s)",
  async (outside) => {
    const base = outside
      ? mkdtempSync(join(tmpdir(), "kozane-external-recovery-"))
      : join(root, "demo");
    try {
      await updateTaskspaceLocation({
        db,
        taskspaceId: params.taskspaceId,
        path: base,
        pathKind: "absolute",
      });
      const pending = await interrupted("create-file");
      expect(pending.pathKind).toBe(outside ? "absolute" : "workspace_relative");
      expect((await recover(pending.id, true)).status).toBe("confirmed");
      expect(readFileSync(join(base, "new.txt"), "utf8")).toBe("");
    } finally {
      if (outside) rmSync(base, { recursive: true, force: true });
    }
  },
);

it("confirms a regular directory rename without changing its contents", async () => {
  mkdirSync(join(root, "demo", "folder"));
  writeFileSync(join(root, "demo", "folder", "a.txt"), "Retained");
  const pending = await interrupted("rename-entry", "folder");
  expect((await recover(pending.id, true)).status).toBe("confirmed");
  expect(readFileSync(join(root, "demo", "renamed.txt", "a.txt"), "utf8")).toBe("Retained");
});

it("rechecks disk state after a successful preview", async () => {
  const pending = await interrupted();
  expect((await recover(pending.id)).status).toBe("confirmable");
  writeFileSync(join(root, "demo", "original.txt"), "Later edit");
  await expect(recover(pending.id, true)).rejects.toThrow("different-content");
  expect(await rows()).toEqual([pending]);
  expect(bytes()).toBe("Later edit");
});

it("rechecks the attachment after earlier queued work settles", async () => {
  const pending = await interrupted();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const earlier = oneAtATime(params.taskspaceId, async () => {
    entered();
    await gate;
    await updateTaskspaceLocation({ db, taskspaceId: params.taskspaceId, path: "elsewhere" });
  });
  await started;
  const attempt = recover(pending.id, true);
  release();
  await earlier;
  await expect(attempt).rejects.toThrow("cannot be confirmed");
  expect(await rows()).toEqual([pending]);
});

it("confirms once for concurrent attempts and refuses abandoned or wrong-kind operations", async () => {
  const pending = await interrupted();
  const attempts = await Promise.all([recover(pending.id, true), recover(pending.id, true)]);
  expect(attempts.map((result) => result.status).sort()).toEqual([
    "already-confirmed",
    "confirmed",
  ]);
  await db.update(localFileOperationTable).set({
    state: "abandoned",
    confirmedAt: null,
    abandonedAt: new Date(),
    abandonReason: "Reviewed",
  });
  await expect(recover(pending.id, true)).rejects.toThrow("abandoned");
  await db.update(localFileOperationTable).set({ kind: "taskspace.directory" });
  await expect(recoverFileOperation(db, root, pending.id, true)).rejects.toThrow(
    "not a file mutation",
  );
});

it("binds a forged path before reading its content even when its hash matches", async () => {
  const pending = await interrupted();
  const intent = JSON.parse(pending.intent);
  intent.contentHash = contentHash("Unrelated");
  writeFileSync(join(root, "unrelated.txt"), "Unrelated");
  await db
    .update(localFileOperationTable)
    .set({ path: "unrelated.txt", intent: JSON.stringify(intent) });
  const evidence = await rows();
  expect(await recover(pending.id)).toMatchObject({
    status: "blocked",
    reason: expect.stringContaining("attachment-mismatch"),
  });
  expect(await rows()).toEqual(evidence);
});
