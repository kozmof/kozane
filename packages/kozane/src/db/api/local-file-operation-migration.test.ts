import { expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDB } from "../../test-utils/db.js";
import { withMigration, type DB } from "../../../../core/src/database.js";
import { migrations } from "../../../../core/src/generated/migrations.js";
import { applyMigrations } from "../../../../core/src/migrations/apply.js";

it.each([
  [22, false],
  [22, true],
  [23, false],
  [23, true],
] as const)(
  "widens local operation kinds at migration %s without changing retained evidence (rollback=%s)",
  async (target, failFirst) => {
    // Test adapters share this runtime handle while their published declarations are built separately.
    const db = (await createTestDB()) as unknown as DB;
    const index = migrations.findIndex(({ tag }) => tag.startsWith(`00${target}_`));
    const latest = migrations[index];
    const start = migrations.findIndex(({ tag }) => tag === "0021_local_file_operation");
    await withMigration(db, async () => [
      { sql: "DROP TABLE local_file_operation", args: [] },
      ...migrations
        .slice(start, index)
        .flatMap((migration) => migration.statements.map((text) => ({ sql: text, args: [] }))),
      { sql: "DELETE FROM __drizzle_migrations WHERE created_at>=?", args: [latest.when] },
      {
        sql: "INSERT INTO local_file_operation(id,kind,version,taskspace_id,namespace_id,path,path_kind,state,intent,created_at,error) VALUES('pending','taskspace.claim',1,'absent','absent','local/日本語','workspace_relative','pending','{}',9007199254740993,'retained error')",
        args: [],
      },
      {
        sql: "INSERT INTO local_file_operation(id,kind,version,taskspace_id,namespace_id,path,path_kind,state,intent,created_at,confirmed_at) VALUES('confirmed','taskspace.claim',1,'absent','absent','local/confirmed','workspace_relative','confirmed','{}',-123,9007199254740993)",
        args: [],
      },
    ]);
    if (target === 23)
      await db.run(
        sql`INSERT INTO local_file_operation(id,kind,version,taskspace_id,namespace_id,path,path_kind,state,intent,created_at) VALUES('retained-file','taskspace.file',1,'absent','absent','local/file','workspace_relative','pending','{}',1)`,
      );
    const kind = target === 23 ? "taskspace.directory" : "taskspace.file";
    const read = async () =>
      (
        await db.values(
          sql`SELECT id,kind,version,taskspace_id,namespace_id,path,path_kind,state,intent,CAST(created_at AS TEXT),CAST(confirmed_at AS TEXT),error FROM local_file_operation ORDER BY id`,
        )
      ).map((row) => Array.from(row));
    const original = await read();
    if (failFirst) {
      await db.run(
        sql.raw(
          `CREATE TRIGGER reject_widen BEFORE INSERT ON __drizzle_migrations WHEN NEW.created_at=${latest.when} BEGIN SELECT RAISE(ABORT,'migration refused'); END`,
        ),
      );
      await expect(applyMigrations(db)).rejects.toThrow();
      expect(await read()).toEqual(original);
      await expect(
        db.run(
          sql`INSERT INTO local_file_operation(id,kind,version,taskspace_id,namespace_id,path,path_kind,state,intent,created_at) VALUES('new-kind',${kind},1,'absent','absent','local/file','workspace_relative','pending','{}',1)`,
        ),
      ).rejects.toThrow();
      await db.run(sql`DROP TRIGGER reject_widen`);
    }
    expect((await applyMigrations(db)).appliedIds).toEqual(
      migrations.slice(index).map(({ id }) => id),
    );
    expect(await read()).toEqual(original);
    await db.run(
      sql`INSERT INTO local_file_operation(id,kind,version,taskspace_id,namespace_id,path,path_kind,state,intent,created_at) VALUES('new-kind',${kind},1,'absent','absent','local/file','workspace_relative','pending','{}',1)`,
    );
    expect(await db.values(sql`PRAGMA foreign_key_check`)).toEqual([]);
    expect((await db.values(sql`PRAGMA foreign_keys`))[0][0]).toBe(1);
  },
);
