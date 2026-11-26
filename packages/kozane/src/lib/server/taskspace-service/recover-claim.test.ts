import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { createTestDB } from "../../../test-utils/db.js";
import type { DB } from "../../../db/database.js";
import { addNamespace, deleteNamespace } from "../../../db/api/namespace.js";
import { getTaskspace, updateTaskspaceLocation } from "../../../db/api/taskspace.js";
import {
  localFileOperationTable,
  taskspaceLocalTable,
  taskspaceTable,
} from "../../../db/schema.js";
import { TASKSPACE_MARKER_FILE } from "../../taskspace-marker.js";
import { contentHash, localClaimIntent, pendingLocalClaims } from "../local-file-operations.js";
import * as directories from "../taskspace-directory.js";
import { createLocalClaimStartupCheck } from "../local-claim-startup.js";
import { claimRecordedTaskspace } from "./claim.js";
import { recoverLocalClaim } from "./recover-claim.js";
import { oneAtATime } from "./queue.js";

let db: DB;
let root: string;
let namespaceId: string;
let id: string;
let taskspaceId: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "kozane-recover-claim-"));
  db = await createTestDB();
  namespaceId = await addNamespace({ db, name: "Namespace" });
  await db.run(
    sql`CREATE TRIGGER reject_confirmation BEFORE UPDATE ON local_file_operation BEGIN SELECT RAISE(ABORT,'interrupted'); END`,
  );
  await expect(
    claimRecordedTaskspace(
      { db, namespaceId, name: "Created", path: "target", pathKind: "workspace_relative" },
      {
        workspaceRoot: root,
        targetDir: join(root, "target"),
        adoptExisting: false,
        parentsInside: true,
        ownIfCreated: true,
      },
    ),
  ).rejects.toMatchObject({ phase: "attach" });
  await db.run(sql`DROP TRIGGER reject_confirmation`);
  const row = (await db.select().from(localFileOperationTable))[0];
  id = row.id;
  taskspaceId = row.taskspaceId;
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});
const recover = (apply = false) => recoverLocalClaim(db, root, id, apply);
const journal = () => db.select().from(localFileOperationTable);
const taskspace = () => getTaskspace({ db, taskspaceId });

it("previews without mutations and atomically confirms only local state without replaying disk work", async () => {
  const original = await taskspace();
  const pending = await journal();
  const bytes = readFileSync(join(root, "target", TASKSPACE_MARKER_FILE));
  const claim = vi.spyOn(directories, "claimTaskspaceDirectory");
  expect((await recover()).status).toBe("confirmable");
  expect(await taskspace()).toEqual(original);
  expect(await journal()).toEqual(pending);
  expect((await recover(true)).status).toBe("confirmed");
  expect(await taskspace()).toMatchObject({
    ...original,
    path: "target",
    pathKind: "workspace_relative",
    lastSeenAt: expect.any(Date),
  });
  const confirmed = await journal();
  expect(confirmed[0]).toMatchObject({
    state: "confirmed",
    confirmedAt: expect.any(Date),
    error: null,
  });
  expect((await recover(true)).status).toBe("already-confirmed");
  expect(await journal()).toEqual(confirmed);
  expect(claim).not.toHaveBeenCalled();
  expect(readFileSync(join(root, "target", TASKSPACE_MARKER_FILE))).toEqual(bytes);
});

