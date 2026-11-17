/** Validate a reconstructed shared projection without installing or activating a workspace. */
import { sql } from "drizzle-orm";
import { withTx, type DB } from "../database.js";
import { migrations } from "../generated/migrations.js";
import { canonicalSchemaManifest } from "../generated/schema-manifest.js";
import { compareSchemaManifests } from "../migrations/schema.js";
import { readSchemaManifest } from "../migrations/schema-reader.js";
import { configureActionConnection, verifyActionConnection } from "./connection.js";
import { localTableNames } from "./local-tables.js";
import { createRestorationPlan } from "./restoration-plan.js";
import { createRowProjection } from "./projection.js";
import { parseTaggedRow, taggedRowKey, ROW_ENCODING_VERSION, type TaggedRow } from "./row-codec.js";
import {
  captureRowSql,
  decodeCapturedRow,
  installationInsert,
  type InstallationValue,
} from "./sql-codec.js";

export const SHARED_RECOVERY_PROJECTION_VERSION = 1;
export interface SharedRecoveryProjection {
  readonly version: typeof SHARED_RECOVERY_PROJECTION_VERSION;
  readonly rowEncodingVersion: typeof ROW_ENCODING_VERSION;
  readonly schemaId: string;
  readonly tables: readonly { readonly name: string; readonly rows: readonly TaggedRow[] }[];
}
export class SharedRecoveryError extends Error {
  override readonly name = "SharedRecoveryError";
}
const applicationTables = canonicalSchemaManifest.filter(
  (entry) => entry.type === "table" && entry.name !== "__drizzle_migrations",
);
const plan = createRestorationPlan(
  canonicalSchemaManifest,
  applicationTables
    .filter((entry) => !localTableNames.includes(entry.name))
    .map(({ name }) => name),
);
const sharedTables = new Set(plan.loadOrder.map(({ name }) => name));
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function fields(input: unknown, names: readonly string[]) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== names.length
  )
    throw new SharedRecoveryError("Invalid shared recovery object");
  return Object.fromEntries(
    names.map((name) => {
      const field = Object.getOwnPropertyDescriptor(input, name);
      if (!field || !("value" in field) || !field.enumerable)
        throw new SharedRecoveryError("Shared recovery requires plain data fields");
      return [name, field.value];
    }),
  );
}
function array(input: unknown): unknown[] {
  if (!Array.isArray(input) || Reflect.ownKeys(input).length !== input.length + 1)
    throw new SharedRecoveryError("Invalid shared recovery array");
  return Array.from({ length: input.length }, (_, index) => {
    const field = Object.getOwnPropertyDescriptor(input, String(index));
    if (!field || !("value" in field) || !field.enumerable)
      throw new SharedRecoveryError("Shared recovery requires plain array entries");
    return field.value;
  });
}

