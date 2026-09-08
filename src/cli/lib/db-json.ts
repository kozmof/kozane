import { createClient, type InValue } from "@libsql/client";
import { is } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import * as schema from "../../db/schema.js";
import { chunked } from "../../lib/constants.js";

const EXPORT_KIND = "kozane.db.export";
const EXPORT_VERSION = 7;
/**
 * Version 7 is the first written after `project` and `bundle` became `namespace` and
 * `partition`, and it is also the oldest that can be read.
 *
 * The floor used to be 2, and every version between carried an upgrade step: filling
 * `is_default`, rebuilding the default layers, defaulting the warps, filling the card
 * timestamps. Those are gone. The rename is not a column a step can fill in — a version 6
 * dump names its tables `project` and `bundle` throughout, and reading one would mean
 * carrying a translation of every table and foreign key in the file, indefinitely, for
 * dumps taken before a beta rename.
 *
 * So an older dump is refused rather than half-read. The cost is real and is the point of
 * saying so here: a dump is a user's backup, and one taken before this release can no
 * longer be imported by `kozane db import`. A workspace still on the old schema should be
 * migrated instead — migration 0014 renames the database in place and keeps every row.
 */
const OLDEST_SUPPORTED_IMPORT_VERSION = 7;

/**
 * The tables a dump carries, in the order rows may be inserted: a table's foreign keys all
 * point at one already written. The reverse of this order is what a restore deletes in.
 *
 * The order and the sort are decisions the schema does not hold, so they are written here.
 * The *columns* are not: they are read off the Drizzle table below, because a column added
 * to the schema and not to this list is silently dropped by `kozane db export` — which is
 * how `namespace.is_default` was lost after migration 0003 — and a list restated by hand
 * could only ever be checked against the schema after the fact. Drizzle reports them in
 * declaration order, which is the order this list held them in.
 */
const TABLE_ORDER = [
  { name: "namespace", orderBy: ["id"] },
  { name: "scope", orderBy: ["id"] },
  { name: "partition", orderBy: ["id"] },
  { name: "layer", orderBy: ["id"] },
  { name: "warp", orderBy: ["id"] },
  { name: "taskspace", orderBy: ["id"] },
  { name: "card", orderBy: ["id"] },
  { name: "glue", orderBy: ["id"] },
  // Grouped by glue rather than sorted by the primary key, which is `card_id` alone: a
  // dump read by a person is easier to check when a group's members are adjacent.
  { name: "glue_rel", orderBy: ["glue_id", "card_id"] },
  { name: "scope_rel", orderBy: ["scope_id", "card_id"] },
] as const;

/** Every table in the Drizzle schema, by its SQL name, with the columns it declares. */
const schemaColumns = new Map(
  Object.values(schema)
    .filter((value) => is(value, SQLiteTable))
    .map((table) => getTableConfig(table))
    .map(({ name, columns }) => [name, columns.map((column) => column.name)]),
);

/**
 * The tables, their columns, and the order rows come back in.
 *
 * Exported so a test can assert that {@link TABLE_ORDER} still names every table the schema
 * has — the one half of this that is not derived, and so the one half that can drift. A
 * table added to the schema and left out here is exported as nothing at all, which is the
 * larger version of the column bug this derivation removes.
 */
export const TABLES = TABLE_ORDER.map((table) => ({
  ...table,
  columns: schemaColumns.get(table.name) ?? [],
}));

type TableName = (typeof TABLE_ORDER)[number]["name"];
type TableRows = Record<TableName, JsonObject[]>;
type JsonScalar = string | number | boolean | null;
type JsonObject = Record<string, JsonScalar>;

export type DbJsonDump = {
  kind: typeof EXPORT_KIND;
  version: typeof EXPORT_VERSION;
  exportedAt: string;
  migrations: {
    applied: string | null;
    latest: string | null;
  };
  tables: TableRows;
};

export type DbJsonImportResult = {
  backupPath: string;
  counts: Record<TableName, number>;
};

function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function selectSql(table: (typeof TABLES)[number]): string {
  const columns = table.columns.map(quoteIdent).join(", ");
  const orderBy = table.orderBy.map(quoteIdent).join(", ");
  return `SELECT ${columns} FROM ${quoteIdent(table.name)} ORDER BY ${orderBy}`;
}

/**
 * A multi-row INSERT for `rowCount` rows of `table`. Sized by the caller through
 * {@link chunked}, the same way every other bulk writer here sizes one — a restore used to
 * spend a round trip per row, which on a workspace of any size is the slowest thing the
 * CLI does.
 */
