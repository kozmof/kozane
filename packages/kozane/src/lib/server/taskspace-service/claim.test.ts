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
import {
  cardTable,
  partitionTable,
  layerTable,
  localFileOperationTable,
  taskspaceLocalTable,
} from "../../../db/schema.js";
import { TASKSPACE_MARKER_FILE } from "../../taskspace-marker.js";
import { contentHash, inspectLocalClaim, pendingLocalClaims } from "../local-file-operations.js";
import * as evidence from "../local-file-operations.js";
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

function edit(statement: string) {
  const writer = new DatabaseSync(join(root, "database.sqlite"));
  try {
    writer.exec("PRAGMA foreign_keys=ON");
    writer.exec(statement);
  } finally {
    writer.close();
  }
}

it.each(["intent", "created", "error", "deleted"] as const)(
  "rejects changed initial %s evidence before disk work",
  async (field) => {
    const statements = {
      intent: "UPDATE local_file_operation SET intent='{}' WHERE id=NEW.id",
      created: "UPDATE local_file_operation SET created_at=created_at+1 WHERE id=NEW.id",
      error: "UPDATE local_file_operation SET error='Changed' WHERE id=NEW.id",
      deleted: "DELETE FROM local_file_operation WHERE id=NEW.id",
    };
    await db.run(
      sql.raw(
        `CREATE TRIGGER change_intent AFTER INSERT ON local_file_operation BEGIN ${statements[field]}; END`,
      ),
    );
    const callback = vi.spyOn(directories, "claimTaskspaceDirectory");
    await expect(claim()).rejects.toThrow();
    expect(callback).not.toHaveBeenCalled();
    expect(await getAllTaskspaces({ db })).toEqual([]);
    expect(await db.select().from(localFileOperationTable)).toEqual([]);
    expect(existsSync(join(root, "target"))).toBe(false);
  },
);

it.each(["intent", "created", "path", "state", "time", "deleted"] as const)(
  "rolls back creation attachment when confirmation changes %s evidence",
  async (field) => {
    const statements = {
      intent: "UPDATE local_file_operation SET intent='{}' WHERE id=NEW.id",
      created: "UPDATE local_file_operation SET created_at=created_at+1 WHERE id=NEW.id",
      path: "UPDATE local_file_operation SET path='different' WHERE id=NEW.id",
      state: "UPDATE local_file_operation SET state='pending',confirmed_at=NULL WHERE id=NEW.id",
      time: "UPDATE local_file_operation SET confirmed_at=confirmed_at+1 WHERE id=NEW.id",
      deleted: "DELETE FROM local_file_operation WHERE id=NEW.id",
    };
    await db.run(
      sql.raw(`CREATE TRIGGER change_confirmation AFTER UPDATE ON local_file_operation
    WHEN NEW.state='confirmed' AND OLD.state='pending' BEGIN ${statements[field]}; END`),
    );
    const callback = vi.spyOn(directories, "claimTaskspaceDirectory");
    await expect(claim()).rejects.toMatchObject({ phase: "attach" });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(await getAllTaskspaces({ db })).toMatchObject([{ name: "Label", path: null }]);
    expect(await db.select().from(taskspaceLocalTable)).toEqual([]);
    const row = await operation();
    expect(row).toMatchObject({ state: "pending", confirmedAt: null, error: null });
    expect(inspectLocalClaim(row, root)).toBe("matching-marker");
  },
);

it.each(["label", "namespace", "attachment", "journal-error", "marker"] as const)(
  "preserves changed %s after disk success instead of publishing attachment",
  async (field) => {
    const original = directories.claimTaskspaceDirectory;
    vi.spyOn(directories, "claimTaskspaceDirectory").mockImplementation((request) => {
      const result = original(request);
      if (field === "label") edit("UPDATE taskspace SET name='Later label'");
      if (field === "namespace") edit("UPDATE taskspace SET namespace_id=NULL");
      if (field === "attachment")
        edit(
          `INSERT INTO taskspace_local(taskspace_id,path,path_kind) VALUES('${request.taskspaceId}','other','workspace_relative')`,
        );
      if (field === "journal-error")
        edit("UPDATE local_file_operation SET error='Separate failure'");
      if (field === "marker")
        writeFileSync(join(root, "target", TASKSPACE_MARKER_FILE), "Newer marker");
      return result;
    });
    await expect(claim()).rejects.toMatchObject({ phase: "attach" });
    expect(await getAllTaskspaces({ db })).toMatchObject([
      {
        name: field === "label" ? "Later label" : "Label",
        namespaceId: field === "namespace" ? null : namespaceId,
        path: field === "attachment" ? "other" : null,
      },
    ]);
    expect(await operation()).toMatchObject({
      state: "pending",
      error: field === "journal-error" ? "Separate failure" : null,
    });
    if (field === "marker")
      expect(readFileSync(join(root, "target", TASKSPACE_MARKER_FILE), "utf8")).toBe(
        "Newer marker",
      );
  },
);

