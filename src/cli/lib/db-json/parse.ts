/** Parsing a dump file into typed rows, refusing malformed ones. */
import {
  EXPORT_KIND,
  EXPORT_VERSION,
  OLDEST_SUPPORTED_IMPORT_VERSION,
  COLUMNS_SINCE,
  TABLES,
  type TableRows,
  type JsonScalar,
  type JsonObject,
  type DbJsonDump,
} from "./format.js";

function isJsonScalar(value: unknown): value is JsonScalar {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

export function parseDump(input: unknown): DbJsonDump {
  if (typeof input !== "object" || input === null) {
    throw new Error("Import file must contain a JSON object");
  }

  const dump = input as Partial<DbJsonDump>;
  if (dump.kind !== EXPORT_KIND) throw new Error("Import file is not a Kozane database export");
  if (typeof dump.version !== "number" || dump.version > EXPORT_VERSION) {
    throw new Error(`Unsupported Kozane database export version: ${String(dump.version)}`);
  }
  // Explain how to recover an older backup when its dump version cannot be imported.
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

  // Keep the narrowed version number available inside the row callback.
  const version = dump.version;
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
      const added = COLUMNS_SINCE[table.name] ?? {};
      for (const column of table.columns) {
        const addedIn = added[column];
        if (!(column in row) && addedIn !== undefined && version < addedIn) {
          (row as JsonObject)[column] = null;
        }
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
