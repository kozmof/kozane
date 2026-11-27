/** Destination schema and migration authority shared by the staging boundaries. */
import { sql } from "drizzle-orm";
import type { Tx, ReadTx } from "../database.js";
import { readSchemaManifest } from "../migrations/schema-reader.js";
import { compareSchemaManifests } from "../migrations/schema.js";
import { validateMigrationHistory } from "../migrations/history.js";
import { canonicalSchemaManifest } from "../generated/schema-manifest.js";
import { captureRowSql } from "./sql-codec.js";
import { LocalRecoveryError } from "./local-recovery.js";
export async function requireRecoveryDestinationSchema(tx: Tx | ReadTx) {
  if ((await tx.values(sql`SELECT 1 FROM sqlite_temp_schema LIMIT 1`)).length)
    throw new LocalRecoveryError("Recovery installation refuses temporary schema objects");
  const actual = await readSchemaManifest(async (query) =>
    (await tx.values(sql.raw(query))).map((row) => Array.from(row)),
  );
  if (!compareSchemaManifests(actual).matches)
    throw new LocalRecoveryError("Recovery installation requires the canonical destination schema");
  const history = await tx.values(
    sql`SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at`,
  );
  validateMigrationHistory(
    history.map((row) => ({ hash: row[0], created_at: row[1] })),
    "complete",
  );
}

/** Capture protected metadata as exact tagged row images, including migration history. */
export async function captureRecoveryDestinationRows(tx: Tx, excluded: ReadonlySet<string>) {
  const result: Record<string, readonly string[]> = {};
  for (const table of canonicalSchemaManifest.filter(
    (entry) => entry.type === "table" && !excluded.has(entry.name),
  )) {
    const columns = table.columns!.map((column) => String(column[1]));
    const name = '"' + table.name.replaceAll('"', '""') + '"';
    result[table.name] = (await tx.values(sql.raw(`SELECT ${captureRowSql(columns)} FROM ${name}`)))
      .map((row) => {
        if (typeof row[0] !== "string")
          throw new LocalRecoveryError("Recovery installation did not return protected row images");
        return row[0];
      })
      .sort();
  }
  return result;
}