it.each(["label", "attachment", "intent", "error", "timestamp"] as const)(
  "retains changed %s instead of compensating a failed directory claim",
  async (field) => {
    vi.spyOn(directories, "claimTaskspaceDirectory").mockImplementation((request) => {
      if (field === "label") edit("UPDATE taskspace SET name='Later label'");
      if (field === "attachment")
        edit(
          `INSERT INTO taskspace_local(taskspace_id,path,path_kind) VALUES('${request.taskspaceId}','other','workspace_relative')`,
        );
      if (field === "intent") edit("UPDATE local_file_operation SET intent='{}'");
      if (field === "error") edit("UPDATE local_file_operation SET error='Separate failure'");
      if (field === "timestamp") edit("UPDATE taskspace SET updated_at=9007199254740993");
      throw Error("Disk failure");
    });
    await expect(claim()).rejects.toMatchObject({
      phase: "claim",
      cause: expect.any(AggregateError),
    });
    expect((await db.values(sql`SELECT count(*) FROM taskspace`))[0][0]).toBe(1);
    expect(await operation()).toMatchObject({
      state: "pending",
      error: field === "error" ? "Separate failure" : null,
    });
    if (field === "timestamp")
      expect((await db.values(sql`SELECT CAST(updated_at AS TEXT) FROM taskspace`))[0][0]).toBe(
        "9007199254740993",
      );
  },
);

it.each(["intent", "error", "state", "deleted"] as const)(
  "rolls back compensation when error recording changes %s evidence",
  async (field) => {
    const statements = {
      intent: "UPDATE local_file_operation SET intent='{}' WHERE id=NEW.id",
      error: "UPDATE local_file_operation SET error='Different failure' WHERE id=NEW.id",
      state:
        "UPDATE local_file_operation SET state='abandoned',abandoned_at=123,abandon_reason='Reviewed' WHERE id=NEW.id",
      deleted: "DELETE FROM local_file_operation WHERE id=NEW.id",
    };
    await db.run(
      sql.raw(`CREATE TRIGGER change_error AFTER UPDATE ON local_file_operation
    WHEN OLD.error IS NULL AND NEW.error IS NOT NULL BEGIN ${statements[field]}; END`),
    );
    mkdirSync(join(root, "target"));
    await expect(claim()).rejects.toMatchObject({
      phase: "claim",
      cause: expect.any(AggregateError),
    });
    expect(await getAllTaskspaces({ db })).toMatchObject([{ name: "Label", path: null }]);
    expect(await operation()).toMatchObject({
      state: "pending",
      intent: expect.not.stringMatching(/^\{\}$/),
      error: null,
    });
  },
);

it("owns creation inputs before its first transaction awaits", async () => {
  const record = {
    db,
    namespaceId,
    scopeId,
    name: "Label",
    path: "target",
    pathKind: "workspace_relative" as const,
    lastSeenAt: new Date(123000),
  };
  const directory = {
    workspaceRoot: root,
    targetDir: join(root, "target"),
    adoptExisting: false,
    parentsInside: true,
    ownIfCreated: true,
  };
  const result = claimRecordedTaskspace(record, directory);
  record.name = "Changed";
  record.lastSeenAt.setTime(999000);
  directory.targetDir = join(root, "changed");
  directory.ownIfCreated = false;
  await result;
  expect(await getAllTaskspaces({ db })).toMatchObject([
    { name: "Label", path: "target", lastSeenAt: new Date(123000) },
  ]);
  expect(inspectLocalClaim(await operation(), root)).toBe("matching-marker");
  expect(existsSync(join(root, "changed"))).toBe(false);
});

