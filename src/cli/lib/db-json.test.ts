import { createClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { is } from "drizzle-orm";
import { SQLiteTable, getTableConfig } from "drizzle-orm/sqlite-core";
import { afterEach, describe, expect, it } from "vitest";
import * as schema from "../../db/schema";
import { runMigrations } from "./db";
import {
  TABLES,
  dumpLimitWarnings,
  exportDbJson,
  hasDbJsonRows,
  importDbJson,
  stringifyDbJson,
} from "./db-json";

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
          sql: "INSERT INTO namespace (id, name) VALUES (?, ?)",
          args: ["namespace-1", "Portable Namespace"],
        },
        {
          sql: "INSERT INTO scope (id, name) VALUES (?, ?)",
          args: ["scope-1", "Planning"],
        },
        {
          sql: "INSERT INTO partition (id, namespace_id, name, is_default) VALUES (?, ?, ?, ?)",
          args: ["partition-1", "namespace-1", "General", 1],
        },
        {
          sql: "INSERT INTO layer (id, namespace_id, name, position, is_default) VALUES (?, ?, ?, ?, ?)",
          args: ["layer-1", "namespace-1", "Base", 0, 1],
        },
        {
          sql: "INSERT INTO warp (id, namespace_id, pos_x, pos_y) VALUES (?, ?, ?, ?)",
          args: ["warp-1", "namespace-1", 240, 480],
        },
        {
          sql: "INSERT INTO taskspace (id, namespace_id, scope_id, name, path, path_kind, last_seen_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          args: [
            "taskspace-1",
            "namespace-1",
            "scope-1",
            "Main",
            ".kozane/taskspaces/main",
            "workspace_relative",
            1_800_000_000_000,
            1_700_000_000_000,
            1_700_000_000_001,
          ],
        },
        // Set timestamps explicitly to avoid the epoch default.
        {
          sql: "INSERT INTO card (id, partition_id, layer_id, taskspace_id, content, pos_x, pos_y, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())",
          args: ["card-1", "partition-1", "layer-1", "taskspace-1", "First", 10, 20],
        },
        {
          sql: "INSERT INTO card (id, partition_id, layer_id, taskspace_id, content, pos_x, pos_y, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())",
          args: ["card-2", "partition-1", "layer-1", null, "Second", 30, 40],
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
        {
          sql: "INSERT INTO scope_area (id, scope_id, namespace_id, pos_x, pos_y, width, height) VALUES (?, ?, ?, ?, ?, ?, ?)",
          args: ["scope-area-1", "scope-1", "namespace-1", 100, 200, 640, 480],
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
      namespace: 1,
      scope: 1,
      scope_area: 1,
      partition: 1,
      layer: 1,
      warp: 1,
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

  it("preserves the default namespace flag", async () => {
    const sourceUrl = await migratedDbUrl("default-source.db");
    const targetUrl = await migratedDbUrl("default-target.db");
    await seedDb(sourceUrl);
    const client = createClient({ url: sourceUrl });
    try {
      await client.execute("UPDATE namespace SET is_default = 1 WHERE id = 'namespace-1'");
    } finally {
      client.close();
    }

    await importDbJson(targetUrl, await exportDbJson(sourceUrl));

    const dump = await exportDbJson(targetUrl);
    expect(dump.tables.namespace[0].is_default).toBe(1);
  });

  // Verify that unsupported dump versions are rejected with an explanation suitable for a
  // user restoring a backup.
  it.each([2, 3, 4, 5, 6])(
    "refuses a version %i export, taken before the rename",
    async (version) => {
      const dbUrl = await migratedDbUrl(`v${version}-refused.db`);
      const legacy = { ...(await exportDbJson(dbUrl)), version };

      await expect(importDbJson(dbUrl, legacy)).rejects.toThrow(
        /predates the rename of "project" to "namespace"/,
      );
    },
  );

  it("tells the holder of an old dump what to do with it", async () => {
    const dbUrl = await migratedDbUrl("old-dump-advice.db");
    const legacy = { ...(await exportDbJson(dbUrl)), version: 6 };

    await expect(importDbJson(dbUrl, legacy)).rejects.toThrow(/kozane db migrate/);
  });

  it("reads a version 7 dump, which predates scope_area, as having no frames", async () => {
    const sourceUrl = await migratedDbUrl("v7-source.db");
    const targetUrl = await migratedDbUrl("v7-target.db");
    await seedDb(sourceUrl);

    // Version 7 predates `scope_area`, so an absent key means there were no saved frames.
    const dump = await exportDbJson(sourceUrl);
    const legacy = {
      ...dump,
      version: 7,
      tables: { ...dump.tables, scope_area: undefined },
    };
    delete (legacy.tables as Record<string, unknown>).scope_area;

    const counts = await importDbJson(targetUrl, legacy as never);

    expect(counts.scope_area).toBe(0);
    // Restore the other tables when an older dump omits a table.
    expect(counts.card).toBe(2);
    expect(counts.scope_rel).toBe(1);
  });

  it("still demands scope_area from a dump old enough to have it", async () => {
    const sourceUrl = await migratedDbUrl("v8-missing-table.db");
    const targetUrl = await migratedDbUrl("v8-missing-target.db");
    await seedDb(sourceUrl);

    const dump = await exportDbJson(sourceUrl);
    const broken = { ...dump, tables: { ...dump.tables } };
    delete (broken.tables as Record<string, unknown>).scope_area;

    await expect(importDbJson(targetUrl, broken as never)).rejects.toThrow(
      "missing table scope_area",
    );
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
  const schemaTables = () =>
    Object.values(schema)
      .filter((value) => is(value, SQLiteTable))
      .map((table) => getTableConfig(table as SQLiteTable));

  /**
   * Verify that exported columns include every declared schema column. Omitting one would
   * silently lose data from the dump.
   */
  it("covers every column of every table in the Drizzle schema", () => {
    const exported = new Map<string, readonly string[]>(
      TABLES.map((table) => [table.name, table.columns]),
    );

    expect([...exported.keys()].sort()).toEqual(
      schemaTables()
        .map((t) => t.name)
        .sort(),
    );
    for (const table of schemaTables()) {
      expect({ table: table.name, columns: [...(exported.get(table.name) ?? [])].sort() }).toEqual({
        table: table.name,
        columns: table.columns.map((column) => column.name).sort(),
      });
    }
  });

  /**
   * Verify that `TABLE_ORDER` includes every schema table and places referenced tables before
   * their dependents. Restore deletes rows in reverse order.
   */
  it("orders every table after the tables its foreign keys point at", () => {
    // Use string keys because Drizzle types table names as strings.
    const position = new Map<string, number>(TABLES.map((table, index) => [table.name, index]));

    expect([...position.keys()].sort()).toEqual(
      schemaTables()
        .map((t) => t.name)
        .sort(),
    );

    for (const table of schemaTables()) {
      for (const reference of table.foreignKeys) {
        const target = getTableConfig(reference.reference().foreignTable).name;
        // A self-reference needs a separate ordering rule. The current schema has none.
        expect(target).not.toBe(table.name);
        expect({
          table: table.name,
          references: target,
          writtenAfterIt: position.get(table.name)! > position.get(target)!,
        }).toEqual({ table: table.name, references: target, writtenAfterIt: true });
      }
    }
  });
});

/**
 * Verify that invalid foreign keys identify the offending row. SQLite's constraint error does
 * not identify it.
 */
describe("import reference validation", () => {
  let sequence = 0;

  async function seededDump() {
    const sourceUrl = await migratedDbUrl(`refs-source-${sequence++}.db`);
    await seedDb(sourceUrl);
    return exportDbJson(sourceUrl);
  }

  async function expectRejectedImport(
    corrupt: (tables: Awaited<ReturnType<typeof seededDump>>["tables"]) => void,
    message: string | RegExp,
  ) {
    const dump = await seededDump();
    corrupt(dump.tables);

    const targetUrl = await migratedDbUrl(`refs-target-${sequence++}.db`);
    await seedDb(targetUrl);

    await expect(importDbJson(targetUrl, dump)).rejects.toThrow(message);

    // The refusal lands before the delete loop, so the workspace being imported into is
    // still whole. A dump rejected halfway would be the worst of both.
    const after = await exportDbJson(targetUrl);
    expect(after.tables.card).toHaveLength(2);
    expect(after.tables.namespace).toHaveLength(1);
  }

  it("rejects a card on an unknown layer", async () => {
    await expectRejectedImport((tables) => {
      tables.card[0].layer_id = "layer-missing";
    }, "card card-1: references unknown layer_id layer-missing");
  });

  it("rejects a layer in an unknown namespace", async () => {
    await expectRejectedImport((tables) => {
      tables.layer[0].namespace_id = "namespace-missing";
    }, "layer layer-1: references unknown namespace_id namespace-missing");
  });

  it("rejects a warp in an unknown namespace", async () => {
    await expectRejectedImport((tables) => {
      tables.warp[0].namespace_id = "namespace-missing";
    }, "warp warp-1: references unknown namespace_id namespace-missing");
  });

  it("rejects a partition in an unknown namespace", async () => {
    await expectRejectedImport((tables) => {
      tables.partition[0].namespace_id = "namespace-missing";
    }, "partition partition-1: references unknown namespace_id namespace-missing");
  });

  it("rejects a card in an unknown partition", async () => {
    await expectRejectedImport((tables) => {
      tables.card[0].partition_id = "partition-missing";
    }, "card card-1: references unknown partition_id partition-missing");
  });

  it("rejects a card in an unknown taskspace", async () => {
    await expectRejectedImport((tables) => {
      tables.card[0].taskspace_id = "taskspace-missing";
    }, "card card-1: references unknown taskspace_id taskspace-missing");
  });

  it("rejects a taskspace in an unknown scope", async () => {
    await expectRejectedImport((tables) => {
      tables.taskspace[0].scope_id = "scope-missing";
    }, "taskspace taskspace-1: references unknown scope_id scope-missing");
  });

  it("rejects a glue_rel naming an unknown card", async () => {
    await expectRejectedImport((tables) => {
      tables.glue_rel[0].card_id = "card-missing";
    }, "glue_rel: references unknown card_id card-missing");
  });

  it("rejects a scope_rel naming an unknown scope", async () => {
    await expectRejectedImport((tables) => {
      tables.scope_rel[0].scope_id = "scope-missing";
    }, "scope_rel: references unknown scope_id scope-missing");
  });

  it("rejects two namespaces claiming to be the default", async () => {
    await expectRejectedImport((tables) => {
      tables.namespace.push({ ...tables.namespace[0], id: "namespace-2", is_default: 1 });
      tables.namespace[0].is_default = 1;
    }, "more than one namespace is marked as the default");
  });

  it("rejects a taskspace in an unknown namespace", async () => {
    await expectRejectedImport((tables) => {
      tables.taskspace[0].namespace_id = "namespace-missing";
    }, "taskspace taskspace-1: references unknown namespace_id namespace-missing");
  });

  it("rejects a glue_rel naming an unknown glue group", async () => {
    await expectRejectedImport((tables) => {
      tables.glue_rel[0].glue_id = "glue-missing";
    }, "glue_rel: references unknown glue_id glue-missing");
  });

  it("rejects a scope_rel naming an unknown card", async () => {
    await expectRejectedImport((tables) => {
      tables.scope_rel[0].card_id = "card-missing";
    }, "scope_rel: references unknown card_id card-missing");
  });

  it("rejects a scope_area on an unknown scope", async () => {
    await expectRejectedImport((tables) => {
      tables.scope_area[0].scope_id = "scope-missing";
    }, "scope_area scope-area-1: references unknown scope_id scope-missing");
  });

  it("rejects a scope_area in an unknown namespace", async () => {
    await expectRejectedImport((tables) => {
      tables.scope_area[0].namespace_id = "namespace-missing";
    }, "scope_area scope-area-1: references unknown namespace_id namespace-missing");
  });

  // Taskspaces may have no namespace, and cards may have no taskspace.
  it("accepts the nullable references that are allowed to be null", async () => {
    const dump = await seededDump();
    dump.tables.taskspace[0].namespace_id = null;
    dump.tables.taskspace[0].scope_id = null;
    const targetUrl = await migratedDbUrl(`refs-target-${sequence++}.db`);
    await expect(importDbJson(targetUrl, dump)).resolves.toMatchObject({ taskspace: 1 });
  });

  // `card.layer_id` is NOT NULL, so a null here would otherwise reach SQLite as a
  // constraint failure rather than as the missing reference it is.
  it("reports a null layer_id as an unknown reference rather than a constraint failure", async () => {
    await expectRejectedImport((tables) => {
      tables.card[0].layer_id = null;
    }, "card card-1: references unknown layer_id null");
  });
});

describe("import batching", () => {
  // Exercise multiple insert batches, including a table wider than the batch size, to verify
  // the generated `VALUES` shape.
  it("restores a table spanning several insert batches", async () => {
    const sourceUrl = await migratedDbUrl("batch-source.db");
    const targetUrl = await migratedDbUrl("batch-target.db");
    await seedDb(sourceUrl);

    const client = createClient({ url: sourceUrl });
    const cardCount = 512;
    try {
      await client.batch(
        Array.from({ length: cardCount }, (_unused, index) => ({
          sql: "INSERT INTO card (id, partition_id, layer_id, content, pos_x, pos_y, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())",
          args: [`bulk-${index}`, "partition-1", "layer-1", `card ${index}`, index, index * 2],
        })),
        "write",
      );
    } finally {
      client.close();
    }

    const dump = await exportDbJson(sourceUrl);
    // The two seeded cards plus the bulk ones.
    expect(dump.tables.card).toHaveLength(cardCount + 2);

    await expect(importDbJson(targetUrl, dump)).resolves.toMatchObject({
      card: cardCount + 2,
    });

    // Check that the round trip preserves row values and order.
    const imported = await exportDbJson(targetUrl);
    expect(imported.tables.card).toEqual(dump.tables.card);
  });
});

describe("export refuses what JSON cannot carry", () => {
  it("names the table and column of a value it cannot represent", async () => {
    const dbUrl = await migratedDbUrl("export-blob.db");
    await seedDb(dbUrl);
    const client = createClient({ url: dbUrl });
    try {
      // SQLite can store a BLOB in a TEXT column. The client returns it as an `ArrayBuffer`,
      // which the exporter must handle as an invalid value.
      await client.execute({
        sql: "UPDATE card SET content = ? WHERE id = ?",
        args: [new Uint8Array([0xde, 0xad, 0xbe, 0xef]), "card-1"],
      });
    } finally {
      client.close();
    }

    await expect(exportDbJson(dbUrl)).rejects.toThrow(
      "Unsupported database value for card.content",
    );
  });

  it("names the table when the client refuses to hand a value over at all", async () => {
    const dbUrl = await migratedDbUrl("export-bigint.db");
    await seedDb(dbUrl);
    const client = createClient({ url: dbUrl });
    try {
      // Beyond 2^53. The client reads integer columns as JavaScript numbers, so this fails
      // during the SELECT rather than in `rowToJson`, with a message that names neither
      // the table nor the column.
      await client.execute({
        sql: "UPDATE card SET z_index = ? WHERE id = ?",
        args: [9007199254740993n, "card-1"],
      });
    } finally {
      client.close();
    }

    await expect(exportDbJson(dbUrl)).rejects.toThrow("Failed to read table card for export");
  });
});

describe("import rejects a malformed dump", () => {
  let sequence = 0;
  const target = () => migratedDbUrl(`malformed-${sequence++}.db`);

  async function wellFormed() {
    const sourceUrl = await migratedDbUrl(`malformed-source-${sequence++}.db`);
    await seedDb(sourceUrl);
    return exportDbJson(sourceUrl);
  }

  it("rejects a dump that is not an object at all", async () => {
    await expect(importDbJson(await target(), "not a dump")).rejects.toThrow(
      "Import file must contain a JSON object",
    );
  });

  it("rejects null, which is an object by typeof and nothing by shape", async () => {
    await expect(importDbJson(await target(), null)).rejects.toThrow(
      "Import file must contain a JSON object",
    );
  });

  it("rejects a dump with no exportedAt", async () => {
    const dump = await wellFormed();
    await expect(importDbJson(await target(), { ...dump, exportedAt: undefined })).rejects.toThrow(
      "Import file is missing exportedAt",
    );
  });

  it("rejects a dump with no migrations block", async () => {
    const dump = await wellFormed();
    await expect(importDbJson(await target(), { ...dump, migrations: null })).rejects.toThrow(
      "Import file is missing migrations",
    );
  });

  it("rejects a migrations block missing a key", async () => {
    const dump = await wellFormed();
    await expect(
      importDbJson(await target(), { ...dump, migrations: { applied: "0001" } }),
    ).rejects.toThrow("Import file has invalid migrations");
  });

  it("rejects a migrations block whose values are the wrong type", async () => {
    const dump = await wellFormed();
    await expect(
      importDbJson(await target(), { ...dump, migrations: { applied: 1, latest: null } }),
    ).rejects.toThrow("Import file has invalid migrations");
  });

  it("rejects a dump with no tables block", async () => {
    const dump = await wellFormed();
    await expect(importDbJson(await target(), { ...dump, tables: null })).rejects.toThrow(
      "Import file is missing tables",
    );
  });

  it("rejects a table that is not an array", async () => {
    const dump = await wellFormed();
    const tables = { ...dump.tables, card: {} };
    await expect(importDbJson(await target(), { ...dump, tables })).rejects.toThrow(
      "Import file is missing table card",
    );
  });

  it("rejects a row that is not an object", async () => {
    const dump = await wellFormed();
    const tables = { ...dump.tables, card: ["not a row"] };
    await expect(importDbJson(await target(), { ...dump, tables })).rejects.toThrow(
      "Invalid row 0 in table card",
    );
  });

  it("rejects a row that is an array, which is an object by typeof", async () => {
    const dump = await wellFormed();
    const tables = { ...dump.tables, card: [[]] };
    await expect(importDbJson(await target(), { ...dump, tables })).rejects.toThrow(
      "Invalid row 0 in table card",
    );
  });

  it("names the row and column of a missing column", async () => {
    const dump = await wellFormed();
    const { z_index: _dropped, ...withoutZIndex } = dump.tables.card[0];
    const tables = { ...dump.tables, card: [withoutZIndex] };
    await expect(importDbJson(await target(), { ...dump, tables })).rejects.toThrow(
      "Row 0 in table card is missing column z_index",
    );
  });

  it("names the row and column of a value JSON cannot carry", async () => {
    const dump = await wellFormed();
    const tables = { ...dump.tables, card: [{ ...dump.tables.card[0], content: { a: 1 } }] };
    await expect(importDbJson(await target(), { ...dump, tables })).rejects.toThrow(
      "Invalid value for card.content at row 0",
    );
  });

  it("reports the second row by its own index", async () => {
    const dump = await wellFormed();
    const tables = { ...dump.tables, card: [dump.tables.card[0], "not a row"] };
    await expect(importDbJson(await target(), { ...dump, tables })).rejects.toThrow(
      "Invalid row 1 in table card",
    );
  });
});

describe("import rolls back a dump SQLite refuses", () => {
  it("leaves the target workspace exactly as it was", async () => {
    // All references pass validation, but the insert violates `scope_name_nonempty`. Verify
    // that rollback restores the rows deleted earlier in the transaction.
    const sourceUrl = await migratedDbUrl("rollback-source.db");
    await seedDb(sourceUrl);
    const dump = await exportDbJson(sourceUrl);
    dump.tables.scope[0].name = "";

    const targetUrl = await migratedDbUrl("rollback-target.db");
    await seedDb(targetUrl);

    await expect(importDbJson(targetUrl, dump)).rejects.toThrow();

    // A failed import must preserve existing data.
    const after = await exportDbJson(targetUrl);
    expect(after.tables.card).toHaveLength(2);
    expect(after.tables.namespace).toHaveLength(1);
    expect(after.tables.scope).toHaveLength(1);
    expect(after.tables.scope[0].name).toBe("Planning");
    expect(after.tables.glue_rel).toHaveLength(2);
    expect(after.tables.scope_area).toHaveLength(1);
  });

  it("leaves the database usable for the import that follows", async () => {
    // Rollback must release the transaction so a later import can succeed.
    const sourceUrl = await migratedDbUrl("rollback-retry-source.db");
    await seedDb(sourceUrl);
    const good = await exportDbJson(sourceUrl);
    const bad = {
      ...good,
      tables: { ...good.tables, scope: [{ ...good.tables.scope[0], name: "" }] },
    };

    const targetUrl = await migratedDbUrl("rollback-retry-target.db");
    await seedDb(targetUrl);

    await expect(importDbJson(targetUrl, bad)).rejects.toThrow();
    await expect(importDbJson(targetUrl, good)).resolves.toMatchObject({ card: 2 });
  });
});

describe("stringifyDbJson", () => {
  const dump = {
    kind: "kozane.db.json" as const,
    version: 1,
    exportedAt: "2026-01-01T00:00:00.000Z",
    migrations: { applied: null, latest: null },
    tables: {},
  };

  it("indents by default and ends with a newline", () => {
    const text = stringifyDbJson(dump as never);
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('\n  "kind"');
  });

  it("writes one line when asked not to indent, still newline-terminated", () => {
    const text = stringifyDbJson(dump as never, false);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.trimEnd().includes("\n")).toBe(false);
  });

  it("round-trips through JSON.parse", () => {
    expect(JSON.parse(stringifyDbJson(dump as never))).toEqual(dump);
  });
});

describe("dumpLimitWarnings", () => {
  const limits = { contentMax: 100, canvasWidth: 1000, canvasHeight: 800 };

  const card = (id: string, over: Partial<Record<string, unknown>> = {}) => ({
    id,
    partition_id: "b-1",
    layer_id: "l-1",
    content: "short",
    pos_x: 10,
    pos_y: 20,
    ...over,
  });

  const dumpOf = (tables: Record<string, unknown[]>) => ({
    tables: { namespace: [], partition: [], layer: [], scope: [], taskspace: [], ...tables },
  });

  it("says nothing about a dump within every limit", () => {
    expect(dumpLimitWarnings(dumpOf({ card: [card("c-1")] }), limits)).toEqual([]);
  });

  it("names the cards whose text is past this workspace's contentMax", () => {
    const dump = dumpOf({
      card: [card("c-1"), card("c-2", { content: "x".repeat(101) })],
    });
    const [warning, ...rest] = dumpLimitWarnings(dump, limits);
    expect(rest).toEqual([]);
    expect(warning).toContain("1 card longer");
    expect(warning).toContain("ui.contentMax of 100");
    expect(warning).toContain("c-2");
    expect(warning).not.toContain("c-1");
  });

  it("names the cards sitting off this workspace's canvas, in either direction", () => {
    const dump = dumpOf({
      card: [
        card("inside"),
        card("too-far-right", { pos_x: 1001 }),
        card("too-far-down", { pos_y: 801 }),
        card("negative", { pos_x: -1 }),
      ],
    });
    const [warning] = dumpLimitWarnings(dump, limits);
    expect(warning).toContain("3 cards positioned outside");
    expect(warning).toContain("1000×800");
    expect(warning).toContain("too-far-right");
    expect(warning).not.toContain("inside");
  });

  // The canvas boundary is inclusive.
  it("counts the far edge as on the board", () => {
    const dump = dumpOf({ card: [card("edge", { pos_x: 1000, pos_y: 800 })] });
    expect(dumpLimitWarnings(dump, limits)).toEqual([]);
  });

  it("names over-long names by table, since every named thing shares one limit", () => {
    const long = "n".repeat(256);
    const dump = dumpOf({
      card: [],
      namespace: [{ id: "ns-1", name: long }],
      layer: [{ id: "l-1", name: "Base" }],
      scope: [{ id: "s-1", name: long }],
    });
    const [warning] = dumpLimitWarnings(dump, limits);
    expect(warning).toContain("2 names longer than the 255-character limit");
    expect(warning).toContain("namespace ns-1");
    expect(warning).toContain("scope s-1");
    expect(warning).not.toContain("l-1");
  });

  it("stops naming rows after a few, and still counts them all", () => {
    const dump = dumpOf({
      card: Array.from({ length: 9 }, (_, i) => card(`c-${i}`, { content: "x".repeat(101) })),
    });
    const [warning] = dumpLimitWarnings(dump, limits);
    expect(warning).toContain("9 cards longer");
    expect(warning).toContain("and 4 more");
    expect(warning).not.toContain("c-8");
  });

  it("reports every condition a dump trips, one line each", () => {
    const dump = dumpOf({
      card: [card("c-1", { content: "x".repeat(101) }), card("c-2", { pos_x: 9999 })],
      scope: [{ id: "s-1", name: "n".repeat(256) }],
    });
    expect(dumpLimitWarnings(dump, limits)).toHaveLength(3);
  });

  // Warnings run after commit. Invalid configuration must not turn a successful restore into
  // an error.
  it("reads a shape it was not given as nothing to warn about", () => {
    expect(dumpLimitWarnings(null, limits)).toEqual([]);
    expect(dumpLimitWarnings("not a dump", limits)).toEqual([]);
    expect(dumpLimitWarnings({}, limits)).toEqual([]);
    expect(dumpLimitWarnings({ tables: null }, limits)).toEqual([]);
    expect(dumpLimitWarnings({ tables: { card: "nope" } }, limits)).toEqual([]);
    expect(dumpLimitWarnings({ tables: { card: [null, 7, "x"] } }, limits)).toEqual([]);
  });
});
