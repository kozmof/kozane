import { createClient } from "@libsql/client";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  backupDb,
  getMigrationStatus,
  listBackups,
  migrationStatusMessage,
  requireCurrentMigrations,
  restoreDb,
  runMigrations,
} from "./db";
import { resolveMigrationsFolder } from "../../db/internal/migrations.js";

/** The same folder `getMigrationStatus` reads its journal from. */
const MIGRATIONS_DIR = resolveMigrationsFolder();

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "kozane-db-test-"));
  tempRoots.push(root);
  return root;
}

function tempDbUrl(path: string): string {
  return `file:${path}`;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore cleanup failure
    }
  }
});

describe("getMigrationStatus", () => {
  it("reports missing for a database file that does not exist", async () => {
    const root = tempRoot();
    const status = await getMigrationStatus(tempDbUrl(join(root, "missing.db")));

    expect(status.state).toBe("missing");
    if (status.state !== "missing") return;
    expect(status.pendingCount).toBeGreaterThan(0);
    // Derive the latest migration from the SQL files so the test checks that the journal
    // agrees with the migrations on disk.
    const newest = readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .at(-1)
      ?.replace(/\.sql$/, "");
    expect(status.latest?.tag).toBe(newest);
  });

  it("reports current after migrations are applied", async () => {
    const root = tempRoot();
    const dbPath = join(root, "current.db");

    await runMigrations(tempDbUrl(dbPath));
    const status = await getMigrationStatus(tempDbUrl(dbPath));

    expect(status.state).toBe("current");
    if (status.state !== "current") return;
    expect(status.pendingCount).toBe(0);
    expect(status.applied?.tag).toBe(status.latest?.tag);
  });

  it("reports pending when only an older migration timestamp is applied", async () => {
    const root = tempRoot();
    const dbPath = join(root, "pending.db");
    const client = createClient({ url: tempDbUrl(dbPath) });

    await client.execute(
      'CREATE TABLE "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)',
    );
    await client.execute({
      sql: 'INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)',
      args: ["test", 1],
    });
    client.close();

    const status = await getMigrationStatus(tempDbUrl(dbPath));

    expect(status.state).toBe("pending");
    if (status.state !== "pending") return;
    expect(status.pendingCount).toBeGreaterThan(0);
  });

  it("reports gapped when an interior migration record is missing", async () => {
    const root = tempRoot();
    const dbPath = join(root, "gapped.db");
    await runMigrations(tempDbUrl(dbPath));
    const client = createClient({ url: tempDbUrl(dbPath) });
    await client.execute(
      "DELETE FROM __drizzle_migrations WHERE created_at = (SELECT MIN(created_at) FROM __drizzle_migrations)",
    );
    client.close();

    const status = await getMigrationStatus(tempDbUrl(dbPath));

    expect(status.state).toBe("gapped");
    if (status.state !== "gapped") return;
    expect(status.skipped).toHaveLength(1);
    expect(status.pendingCount).toBe(0);
  });

  it("reports unknown for unreadable migration metadata in the database", async () => {
    const root = tempRoot();
    const dbPath = join(root, "unknown.db");
    const client = createClient({ url: tempDbUrl(dbPath) });

    await client.execute(
      'CREATE TABLE "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)',
    );
    await client.execute({
      sql: 'INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)',
      args: ["test", "not-a-timestamp"],
    });
    client.close();

    const status = await getMigrationStatus(tempDbUrl(dbPath));

    expect(status.state).toBe("unknown");
    if (status.state === "unknown") {
      expect(status.error).toContain("Invalid latest applied migration timestamp");
    }
  });
});

describe("backupDb", () => {
  it("backs up the workspace database without overwriting existing backups", async () => {
    const root = tempRoot();
    const kozaneDir = join(root, ".kozane");
    mkdirSync(kozaneDir, { recursive: true });

    const dbPath = join(kozaneDir, "kozane.db");
    const client = createClient({ url: `file:${dbPath}` });
    await client.execute("CREATE TABLE test (id INTEGER PRIMARY KEY)");
    client.close();

    const first = await backupDb(root);
    const second = await backupDb(root);

    expect(first).not.toBe(second);
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(true);
  });
});

