import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createTestDB } from "../../../test-utils/db.js";
import type { DB } from "../../../db/database.js";
import { addNamespace } from "../../../db/api/namespace.js";
import {
  addTaskspace,
  getAllTaskspaceLocalMetadata,
  updateTaskspaceLocation,
} from "../../../db/api/taskspace.js";
import { localFileOperationTable } from "../../../db/schema.js";
import { _resetWorkspaceRootForTest } from "../../../db/internal/config.js";
import { captureApplicationRows } from "../../../test-utils/action-tables.js";
import type { DB as CoreDB } from "../../../../../core/src/database.js";
import { createFile, saveFile } from "./file.js";
import { createDirectory, renameEntry, removeEntry } from "./files.js";
import * as disk from "../taskspace-files.js";
import { contentHash, pendingLocalClaims } from "../local-file-operations.js";
import {
  inspectTaskspaceFileOperation,
  pendingTaskspaceFileOperations,
} from "../taskspace-file-operations.js";
import { createLocalClaimStartupCheck } from "../local-claim-startup.js";
import { journalTaskspaceFileChange } from "./file-operation.js";
import { recoverLocalClaim } from "./recover-claim.js";

let db: DB;
let root: string;
let params: { namespaceId: string; taskspaceId: string };
let previousRoot: string | undefined;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "kozane-file-journal-"));
  mkdirSync(join(root, ".kozane"));
  writeFileSync(join(root, ".kozane", "config.json"), JSON.stringify({ name: "test" }));
  mkdirSync(join(root, "demo"));
  writeFileSync(join(root, "demo", "original.txt"), "Original");
  db = await createTestDB(join(root, "database.sqlite"));
  const namespaceId = await addNamespace({ db, name: "Namespace" });
  const taskspaceId = await addTaskspace({ db, namespaceId, name: "Demo", path: "demo" });
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
const operations = () => db.select().from(localFileOperationTable);
// The source alias and published handle describe the same adapter during these host tests.
const shared = () => captureApplicationRows(db as unknown as CoreDB);
const cases = [
  "create-file",
  "save-file",
  "create-directory",
  "rename-entry",
  "remove-entry",
] as const;
async function change(operation: (typeof cases)[number]) {
  const context = { db };
  switch (operation) {
    case "create-file":
      return createFile(context, params, { path: "new.txt" });
    case "save-file": {
      const { signature } = disk.readTaskspaceFile({
        baseDir: join(root, "demo"),
        subPath: "original.txt",
      });
      return saveFile(context, params, {
        path: "original.txt",
        content: "Saved 日本語 🪁\n",
        signature,
      });
    }
    case "create-directory":
      return createDirectory(context, params, { path: "new-directory" });
    case "rename-entry":
      return renameEntry(context, params, { path: "original.txt", name: "renamed.txt" });
    case "remove-entry":
      return removeEntry(context, params, "original.txt");
  }
}
const observation = (operation: (typeof cases)[number]) =>
  ({
    "create-file": "matching-content",
    "save-file": "matching-content",
    "create-directory": "directory-present",
    "rename-entry": "target-only",
    "remove-entry": "entry-absent",
  })[operation];

it.each(cases)(
  "journals and confirms %s without changing shared rows or local attachments",
  async (operation) => {
    const before = await shared();
    const local = await getAllTaskspaceLocalMetadata({ db });
    await change(operation);
    const [row] = await operations();
    expect(row).toMatchObject({
      kind: "taskspace.file",
      version: 1,
      ...params,
      state: "confirmed",
      error: null,
    });
    expect(row.confirmedAt).toBeInstanceOf(Date);
    expect(inspectTaskspaceFileOperation(row, root)).toBe(observation(operation));
    if (operation === "save-file") {
      expect(JSON.parse(row.intent).contentHash).toBe(
        contentHash(readFileSync(join(root, "demo", "original.txt"))),
      );
      expect(row.intent).not.toContain("Saved 日本語");
    }
    expect(await shared()).toEqual(before);
    expect(await getAllTaskspaceLocalMetadata({ db })).toEqual(local);
    expect((await pendingTaskspaceFileOperations(db, root)).total).toBe(0);
  },
);

it("commits pending intent before invoking the file callback", async () => {
  const original = disk.createTaskspaceFile;
  vi.spyOn(disk, "createTaskspaceFile").mockImplementation((input) => {
    const reader = new DatabaseSync(join(root, "database.sqlite"), { readOnly: true });
    try {
      expect(
        reader.prepare("SELECT kind,state,path FROM local_file_operation").get(),
      ).toMatchObject({
        kind: "taskspace.file",
        state: "pending",
        path: join("demo", "new.txt"),
      });
      expect(existsSync(join(root, "demo", "new.txt"))).toBe(false);
    } finally {
      reader.close();
    }
    return original(input);
  });
  await change("create-file");
});

