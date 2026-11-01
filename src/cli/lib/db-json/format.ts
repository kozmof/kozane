/** The dump format: its version, table order, and row shapes. */
import { is } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import * as schema from "../../../db/schema.js";

export const EXPORT_KIND = "kozane.db.export";

export const EXPORT_VERSION = 9;

/**
 * Oldest supported dump version. Version 7 uses the `namespace` and `partition` table names.
 *
 * Version 8 adds `scope_area`. `parseDump` treats that table as empty in older supported
 * dumps and requires it in versions that include it. {@link TABLE_ORDER} records each table's
 * first version.
 *
 * Version 9 adds `inventory` and the `card.inventory_id` and `card.inventory_slot` columns.
 * Older dumps read as having no inventories and no stored cards. {@link COLUMNS_SINCE} records
 * each added column's first version.
 *
 * Dumps before version 7 are rejected. Migrate an old workspace database in place before
 * exporting it. Migration 0014 renames the tables without discarding rows.
 */
export const OLDEST_SUPPORTED_IMPORT_VERSION = 7;

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
  // Before `card`, whose `inventory_id` points at it.
  { name: "inventory", orderBy: ["id"], since: 9 },
  { name: "taskspace", orderBy: ["id"] },
  { name: "card", orderBy: ["id"] },
  { name: "glue", orderBy: ["id"] },
  // Keep glue members beside their groups in the dump.
  { name: "glue_rel", orderBy: ["glue_id", "card_id"] },
  { name: "scope_rel", orderBy: ["scope_id", "card_id"] },
] as const;

/**
 * Columns added after a table's first dump version, keyed by their first version. Older
 * dumps omit these fields. Read them as null to match the migration's value for existing rows.
 */
export const COLUMNS_SINCE: Partial<Record<string, Record<string, number>>> = {
  card: { inventory_id: 9, inventory_slot: 9 },
};

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

export type TableName = (typeof TABLE_ORDER)[number]["name"];

export type TableRows = Record<TableName, JsonObject[]>;

export type JsonScalar = string | number | boolean | null;

export type JsonObject = Record<string, JsonScalar>;

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