it("retains a card linked during a failed directory claim", async () => {
  await db.insert(partitionTable).values({ id: "p", namespaceId, name: "Inbox", isDefault: true });
  await db.insert(layerTable).values({ id: "l", namespaceId, name: "Base", isDefault: true });
  await db
    .insert(cardTable)
    .values({ id: "card", partitionId: "p", layerId: "l", content: "Linked later" });
  vi.spyOn(directories, "claimTaskspaceDirectory").mockImplementation((request) => {
    edit(`UPDATE card SET taskspace_id='${request.taskspaceId}' WHERE id='card'`);
    throw Error("Disk failure");
  });
  await expect(claim()).rejects.toMatchObject({
    phase: "claim",
    cause: expect.any(AggregateError),
  });
  const row = await operation();
  expect(await getAllTaskspaces({ db })).toMatchObject([{ id: row.taskspaceId, path: null }]);
  expect((await db.select().from(cardTable))[0].taskspaceId).toBe(row.taskspaceId);
  expect(row.error).toBeNull();
});

it("records the failure when namespace deletion already removed the new shared identity", async () => {
  const failure = Error("Disk failure");
  vi.spyOn(directories, "claimTaskspaceDirectory").mockImplementation(() => {
    edit(`DELETE FROM namespace WHERE id='${namespaceId}'`);
    throw failure;
  });
  await expect(claim()).rejects.toMatchObject({ phase: "claim", cause: failure });
  expect(await getAllTaskspaces({ db })).toEqual([]);
  expect(await operation()).toMatchObject({ state: "pending", error: String(failure) });
});

it.each(["label", "path", "observation"] as const)(
  "rolls back attachment if a confirmation trigger changes final %s state",
  async (field) => {
    const statement = {
      label: "UPDATE taskspace SET name='Changed'",
      path: "UPDATE taskspace_local SET path='different'",
      observation: "UPDATE taskspace_local SET last_seen_at=NULL",
    };
    await db.run(
      sql.raw(`CREATE TRIGGER change_confirmation AFTER UPDATE ON local_file_operation
    WHEN NEW.state='confirmed' AND OLD.state='pending' BEGIN ${statement[field]}; END`),
    );
    await expect(claim()).rejects.toMatchObject({ phase: "attach" });
    expect(await getAllTaskspaces({ db })).toMatchObject([
      { name: "Label", path: null, lastSeenAt: null },
    ]);
    expect(await operation()).toMatchObject({ state: "pending", error: null });
  },
);

it("rolls back compensation if error recording recreates the shared identity", async () => {
  await db.run(sql`CREATE TRIGGER recreate_claim AFTER UPDATE ON local_file_operation
    WHEN OLD.error IS NULL AND NEW.error IS NOT NULL BEGIN
      INSERT INTO taskspace(id,namespace_id,name,created_at,updated_at) VALUES(NEW.taskspace_id,NEW.namespace_id,'Recreated',1,2);
    END`);
  mkdirSync(join(root, "target"));
  await expect(claim()).rejects.toMatchObject({
    phase: "claim",
    cause: expect.any(AggregateError),
  });
  expect(await getAllTaskspaces({ db })).toMatchObject([{ name: "Label", path: null }]);
  expect(await operation()).toMatchObject({ state: "pending", error: null });
});

it("preserves a marker changed during database confirmation without publishing the attachment", async () => {
  const observe = evidence.inspectLocalClaim;
  let observations = 0;
  vi.spyOn(evidence, "inspectLocalClaim").mockImplementation((...args) => {
    const result = observe(...args);
    if (++observations === 1)
      writeFileSync(join(root, "target", TASKSPACE_MARKER_FILE), "Newer marker");
    return result;
  });
  await expect(claim()).rejects.toMatchObject({ phase: "attach" });
  expect(await getAllTaskspaces({ db })).toMatchObject([{ path: null }]);
  expect(await operation()).toMatchObject({ state: "pending", error: null });
  expect(readFileSync(join(root, "target", TASKSPACE_MARKER_FILE), "utf8")).toBe("Newer marker");
});

it("refuses invalid observation dates before shared creation or disk work", async () => {
  await expect(
    claimRecordedTaskspace(
      {
        db,
        namespaceId,
        name: "Label",
        path: "target",
        pathKind: "workspace_relative",
        lastSeenAt: new Date(NaN),
      },
      {
        workspaceRoot: root,
        targetDir: join(root, "target"),
        adoptExisting: false,
        parentsInside: true,
        ownIfCreated: true,
      },
    ),
  ).rejects.toThrow("timestamp");
  expect(await getAllTaskspaces({ db })).toEqual([]);
  expect(await db.select().from(localFileOperationTable)).toEqual([]);
  expect(existsSync(join(root, "target"))).toBe(false);
});
