import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sql } from "drizzle-orm";
import { createTestDB } from "../../../test-utils/db.js";
import type { Tx } from "../../../db/database.js";
import { localFileOperationTable, taskspaceLocalTable } from "../../../db/schema.js";
import { journalLocalOperation } from "./journal-operation.js";

let db: Awaited<ReturnType<typeof createTestDB>>;
let root: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "kozane-operation-boundaries-"));
  db = await createTestDB(join(root, "database.sqlite"));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});
function intent() {
  return {
    kind: "taskspace.file" as "taskspace.file" | "taskspace.directory" | "taskspace.claim",
    taskspaceId: "shared-identity",
    namespaceId: "namespace",
    path: "target",
    pathKind: "workspace_relative" as const,
    intent: "original evidence",
  };
}
const rows = () => db.select().from(localFileOperationTable);
const attachments = () => db.select().from(taskspaceLocalTable);
const applyDisk = () => {
  writeFileSync(join(root, "result"), "Applied once");
  return "disk result";
};
async function publish(tx: Tx) {
  await tx.insert(taskspaceLocalTable).values({ taskspaceId: "shared-identity", path: "target" });
  return "published";
}

it.each(["taskspace.file", "taskspace.directory", "taskspace.claim"] as const)(
  "commits %s intent before disk work and publishes only with its receipt",
  async (kind) => {
    const request = { ...intent(), kind };
    const callback = vi.fn((operationId: string) => {
      const reader = new DatabaseSync(join(root, "database.sqlite"), { readOnly: true });
      try {
        expect(
          reader.prepare("SELECT id,state,intent FROM local_file_operation").get(),
        ).toMatchObject({ id: operationId, state: "pending", intent: request.intent });
        expect(reader.prepare("SELECT count(*) AS total FROM taskspace_local").get()).toMatchObject(
          { total: 0 },
        );
      } finally {
        reader.close();
      }
      return applyDisk();
    });
    const response = await journalLocalOperation(db, request, callback, async (tx, result, id) => {
      expect(result).toBe("disk result");
      expect((await tx.select().from(localFileOperationTable))[0].id).toBe(id);
      await publish(tx);
      return "published";
    });
    expect(response).toBe("published");
    expect(callback).toHaveBeenCalledTimes(1);
    expect((await rows())[0]).toMatchObject({ kind, state: "confirmed", error: null });
    expect(await attachments()).toHaveLength(1);
    expect(readFileSync(join(root, "result"), "utf8")).toBe("Applied once");
  },
);

it.each(["intent", "created", "state", "error", "deleted"] as const)(
  "refuses changed initial %s evidence without touching disk",
  async (field) => {
    const statements = {
      intent: "UPDATE local_file_operation SET intent='changed' WHERE id=NEW.id",
      created: "UPDATE local_file_operation SET created_at=created_at+1 WHERE id=NEW.id",
      state: "UPDATE local_file_operation SET state='confirmed',confirmed_at=123 WHERE id=NEW.id",
      error: "UPDATE local_file_operation SET error='Unexpected failure' WHERE id=NEW.id",
      deleted: "DELETE FROM local_file_operation WHERE id=NEW.id",
    };
    await db.run(
      sql.raw(
        `CREATE TRIGGER change_intent AFTER INSERT ON local_file_operation BEGIN ${statements[field]}; END`,
      ),
    );
    const callback = vi.fn(applyDisk);
    await expect(journalLocalOperation(db, intent(), callback, publish)).rejects.toThrow();
    expect(callback).not.toHaveBeenCalled();
    expect(await rows()).toEqual([]);
    expect(await attachments()).toEqual([]);
    expect(existsSync(join(root, "result"))).toBe(false);
  },
);

it.each(["intent", "created", "state", "time", "deleted"] as const)(
  "rolls back publication if confirmation triggers change final %s evidence",
  async (field) => {
    const statements = {
      intent: "UPDATE local_file_operation SET intent='changed' WHERE id=NEW.id",
      created: "UPDATE local_file_operation SET created_at=created_at+1 WHERE id=NEW.id",
      state: "UPDATE local_file_operation SET state='pending',confirmed_at=NULL WHERE id=NEW.id",
      time: "UPDATE local_file_operation SET confirmed_at=confirmed_at+1 WHERE id=NEW.id",
      deleted: "DELETE FROM local_file_operation WHERE id=NEW.id",
    };
    await db.run(
      sql.raw(`CREATE TRIGGER change_confirmation AFTER UPDATE ON local_file_operation
      WHEN NEW.state='confirmed' AND OLD.state='pending' BEGIN ${statements[field]}; END`),
    );
    const callback = vi.fn(applyDisk);
    await expect(journalLocalOperation(db, intent(), callback, publish)).rejects.toMatchObject({
      phase: "confirm",
    });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(await attachments()).toEqual([]);
    expect(await rows()).toMatchObject([
      { intent: "original evidence", state: "pending", confirmedAt: null, error: null },
    ]);
    expect(readFileSync(join(root, "result"), "utf8")).toBe("Applied once");
  },
);

