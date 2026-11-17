/** Internal local checkpoint capture. This format does not authorize installation or activation. */
import { sql } from "drizzle-orm";
import { withReadTx, type DB, type ReadTx } from "../database.js";
import { migrations } from "../generated/migrations.js";
import { canonicalSchemaManifest } from "../generated/schema-manifest.js";
import { compareSchemaManifests } from "../migrations/schema.js";
import { readSchemaManifest } from "../migrations/schema-reader.js";
import { localTableNames } from "./local-tables.js";
import { createRestorationPlan } from "./restoration-plan.js";
import { createRowProjection } from "./projection.js";
import { parseTaggedRow, taggedRowKey, ROW_ENCODING_VERSION, type TaggedRow } from "./row-codec.js";
import { captureRowSql, decodeCapturedRow } from "./sql-codec.js";

export const LOCAL_RECOVERY_VERSION = 1;
export interface LocalRecoveryIdentity {
  readonly workspaceId: string;
  readonly deviceId: string;
  readonly epochId: string;
  readonly checkpointId: string;
  readonly schemaId: string;
}
export interface LocalRecoverySelection {
  readonly baselineId: string;
  readonly effectSetIds: readonly string[];
}
export interface LocalRecoverySnapshot {
  readonly version: typeof LOCAL_RECOVERY_VERSION;
  readonly rowEncodingVersion: typeof ROW_ENCODING_VERSION;
  readonly identity: LocalRecoveryIdentity;
  readonly selection: LocalRecoverySelection;
  readonly tables: readonly { readonly name: string; readonly rows: readonly TaggedRow[] }[];
}
export class LocalRecoveryError extends Error {
  override readonly name = "LocalRecoveryError";
}
const plan = createRestorationPlan(canonicalSchemaManifest, localTableNames);
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
function object(input: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== fields.length
  )
    throw new LocalRecoveryError("Invalid local recovery object");
  return Object.fromEntries(
    fields.map((field) => {
      const property = Object.getOwnPropertyDescriptor(input, field);
      if (!property || !("value" in property) || !property.enumerable)
        throw new LocalRecoveryError("Local recovery requires plain data fields");
      return [field, property.value];
    }),
  );
}
function array(input: unknown): unknown[] {
  if (!Array.isArray(input) || Reflect.ownKeys(input).length !== input.length + 1)
    throw new LocalRecoveryError("Invalid local recovery array");
  return Array.from({ length: input.length }, (_, index) => {
    const property = Object.getOwnPropertyDescriptor(input, String(index));
    if (!property || !("value" in property) || !property.enumerable)
      throw new LocalRecoveryError("Local recovery requires plain array entries");
    return property.value;
  });
}
function id(input: unknown): string {
  if (
    typeof input !== "string" ||
    !input.trim() ||
    input.length > 1000 ||
    input.includes("\0") ||
    !input.isWellFormed()
  )
    throw new LocalRecoveryError("Invalid local recovery identity");
  return input;
}
export function parseLocalRecoveryIdentity(
  input: unknown,
  schemaIds: readonly string[] = [migrations.at(-1)!.id],
): LocalRecoveryIdentity {
  const fields = ["workspaceId", "deviceId", "epochId", "checkpointId", "schemaId"] as const;
  const value = object(input, fields);
  const parsed = Object.fromEntries(
    fields.map((field) => [field, id(value[field])]),
  ) as unknown as LocalRecoveryIdentity;
  if (!schemaIds.includes(parsed.schemaId))
    throw new LocalRecoveryError("Unsupported local recovery schema");
  return Object.freeze(parsed);
}
export function parseLocalRecoverySelection(input: unknown): LocalRecoverySelection {
  const value = object(input, ["baselineId", "effectSetIds"]);
  const effects = array(value.effectSetIds).map(id);
  if (new Set(effects).size !== effects.length)
    throw new LocalRecoveryError("Duplicate selected effect set");
  return Object.freeze({ baselineId: id(value.baselineId), effectSetIds: Object.freeze(effects) });
}