describe("restoreDb", () => {
  it("atomically replaces the target with a valid Kozane database", async () => {
    const root = tempRoot();
    const source = join(root, "backup.db");
    const target = join(root, "current.db");
    await runMigrations(tempDbUrl(source));
    writeFileSync(target, "old database");

    await restoreDb(source, target);

    expect((await getMigrationStatus(tempDbUrl(target))).state).toBe("current");
  });

  // Keep recent commits in a WAL sidecar to verify that restore stages the complete database.
  // Copying only the main file would miss them.
  it("restores a backup whose latest commits are still in its write-ahead log", async () => {
    const root = tempRoot();
    const source = join(root, "backup.db");
    const target = join(root, "current.db");
    await runMigrations(tempDbUrl(source));

    // Held open, and checkpointing switched off, so the rows below stay in the log rather
    // than being folded into the main file on close.
    const holder = createClient({ url: tempDbUrl(source) });
    await holder.execute("PRAGMA wal_autocheckpoint = 0");
    await holder.execute("INSERT INTO namespace (id, name, is_default) VALUES ('n1', 'kept', 1)");
    writeFileSync(target, "old database");

    try {
      await restoreDb(source, target);
    } finally {
      holder.close();
    }

    expect((await getMigrationStatus(tempDbUrl(target))).state).toBe("current");
    const restored = createClient({ url: tempDbUrl(target) });
    try {
      const rows = await restored.execute("SELECT name FROM namespace");
      expect(rows.rows.map((row) => row.name)).toEqual(["kept"]);
    } finally {
      restored.close();
    }
  });

  it("rejects a SQLite database without Kozane migration metadata", async () => {
    const root = tempRoot();
    const source = join(root, "other.db");
    const target = join(root, "current.db");
    const client = createClient({ url: tempDbUrl(source) });
    await client.execute("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)");
    client.close();
    writeFileSync(target, "original");

    await expect(restoreDb(source, target)).rejects.toThrow("recognized Kozane database");
    expect(readFileSync(target, "utf8")).toBe("original");
  });

  it("rejects an invalid backup without changing the target", async () => {
    const root = tempRoot();
    const source = join(root, "invalid.db");
    const target = join(root, "current.db");
    writeFileSync(source, "not sqlite");
    writeFileSync(target, "original");

    await expect(restoreDb(source, target)).rejects.toThrow();
    expect(readFileSync(target, "utf8")).toBe("original");
  });

  // Verify that restore removes old WAL sidecars so SQLite cannot replay them over the
  // restored database. Write the fixture directly to avoid depending on checkpoint timing.
  it("clears the log files left beside the database it replaces", async () => {
    const root = tempRoot();
    const source = join(root, "backup.db");
    const target = join(root, "current.db");
    await runMigrations(tempDbUrl(source));
    writeFileSync(target, "old database");
    writeFileSync(`${target}-wal`, "stale log");
    writeFileSync(`${target}-shm`, "stale index");

    await restoreDb(source, target);

    expect(existsSync(`${target}-wal`)).toBe(false);
    expect(existsSync(`${target}-shm`)).toBe(false);
    expect((await getMigrationStatus(tempDbUrl(target))).state).toBe("current");
  });

  it("leaves nothing of the staged copy behind", async () => {
    const root = tempRoot();
    const source = join(root, "backup.db");
    const target = join(root, "current.db");
    await runMigrations(tempDbUrl(source));

    await restoreDb(source, target);

    expect(readdirSync(root).filter((name) => name.includes(".restore-"))).toEqual([]);
  });
});

/**
 * Test backup discovery, migration status messages, and the migration guard directly. These
 * recovery paths also run through the CLI subprocess tests.
 */
const ENTRY = { idx: 0, when: 1_700_000_000_000, tag: "0000_init" };
const LATER = { idx: 1, when: 1_800_000_000_000, tag: "0001_add_width" };

describe("listBackups", () => {
  it("is empty for a workspace that has never been backed up", () => {
    // The backup directory does not exist until the first backup. Treat its absence as an
    // empty list.
    expect(listBackups(tempRoot())).toEqual([]);
  });

  it("is empty for a backup directory with nothing in it", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".kozane", "backups"), { recursive: true });
    expect(listBackups(root)).toEqual([]);
  });

  it("lists only .db files, oldest name first, as absolute paths", () => {
    const root = tempRoot();
    const backups = join(root, ".kozane", "backups");
    mkdirSync(backups, { recursive: true });
    // Written out of order, so the sort is doing the work rather than the filesystem.
    for (const name of ["2024-03-01.db", "2024-01-01.db", "2024-02-01.db"]) {
      writeFileSync(join(backups, name), "");
    }
    // The sidecars a WAL database leaves beside it, and a stray note. None is a backup.
    for (const name of ["2024-01-01.db-wal", "2024-01-01.db-shm", "README.txt"]) {
      writeFileSync(join(backups, name), "");
    }

    expect(listBackups(root)).toEqual([
      join(backups, "2024-01-01.db"),
      join(backups, "2024-02-01.db"),
      join(backups, "2024-03-01.db"),
    ]);
  });
});

