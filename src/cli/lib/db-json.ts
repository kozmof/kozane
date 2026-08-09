import { createClient, type InValue } from "@libsql/client";

const EXPORT_KIND = "kozane.db.export";
const EXPORT_VERSION = 3;
// Version 2 predates `project.is_default` (migration 0003). Such a file is still
// importable; every project comes back non-default, which is what version 2 recorded.
const OLDEST_SUPPORTED_IMPORT_VERSION = 2;

/** Exported so tests can assert this list stays in step with the Drizzle schema. */
export const TABLES = [
  {
    name: "project",
    columns: ["id", "name", "is_default"],
    orderBy: ["id"],
  },
  {
    name: "scope",
    columns: ["id", "name"],
    orderBy: ["id"],
  },
  {
    name: "bundle",
    columns: ["id", "project_id", "name", "is_default"],
    orderBy: ["id"],
  },
  {
    name: "taskspace",
    columns: [
      "id",
      "project_id",
      "scope_id",
      "name",
      "path",
      "path_kind",
      "last_seen_at",
      "created_at",
      "updated_at",
    ],
    orderBy: ["id"],
  },
  {
    name: "card",
    columns: ["id", "bundle_id", "taskspace_id", "content", "pos_x", "pos_y", "z_index"],
    orderBy: ["id"],
  },
  {
    name: "glue",
    columns: ["id"],
    orderBy: ["id"],
  },
  {
    name: "glue_rel",
    columns: ["glue_id", "card_id"],
    orderBy: ["glue_id", "card_id"],
  },
  {
    name: "scope_rel",
    columns: ["scope_id", "card_id"],
    orderBy: ["scope_id", "card_id"],
  },
] as const;

type TableName = (typeof TABLES)[number]["name"];
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

function insertSql(table: (typeof TABLES)[number]): string {
  const columns = table.columns.map(quoteIdent).join(", ");
  const placeholders = table.columns.map(() => "?").join(", ");
  return `INSERT INTO ${quoteIdent(table.name)} (${columns}) VALUES (${placeholders})`;
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

/** Fills in columns added after `version`, so older exports validate against TABLES. */
function upgradeDumpTables(version: number, tables: Partial<TableRows>): void {
  if (version >= 3) return;
  for (const row of tables.project ?? []) {
    if (typeof row === "object" && row !== null && !("is_default" in row)) row.is_default = 0;
  }
}

function parseDump(input: unknown): DbJsonDump {
  if (typeof input !== "object" || input === null) {
    throw new Error("Import file must contain a JSON object");
  }

  const dump = input as Partial<DbJsonDump>;
  if (dump.kind !== EXPORT_KIND) throw new Error("Import file is not a Kozane database export");
  if (
    typeof dump.version !== "number" ||
    dump.version < OLDEST_SUPPORTED_IMPORT_VERSION ||
    dump.version > EXPORT_VERSION
  ) {
    throw new Error(`Unsupported Kozane database export version: ${String(dump.version)}`);
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

  upgradeDumpTables(dump.version, dump.tables as Partial<TableRows>);

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
  const projectIds = new Set(tables.project.map((r) => r.id as string));
  const bundleIds = new Set(tables.bundle.map((r) => r.id as string));
  const cardIds = new Set(tables.card.map((r) => r.id as string));
  const glueIds = new Set(tables.glue.map((r) => r.id as string));
  const scopeIds = new Set(tables.scope.map((r) => r.id as string));
  const taskspaceIds = new Set(tables.taskspace.map((r) => r.id as string));

  if (tables.project.filter((row) => Number(row.is_default) === 1).length > 1)
    throw new Error("project: more than one project is marked as the default");
  for (const row of tables.bundle) {
    if (!projectIds.has(row.project_id as string))
      throw new Error(`bundle ${row.id}: references unknown project_id ${row.project_id}`);
  }
  for (const row of tables.card) {
    if (!bundleIds.has(row.bundle_id as string))
      throw new Error(`card ${row.id}: references unknown bundle_id ${row.bundle_id}`);
    if (row.taskspace_id !== null && !taskspaceIds.has(row.taskspace_id as string))
      throw new Error(`card ${row.id}: references unknown taskspace_id ${row.taskspace_id}`);
  }
  for (const row of tables.taskspace) {
    if (row.project_id !== null && !projectIds.has(row.project_id as string))
      throw new Error(`taskspace ${row.id}: references unknown project_id ${row.project_id}`);
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
        const sql = insertSql(table);
        for (const row of dump.tables[table.name]) {
          await client.execute({
            sql,
            args: table.columns.map((column) => row[column] as InValue),
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