/** Complete shared table coverage is mandatory. Device-local tables never belong to this projection. */
export function parseSharedRecoveryProjection(input: unknown): SharedRecoveryProjection {
  const value = fields(input, ["version", "rowEncodingVersion", "schemaId", "tables"]);
  if (
    value.version !== SHARED_RECOVERY_PROJECTION_VERSION ||
    value.rowEncodingVersion !== ROW_ENCODING_VERSION ||
    value.schemaId !== migrations.at(-1)!.id
  )
    throw new SharedRecoveryError("Unsupported shared recovery schema or encoding");
  const tables = new Map<string, readonly TaggedRow[]>();
  for (const entry of array(value.tables)) {
    const table = fields(entry, ["name", "rows"]);
    if (typeof table.name !== "string" || !sharedTables.has(table.name) || tables.has(table.name))
      throw new SharedRecoveryError("Unknown or duplicate shared recovery table");
    tables.set(
      table.name,
      array(table.rows).map((row) => {
        const parsed = parseTaggedRow(row);
        return Object.freeze(
          Object.fromEntries(
            Object.keys(parsed)
              .sort()
              .map((column) => [column, parsed[column]]),
          ),
        );
      }),
    );
  }
  if (tables.size !== plan.loadOrder.length)
    throw new SharedRecoveryError("Incomplete shared recovery tables");
  const projection = createRowProjection(
    plan.loadOrder,
    [...tables].flatMap(([table, rows]) => rows.map((row) => ({ table, row }))),
  );
  return Object.freeze({
    version: SHARED_RECOVERY_PROJECTION_VERSION,
    rowEncodingVersion: ROW_ENCODING_VERSION,
    schemaId: migrations.at(-1)!.id,
    tables: Object.freeze(
      plan.loadOrder.map((table) => {
        const rows = projection.rows(table.name).map((row) => {
          if (table.primaryKey.some((column) => row[column][0] === "null"))
            throw new SharedRecoveryError("Shared recovery primary key is NULL");
          return {
            row,
            key: taggedRowKey(
              Object.fromEntries(table.primaryKey.map((column) => [column, row[column]])),
            ),
          };
        });
        rows.sort((a, b) => compare(a.key, b.key));
        return Object.freeze({ name: table.name, rows: Object.freeze(rows.map(({ row }) => row)) });
      }),
    ),
  });
}
function statement(value: InstallationValue) {
  const parts = value.sql.split("?");
  if (parts.length !== value.args.length + 1)
    throw new SharedRecoveryError("Invalid shared recovery installation statement");
  return sql.join(
    parts.flatMap((part, index) =>
      index === 0 ? [sql.raw(part)] : [sql`${value.args[index - 1]}`, sql.raw(part)],
    ),
    sql``,
  );
}

/** The trusted factory owns a separate empty database and its disposal. All temporary changes roll back. */
export async function validateSharedRecoveryProjection(
  createDatabase: () => Promise<DB>,
  input: unknown,
): Promise<SharedRecoveryProjection> {
  const snapshot = parseSharedRecoveryProjection(input);
  const target = createRowProjection(
    plan.loadOrder,
    snapshot.tables.flatMap((table) => table.rows.map((row) => ({ table: table.name, row }))),
  );
  const db = await createDatabase();
  await withTx(db, async (tx) => {
    const execute = (query: string) => tx.values(sql.raw(query));
    await configureActionConnection(execute);
    const actual = await readSchemaManifest(async (query) =>
      (await execute(query)).map((row) => Array.from(row)),
    );
    if (!compareSchemaManifests(actual).matches)
      throw new SharedRecoveryError("Shared recovery validation requires the canonical schema");
    for (const table of applicationTables)
      if ((await execute(`SELECT 1 FROM ${quote(table.name)} LIMIT 1`)).length)
        throw new SharedRecoveryError("Shared recovery validation requires an empty database");
    await tx.run(sql`SAVEPOINT shared_recovery_validation`);
    try {
      // Only these two business triggers mutate loaded rows. Keep validation triggers and constraints.
      await tx.run(sql`DROP TRIGGER card_inventory_clear_slot`);
      await tx.run(sql`DROP TRIGGER card_stamp_missing_timestamps`);
      for (const table of plan.loadOrder)
        for (const row of target.rows(table.name))
          await tx.run(statement(installationInsert(table.name, row)));
      if ((await execute("PRAGMA foreign_key_check")).length)
        throw new SharedRecoveryError("Shared recovery validation foreign-key check failed");
      if (
        (
          await execute(
            "SELECT 1 FROM card WHERE (inventory_id IS NULL) <> (inventory_slot IS NULL) LIMIT 1",
          )
        ).length
      )
        throw new SharedRecoveryError("Shared recovery validation inventory pair invariant failed");
      for (const table of plan.loadOrder) {
        const loaded = await execute(
          `SELECT ${captureRowSql(table.columns)} FROM ${quote(table.name)}`,
        );
        target.verifyInstalledRows(
          table.name,
          loaded.map((row) => {
            if (typeof row[0] !== "string")
              throw new SharedRecoveryError(
                "Shared recovery validation did not return a row image",
              );
            return decodeCapturedRow(row[0]);
          }),
        );
      }
      await verifyActionConnection(execute);
    } finally {
      await tx.run(sql`ROLLBACK TO shared_recovery_validation`);
      await tx.run(sql`RELEASE shared_recovery_validation`);
    }
  });
  return snapshot;
}