describe("migrationStatusMessage", () => {
  it("reports a current database without a pending count or a remedy", () => {
    const message = migrationStatusMessage({
      state: "current",
      dbPath: "/w/.kozane/kozane.db",
      latest: ENTRY,
      applied: ENTRY,
      pendingCount: 0,
    });

    expect(message).toContain("Database: /w/.kozane/kozane.db");
    expect(message).toContain("Status  : current");
    expect(message).toContain("Latest  : 0000_init (1700000000000)");
    expect(message).toContain("Applied : 0000_init (1700000000000)");
    expect(message).not.toContain("Pending");
    expect(message).not.toContain("Run     :");
  });

  it("sends a pending database to db migrate", () => {
    const message = migrationStatusMessage({
      state: "pending",
      dbPath: "/w/.kozane/kozane.db",
      latest: LATER,
      applied: ENTRY,
      pendingCount: 1,
    });

    expect(message).toContain("Pending : 1");
    expect(message).toContain("Run     : kozane db migrate");
  });

  it("sends a gapped database to db restore, and says migrate cannot repair it", () => {
    // Migration cannot repair a gap in history because it applies only migrations newer than
    // the latest recorded one.
    const message = migrationStatusMessage({
      state: "gapped",
      dbPath: "/w/.kozane/kozane.db",
      latest: LATER,
      applied: LATER,
      pendingCount: 1,
      skipped: [ENTRY],
    });

    expect(message).toContain("Skipped : 0000_init");
    expect(message).toContain("kozane db restore");
    expect(message).toContain("kozane db migrate cannot repair this");
    expect(message).not.toContain("Run     : kozane db migrate");
  });

  it("says the file is missing for a workspace with no database", () => {
    const message = migrationStatusMessage({
      state: "missing",
      dbPath: "/w/.kozane/kozane.db",
      latest: ENTRY,
      applied: null,
      pendingCount: 1,
    });

    expect(message).toContain("Detail  : database file is missing");
    // `applied` is null here, and the label is what keeps that readable.
    expect(message).toContain("Applied : none");
  });

  it("carries the error and sends an unreadable database to doctor", () => {
    const message = migrationStatusMessage({
      state: "unknown",
      dbPath: null,
      latest: null,
      error: "SQLITE_NOTADB: file is not a database",
    });

    expect(message).toContain("Database: unknown");
    expect(message).toContain("Latest  : none");
    expect(message).toContain("Detail  : SQLITE_NOTADB: file is not a database");
    expect(message).toContain("Try     : kozane doctor");
    // The one state with no `applied` field at all, which is why it is skipped rather than
    // printed as "none".
    expect(message).not.toContain("Applied");
  });
});

describe("requireCurrentMigrations", () => {
  /** Captures the exit and the log, so the guard can be run without ending the test run. */
  function trapExit() {
    const errors: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.join(" "));
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    return { errors, restore: () => [error, exit].forEach((spy) => spy.mockRestore()) };
  }

  it("returns quietly when every migration is applied", async () => {
    const root = tempRoot();
    const dbPath = join(root, "current.db");
    await runMigrations(tempDbUrl(dbPath));

    const { errors, restore } = trapExit();
    try {
      await expect(
        requireCurrentMigrations(tempDbUrl(dbPath), "this command can run"),
      ).resolves.toBeUndefined();
      expect(errors).toEqual([]);
    } finally {
      restore();
    }
  });

  it("names the purpose and exits non-zero for a database that is not current", async () => {
    // A database that has never been migrated is missing, not pending. The guard rejects both
    // states.
    const root = tempRoot();
    const { errors, restore } = trapExit();
    try {
      await expect(
        requireCurrentMigrations(tempDbUrl(join(root, "absent.db")), "cards can be added"),
      ).rejects.toThrow("process.exit(1)");
      expect(errors[0]).toBe("Kozane database needs attention before cards can be added.");
      // Do not suggest migration as a repair for a gap in history.
      expect(errors.join("\n")).toContain("kozane db status");
      expect(errors.join("\n")).not.toContain("Run: kozane db migrate");
    } finally {
      restore();
    }
  });
});
