import { expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDB } from "../../test-utils/db.js";
import { withMigration, type DB } from "../../../../core/src/database.js";
import { migrations } from "../../../../core/src/generated/migrations.js";
import { canonicalSchemaManifest } from "../../../../core/src/generated/schema-manifest.js";
import { createRestorationPlan } from "../../../../core/src/actions/restoration-plan.js";
import { applyMigrations } from "../../../../core/src/migrations/apply.js";
import {
  getTaskspace,
  getAllTaskspaceLocalMetadata,
  deleteTaskspace,
} from "../../../../core/src/api/taskspace.js";

it.each([false, true])(
  "upgrades populated schema 19 without losing attachments or related rows (rollback=%s)",
  async (failFirst) => {
    const db = (await createTestDB()) as unknown as DB;
    const splitIndex = migrations.findIndex(({ tag }) => tag === "0020_taskspace_local");
    expect(splitIndex).toBeGreaterThan(0);
    const latest = migrations[splitIndex];
    const names = canonicalSchemaManifest
      .filter(
        ({ type, name }) =>
          type === "table" &&
          ![
            "__drizzle_migrations",
            "taskspace_local",
            "local_file_operation",
            "local_image_upload",
            "local_asset_manifest",
            "local_recovery_checkpoint",
            "local_recovery_shared_history",
            "local_recovery_assets",
            "local_recovery_executions",
            "local_recovery_actions",
            "local_recovery_retained_history",
            "local_recovery_retained_assets",
            "local_recovery_action_archives",
            "local_recovery_run_archives",
            "local_recovery_run_assets",
            "local_recovery_installation",
            "shared_recovery_installation",
            "shared_only_recovery_installation",
          ].includes(name),
      )
      .map(({ name }) => name);
    const plan = createRestorationPlan(canonicalSchemaManifest, names);
    // Rebuild this empty test database with the exact retained schema-19 migration prefix.
    await withMigration(db, async () => [
      ...[
        "local_recovery_shared_history",
        "local_recovery_assets",
        "local_recovery_executions",
        "local_recovery_actions",
        "local_recovery_retained_history",
        "local_recovery_retained_assets",
        "local_recovery_action_archives",
        "local_recovery_run_archives",
        "local_recovery_run_assets",
        "local_recovery_installation",
        "shared_recovery_installation",
        "shared_only_recovery_installation",
        "local_asset_manifest",
        "local_recovery_checkpoint",
        "local_image_upload",
        "local_file_operation",
        "taskspace_local",
        ...plan.deleteOrder,
      ].map((name) => ({
        sql: `DROP TABLE "${name}"`,
        args: [],
      })),
      { sql: "DELETE FROM __drizzle_migrations", args: [] },
      ...migrations.slice(0, splitIndex).flatMap((migration) => [
        ...migration.statements.map((text) => ({ sql: text, args: [] })),
        {
          sql: "INSERT INTO __drizzle_migrations(hash,created_at) VALUES(?,?)",
          args: [migration.hash, migration.when],
        },
      ]),
      ...[
        "INSERT INTO namespace(id,name) VALUES('n','Namespace')",
        "INSERT INTO partition(id,namespace_id,name,is_default) VALUES('p','n','Inbox',1)",
        "INSERT INTO layer(id,namespace_id,name,is_default) VALUES('l','n','Base',1)",
        "INSERT INTO scope(id,name) VALUES('s','Scope')",
        "INSERT INTO taskspace(id,namespace_id,scope_id,name,path,path_kind,last_seen_at,created_at,updated_at) VALUES('t','n','s','Label','local/日本語','workspace_relative',9007199254740993,0,-123)",
        "INSERT INTO card(id,partition_id,layer_id,taskspace_id,content,created_at,updated_at) VALUES('c','p','l','t','Card',1,2)",
        "INSERT INTO scope_rel(scope_id,card_id) VALUES('s','c')",
      ].map((text) => ({ sql: text, args: [] })),
    ]);
    if (failFirst) {
      await db.run(
        sql.raw(
          `CREATE TRIGGER reject_split BEFORE INSERT ON __drizzle_migrations WHEN NEW.created_at=${latest.when} BEGIN SELECT RAISE(ABORT,'split failed'); END`,
        ),
      );
      await expect(applyMigrations(db)).rejects.toThrow();
      expect(
        await db.values(sql`SELECT name FROM sqlite_schema WHERE name='taskspace_local'`),
      ).toEqual([]);
      expect((await db.values(sql`SELECT path FROM taskspace WHERE id='t'`))[0][0]).toBe(
        "local/日本語",
      );
      await db.run(sql`DROP TRIGGER reject_split`);
    }
    expect((await applyMigrations(db)).appliedIds).toEqual(
      migrations.slice(splitIndex).map(({ id }) => id),
    );
    expect(
      (
        await db.values(
          sql`SELECT CAST(last_seen_at AS TEXT) FROM taskspace_local WHERE taskspace_id='t'`,
        )
      )[0][0],
    ).toBe("9007199254740993");
    expect(
      (await db.values(sql`SELECT created_at,updated_at FROM taskspace WHERE id='t'`)).map(
        (row) => [row[0], row[1]],
      ),
    ).toEqual([[0, -123]]);
    expect((await db.values(sql`SELECT taskspace_id FROM card WHERE id='c'`))[0][0]).toBe("t");
    expect(await db.values(sql`SELECT * FROM scope_rel`)).toHaveLength(1);
    expect(await db.values(sql`PRAGMA foreign_key_check`)).toEqual([]);
    // Replace the deliberately out-of-Date-range observation only after proving exact migration.
    await db.run(sql`UPDATE taskspace_local SET last_seen_at=100 WHERE taskspace_id='t'`);
    expect(await getTaskspace({ db, taskspaceId: "t" })).toMatchObject({
      path: "local/日本語",
      lastSeenAt: new Date(100000),
      createdAt: new Date(0),
      updatedAt: new Date(-123000),
    });
    const local = await getAllTaskspaceLocalMetadata({ db });
    await deleteTaskspace({ db, taskspaceId: "t" });
    expect(await getTaskspace({ db, taskspaceId: "t" })).toBeUndefined();
    expect(await getAllTaskspaceLocalMetadata({ db })).toEqual(local);
  },
);