it.each([false, true])(
  "touches no files when pending intent cannot commit (deferred=%s)",
  async (commit) => {
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
    const callback = vi.spyOn(disk, "createTaskspaceFile");
    await expect(change("create-file")).rejects.toMatchObject({ status: 500 });
    expect(callback).not.toHaveBeenCalled();
    expect(await operations()).toEqual([]);
    expect(existsSync(join(root, "demo", "new.txt"))).toBe(false);
  },
);

it.each(cases)(
  "retains %s after failed confirmation without repeating disk work",
  async (operation) => {
    await db.run(
      sql`CREATE TRIGGER reject_confirmation BEFORE UPDATE ON local_file_operation BEGIN SELECT RAISE(ABORT,'confirm refused'); END`,
    );
    const before = await shared();
    await expect(change(operation)).rejects.toMatchObject({
      status: 500,
      message: expect.stringContaining("needs recovery"),
    });
    const rows = await operations();
    expect(rows[0]).toMatchObject({ state: "pending", confirmedAt: null, error: null });
    expect(inspectTaskspaceFileOperation(rows[0], root)).toBe(observation(operation));
    for (let i = 0; i < 2; i++) {
      expect((await pendingTaskspaceFileOperations(db, root)).named[0].observation).toBe(
        observation(operation),
      );
      expect((await pendingLocalClaims(db, root)).total).toBe(0);
    }
    const warn = vi.fn();
    await createLocalClaimStartupCheck(warn)(db, root);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain("pending taskspace file operation");
    expect(warn.mock.calls[0][0]).toContain("kozane taskspace recover <operationId>");
    expect(await operations()).toEqual(rows);
    expect(await shared()).toEqual(before);
    await expect(recoverLocalClaim(db, root, rows[0].id, true)).rejects.toThrow(
      "not a directory claim",
    );
  },
);

it("retains installed file bytes after a confirmation commit failure", async () => {
  await db.run(sql`CREATE TABLE deferred_parent(id TEXT PRIMARY KEY)`);
  await db.run(
    sql`CREATE TABLE deferred_child(parent_id TEXT REFERENCES deferred_parent(id) DEFERRABLE INITIALLY DEFERRED)`,
  );
  await db.run(
    sql`CREATE TRIGGER reject_confirmation AFTER UPDATE ON local_file_operation BEGIN INSERT INTO deferred_child VALUES('missing'); END`,
  );
  await expect(change("save-file")).rejects.toMatchObject({
    status: 500,
    message: expect.stringContaining("needs recovery"),
  });
  const [row] = await operations();
  expect(row.state).toBe("pending");
  expect(inspectTaskspaceFileOperation(row, root)).toBe("matching-content");
  expect(readFileSync(join(root, "demo", "original.txt"), "utf8")).toBe("Saved 日本語 🪁\n");
});

it("preserves stale-save errors and records pending evidence without overwriting the file", async () => {
  await expect(
    saveFile({ db }, params, { path: "original.txt", content: "Do not write", signature: "stale" }),
  ).rejects.toMatchObject({ status: 409, message: "File changed on disk since it was opened" });
  const [row] = await operations();
  expect(row).toMatchObject({ state: "pending", error: expect.stringContaining("File changed") });
  expect(inspectTaskspaceFileOperation(row, root)).toBe("different-content");
  expect(readFileSync(join(root, "demo", "original.txt"), "utf8")).toBe("Original");
});

it("preserves pending intent and both errors when a callback and error recording fail", async () => {
  await db.run(
    sql`CREATE TRIGGER reject_error BEFORE UPDATE ON local_file_operation BEGIN SELECT RAISE(ABORT,'error recording refused'); END`,
  );
  await expect(createFile({ db }, params, { path: "original.txt" })).rejects.toMatchObject({
    status: 500,
  });
  expect((await operations())[0]).toMatchObject({ state: "pending", error: null });
  expect(vi.mocked(console.error).mock.calls[0][1]).toBeInstanceOf(AggregateError);
});

it("refuses a changed attachment after the intent commit and before the callback", async () => {
  mkdirSync(join(root, "other"));
  const callback = vi.fn();
  await expect(
    journalTaskspaceFileChange(
      {
        db,
        ...params,
        root,
        baseDir: join(root, "demo"),
        request: { operation: "create-file", subPath: "new.txt" },
        currentBaseDir: async () => {
          await updateTaskspaceLocation({ db, taskspaceId: params.taskspaceId, path: "other" });
          return join(root, "other");
        },
      },
      callback,
    ),
  ).rejects.toMatchObject({ phase: "change" });
  expect(callback).not.toHaveBeenCalled();
  expect((await operations())[0].state).toBe("pending");
  expect(existsSync(join(root, "demo", "new.txt"))).toBe(false);
  expect(existsSync(join(root, "other", "new.txt"))).toBe(false);
});

