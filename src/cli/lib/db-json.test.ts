import { createClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "./db";
import { exportDbJson, hasDbJsonRows, importDbJson } from "./db-json";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "kozane-db-json-test-"));
  tempRoots.push(root);
  return root;
}

function tempDbUrl(path: string): string {
  return `file:${path}`;
}

async function migratedDbUrl(name: string): Promise<string> {
  const dbUrl = tempDbUrl(join(tempRoot(), name));
  await runMigrations(dbUrl);
  return dbUrl;
}

async function seedDb(dbUrl: string): Promise<void> {
  const client = createClient({ url: dbUrl });
  try {
    await client.batch(
      [
        {
          sql: "INSERT INTO project (id, name) VALUES (?, ?)",
          args: ["project-1", "Portable Project"],
        },
        {
          sql: "INSERT INTO scope (id, name) VALUES (?, ?)",
          args: ["scope-1", "Planning"],
        },
        {
          sql: "INSERT INTO bundle (id, project_id, name, is_default) VALUES (?, ?, ?, ?)",
          args: ["bundle-1", "project-1", "General", 1],
        },
        {
          sql: "INSERT INTO working_copy (id, project_id, scope_id, name, path, path_kind, last_seen_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          args: [
            "wc-1",
            "project-1",
            "scope-1",
            "Main",
            ".kozane/working-copies/main",
            "project_relative",
            1_800_000_000_000,
            1_700_000_000_000,
            1_700_000_000_001,
          ],
        },
        {
          sql: "INSERT INTO card (id, bundle_id, working_copy_id, content, pos_x, pos_y) VALUES (?, ?, ?, ?, ?, ?)",
          args: ["card-1", "bundle-1", "wc-1", "First", 10, 20],
        },
        {
          sql: "INSERT INTO card (id, bundle_id, working_copy_id, content, pos_x, pos_y) VALUES (?, ?, ?, ?, ?, ?)",
          args: ["card-2", "bundle-1", null, "Second", 30, 40],
        },
        {
          sql: "INSERT INTO glue (id) VALUES (?)",
          args: ["glue-1"],
        },
        {
          sql: "INSERT INTO glue_rel (glue_id, card_id) VALUES (?, ?)",
          args: ["glue-1", "card-1"],
        },
        {
          sql: "INSERT INTO glue_rel (glue_id, card_id) VALUES (?, ?)",
          args: ["glue-1", "card-2"],
        },
        {
          sql: "INSERT INTO scope_rel (scope_id, card_id) VALUES (?, ?)",
          args: ["scope-1", "card-1"],
        },
      ],
      "write",
    );
  } finally {
    client.close();
  }
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

describe("db JSON export/import", () => {
  it("round-trips database rows through JSON", async () => {
    const sourceUrl = await migratedDbUrl("source.db");
    const targetUrl = await migratedDbUrl("target.db");
    await seedDb(sourceUrl);

    const sourceDump = await exportDbJson(sourceUrl);
    const counts = await importDbJson(targetUrl, sourceDump);
    const targetDump = await exportDbJson(targetUrl);

    expect(counts).toEqual({
      project: 1,
      scope: 1,
      bundle: 1,
      working_copy: 1,
      card: 2,
      glue: 1,
      glue_rel: 2,
      scope_rel: 1,
    });
    expect({ ...targetDump, exportedAt: sourceDump.exportedAt }).toEqual(sourceDump);
  });

  it("reports whether any exported table has rows", async () => {
    const dbUrl = await migratedDbUrl("rows.db");

    await expect(hasDbJsonRows(dbUrl)).resolves.toBe(false);
    await seedDb(dbUrl);
    await expect(hasDbJsonRows(dbUrl)).resolves.toBe(true);
  });

  it("rejects invalid export JSON", async () => {
    const dbUrl = await migratedDbUrl("invalid.db");

    await expect(importDbJson(dbUrl, { kind: "other" })).rejects.toThrow(
      "not a Kozane database export",
    );
  });
});
