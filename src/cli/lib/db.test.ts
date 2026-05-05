import { createClient } from "@libsql/client";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backupDb, getMigrationStatus, runMigrations } from "./db";

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
    expect(status.pendingCount).toBeGreaterThan(0);
    expect(status.latest?.tag).toMatch(/^0000_/);
  });

  it("reports current after migrations are applied", async () => {
    const root = tempRoot();
    const dbPath = join(root, "current.db");

    await runMigrations(tempDbUrl(dbPath));
    const status = await getMigrationStatus(tempDbUrl(dbPath));

    expect(status.state).toBe("current");
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
    expect(status.pendingCount).toBeGreaterThan(0);
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
  it("backs up the workspace database without overwriting existing backups", () => {
    const root = tempRoot();
    const kozaneDir = join(root, ".kozane");
    mkdirSync(kozaneDir, { recursive: true });
    writeFileSync(join(kozaneDir, "kozane.db"), "db contents", "utf-8");

    const first = backupDb(root);
    const second = backupDb(root);

    expect(first).not.toBe(second);
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(true);
  });
});