it("refuses traversal and forged rename destinations during read-only inspection", async () => {
  await change("rename-entry");
  const [row] = await operations();
  const intent = JSON.parse(row.intent);
  expect(
    inspectTaskspaceFileOperation(
      {
        ...row,
        path: "../outside",
        intent: JSON.stringify({ ...intent, targetPath: join("..", "renamed.txt") }),
      },
      root,
    ),
  ).toBe("unsafe-path");
  intent.targetPath = "../outside";
  expect(inspectTaskspaceFileOperation({ ...row, intent: JSON.stringify(intent) }, root)).toBe(
    "invalid-intent",
  );
});

it("waits for outstanding file work before confirming completion", async () => {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const changing = journalTaskspaceFileChange(
    {
      db,
      ...params,
      root,
      baseDir: join(root, "demo"),
      request: { operation: "create-file", subPath: "async.txt" },
      currentBaseDir: async () => join(root, "demo"),
    },
    async (baseDir) => {
      entered();
      await waiting;
      return disk.createTaskspaceFile({ baseDir, subPath: "async.txt" });
    },
  );
  await started;
  expect((await operations())[0]).toMatchObject({ state: "pending", confirmedAt: null });
  expect(existsSync(join(root, "demo", "async.txt"))).toBe(false);
  release();
  await changing;
  expect((await operations())[0].state).toBe("confirmed");
});

it.each(cases)(
  "retains completed %s after a confirmation trigger changes its receipt",
  async (operation) => {
    await db.run(sql`CREATE TRIGGER change_confirmation AFTER UPDATE ON local_file_operation
    WHEN NEW.state='confirmed' AND OLD.state='pending'
    BEGIN UPDATE local_file_operation SET created_at=created_at+1 WHERE id=NEW.id; END`);
    const before = await shared();
    const local = await getAllTaskspaceLocalMetadata({ db });
    await expect(change(operation)).rejects.toMatchObject({
      status: 500,
      message: expect.stringContaining("needs recovery"),
    });
    const [row] = await operations();
    expect(row).toMatchObject({ state: "pending", confirmedAt: null, error: null });
    expect(inspectTaskspaceFileOperation(row, root)).toBe(observation(operation));
    expect(await shared()).toEqual(before);
    expect(await getAllTaskspaceLocalMetadata({ db })).toEqual(local);
  },
);

it.each(cases)(
  "refuses %s confirmation when a trigger changes its attachment",
  async (operation) => {
    mkdirSync(join(root, "other"));
    await db.run(sql`CREATE TRIGGER change_attachment AFTER UPDATE ON local_file_operation
    WHEN NEW.state='confirmed' AND OLD.state='pending' BEGIN UPDATE taskspace_local SET path='other'; END`);
    const before = await shared();
    const local = await getAllTaskspaceLocalMetadata({ db });
    await expect(change(operation)).rejects.toMatchObject({
      status: 500,
      message: expect.stringContaining("needs recovery"),
    });
    const [row] = await operations();
    expect(row).toMatchObject({ state: "pending", confirmedAt: null, error: null });
    expect(inspectTaskspaceFileOperation(row, root)).toBe(observation(operation));
    expect(await shared()).toEqual(before);
    expect(await getAllTaskspaceLocalMetadata({ db })).toEqual(local);
  },
);

it.each(cases)(
  "keeps newer disk state when %s no longer has its intended outcome",
  async (operation) => {
    switch (operation) {
      case "create-file": {
        const original = disk.createTaskspaceFile;
        vi.spyOn(disk, "createTaskspaceFile").mockImplementation((input) => {
          const result = original(input);
          writeFileSync(join(root, "demo", "new.txt"), "Newer edit");
          return result;
        });
        break;
      }
      case "save-file": {
        const original = disk.writeTaskspaceFile;
        vi.spyOn(disk, "writeTaskspaceFile").mockImplementation((input) => {
          const result = original(input);
          writeFileSync(join(root, "demo", "original.txt"), "Newer edit");
          return result;
        });
        break;
      }
      case "create-directory": {
        const original = disk.createTaskspaceDirectory;
        vi.spyOn(disk, "createTaskspaceDirectory").mockImplementation((input) => {
          const result = original(input);
          rmSync(join(root, "demo", "new-directory"), { recursive: true });
          writeFileSync(join(root, "demo", "new-directory"), "Newer file");
          return result;
        });
        break;
      }
      case "rename-entry": {
        const original = disk.renameTaskspaceEntry;
        vi.spyOn(disk, "renameTaskspaceEntry").mockImplementation((input) => {
          const result = original(input);
          writeFileSync(join(root, "demo", "original.txt"), "Newer source");
          return result;
        });
        break;
      }
      case "remove-entry": {
        const original = disk.deleteTaskspaceEntry;
        vi.spyOn(disk, "deleteTaskspaceEntry").mockImplementation((input) => {
          const result = original(input);
          writeFileSync(join(root, "demo", "original.txt"), "Recreated");
          return result;
        });
      }
    }
    await expect(change(operation)).rejects.toMatchObject({
      status: 500,
      message: expect.stringContaining("needs recovery"),
    });
    expect(await operations()).toMatchObject([{ state: "pending", error: null }]);
    const file =
      operation === "create-file"
        ? "new.txt"
        : operation === "create-directory"
          ? "new-directory"
          : "original.txt";
    const expected = {
      "create-file": "Newer edit",
      "save-file": "Newer edit",
      "create-directory": "Newer file",
      "rename-entry": "Newer source",
      "remove-entry": "Recreated",
    }[operation];
    expect(readFileSync(join(root, "demo", file), "utf8")).toBe(expected);
  },
);

