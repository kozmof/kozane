import { createClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { is } from "drizzle-orm";
import { SQLiteTable, getTableConfig } from "drizzle-orm/sqlite-core";
import { afterEach, describe, expect, it } from "vitest";
import * as schema from "../../db/schema";
import { runMigrations } from "./db";
import { TABLES, exportDbJson, hasDbJsonRows, importDbJson } from "./db-json";

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
          sql: "INSERT INTO layer (id, project_id, name, position, is_default) VALUES (?, ?, ?, ?, ?)",
          args: ["layer-1", "project-1", "Base", 0, 1],
        },
        {
          sql: "INSERT INTO taskspace (id, project_id, scope_id, name, path, path_kind, last_seen_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          args: [
            "taskspace-1",
            "project-1",
            "scope-1",
            "Main",
            ".kozane/taskspaces/main",
            "project_relative",
            1_800_000_000_000,
            1_700_000_000_000,
            1_700_000_000_001,
          ],
        },
        {
          sql: "INSERT INTO card (id, bundle_id, layer_id, taskspace_id, content, pos_x, pos_y) VALUES (?, ?, ?, ?, ?, ?, ?)",
          args: ["card-1", "bundle-1", "layer-1", "taskspace-1", "First", 10, 20],
        },
        {
          sql: "INSERT INTO card (id, bundle_id, layer_id, taskspace_id, content, pos_x, pos_y) VALUES (?, ?, ?, ?, ?, ?, ?)",
          args: ["card-2", "bundle-1", "layer-1", null, "Second", 30, 40],
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
      layer: 1,
      taskspace: 1,
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

  it("preserves the default project flag", async () => {
    const sourceUrl = await migratedDbUrl("default-source.db");
    const targetUrl = await migratedDbUrl("default-target.db");
    await seedDb(sourceUrl);
    const client = createClient({ url: sourceUrl });
    try {
      await client.execute("UPDATE project SET is_default = 1 WHERE id = 'project-1'");
    } finally {
      client.close();
    }

    await importDbJson(targetUrl, await exportDbJson(sourceUrl));

    const dump = await exportDbJson(targetUrl);
    expect(dump.tables.project[0].is_default).toBe(1);
  });

  it("imports a version 2 export without the default project column", async () => {
    const sourceUrl = await migratedDbUrl("v2-source.db");
    const targetUrl = await migratedDbUrl("v2-target.db");
    await seedDb(sourceUrl);

    const dump = await exportDbJson(sourceUrl);
    const legacy = {
      ...dump,
      version: 2,
      tables: {
        ...dump.tables,
        project: dump.tables.project.map(({ id, name }) => ({ id, name })),
      },
    };

    await expect(importDbJson(targetUrl, legacy)).resolves.toMatchObject({ project: 1 });
    expect((await exportDbJson(targetUrl)).tables.project[0].is_default).toBe(0);
  });

  it("imports a version 3 export by rebuilding the default layer", async () => {
    const sourceUrl = await migratedDbUrl("v3-source.db");
    const targetUrl = await migratedDbUrl("v3-target.db");
    await seedDb(sourceUrl);

    const dump = await exportDbJson(sourceUrl);
    const { layer: _layer, ...tablesWithoutLayer } = dump.tables;
    const legacy = {
      ...dump,
      version: 3,
      tables: {
        ...tablesWithoutLayer,
        card: dump.tables.card.map(({ layer_id: _layerId, ...card }) => card),
      },
    };

    await expect(importDbJson(targetUrl, legacy)).resolves.toMatchObject({ layer: 1, card: 2 });

    const imported = await exportDbJson(targetUrl);
    expect(imported.tables.layer).toMatchObject([
      { project_id: "project-1", name: "Base", position: 0, is_default: 1 },
    ]);
    const baseLayerId = imported.tables.layer[0].id;
    expect(imported.tables.card.map(({ layer_id }) => layer_id)).toEqual([
      baseLayerId,
      baseLayerId,
    ]);
  });

  it("rejects an export version this build cannot read", async () => {
    const dbUrl = await migratedDbUrl("future.db");
    const dump = { ...(await exportDbJson(dbUrl)), version: 99 };

    await expect(importDbJson(dbUrl, dump)).rejects.toThrow("Unsupported Kozane database export");
  });

  it("rejects invalid export JSON", async () => {
    const dbUrl = await migratedDbUrl("invalid.db");

    await expect(importDbJson(dbUrl, { kind: "other" })).rejects.toThrow(
      "not a Kozane database export",
    );
  });
});

describe("export table list", () => {
  // Columns added to the schema without being added here are silently dropped by
  // `kozane db export`, which is how `project.is_default` was lost after migration 0003.
  it("covers every column of every table in the Drizzle schema", () => {
    const schemaTables = Object.values(schema)
      .filter((value) => is(value, SQLiteTable))
      .map((table) => getTableConfig(table as SQLiteTable));

    const exported = new Map<string, readonly string[]>(
      TABLES.map((table) => [table.name, table.columns]),
    );

    expect([...exported.keys()].sort()).toEqual(schemaTables.map((t) => t.name).sort());
    for (const table of schemaTables) {
      expect({ table: table.name, columns: [...(exported.get(table.name) ?? [])].sort() }).toEqual({
        table: table.name,
        columns: table.columns.map((column) => column.name).sort(),
      });
    }
  });
});