function insertSql(table: (typeof TABLES)[number], rowCount: number): string {
  const columns = table.columns.map(quoteIdent).join(", ");
  const tuple = `(${table.columns.map(() => "?").join(", ")})`;
  const values = Array.from({ length: rowCount }, () => tuple).join(", ");
  return `INSERT INTO ${quoteIdent(table.name)} (${columns}) VALUES ${values}`;
}

function deleteSql(table: (typeof TABLES)[number]): string {
  return `DELETE FROM ${quoteIdent(table.name)}`;
}

function countSql(table: (typeof TABLES)[number]): string {
  return `SELECT COUNT(*) AS count FROM ${quoteIdent(table.name)}`;
}

function emptyTables(): TableRows {
  return Object.fromEntries(TABLES.map((table) => [table.name, []])) as unknown as TableRows;
}

function rowToJson(row: Record<string, unknown>): JsonObject {
  const next: JsonObject = {};
  for (const [key, value] of Object.entries(row)) {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      next[key] = value;
      continue;
    }

    if (typeof value === "bigint") {
      const asNumber = Number(value);
      if (!Number.isSafeInteger(asNumber)) throw new Error(`Value for ${key} exceeds JSON range`);
      next[key] = asNumber;
      continue;
    }

    throw new Error(`Unsupported database value for ${key}`);
  }
  return next;
}

