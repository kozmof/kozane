import { createClient, type InValue } from "@libsql/client";
import { is } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import * as schema from "../../db/schema.js";
import { chunked, NAME_MAX } from "../../lib/constants.js";
import { plural } from "./plural.js";

const EXPORT_KIND = "kozane.db.export";
const EXPORT_VERSION = 8;
/**
 * Oldest supported dump version. Version 7 uses the `namespace` and `partition` table names.
 *
 * Version 8 adds `scope_area`. `parseDump` treats that table as empty in older supported
 * dumps and requires it in versions that include it. {@link TABLE_ORDER} records each table's
 * first version.
 *
 * Dumps before version 7 are rejected. Migrate an old workspace database in place before
 * exporting it. Migration 0014 renames the tables without discarding rows.
 */
const OLDEST_SUPPORTED_IMPORT_VERSION = 7;

/**
 * Tables in foreign-key insertion order. Restore deletes them in reverse order.
 *
 * Declare ordering here and derive columns from the Drizzle schema so new columns are
 * included in exports automatically.
 */
const TABLE_ORDER = [
  { name: "namespace", orderBy: ["id"] },
  { name: "scope", orderBy: ["id"] },
  // Place the frame table after its referenced tables and beside the card layout data.
  { name: "scope_area", orderBy: ["id"], since: 8 },
  { name: "partition", orderBy: ["id"] },
  { name: "layer", orderBy: ["id"] },
  { name: "warp", orderBy: ["id"] },
  { name: "taskspace", orderBy: ["id"] },
  { name: "card", orderBy: ["id"] },
  { name: "glue", orderBy: ["id"] },
  // Keep glue members beside their groups in the dump.
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
 * Exported tables, their schema-derived columns, and row ordering. Export this list so tests
 * can verify that it includes every schema table.
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
 * Build a multi-row insert for `rowCount` rows. The caller uses {@link chunked} to stay
 * within the parameter budget.
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

/** Report the table and column when a value cannot be represented in JSON. */
function rowToJson(row: Record<string, unknown>, table: TableName): JsonObject {
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

    // The default client rejects oversized integers during `SELECT`, before they reach this
    // branch. Support clients configured to return bigints by converting values that fit
    // safely in a number.
    if (typeof value === "bigint") {
      const asNumber = Number(value);
      if (!Number.isSafeInteger(asNumber))
        throw new Error(`Value for ${table}.${key} exceeds JSON range`);
      next[key] = asNumber;
      continue;
    }

    // A BLOB arrives as an `ArrayBuffer`. The schema has no BLOB columns, so this value is
    // invalid for an export.
    throw new Error(`Unsupported database value for ${table}.${key}`);
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
    const tables = dump.tables as Partial<TableRows>;
    // Treat tables omitted by older dumps as empty.
    const since = "since" in table ? table.since : undefined;
    if (since !== undefined && dump.version < since && tables[table.name] === undefined) {
      tables[table.name] = [];
    }

    const rows = tables[table.name];
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
      let rows;
      try {
        rows = (await client.execute(selectSql(table))).rows;
      } catch (e) {
        // Add the table name when a read fails, including when the client rejects an unsafe
        // integer. Preserve the original error as `cause` for diagnostics.
        throw new Error(
          `Failed to read table ${table.name} for export: ${e instanceof Error ? e.message : String(e)}`,
          { cause: e },
        );
      }
      tables[table.name] = rows.map((row) => rowToJson(row, table.name));
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
  for (const row of tables.scope_area) {
    if (!scopeIds.has(row.scope_id as string))
      throw new Error(`scope_area ${row.id}: references unknown scope_id ${row.scope_id}`);
    if (!namespaceIds.has(row.namespace_id as string))
      throw new Error(`scope_area ${row.id}: references unknown namespace_id ${row.namespace_id}`);
  }
}

/**
 * Workspace limits used to check imported rows. Use the target workspace's configured limits,
 * which may differ from the source's.
 */
export type DumpLimits = { contentMax: number; canvasWidth: number; canvasHeight: number };

/** Limit warning samples as doctor does to keep output bounded. */
const LIMIT_WARNING_NAMED_MAX = 5;

/** The first few ids, and a count of the rest. */
function nameSome(ids: string[]): string {
  const named = ids.slice(0, LIMIT_WARNING_NAMED_MAX);
  const rest = ids.length - named.length;
  return rest > 0 ? `${named.join(", ")}, and ${rest} more` : named.join(", ");
}

function overLimit(
  rows: JsonObject[],
  offending: (row: JsonObject) => boolean,
): { total: number; ids: string[] } {
  const hit = rows.filter(offending);
  return { total: hit.length, ids: hit.map((row) => String(row.id)) };
}

/**
 * Read a table's rows for the post-import warning report. Return no rows for an unexpected
 * shape so reporting cannot turn a successful restore into an apparent failure. `parseDump`
 * already validated the import.
 */
function rowsOf(input: unknown, table: TableName): JsonObject[] {
  if (typeof input !== "object" || input === null) return [];
  const tables = (input as { tables?: unknown }).tables;
  if (typeof tables !== "object" || tables === null) return [];
  const rows = (tables as Record<string, unknown>)[table];
  if (!Array.isArray(rows)) return [];
  return rows.filter(
    (row): row is JsonObject => typeof row === "object" && row !== null && !Array.isArray(row),
  );
}

/**
 * Report imported rows that exceed the target workspace's text, name, or canvas limits.
 *
 * These configurable limits do not invalidate a backup. Warn after a successful import so
 * workspaces with different settings can exchange dumps. Broken foreign keys are rejected
 * separately by {@link validateDumpRefs}.
 *
 * Return one line per condition. `kozane doctor` can find the same conditions in the restored
 * database later.
 */
export function dumpLimitWarnings(input: unknown, limits: DumpLimits): string[] {
  const warnings: string[] = [];
  const { contentMax, canvasWidth, canvasHeight } = limits;
  const cards = rowsOf(input, "card");

  const long = overLimit(
    cards,
    (row) => typeof row.content === "string" && row.content.length > contentMax,
  );
  if (long.total > 0)
    warnings.push(
      `card: ${plural(long.total, "card")} longer than this workspace's ` +
        `ui.contentMax of ${contentMax} characters (${nameSome(long.ids)}). ` +
        `Editing one through the board or 'kozane card edit' will refuse it until it is shortened.`,
    );

  // Check positions against the configured canvas size.
  const offBoard = overLimit(
    cards,
    (row) =>
      Number(row.pos_x) < 0 ||
      Number(row.pos_y) < 0 ||
      Number(row.pos_x) > canvasWidth ||
      Number(row.pos_y) > canvasHeight,
  );
  if (offBoard.total > 0)
    warnings.push(
      `card: ${plural(offBoard.total, "card")} positioned outside this ` +
        `workspace's ${canvasWidth}×${canvasHeight} canvas ` +
        `(${nameSome(offBoard.ids)}). Use 'kozane card move' to bring one back, ` +
        `or raise ui.canvasWidth / ui.canvasHeight.`,
    );

  // Combine named entities into one warning. Include the table with each ID to distinguish
  // rows across tables.
  const namedTables: TableName[] = ["namespace", "partition", "layer", "scope", "taskspace"];
  const longNames = namedTables.flatMap((table) =>
    rowsOf(input, table)
      .filter((row) => typeof row.name === "string" && row.name.length > NAME_MAX)
      .map((row) => `${table} ${String(row.id)}`),
  );
  if (longNames.length > 0)
    warnings.push(
      `${plural(longNames.length, "name")} longer than the ${NAME_MAX}-character ` +
        `limit (${nameSome(longNames)}). Renaming one will refuse it until it is shortened.`,
    );

  return warnings;
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
