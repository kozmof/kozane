/** The dump format: its version, table order, and row shapes. */
import { is } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import * as schema from "../../../db/schema.js";

export const EXPORT_KIND = "kozane.db.export";

export const EXPORT_VERSION = 26;

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
 * Version 10 moves inline taskspace paths and observations into `taskspace_local`.
 * Local rows may outlive shared taskspaces. Imports of older dumps split those fields.
 * Version 11 adds retained local filesystem operation records.
 * Version 12 includes taskspace file mutation intents in the same local journal.
 * Version 13 adds managed taskspace directory move and removal intents.
 * Version 14 adds explicit abandonment metadata and planned CLI layout paths.
 * Version 15 includes local image upload pins and their installation evidence.
 * Version 16 includes retained asset manifest owners and explicit release decisions.
 * Version 17 includes the local trusted checkpoint descriptor catalog.
 * Version 18 includes shared-history descriptors and their original local checkpoint bindings.
 * Version 19 includes trusted recovery asset descriptors bound to both original checkpoints.
 * Version 20 includes trusted selected-execution descriptors and their original local bindings.
 * Version 21 includes trusted original-action descriptors and their original local bindings.
 * Version 22 includes trusted retained-history descriptors and their original local bindings.
 * Version 23 includes retained-manifest descriptors with all original source bindings.
 * Version 24 includes broader original-action archive descriptors and original local bindings.
 * Version 25 includes broader retained-run archive descriptors and original local bindings.
 * Version 26 includes broader run-manifest descriptors with all original source bindings.
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
  { name: "taskspace_local", orderBy: ["taskspace_id"], since: 10 },
  { name: "local_file_operation", orderBy: ["id"], since: 11 },
  { name: "local_image_upload", orderBy: ["filename"], since: 15 },
  { name: "local_asset_manifest", orderBy: ["owner_kind", "owner_id"], since: 16 },
  {
    name: "local_recovery_checkpoint",
    orderBy: ["workspace_id", "device_id", "epoch_id", "checkpoint_id"],
    since: 17,
  },
  {
    name: "local_recovery_shared_history",
    orderBy: ["workspace_id", "device_id", "epoch_id", "checkpoint_id"],
    since: 18,
  },
  {
    name: "local_recovery_assets",
    orderBy: ["workspace_id", "device_id", "epoch_id", "checkpoint_id"],
    since: 19,
  },
  {
    name: "local_recovery_executions",
    orderBy: ["workspace_id", "device_id", "epoch_id", "checkpoint_id"],
    since: 20,
  },
  {
    name: "local_recovery_actions",
    orderBy: ["workspace_id", "device_id", "epoch_id", "checkpoint_id"],
    since: 21,
  },
  {
    name: "local_recovery_retained_history",
    orderBy: ["workspace_id", "device_id", "epoch_id", "checkpoint_id"],
    since: 22,
  },
  {
    name: "local_recovery_retained_assets",
    orderBy: ["workspace_id", "device_id", "epoch_id", "checkpoint_id"],
    since: 23,
  },
  {
    name: "local_recovery_action_archives",
    orderBy: ["workspace_id", "device_id", "epoch_id", "checkpoint_id"],
    since: 24,
  },
  {
    name: "local_recovery_run_archives",
    orderBy: ["workspace_id", "device_id", "epoch_id", "checkpoint_id"],
    since: 25,
  },
  {
    name: "local_recovery_run_assets",
    orderBy: ["workspace_id", "device_id", "epoch_id", "checkpoint_id"],
    since: 26,
  },
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
  local_file_operation: { abandoned_at: 14, abandon_reason: 14 },
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