it.each([
  "missing-marker",
  "different-marker",
  "missing-directory",
  "symlink",
  "invalid-intent",
  "forged-hash",
  "reassigned",
  "removed",
  "attachment",
])(
  "refuses %s after an earlier successful preview and retains pending evidence",
  async (change) => {
    expect((await recover()).status).toBe("confirmable");
    const marker = join(root, "target", TASKSPACE_MARKER_FILE);
    if (change === "missing-marker") rmSync(marker);
    if (change === "different-marker") writeFileSync(marker, "changed");
    if (change === "missing-directory") rmSync(join(root, "target"), { recursive: true });
    if (change === "symlink") {
      rmSync(marker);
      symlinkSync(join(root, "unrelated"), marker);
    }
    if (change === "invalid-intent") await db.update(localFileOperationTable).set({ intent: "{}" });
    if (change === "forged-hash") {
      writeFileSync(marker, "unrelated");
      const intent = JSON.parse(
        localClaimIntent(taskspaceId, namespaceId, {
          adoptExisting: false,
          parentsInside: true,
          ownIfCreated: true,
        }),
      );
      intent.markerHashes = [contentHash("unrelated")];
      await db.update(localFileOperationTable).set({ intent: JSON.stringify(intent) });
    }
    if (change === "reassigned") {
      const other = await addNamespace({ db, name: "Other" });
      await db
        .update(taskspaceTable)
        .set({ namespaceId: other })
        .where(eq(taskspaceTable.id, taskspaceId));
    }
    if (change === "removed") await deleteNamespace({ db, namespaceId });
    if (change === "attachment")
      await updateTaskspaceLocation({ db, taskspaceId, path: "different" });
    const rows = await journal();
    const shared = await taskspace();
    expect((await recover()).status).toBe("blocked");
    await expect(recover(true)).rejects.toThrow("cannot be confirmed");
    expect(await journal()).toEqual(rows);
    expect(await taskspace()).toEqual(shared);
  },
);

it.each([false, true])(
  "rolls back local publication after confirmation failure (commit=%s)",
  async (commit) => {
    if (commit) {
      await db.run(sql`CREATE TABLE deferred_parent(id TEXT PRIMARY KEY)`);
      await db.run(
        sql`CREATE TABLE deferred_child(parent_id TEXT REFERENCES deferred_parent(id) DEFERRABLE INITIALLY DEFERRED)`,
      );
      await db.run(
        sql`CREATE TRIGGER reject_confirmation AFTER UPDATE ON local_file_operation BEGIN INSERT INTO deferred_child VALUES('missing'); END`,
      );
    } else {
      await db.run(
        sql`CREATE TRIGGER reject_confirmation BEFORE UPDATE ON local_file_operation BEGIN SELECT RAISE(ABORT,'confirmation refused'); END`,
      );
    }
    const original = await taskspace();
    const rows = await journal();
    await expect(recover(true)).rejects.toThrow();
    expect(await taskspace()).toEqual(original);
    expect(await journal()).toEqual(rows);
    await db.run(sql`DROP TRIGGER reject_confirmation`);
    expect((await recover(true)).status).toBe("confirmed");
  },
);

it("serializes with taskspace file operations and makes concurrent confirmation idempotent", async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = oneAtATime(taskspaceId, async () => {
    entered();
    await gate;
  });
  await started;
  let finished = false;
  const first = recover(true).then((value) => {
    finished = true;
    return value;
  });
  // An independent snapshot remains readable while recovery is queued behind disk work.
  expect((await recover()).status).toBe("confirmable");
  expect(finished).toBe(false);
  release();
  await held;
  const second = recover(true);
  expect((await first).status).toBe("confirmed");
  expect((await second).status).toBe("already-confirmed");
});

it("reports pending claims once for overlapping startup checks and never confirms them", async () => {
  const warn = vi.fn();
  const inspect = createLocalClaimStartupCheck(warn);
  const rows = await journal();
  const original = await taskspace();
  await Promise.all([inspect(db, root), inspect(db, root), inspect(db, root)]);
  expect(warn).toHaveBeenCalledOnce();
  expect(warn.mock.calls[0][0]).toContain(`${id} (matching-marker)`);
  expect(await journal()).toEqual(rows);
  expect(await taskspace()).toEqual(original);
  expect((await pendingLocalClaims(db, root)).total).toBe(1);
  const restarted = createLocalClaimStartupCheck(warn);
  await restarted(db, root);
  expect(warn).toHaveBeenCalledTimes(2);
});

it("reports inspection failure without rejecting startup or retrying external work", async () => {
  const warn = vi.fn();
  const inspect = createLocalClaimStartupCheck(warn);
  await db.run(sql`DROP TABLE local_file_operation`);
  await expect(inspect(db, root)).resolves.toBeUndefined();
  await inspect(db, root);
  expect(warn).toHaveBeenCalledOnce();
  expect(warn.mock.calls[0][0]).toContain("Could not inspect");
});