it.each(cases)(
  "confirms %s while leaving unrelated unsafe timestamps unchanged",
  async (operation) => {
    await db.run(
      sql`UPDATE taskspace SET created_at=9007199254740993,updated_at=-9007199254740995`,
    );
    await db.run(sql`UPDATE taskspace_local SET last_seen_at=9007199254740997`);
    const before = await shared();
    await change(operation);
    expect(await shared()).toEqual(before);
    expect(
      (await db.values(sql`SELECT CAST(last_seen_at AS TEXT) FROM taskspace_local`))[0][0],
    ).toBe("9007199254740997");
    expect((await operations())[0].state).toBe("confirmed");
  },
);

it("retains a separately committed attachment change after disk work", async () => {
  mkdirSync(join(root, "other"));
  await expect(
    journalTaskspaceFileChange(
      {
        db,
        ...params,
        root,
        baseDir: join(root, "demo"),
        request: { operation: "create-file", subPath: "new.txt" },
        currentBaseDir: async () => join(root, "demo"),
      },
      async (baseDir) => {
        const result = disk.createTaskspaceFile({ baseDir, subPath: "new.txt" });
        await updateTaskspaceLocation({ db, taskspaceId: params.taskspaceId, path: "other" });
        return result;
      },
    ),
  ).rejects.toMatchObject({ phase: "confirm" });
  expect(await getAllTaskspaceLocalMetadata({ db })).toMatchObject([{ path: "other" }]);
  expect(await operations()).toMatchObject([{ state: "pending", error: null }]);
  expect(readFileSync(join(root, "demo", "new.txt"), "utf8")).toBe("");
});

it("owns file intent and its resolver before asynchronous journal work", async () => {
  const input = {
    db,
    ...params,
    root,
    baseDir: join(root, "demo"),
    request: { operation: "create-file" as const, subPath: "owned.txt" },
    currentBaseDir: async () => join(root, "demo"),
  };
  const callback = vi.fn((baseDir: string) =>
    disk.createTaskspaceFile({ baseDir, subPath: "owned.txt" }),
  );
  const changing = journalTaskspaceFileChange(input, callback);
  input.request.subPath = "changed.txt";
  input.currentBaseDir = async () => {
    throw Error("Changed resolver");
  };
  await changing;
  expect(callback).toHaveBeenCalledTimes(1);
  expect((await operations())[0]).toMatchObject({
    path: join("demo", "owned.txt"),
    state: "confirmed",
  });
  expect(existsSync(join(root, "demo", "changed.txt"))).toBe(false);
});

it.each(["namespace", "taskspace", "missing-namespace"] as const)(
  "refuses final %s changes without confirming file work",
  async (field) => {
    await db.run(
      sql`INSERT INTO namespace(id,name,is_default) VALUES('other-namespace','Other',0)`,
    );
    const statement = {
      namespace: "UPDATE taskspace SET namespace_id='other-namespace'",
      taskspace: "DELETE FROM taskspace",
      "missing-namespace": `DELETE FROM namespace WHERE id='${params.namespaceId}'`,
    };
    await db.run(
      sql.raw(`CREATE TRIGGER change_visibility AFTER UPDATE ON local_file_operation
    WHEN NEW.state='confirmed' AND OLD.state='pending' BEGIN ${statement[field]}; END`),
    );
    const before = await shared();
    const attachment = await getAllTaskspaceLocalMetadata({ db });
    await expect(change("create-file")).rejects.toMatchObject({
      status: 500,
      message: expect.stringContaining("needs recovery"),
    });
    expect(await shared()).toEqual(before);
    expect(await getAllTaskspaceLocalMetadata({ db })).toEqual(attachment);
    expect(await operations()).toMatchObject([{ state: "pending", error: null }]);
    expect(readFileSync(join(root, "demo", "new.txt"), "utf8")).toBe("");
  },
);
