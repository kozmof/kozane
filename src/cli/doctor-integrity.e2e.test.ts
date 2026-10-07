import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Test `kozane doctor` through the CLI, including SQLite integrity checks and reports of rows
 * beyond workspace limits.
 *
 * Create invalid rows through a raw client to reproduce writes that bypass application
 * validation. Share initialized workspaces where the cases do not interfere, since each
 * initialization runs migrations.
 */

const cliEntry = resolve("src/cli/index.ts");
const tsxLoader = createRequire(join(process.cwd(), "package.json")).resolve("tsx");
const tempRoots: string[] = [];

function runCli(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, ["--import", tsxLoader, cliEntry, ...args], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, TMPDIR: tmpdir(), NO_COLOR: "1" },
  });
}

/** An initialised workspace, migrated, with its default namespace in place. */
function initWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "kozane-doctor-integrity-e2e-"));
  tempRoots.push(root);
  const init = runCli(root, "init");
  expect(init.status).toBe(0);
  return root;
}

function dbUrlOf(root: string): string {
  return `file:${join(root, ".kozane", "kozane.db")}`;
}

/** Writes rows the way nothing in Kozane would, which is the only way these conditions arise. */
async function withRawDb(
  root: string,
  write: (client: ReturnType<typeof createClient>) => Promise<void>,
) {
  const client = createClient({ url: dbUrlOf(root) });
  try {
    await write(client);
  } finally {
    client.close();
  }
}

/** The ids a freshly initialised workspace already has, for rows written by hand below. */
async function defaults(root: string): Promise<{ partitionId: string; layerId: string }> {
  let ids = { partitionId: "", layerId: "" };
  await withRawDb(root, async (client) => {
    const partition = await client.execute("SELECT id FROM partition LIMIT 1");
    const layer = await client.execute("SELECT id FROM layer LIMIT 1");
    ids = {
      partitionId: String(partition.rows[0].id),
      layerId: String(layer.rows[0].id),
    };
  });
  return ids;
}

const INSERT_CARD =
  "INSERT INTO card (id, partition_id, layer_id, content, pos_x, pos_y, z_index, created_at, updated_at) " +
  "VALUES (?, ?, ?, ?, ?, 0, 0, 1, 1)";

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("kozane doctor — integrity and limits", () => {
  it("passes both checks on a workspace kozane itself wrote", () => {
    const root = initWorkspace();
    expect(runCli(root, "card", "add", "ordinary").status).toBe(0);

    const result = runCli(root, "doctor");
    expect(result.stdout).toContain("✓  Database integrity");
    expect(result.stdout).toContain("✓  Rows within workspace limits");
    expect(result.status).toBe(0);
  });

  /**
   * Verify that the foreign-key check finds a dangling reference in a structurally valid
   * database.
   */
  it("reports a row referencing a parent that does not exist", async () => {
    const root = initWorkspace();
    const { layerId } = await defaults(root);

    await withRawDb(root, async (client) => {
      // Disable foreign-key enforcement explicitly so this connection can insert a dangling
      // reference.
      await client.execute("PRAGMA foreign_keys = OFF");
      await client.execute({
        sql: INSERT_CARD,
        args: ["orphan-card", "no-such-partition", layerId, "stranded", 0],
      });
    });

    const result = runCli(root, "doctor");
    expect(result.stdout).toContain("✗  Database integrity");
    expect(result.stdout).toContain("referencing a row that does not exist");
    expect(result.stdout).toContain("card");
    expect(result.status).toBe(1);
  });

  /**
   * Verify that diagnostics find rows beyond current limits. Imports accept these rows to
   * allow restores across workspaces with different settings and warn about them separately.
   */
  it("reports a card past ui.contentMax, one off the canvas, and an over-long name", async () => {
    const root = initWorkspace();
    const { partitionId, layerId } = await defaults(root);

    await withRawDb(root, async (client) => {
      await client.execute("PRAGMA foreign_keys = ON");
      await client.execute({
        sql: INSERT_CARD,
        args: ["over-long", partitionId, layerId, "x".repeat(200_001), 0],
      });
      await client.execute({
        sql: INSERT_CARD,
        args: ["off-board", partitionId, layerId, "somewhere else", 999_999],
      });
      await client.execute({
        sql: "INSERT INTO scope (id, name) VALUES (?, ?)",
        args: ["wide-scope", "n".repeat(300)],
      });
    });

    const result = runCli(root, "doctor");
    expect(result.stdout).toContain("✗  Rows within workspace limits");
    expect(result.stdout).toContain("1 card over ui.contentMax");
    expect(result.stdout).toContain("1 card off the canvas");
    expect(result.stdout).toContain("1 name over 255 characters");
    expect(result.stdout).toContain("scope wide-scope");
    expect(result.stdout).toContain("editing one will refuse it");
    expect(result.status).toBe(1);

    // The rows are sound references even so, which is what separates the two checks.
    expect(result.stdout).toContain("✓  Database integrity");
  });
});