it("recovers while preserving unsafe shared timestamps and replacing an unrelated local observation", async () => {
  await db.run(sql`UPDATE taskspace SET created_at=9007199254740993,updated_at=9007199254740995`);
  await db.run(sql`INSERT INTO taskspace_local(taskspace_id,path,path_kind,last_seen_at)
    VALUES(${taskspaceId},NULL,'workspace_relative',9007199254740997)`);
  const shared = () =>
    db.values(sql`SELECT id,namespace_id,name,scope_id,
    CAST(created_at AS TEXT),CAST(updated_at AS TEXT) FROM taskspace`);
  const original = (await shared()).map((row) => Array.from(row));
  const claim = vi.spyOn(directories, "claimTaskspaceDirectory");
  expect((await recover()).status).toBe("confirmable");
  expect((await recover(true)).status).toBe("confirmed");
  expect((await shared()).map((row) => Array.from(row))).toEqual(original);
  expect(await db.select().from(taskspaceLocalTable)).toMatchObject([
    { taskspaceId, path: "target", lastSeenAt: expect.any(Date) },
  ]);
  expect(claim).not.toHaveBeenCalled();
});

it("clears the inspected claim error only after verifying matching completed work", async () => {
  await db.update(localFileOperationTable).set({ error: "Interrupted after writing the marker" });
  expect((await recover()).status).toBe("confirmable");
  expect((await journal())[0].error).toBe("Interrupted after writing the marker");
  expect((await recover(true)).status).toBe("confirmed");
  expect((await journal())[0].error).toBeNull();
  await updateTaskspaceLocation({ db, taskspaceId, path: "later", lastSeenAt: new Date(123000) });
  const later = await taskspace();
  expect((await recover(true)).status).toBe("already-confirmed");
  expect(await taskspace()).toEqual(later);
});

it.each(["path", "intent", "namespace", "created", "error", "abandoned"] as const)(
  "rolls back publication when a trigger changes pending %s evidence",
  async (field) => {
    const changes = {
      path: "path='different'",
      intent: "intent='{}'",
      namespace: "namespace_id='different'",
      created: "created_at=created_at+1",
      error: "error='Changed after inspection'",
      abandoned: "state='abandoned',abandoned_at=123,abandon_reason='Reviewed'",
    };
    await db.run(
      sql.raw(`CREATE TRIGGER change_claim AFTER INSERT ON taskspace_local
      BEGIN UPDATE local_file_operation SET ${changes[field]}; END`),
    );
    const pending = await journal();
    const original = await taskspace();
    const marker = readFileSync(join(root, "target", TASKSPACE_MARKER_FILE));
    await expect(recover(true)).rejects.toThrow();
    expect(await journal()).toEqual(pending);
    expect(await taskspace()).toEqual(original);
    expect(readFileSync(join(root, "target", TASKSPACE_MARKER_FILE))).toEqual(marker);
  },
);

it.each(["intent", "state", "attachment", "namespace", "observation", "receipt"] as const)(
  "rolls back when confirmation triggers change final %s state",
  async (field) => {
    const changes = {
      intent: "UPDATE local_file_operation SET intent='{}' WHERE id=NEW.id",
      state: "UPDATE local_file_operation SET state='pending',confirmed_at=NULL WHERE id=NEW.id",
      attachment: "UPDATE taskspace_local SET path='different'",
      namespace: "UPDATE taskspace SET namespace_id=NULL",
      observation: "UPDATE taskspace_local SET last_seen_at=NULL",
      receipt: "UPDATE local_file_operation SET confirmed_at=confirmed_at+1 WHERE id=NEW.id",
    };
    await db.run(
      sql.raw(`CREATE TRIGGER change_confirmed AFTER UPDATE ON local_file_operation
      WHEN NEW.state='confirmed' AND OLD.state='pending' BEGIN ${changes[field]}; END`),
    );
    const pending = await journal();
    const original = await taskspace();
    await expect(recover(true)).rejects.toThrow();
    expect(await journal()).toEqual(pending);
    expect(await taskspace()).toEqual(original);
  },
);
