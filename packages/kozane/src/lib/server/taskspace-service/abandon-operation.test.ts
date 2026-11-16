import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createTestDB } from "../../../test-utils/db.js";
import { createNamespace } from "../../../db/api/namespace.js";
import { addTaskspace, getTaskspace } from "../../../db/api/taskspace.js";
import { localFileOperationTable } from "../../../db/schema.js";
import { withTx } from "../../../db/database.js";
import { captureApplicationRows } from "../../../test-utils/action-tables.js";
import type { DB as CoreDB } from "../../../../../core/src/database.js";
import { abandonLocalOperation } from "./abandon-operation.js";
import { recoverLocalClaim } from "./recover-claim.js";
import { oneAtATime } from "./queue.js";
import { createLocalClaimStartupCheck } from "../local-claim-startup.js";

let db: Awaited<ReturnType<typeof createTestDB>>;
let root: string;
let taskspaceId: string;
beforeEach(async () => {
  db = await createTestDB();
  root = mkdtempSync(join(tmpdir(), "kozane-abandon-operation-"));
  mkdirSync(join(root, "demo"));
  writeFileSync(join(root, "demo", "file.txt"), "Keep this file");
  const namespaceId = await createNamespace({ db, name: "Namespace", isDefault: true });
  taskspaceId = await addTaskspace({ db, namespaceId, name: "Demo", path: "demo" });
  await db
    .insert(localFileOperationTable)
    .values({
      id: "operation",
      kind: "taskspace.file",
      version: 1,
      taskspaceId,
      namespaceId,
      path: "demo/file.txt",
      pathKind: "workspace_relative",
      state: "pending",
      intent: "{}",
      error: "Original failure",
      createdAt: new Date(123000),
    });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});
const rows = () => db.select().from(localFileOperationTable);
// The source fixture and host package share this runtime adapter.
const shared = () => captureApplicationRows(db as unknown as CoreDB);

it.each(["taskspace.claim", "taskspace.file", "taskspace.directory"] as const)(
  "previews and abandons %s without changing disk, shared rows or attachments",
  async (kind) => {
    await db.update(localFileOperationTable).set({ kind });
    const [original] = await rows();
    const before = await shared();
    const attachment = await getTaskspace({ db, taskspaceId });
    expect((await abandonLocalOperation(db, "operation", "  Reviewed evidence  ")).changed).toBe(
      false,
    );
    expect(await rows()).toEqual([original]);
    expect(
      (await abandonLocalOperation(db, "operation", "  Reviewed evidence  ", true)).changed,
    ).toBe(true);
    const abandoned = await rows();
    expect(abandoned[0]).toEqual({
      ...original,
      state: "abandoned",
      abandonedAt: expect.any(Date),
      abandonReason: "Reviewed evidence",
    });
    expect((await abandonLocalOperation(db, "operation", "Reviewed evidence", true)).changed).toBe(
      false,
    );
    expect(await rows()).toEqual(abandoned);
    expect(await shared()).toEqual(before);
    expect(await getTaskspace({ db, taskspaceId })).toEqual(attachment);
    expect(readFileSync(join(root, "demo", "file.txt"), "utf8")).toBe("Keep this file");
    const warn = vi.fn();
    await createLocalClaimStartupCheck(warn)(db, root);
    expect(warn).not.toHaveBeenCalled();
    if (kind === "taskspace.claim")
      await expect(recoverLocalClaim(db, root, "operation", true)).rejects.toThrow("abandoned");
  },
);

it.each([false, true])(
  "rolls back abandoned state and reason on failure (commit=%s)",
  async (commit) => {
    if (commit) {
      await db.run(sql`CREATE TABLE deferred_parent(id TEXT PRIMARY KEY)`);
      await db.run(
        sql`CREATE TABLE deferred_child(parent_id TEXT REFERENCES deferred_parent(id) DEFERRABLE INITIALLY DEFERRED)`,
      );
      await db.run(
        sql`CREATE TRIGGER reject_abandonment AFTER UPDATE ON local_file_operation BEGIN INSERT INTO deferred_child VALUES('missing'); END`,
      );
    } else
      await db.run(
        sql`CREATE TRIGGER reject_abandonment BEFORE UPDATE ON local_file_operation BEGIN SELECT RAISE(ABORT,'abandonment refused'); END`,
      );
    const original = await rows();
    await expect(abandonLocalOperation(db, "operation", "Reviewed", true)).rejects.toThrow();
    expect(await rows()).toEqual(original);
    await db.run(sql`DROP TRIGGER reject_abandonment`);
    expect((await abandonLocalOperation(db, "operation", "Reviewed", true)).changed).toBe(true);
  },
);

it.each(["", "  ", "\0", "x".repeat(1001)])(
  "refuses an invalid reason without changing evidence",
  async (reason) => {
    const original = await rows();
    await expect(abandonLocalOperation(db, "operation", reason, true)).rejects.toThrow("reason");
    expect(await rows()).toEqual(original);
  },
);

it("refuses completed records, unknown IDs and edits to an abandonment reason", async () => {
  await expect(abandonLocalOperation(db, "missing", "Reviewed", true)).rejects.toThrow("not found");
  await abandonLocalOperation(db, "operation", "Reviewed", true);
  const abandoned = await rows();
  await expect(abandonLocalOperation(db, "operation", "Another reason", true)).rejects.toThrow(
    "another reason",
  );
  expect(await rows()).toEqual(abandoned);
  await db
    .insert(localFileOperationTable)
    .values({
      ...abandoned[0],
      id: "completed",
      state: "confirmed",
      confirmedAt: new Date(),
      error: null,
      abandonedAt: null,
      abandonReason: null,
    });
  await expect(abandonLocalOperation(db, "completed", "Reviewed", true)).rejects.toThrow(
    "Completed operations",
  );
});

it("serializes with file work and refuses abandonment after that work confirms", async () => {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = oneAtATime(taskspaceId, async () => {
    entered();
    await waiting;
    await withTx(db, async (tx) => {
      await tx
        .update(localFileOperationTable)
        .set({ state: "confirmed", confirmedAt: new Date(), error: null });
    });
  });
  await started;
  const abandoning = abandonLocalOperation(db, "operation", "Reviewed", true);
  expect((await abandonLocalOperation(db, "operation", "Reviewed")).operation.state).toBe(
    "pending",
  );
  const rejected = expect(abandoning).rejects.toThrow("Completed operations");
  release();
  await held;
  await rejected;
  expect((await rows())[0]).toMatchObject({
    state: "confirmed",
    abandonedAt: null,
    abandonReason: null,
  });
});

it("makes concurrent identical abandonment requests idempotent", async () => {
  const outcomes = await Promise.all([
    abandonLocalOperation(db, "operation", "Reviewed", true),
    abandonLocalOperation(db, "operation", "Reviewed", true),
  ]);
  expect(outcomes.map(({ changed }) => changed).sort()).toEqual([false, true]);
  expect(await rows()).toHaveLength(1);
});
