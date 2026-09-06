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
import { afterEach, describe, expect, it } from "vitest";
import { backupDb, getMigrationStatus, restoreDb, runMigrations } from "./db";
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
    // The newest migration in drizzle/, read off the directory rather than written down.
    // It was written down, and so had to be corrected by hand every time one was generated
    // — which is a test that fails on a change that is not a fault, and is corrected by
    // copying the value the code just produced. Taken from the `.sql` files, this asserts
    // something the pinned string never did: that the journal `getMigrationStatus` reads
    // agrees with the migrations actually on disk.
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

  // A write-ahead log holds commits the main file does not, so one left beside a database
  // that has been swapped underneath it describes a history the restored database never
  // had — SQLite would replay it and produce neither the backup nor what was there before.
  // Written by hand rather than by provoking WAL mode: nothing here sets `journal_mode`, so
  // the point is that the restore clears these whether or not the driver is using them.
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