/** Complete local table coverage is mandatory, including empty tables and absent taskspace metadata. */
export function parseLocalRecoverySnapshot(input: unknown): LocalRecoverySnapshot {
  const value = object(input, ["version", "rowEncodingVersion", "identity", "selection", "tables"]);
  if (value.version !== LOCAL_RECOVERY_VERSION || value.rowEncodingVersion !== ROW_ENCODING_VERSION)
    throw new LocalRecoveryError("Unsupported local recovery encoding");
  const keys = parseLocalRecoveryIdentity(value.identity);
  const selected = parseLocalRecoverySelection(value.selection);
  const tables = new Map<string, readonly TaggedRow[]>();
  for (const entry of array(value.tables)) {
    const table = object(entry, ["name", "rows"]);
    if (
      typeof table.name !== "string" ||
      !localTableNames.includes(table.name) ||
      tables.has(table.name)
    )
      throw new LocalRecoveryError("Unknown or duplicate local recovery table");
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
    throw new LocalRecoveryError("Incomplete local recovery tables");
  const projection = createRowProjection(
    plan.loadOrder,
    [...tables].flatMap(([table, rows]) => rows.map((row) => ({ table, row }))),
  );
  return Object.freeze({
    version: LOCAL_RECOVERY_VERSION,
    rowEncodingVersion: ROW_ENCODING_VERSION,
    identity: keys,
    selection: selected,
    tables: Object.freeze(
      plan.loadOrder.map((table) => {
        const key = (row: TaggedRow) => {
          if (table.primaryKey.some((column) => row[column][0] === "null"))
            throw new LocalRecoveryError("Local recovery primary key is NULL");
          return taggedRowKey(
            Object.fromEntries(table.primaryKey.map((column) => [column, row[column]])),
          );
        };
        const rows = projection.rows(table.name).map((row) => ({ row, key: key(row) }));
        rows.sort((a, b) => compare(a.key, b.key));
        return Object.freeze({ name: table.name, rows: Object.freeze(rows.map(({ row }) => row)) });
      }),
    ),
  });
}

/** Identity comparison is required before considering local installation on the originating device. */
export function requireLocalRecoveryIdentity(
  input: unknown,
  expected: LocalRecoveryIdentity,
): LocalRecoverySnapshot {
  const wanted = parseLocalRecoveryIdentity(expected);
  const snapshot = parseLocalRecoverySnapshot(input);
  for (const field of Object.keys(wanted) as (keyof LocalRecoveryIdentity)[])
    if (snapshot.identity[field] !== wanted[field])
      throw new LocalRecoveryError(`Local recovery identity mismatch: ${field}`);
  return snapshot;
}

/** Read selections and local rows through this same snapshot. The host owns identity and checkpoint persistence. */
export function captureLocalRecoverySnapshot(
  db: DB,
  keys: LocalRecoveryIdentity,
  readSelection: (tx: ReadTx) => Promise<LocalRecoverySelection>,
): Promise<LocalRecoverySnapshot> {
  const copied = parseLocalRecoveryIdentity(keys);
  if (typeof readSelection !== "function")
    throw new LocalRecoveryError("Local recovery requires a checkpoint reader");
  return withReadTx(db, async (tx) => {
    const actual = await readSchemaManifest(async (query) =>
      (await tx.values(sql.raw(query))).map((row) => Array.from(row)),
    );
    const local = (objects: typeof canonicalSchemaManifest) =>
      objects.filter((entry) => localTableNames.includes(entry.table));
    if (!compareSchemaManifests(local(actual), local(canonicalSchemaManifest)).matches)
      throw new LocalRecoveryError("Local recovery requires the canonical local schema");
    const selected = parseLocalRecoverySelection(await readSelection(tx));
    const tables = [];
    for (const table of plan.loadOrder) {
      const rows = await tx.values(
        sql.raw(
          `SELECT ${captureRowSql(table.columns)} FROM ${quote(table.name)} ORDER BY ${table.primaryKey.map(quote).join(",")}`,
        ),
      );
      tables.push({
        name: table.name,
        rows: rows.map((row) => {
          if (typeof row[0] !== "string")
            throw new LocalRecoveryError("Local recovery capture did not return a row image");
          return decodeCapturedRow(row[0]);
        }),
      });
    }
    return parseLocalRecoverySnapshot({
      version: LOCAL_RECOVERY_VERSION,
      rowEncodingVersion: ROW_ENCODING_VERSION,
      identity: copied,
      selection: selected,
      tables,
    });
  });
}
