/** Destination schema and migration authority shared by the staging boundaries. */
import { sql } from "drizzle-orm";
import type { Tx, ReadTx } from "../database.js";
import { readSchemaManifest } from "../migrations/schema-reader.js";
import { compareSchemaManifests } from "../migrations/schema.js";
import { validateMigrationHistory } from "../migrations/history.js";
import { LocalRecoveryError } from "./local-recovery.js";
export async function requireRecoveryDestinationSchema(tx: Tx | ReadTx) {
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
