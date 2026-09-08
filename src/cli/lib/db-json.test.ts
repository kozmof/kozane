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
            "project_relative",
            1_800_000_000_000,
            1_700_000_000_000,
            1_700_000_000_001,
          ],
        },
        // Both timestamps are written rather than left to the column default that migration
        // 0011 needed in order to add them NOT NULL: a row that takes that default lands at
        // the epoch, and a seed that exports as 1970 is not the seed these round trips mean
        // to be testing.
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

  it("imports a version 2 export without the default namespace column", async () => {
    const sourceUrl = await migratedDbUrl("v2-source.db");
    const targetUrl = await migratedDbUrl("v2-target.db");
    await seedDb(sourceUrl);

    const dump = await exportDbJson(sourceUrl);
    const legacy = {
      ...dump,
      version: 2,
      tables: {
        ...dump.tables,
        namespace: dump.tables.namespace.map(({ id, name }) => ({ id, name })),
      },
    };

    await expect(importDbJson(targetUrl, legacy)).resolves.toMatchObject({ namespace: 1 });
    expect((await exportDbJson(targetUrl)).tables.namespace[0].is_default).toBe(0);
  });

  it("imports a version 3 export by rebuilding the default layer", async () => {
    const sourceUrl = await migratedDbUrl("v3-source.db");
    const targetUrl = await migratedDbUrl("v3-target.db");
    await seedDb(sourceUrl);

    const dump = await exportDbJson(sourceUrl);
    const { layer: _layer, warp: _warp, ...tablesWithoutLayer } = dump.tables;
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
      { namespace_id: "namespace-1", name: "Base", position: 0, is_default: 1 },
    ]);
    const baseLayerId = imported.tables.layer[0].id;
    expect(imported.tables.card.map(({ layer_id }) => layer_id)).toEqual([
      baseLayerId,
      baseLayerId,
    ]);
  });

  it("imports a version 4 export, which predates warps", async () => {
    const sourceUrl = await migratedDbUrl("v4-source.db");
    const targetUrl = await migratedDbUrl("v4-target.db");
    await seedDb(sourceUrl);

    const dump = await exportDbJson(sourceUrl);
    const { warp: _warp, ...tablesWithoutWarp } = dump.tables;
    const legacy = { ...dump, version: 4, tables: tablesWithoutWarp };

    await expect(importDbJson(targetUrl, legacy)).resolves.toMatchObject({ warp: 0, namespace: 1 });
    expect((await exportDbJson(targetUrl)).tables.warp).toEqual([]);
  });

  it("imports a version 5 export, which predates the card timestamps", async () => {
    const sourceUrl = await migratedDbUrl("v5-source.db");
    const targetUrl = await migratedDbUrl("v5-target.db");
    await seedDb(sourceUrl);

    const dump = await exportDbJson(sourceUrl);
    const legacy = {
      ...dump,
      version: 5,
      tables: {
        ...dump.tables,
        card: dump.tables.card.map(
          ({ created_at: _createdAt, updated_at: _updatedAt, ...card }) => card,
        ),
      },
    };

    await expect(importDbJson(targetUrl, legacy)).resolves.toMatchObject({ card: 2 });

    // A dump carrying no history is filled the way migration 0011 fills the rows already in
    // a database: both columns at the moment of the import, which reads as created now and
    // never since edited, so `kozane card list --sort gap` reports `0s` for these cards.
    const importedAt = Math.floor(Date.now() / 1000);
    for (const card of (await exportDbJson(targetUrl)).tables.card) {
      expect(card.created_at).toBe(card.updated_at);
      expect(card.created_at).toBeGreaterThan(importedAt - 600);
    }
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
   * The columns are read off the schema now rather than restated, so this no longer catches a
   * drift — it asserts that the derivation reaches every table with the columns it declares,
   * which is the property the export depends on. A column missing here is a column
   * `kozane db export` silently drops, which is how `namespace.is_default` was lost after
   * migration 0003.
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
   * The half that is still written by hand, and so the half that can still drift. A table
   * added to the schema and left out of `TABLE_ORDER` is exported as nothing at all — worse
   * than the missing column above, and invisible for the same reason.
   *
   * The order itself is asserted rather than only its membership: an insert has to name a
   * table after every table its foreign keys point at, and a restore deletes in the reverse
   * of this order for the same reason.
   */
  it("orders every table after the tables its foreign keys point at", () => {
    // Keyed as plain strings: the names come back off the Drizzle tables below, which report
    // a `string` rather than the literal union `TABLE_ORDER` gives these.
    const position = new Map<string, number>(TABLES.map((table, index) => [table.name, index]));

    expect([...position.keys()].sort()).toEqual(
      schemaTables()
        .map((t) => t.name)
        .sort(),
    );

    for (const table of schemaTables()) {
      for (const reference of table.foreignKeys) {
        const target = getTableConfig(reference.reference().foreignTable).name;
        // A self-reference would be neither before nor after itself; there are none, and one
        // added later needs a rule of its own rather than this one.
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
 * `validateDumpRefs` exists to name the offending row, because SQLite's own
 * `FOREIGN KEY constraint failed` names nothing. None of its branches had a test, which is
 * how three of the export's foreign keys — `card.layer_id`, `layer.namespace_id` and
 * `warp.namespace_id` — came to have no check at all while the docblock claimed every one
 * was covered.
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

  // `card.layer_id` is NOT NULL, so a null here would otherwise reach SQLite as a
  // constraint failure rather than as the missing reference it is.
  it("reports a null layer_id as an unknown reference rather than a constraint failure", async () => {
    await expectRejectedImport((tables) => {
      tables.card[0].layer_id = null;
    }, "card card-1: references unknown layer_id null");
  });
});

describe("import batching", () => {
  // Rows used to go in one statement per row. `chunked` splits them by the parameter
  // budget instead, so a table wider than the batch size still lands in one piece — and a
  // count that spans several batches is the case a wrong `VALUES` shape would break.
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

    // Round-tripped whole: same rows, same values, in the same order.
    const imported = await exportDbJson(targetUrl);
    expect(imported.tables.card).toEqual(dump.tables.card);
  });
});