function isJsonScalar(value: unknown): value is JsonScalar {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function parseDump(input: unknown): DbJsonDump {
  if (typeof input !== "object" || input === null) {
    throw new Error("Import file must contain a JSON object");
  }

  const dump = input as Partial<DbJsonDump>;
  if (dump.kind !== EXPORT_KIND) throw new Error("Import file is not a Kozane database export");
  if (typeof dump.version !== "number" || dump.version > EXPORT_VERSION) {
    throw new Error(`Unsupported Kozane database export version: ${String(dump.version)}`);
  }
  // Said in full rather than as "unsupported version". A dump below the floor is a backup
  // someone is holding, and the bare version number gives them nothing to do about it.
  if (dump.version < OLDEST_SUPPORTED_IMPORT_VERSION) {
    throw new Error(
      `Kozane database export version ${String(dump.version)} predates the rename of ` +
        `"project" to "namespace" and "bundle" to "partition", and cannot be imported. ` +
        `Import it with Kozane 0.10 or earlier and then run "kozane db migrate", which ` +
        `renames the database in place and keeps every row.`,
    );
  }
  if (typeof dump.exportedAt !== "string") throw new Error("Import file is missing exportedAt");
  if (typeof dump.migrations !== "object" || dump.migrations === null) {
    throw new Error("Import file is missing migrations");
  }
  if (
    !("applied" in dump.migrations) ||
    (dump.migrations.applied !== null && typeof dump.migrations.applied !== "string") ||
    !("latest" in dump.migrations) ||
    (dump.migrations.latest !== null && typeof dump.migrations.latest !== "string")
  ) {
    throw new Error("Import file has invalid migrations");
  }
  if (typeof dump.tables !== "object" || dump.tables === null) {
    throw new Error("Import file is missing tables");
  }

  for (const table of TABLES) {
    const rows = (dump.tables as Partial<TableRows>)[table.name];
    if (!Array.isArray(rows)) throw new Error(`Import file is missing table ${table.name}`);

    rows.forEach((row, index) => {
      if (typeof row !== "object" || row === null || Array.isArray(row)) {
        throw new Error(`Invalid row ${index} in table ${table.name}`);
      }
      for (const column of table.columns) {
        if (!(column in row)) {
          throw new Error(`Row ${index} in table ${table.name} is missing column ${column}`);
        }
        if (!isJsonScalar(row[column])) {
          throw new Error(`Invalid value for ${table.name}.${column} at row ${index}`);
        }
      }
    });
  }

  return dump as DbJsonDump;
}

export async function exportDbJson(
  dbUrl: string,
  migrations: DbJsonDump["migrations"] = { applied: null, latest: null },
): Promise<DbJsonDump> {
  const client = createClient({ url: dbUrl });
  try {
    await client.execute("PRAGMA busy_timeout = 5000");
    const tables = emptyTables();
    for (const table of TABLES) {
      const result = await client.execute(selectSql(table));
      tables[table.name] = result.rows.map((row) => rowToJson(row));
    }

    return {
      kind: EXPORT_KIND,
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      migrations,
      tables,
    };
  } finally {
    client.close();
  }
}

export async function hasDbJsonRows(dbUrl: string): Promise<boolean> {
  const client = createClient({ url: dbUrl });
  try {
    await client.execute("PRAGMA busy_timeout = 5000");
    for (const table of TABLES) {
      const result = await client.execute(countSql(table));
      const rawCount = result.rows[0]?.count;
      const count =
        typeof rawCount === "number"
          ? rawCount
          : typeof rawCount === "bigint"
            ? Number(rawCount)
            : Number(rawCount ?? 0);
      if (count > 0) return true;
    }
    return false;
  } finally {
    client.close();
  }
}

/**
 * Reports broken references before the insert loop starts. SQLite enforces the same
 * constraints during the import transaction, but names the offending row far less
 * clearly, so every foreign key in the export is checked here.
 */
function validateDumpRefs(tables: TableRows): void {
  const namespaceIds = new Set(tables.namespace.map((r) => r.id as string));
  const partitionIds = new Set(tables.partition.map((r) => r.id as string));
  const layerIds = new Set(tables.layer.map((r) => r.id as string));
  const cardIds = new Set(tables.card.map((r) => r.id as string));
  const glueIds = new Set(tables.glue.map((r) => r.id as string));
  const scopeIds = new Set(tables.scope.map((r) => r.id as string));
  const taskspaceIds = new Set(tables.taskspace.map((r) => r.id as string));

  if (tables.namespace.filter((row) => Number(row.is_default) === 1).length > 1)
    throw new Error("namespace: more than one namespace is marked as the default");
  for (const row of tables.partition) {
    if (!namespaceIds.has(row.namespace_id as string))
      throw new Error(`partition ${row.id}: references unknown namespace_id ${row.namespace_id}`);
  }
  for (const row of tables.layer) {
    if (!namespaceIds.has(row.namespace_id as string))
      throw new Error(`layer ${row.id}: references unknown namespace_id ${row.namespace_id}`);
  }
  for (const row of tables.warp) {
    if (!namespaceIds.has(row.namespace_id as string))
      throw new Error(`warp ${row.id}: references unknown namespace_id ${row.namespace_id}`);
  }
  for (const row of tables.card) {
    if (!partitionIds.has(row.partition_id as string))
      throw new Error(`card ${row.id}: references unknown partition_id ${row.partition_id}`);
    // `card.layer_id` is NOT NULL, so a null arriving here is caught by the same check
    // and reported as the unknown reference it is rather than as a constraint failure.
    if (!layerIds.has(row.layer_id as string))
      throw new Error(`card ${row.id}: references unknown layer_id ${row.layer_id}`);
    if (row.taskspace_id !== null && !taskspaceIds.has(row.taskspace_id as string))
      throw new Error(`card ${row.id}: references unknown taskspace_id ${row.taskspace_id}`);
  }
  for (const row of tables.taskspace) {
    if (row.namespace_id !== null && !namespaceIds.has(row.namespace_id as string))
      throw new Error(`taskspace ${row.id}: references unknown namespace_id ${row.namespace_id}`);
    if (row.scope_id !== null && !scopeIds.has(row.scope_id as string))
      throw new Error(`taskspace ${row.id}: references unknown scope_id ${row.scope_id}`);
  }
  for (const row of tables.glue_rel) {
    if (!glueIds.has(row.glue_id as string))
      throw new Error(`glue_rel: references unknown glue_id ${row.glue_id}`);
    if (!cardIds.has(row.card_id as string))
      throw new Error(`glue_rel: references unknown card_id ${row.card_id}`);
  }
  for (const row of tables.scope_rel) {
    if (!scopeIds.has(row.scope_id as string))
      throw new Error(`scope_rel: references unknown scope_id ${row.scope_id}`);
    if (!cardIds.has(row.card_id as string))
      throw new Error(`scope_rel: references unknown card_id ${row.card_id}`);
  }
}

export async function importDbJson(
  dbUrl: string,
  input: unknown,
): Promise<Record<TableName, number>> {
  const dump = parseDump(input);
  validateDumpRefs(dump.tables);
  const client = createClient({ url: dbUrl });

  try {
    await client.execute("PRAGMA busy_timeout = 5000");
    await client.execute("PRAGMA foreign_keys = ON");
    await client.execute("BEGIN");
    try {
      for (const table of [...TABLES].reverse()) {
        await client.execute(deleteSql(table));
      }

      for (const table of TABLES) {
        for (const batch of chunked(dump.tables[table.name], {
          columnsPerRow: table.columns.length,
        })) {
          await client.execute({
            sql: insertSql(table, batch.length),
            args: batch.flatMap((row) => table.columns.map((column) => row[column] as InValue)),
          });
        }
      }

      await client.execute("COMMIT");
    } catch (e) {
      await client.execute("ROLLBACK");
      throw e;
    }

    return Object.fromEntries(
      TABLES.map((table) => [table.name, dump.tables[table.name].length]),
    ) as Record<TableName, number>;
  } finally {
    client.close();
  }
}

export function stringifyDbJson(dump: DbJsonDump, pretty = true): string {
  return `${JSON.stringify(dump, null, pretty ? 2 : 0)}\n`;
}
