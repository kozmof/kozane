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
      // Roll back the newest migration (0004_taskspace) so one migration is pending.
      await client.batch(
        [
          "ALTER TABLE card RENAME COLUMN taskspace_id TO working_copy_id",
          "ALTER TABLE taskspace RENAME TO working_copy",
          "DELETE FROM __drizzle_migrations WHERE created_at = 1786275000000",
        ],
        "write",
      );
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

  it("restores the most recent automatic backup", () => {
    const root = tempWorkspace();
    cli(root, "init");
    const projectId = outputId(cli(root, "project", "create", "Latest backup project"));
    const backupDir = join(root, ".kozane", "backups");
    mkdirSync(backupDir, { recursive: true });
    const backup = join(backupDir, "kozane-99999999-999999.db");
    copyFileSync(join(root, ".kozane", "kozane.db"), backup);

    cli(root, "project", "delete", projectId);
    const output = cli(root, "db", "restore");

    expect(output).toContain("Available backups:");
    expect(output).toContain("← most recent");
    expect(output).toContain(`Restored: ${backup}`);
    expect(cli(root, "project", "list")).toContain("Latest backup project");
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