it.each(["intent", "error", "state", "deleted"] as const)(
  "retains both failures when error recording changes final %s evidence",
  async (field) => {
    const statements = {
      intent: "UPDATE local_file_operation SET intent='changed' WHERE id=NEW.id",
      error: "UPDATE local_file_operation SET error='Different failure' WHERE id=NEW.id",
      state:
        "UPDATE local_file_operation SET state='abandoned',abandoned_at=123,abandon_reason='Reviewed' WHERE id=NEW.id",
      deleted: "DELETE FROM local_file_operation WHERE id=NEW.id",
    };
    await db.run(
      sql.raw(`CREATE TRIGGER change_error AFTER UPDATE ON local_file_operation
      WHEN OLD.error IS NULL AND NEW.error IS NOT NULL BEGIN ${statements[field]}; END`),
    );
    const failure = Error("Disk failure");
    const callback = vi.fn(() => {
      applyDisk();
      throw failure;
    });
    const publishChanges = vi.fn(publish);
    await expect(
      journalLocalOperation(db, intent(), callback, publishChanges),
    ).rejects.toMatchObject({ phase: "change", cause: expect.any(AggregateError) });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(publishChanges).not.toHaveBeenCalled();
    expect(await rows()).toMatchObject([
      { intent: "original evidence", state: "pending", error: null },
    ]);
    expect(readFileSync(join(root, "result"), "utf8")).toBe("Applied once");
  },
);

it.each(["created", "error"] as const)(
  "refuses externally changed %s evidence before publication",
  async (field) => {
    const publishChanges = vi.fn(publish);
    await expect(
      journalLocalOperation(
        db,
        intent(),
        async () => {
          applyDisk();
          if (field === "created")
            await db.run(sql`UPDATE local_file_operation SET created_at=created_at+1`);
          else await db.run(sql`UPDATE local_file_operation SET error='Separate failure'`);
        },
        publishChanges,
      ),
    ).rejects.toMatchObject({ phase: "confirm" });
    expect(publishChanges).not.toHaveBeenCalled();
    expect(await attachments()).toEqual([]);
    expect((await rows())[0]).toMatchObject({
      state: "pending",
      error: field === "error" ? "Separate failure" : null,
    });
  },
);

it("owns the intent before awaited preparation can mutate caller inputs", async () => {
  const request = intent();
  await journalLocalOperation(db, request, applyDisk, publish, async () => {
    request.path = "changed";
    request.intent = "changed";
    request.kind = "taskspace.claim";
  });
  expect(await rows()).toMatchObject([
    { kind: "taskspace.file", path: "target", intent: "original evidence", state: "confirmed" },
  ]);
});

it("preserves a separately recorded error when disk work also fails", async () => {
  const failure = Error("Disk failure");
  await expect(
    journalLocalOperation(
      db,
      intent(),
      async () => {
        applyDisk();
        await db.run(sql`UPDATE local_file_operation SET error='Separate failure'`);
        throw failure;
      },
      publish,
    ),
  ).rejects.toMatchObject({ phase: "change", cause: expect.any(AggregateError) });
  expect((await rows())[0]).toMatchObject({ state: "pending", error: "Separate failure" });
  expect(await attachments()).toEqual([]);
});

it("verifies confirmed publication in the same transaction before returning its response", async () => {
  const verify = vi.fn(async (tx: Tx, response: string) => {
    expect(response).toBe("published");
    expect((await tx.select().from(localFileOperationTable))[0].state).toBe("confirmed");
    expect(await tx.select().from(taskspaceLocalTable)).toMatchObject([{ path: "target" }]);
  });
  expect(await journalLocalOperation(db, intent(), applyDisk, publish, undefined, verify)).toBe(
    "published",
  );
  expect(verify).toHaveBeenCalledTimes(1);
});

it("rolls back publication and confirmation when final verification refuses the result", async () => {
  const callback = vi.fn(applyDisk);
  await expect(
    journalLocalOperation(db, intent(), callback, publish, undefined, () => {
      throw Error("Verification refused");
    }),
  ).rejects.toMatchObject({
    phase: "confirm",
    cause: expect.objectContaining({ message: "Verification refused" }),
  });
  expect(callback).toHaveBeenCalledTimes(1);
  expect(await attachments()).toEqual([]);
  expect(await rows()).toMatchObject([{ state: "pending", error: null, confirmedAt: null }]);
  expect(readFileSync(join(root, "result"), "utf8")).toBe("Applied once");
});

it("checks the final receipt after the verification callback settles", async () => {
  await expect(
    journalLocalOperation(db, intent(), applyDisk, publish, undefined, async (tx) => {
      await tx.update(localFileOperationTable).set({ intent: "changed" });
    }),
  ).rejects.toMatchObject({ phase: "confirm" });
  expect(await attachments()).toEqual([]);
  expect(await rows()).toMatchObject([
    { intent: "original evidence", state: "pending", error: null },
  ]);
});
