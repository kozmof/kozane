import { createClient, type InValue } from "@libsql/client";

const EXPORT_KIND = "kozane.db.export";
const EXPORT_VERSION = 1;

const TABLES = [
  {
    name: "project",
    columns: ["id", "name"],
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
    name: "working_copy",
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
    columns: ["id", "bundle_id", "working_copy_id", "content", "pos_x", "pos_y"],
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
  return {
    project: [],
    scope: [],
    bundle: [],
    working_copy: [],
    card: [],
    glue: [],
    glue_rel: [],
    scope_rel: [],
  };
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
  if (dump.version !== EXPORT_VERSION) {
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

export async function importDbJson(
  dbUrl: string,
  input: unknown,
): Promise<Record<TableName, number>> {
  const dump = parseDump(input);
  const client = createClient({ url: dbUrl });

  try {
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
