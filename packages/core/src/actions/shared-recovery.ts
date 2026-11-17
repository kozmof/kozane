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
import { createRowProjection, type ProjectionEffect } from "./projection.js";
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
/** Expected counts come from completed retained records, independently of received effect arrays. */
export interface SharedRecoverySelection {
  readonly baselineId: string;
  readonly effectSets: readonly { readonly id: string; readonly effectCount: number }[];
}
export type SharedRecoveryEffect = ProjectionEffect;
export interface SharedRecoveryHistory {
  readonly baseline: { readonly id: string; readonly projection: SharedRecoveryProjection };
  readonly effectSets: readonly {
    readonly id: string;
    readonly effects: readonly SharedRecoveryEffect[];
  }[];
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

function historyId(input: unknown): string {
  if (
    typeof input !== "string" ||
    !input.trim() ||
    input.length > 1000 ||
    input.includes("\0") ||
    !input.isWellFormed()
  )
    throw new SharedRecoveryError("Invalid shared recovery history identity");
  return input;
}
function selectedHistory(input: unknown): SharedRecoverySelection {
  const value = fields(input, ["baselineId", "effectSets"]);
  const seen = new Set<string>();
  const effectSets = array(value.effectSets).map((input) => {
    const entry = fields(input, ["id", "effectCount"]);
    const id = historyId(entry.id);
    if (seen.has(id))
      throw new SharedRecoveryError("Duplicate selected shared recovery effect set");
    if (!Number.isSafeInteger(entry.effectCount) || (entry.effectCount as number) < 0)
      throw new SharedRecoveryError("Invalid expected shared recovery effect count");
    seen.add(id);
    return Object.freeze({ id, effectCount: entry.effectCount as number });
  });
  return Object.freeze({
    baselineId: historyId(value.baselineId),
    effectSets: Object.freeze(effectSets),
  });
}

/** Pure reconstruction. The trusted host owns identity, completeness and retention of the selected records. */
export function reconstructSharedRecoveryProjection(
  input: unknown,
  expected: SharedRecoverySelection,
): SharedRecoveryProjection {
  const selected = selectedHistory(expected);
  const value = fields(input, ["baseline", "effectSets"]);
  const baseline = fields(value.baseline, ["id", "projection"]);
  if (historyId(baseline.id) !== selected.baselineId)
    throw new SharedRecoveryError("Shared recovery baseline selection mismatch");
  const initial = parseSharedRecoveryProjection(baseline.projection);
  const counts = new Map(selected.effectSets.map((entry) => [entry.id, entry.effectCount]));
  const sets = new Map<string, readonly ProjectionEffect[]>();
  for (const input of array(value.effectSets)) {
    const entry = fields(input, ["id", "effects"]);
    const id = historyId(entry.id);
    if (!counts.has(id) || sets.has(id))
      throw new SharedRecoveryError("Unselected or duplicate shared recovery effect set");
    const effects = array(entry.effects);
    if (effects.length !== counts.get(id))
      throw new SharedRecoveryError("Shared recovery effect count mismatch");
    sets.set(
      id,
      Object.freeze(
        effects.map((input, index): ProjectionEffect => {
          const effect = fields(input, ["ord", "table", "key", "op", "before", "after"]);
          if (effect.ord !== index)
            throw new SharedRecoveryError(
              "Shared recovery effects require consecutive ordinals from zero",
            );
          const table = plan.loadOrder.find((table) => table.name === effect.table);
          if (!table || !["I", "U", "D"].includes(effect.op as string))
            throw new SharedRecoveryError("Invalid shared recovery effect table or operation");
          const key = parseTaggedRow(effect.key);
          if (table.primaryKey.some((column) => key[column]?.[0] === "null"))
            throw new SharedRecoveryError("Shared recovery effect primary key is NULL");
          return Object.freeze({
            ord: index,
            table: table.name,
            key,
            op: effect.op as "I" | "U" | "D",
            before: effect.before === null ? null : parseTaggedRow(effect.before),
            after: effect.after === null ? null : parseTaggedRow(effect.after),
          });
        }),
      ),
    );
  }
  if (sets.size !== selected.effectSets.length)
    throw new SharedRecoveryError("Missing selected shared recovery effect set");
  let projection = createRowProjection(
    plan.loadOrder,
    initial.tables.flatMap((table) => table.rows.map((row) => ({ table: table.name, row }))),
  );
  for (const { id } of selected.effectSets) projection = projection.apply(sets.get(id)!);
  return parseSharedRecoveryProjection({
    ...initial,
    tables: plan.loadOrder.map(({ name }) => ({ name, rows: projection.rows(name) })),
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
