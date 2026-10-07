import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createRequire } from "node:module";
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { writeServerState } from "../lib/server/runtime-state.js";

const cliEntry = resolve("src/cli/index.ts");
const tsxLoader = createRequire(join(process.cwd(), "package.json")).resolve("tsx");
const tempRoots: string[] = [];

function tempWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "kozane-db-more-e2e-"));
  tempRoots.push(root);
  return root;
}

function runCli(cwd: string, ...args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ["--import", tsxLoader, cliEntry, ...args], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, TMPDIR: tmpdir(), NO_COLOR: "1" },
  });
}

function cli(cwd: string, ...args: string[]): string {
  const result = runCli(cwd, ...args);
  if (result.status !== 0) {
    throw new Error(
      [`kozane ${args.join(" ")} failed (${result.status})`, result.stdout, result.stderr]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return result.stdout;
}

function outputId(output: string): string {
  const match = output.match(/^\s*id\s*:\s*(\S+)/m);
  if (!match) throw new Error(`Command output did not contain an ID:\n${output}`);
  return match[1];
}

/**
 * Restore the fixture to schema 0004 so migrations from 0005 onward can run again.
 *
 * Reverse migration 0014's names for tables and indexes that remain. Drop tables recreated by
 * later migrations and restore the card shape expected by 0005. Older indexes must retain the
 * names migration 0014 expects to remove.
 */
const ROLLBACK_TO_0004 = [
  "ALTER TABLE `namespace` RENAME TO `project`",
  "ALTER TABLE `partition` RENAME TO `bundle`",
  "ALTER TABLE `bundle` RENAME COLUMN `namespace_id` TO `project_id`",
  "ALTER TABLE `taskspace` RENAME COLUMN `namespace_id` TO `project_id`",
  "ALTER TABLE `card` RENAME COLUMN `partition_id` TO `bundle_id`",
  "DROP INDEX IF EXISTS `namespace_one_default`",
  "CREATE UNIQUE INDEX `project_one_default` ON `project` (`is_default`) WHERE is_default = 1",
  "DROP INDEX IF EXISTS `partition_one_default_per_namespace`",
  "CREATE UNIQUE INDEX `bundle_one_default_per_project` ON `bundle` (`project_id`) WHERE is_default = 1",
  "DROP INDEX IF EXISTS `partition_name_per_namespace`",
  "CREATE UNIQUE INDEX `bundle_name_per_project` ON `bundle` (`project_id`,`name`)",
  // Rebuild `card` without `layer_id`, which is the column 0005 adds and rebuilds the table
  // for.
  `CREATE TABLE __old_card (
     id text PRIMARY KEY NOT NULL,
     bundle_id text NOT NULL,
     taskspace_id text,
     content text NOT NULL,
     pos_x integer DEFAULT 0 NOT NULL,
     pos_y integer DEFAULT 0 NOT NULL,
     z_index integer DEFAULT 0 NOT NULL,
     FOREIGN KEY (bundle_id) REFERENCES bundle(id) ON UPDATE cascade ON DELETE cascade,
     FOREIGN KEY (taskspace_id) REFERENCES taskspace(id) ON UPDATE cascade ON DELETE set null
   )`,
  "INSERT INTO __old_card SELECT id, bundle_id, taskspace_id, content, pos_x, pos_y, z_index FROM card",
  "DROP TABLE card",
  "ALTER TABLE __old_card RENAME TO card",
  "DROP TABLE layer",
  "DROP TABLE warp",
  // Added by 0016, which is one of the migrations the journal delete below marks as never
  // applied. Left standing, the re-apply fails on `CREATE TABLE scope_area`. Its indexes go
  // with it, the same as `warp`'s do.
  "DROP TABLE IF EXISTS scope_area",
  // Drop later indexes on tables that remain in the rolled-back fixture. Indexes on rebuilt
  // or dropped tables disappear with those tables.
  "DROP INDEX IF EXISTS taskspace_scope",
  "DROP INDEX IF EXISTS glue_rel_glue",
  "DROP INDEX IF EXISTS scope_rel_card",
  "DELETE FROM __drizzle_migrations WHERE created_at >= 1786415069324",
];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("additional database CLI branches", () => {
  it("reports an already-current migration without creating a backup", () => {
    const root = tempWorkspace();
    cli(root, "init");

    const output = cli(root, "db", "migrate");

    expect(output).toContain("Database is already current.");
    expect(existsSync(join(root, ".kozane", "backups"))).toBe(false);
  }, 30_000);

  it("backs up and applies a pending migration", async () => {
    const root = tempWorkspace();
    cli(root, "init");
    const dbPath = join(root, ".kozane", "kozane.db");
    const client = createClient({ url: `file:${dbPath}` });
    try {
      // Roll back to the pre-layer schema (0004) so migrations are pending. Drizzle
      // re-applies everything newer than the newest row left behind, so every migration
      // from 0005 on has to go, not just the one being exercised.
      await client.batch(ROLLBACK_TO_0004, "write");
    } finally {
      client.close();
    }

    expect(runCli(root, "db", "status")).toMatchObject({
      status: 1,
      stdout: expect.stringContaining("Status  : pending"),
    });
    const output = cli(root, "db", "migrate");
    expect(output).toContain("Backup created:");
    expect(output).toContain("Database migrated.");
    expect(output).toContain("Status  : current");
  }, 30_000);

  it("keeps glue and scope rows when the layer migration rebuilds the card table", async () => {
    const root = tempWorkspace();
    cli(root, "init");
    const dbPath = join(root, ".kozane", "kozane.db");
    const client = createClient({ url: `file:${dbPath}` });
    try {
      const partitionId = (await client.execute("SELECT id FROM partition LIMIT 1")).rows[0]
        .id as string;
      await client.batch(
        [
          { sql: "INSERT INTO scope (id, name) VALUES ('s1', 'demo')" },
          { sql: "INSERT INTO glue (id) VALUES ('g1')" },
          // Set timestamps explicitly to avoid the migration's epoch default in fixture rows.
          {
            sql: "INSERT INTO card (id, partition_id, layer_id, content, created_at, updated_at) SELECT 'c1', ?, id, 'one', unixepoch(), unixepoch() FROM layer LIMIT 1",
            args: [partitionId],
          },
          {
            sql: "INSERT INTO card (id, partition_id, layer_id, content, created_at, updated_at) SELECT 'c2', ?, id, 'two', unixepoch(), unixepoch() FROM layer LIMIT 1",
            args: [partitionId],
          },
          { sql: "INSERT INTO glue_rel (glue_id, card_id) VALUES ('g1','c1'), ('g1','c2')" },
          { sql: "INSERT INTO scope_rel (scope_id, card_id) VALUES ('s1','c1')" },
        ],
        "write",
      );

      // Disable foreign keys before rolling back the fixture so its own table drops do not
      // cascade away the rows being tested.
      await client.execute("PRAGMA foreign_keys = OFF");
      for (const sql of ROLLBACK_TO_0004) {
        await client.execute(sql);
      }
      expect((await client.execute("SELECT count(*) AS n FROM glue_rel")).rows[0].n).toBe(2);
    } finally {
      client.close();
    }

    expect(cli(root, "db", "migrate")).toContain("Database migrated.");

    const after = createClient({ url: `file:${dbPath}` });
    try {
      const counts: Record<string, unknown> = {};
      for (const table of ["card", "glue_rel", "scope_rel", "layer"]) {
        counts[table] = (await after.execute(`SELECT count(*) AS n FROM ${table}`)).rows[0].n;
      }
      // The rebuild runs with foreign keys disabled, so dropping the old card table does
      // not take the rows that reference it along with it.
      expect(counts).toEqual({ card: 2, glue_rel: 2, scope_rel: 1, layer: 1 });
      const cards = await after.execute("SELECT layer_id FROM card");
      expect(cards.rows.every(({ layer_id }) => typeof layer_id === "string")).toBe(true);
    } finally {
      after.close();
    }
  }, 30_000);

  it("restores the most recent automatic backup", () => {
    const root = tempWorkspace();
    cli(root, "init");
    const namespaceId = outputId(cli(root, "namespace", "create", "Latest backup namespace"));
    const backupDir = join(root, ".kozane", "backups");
    mkdirSync(backupDir, { recursive: true });
    const backup = join(backupDir, "kozane-99999999-999999.db");
    copyFileSync(join(root, ".kozane", "kozane.db"), backup);

    cli(root, "namespace", "delete", namespaceId);
    const output = cli(root, "db", "restore");

    expect(output).toContain("Available backups:");
    expect(output).toContain("← most recent");
    expect(output).toContain(`Restored: ${backup}`);
    expect(cli(root, "namespace", "list")).toContain("Latest backup namespace");
  }, 30_000);

  it("reports invalid imports and missing restore files", () => {
    const root = tempWorkspace();
    cli(root, "init");
    const malformed = join(root, "malformed.json");
    const invalid = join(root, "invalid.json");
    writeFileSync(malformed, "{");
    writeFileSync(invalid, JSON.stringify({ kind: "other" }));

    const malformedResult = runCli(root, "db", "import", malformed, "--force");
    expect(malformedResult.status).not.toBe(0);
    expect(malformedResult.stderr).toContain("Failed to read JSON import file");

    const invalidResult = runCli(root, "db", "import", invalid, "--force");
    expect(invalidResult.status).not.toBe(0);
    expect(invalidResult.stderr).toContain("Import file is not a Kozane database export");
    expect(invalidResult.stderr).toContain("Backup remains at:");

    const missing = join(root, "missing.db");
    const missingResult = runCli(root, "db", "restore", missing);
    expect(missingResult.status).not.toBe(0);
    expect(missingResult.stderr).toContain(`Backup file not found: ${missing}`);
  }, 30_000);

  it("refuses to restore while an active server process is recorded", () => {
    const root = tempWorkspace();
    cli(root, "init");
    const backup = join(root, "backup.db");
    copyFileSync(join(root, ".kozane", "kozane.db"), backup);
    writeServerState(root, process.pid);

    const result = runCli(root, "db", "restore", backup);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      `Refusing to restore while Kozane server process ${process.pid} is running`,
    );
  }, 30_000);
});
