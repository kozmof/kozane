import { expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDB } from "../../test-utils/db.js";
import type { DB } from "../../../../core/src/database.js";
import { withMigration } from "../../../../core/src/database.js";
import { migrations } from "../../../../core/src/generated/migrations.js";
import { applyMigrations } from "../../../../core/src/migrations/apply.js";
import { localImageUploadTable } from "../../../../core/src/schema.js";
import { installCapturePrototype, capturedTables } from "../../test-utils/action-capture.js";
const filename = "00000000-0000-4000-8000-000000000001.svg";
const entry = {
  filename,
  byteLength: 3,
  sha256: "a".repeat(64),
  state: "pending" as const,
  createdAt: new Date(1000),
};

it.each([false, true])(
  "migration 25 adds local pins atomically without changing earlier evidence (rollback=%s)",
  async (fail) => {
    const db = (await createTestDB()) as unknown as DB;
    const migration = migrations.find((migration) => migration.tag === "0025_local_image_upload")!;
    await withMigration(db, async () => [
      { sql: "DROP TABLE local_recovery_retained_history", args: [] },
      { sql: "DROP TABLE local_recovery_actions", args: [] },
      { sql: "DROP TABLE local_recovery_executions", args: [] },
      { sql: "DROP TABLE local_recovery_assets", args: [] },
      { sql: "DROP TABLE local_recovery_shared_history", args: [] },
      { sql: "DROP TABLE local_recovery_checkpoint", args: [] },
      { sql: "DROP TABLE local_asset_manifest", args: [] },
      { sql: "DROP TABLE local_image_upload", args: [] },
      { sql: "DELETE FROM __drizzle_migrations WHERE created_at>=?", args: [migration.when] },
      {
        sql: "INSERT INTO local_file_operation(id,kind,version,taskspace_id,namespace_id,path,path_kind,state,intent,created_at,error) VALUES('pending','taskspace.file',1,'absent','absent','local/file','workspace_relative','pending','{}',9007199254740993,'Original error')",
        args: [],
      },
    ]);
    const before = Array.from(
      (await db.values(sql`SELECT CAST(created_at AS TEXT),error FROM local_file_operation`))[0],
    );
    if (fail) {
      await db.run(
        sql.raw(
          `CREATE TRIGGER reject_upgrade BEFORE INSERT ON __drizzle_migrations WHEN NEW.created_at=${migration.when} BEGIN SELECT RAISE(ABORT,'upgrade refused'); END`,
        ),
      );
      await expect(applyMigrations(db)).rejects.toThrow();
      await expect(db.select().from(localImageUploadTable)).rejects.toThrow();
      await db.run(sql`DROP TRIGGER reject_upgrade`);
    }
    expect((await applyMigrations(db)).appliedIds).toEqual(
      migrations.filter((row) => row.when >= migration.when).map((row) => row.id),
    );
    expect(
      Array.from(
        (await db.values(sql`SELECT CAST(created_at AS TEXT),error FROM local_file_operation`))[0],
      ),
    ).toEqual(before);
    await db.insert(localImageUploadTable).values(entry);
  },
);

it.each([
  { filename: "../outside.svg" },
  { filename: "/absolute.svg" },
  { byteLength: 0 },
  { byteLength: 10485761 },
  { byteLength: 1.5 },
  { sha256: "A".repeat(64) },
  { sha256: "a".repeat(63) },
  { state: "installed" },
  { state: "completed" },
  { state: "abandoned" },
])("refuses invalid pin metadata or incomplete states %#", async (change) => {
  const db = (await createTestDB()) as unknown as DB;
  await expect(
    db.insert(localImageUploadTable).values({ ...entry, ...change } as typeof entry),
  ).rejects.toThrow();
  expect(await db.select().from(localImageUploadTable)).toEqual([]);
});

it("excludes all pin states from shared capture and preserves them through shared restoration", async () => {
  const db = (await createTestDB()) as unknown as DB;
  await db.insert(localImageUploadTable).values([
    entry,
    {
      ...entry,
      filename: filename.replace("001.svg", "002.svg"),
      state: "installed",
      installedAt: new Date(2000),
    },
    {
      ...entry,
      filename: filename.replace("001.svg", "003.svg"),
      state: "completed",
      installedAt: new Date(2000),
      completedAt: new Date(3000),
    },
    {
      ...entry,
      filename: filename.replace("001.svg", "004.svg"),
      state: "abandoned",
      error: "Partial installation",
      abandonedAt: new Date(4000),
      abandonReason: "Reviewed",
    },
  ]);
  const before = await db.select().from(localImageUploadTable);
  const capture = await installCapturePrototype(db);
  expect(capturedTables).toHaveLength(12);
  expect(capturedTables.some((table) => table.name === "local_image_upload")).toBe(false);
  await capture.restore(async () => (await createTestDB()) as unknown as DB, []);
  expect(await db.select().from(localImageUploadTable)).toEqual(before);
});
