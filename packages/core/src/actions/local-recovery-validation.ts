/** Internal isolated SQL validation. This boundary never installs a live local snapshot. */
import { sql } from "drizzle-orm";
import { withTx, type DB } from "../database.js";
import { canonicalSchemaManifest } from "../generated/schema-manifest.js";
import { compareSchemaManifests } from "../migrations/schema.js";
import { readSchemaManifest } from "../migrations/schema-reader.js";
import { configureActionConnection, verifyActionConnection } from "./connection.js";
import { localTableNames } from "./local-tables.js";
import { localRecoveryAssetManifest } from "./local-recovery-assets.js";
import {
  LocalRecoveryError,
  requireLocalRecoveryIdentity,
  type LocalRecoveryIdentity,
  type LocalRecoverySnapshot,
} from "./local-recovery.js";
import { createRestorationPlan } from "./restoration-plan.js";
import { createRowProjection } from "./projection.js";
import {
  captureRowSql,
  decodeCapturedRow,
  installationInsert,
  type InstallationValue,
} from "./sql-codec.js";

const plan = createRestorationPlan(canonicalSchemaManifest, localTableNames);
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
function statement(value: InstallationValue) {
  // Only canonical table/column identifiers reach the generator. They contain no question marks.
  const parts = value.sql.split("?");
  if (parts.length !== value.args.length + 1)
    throw new LocalRecoveryError("Invalid local recovery installation statement");
  return sql.join(
    parts.flatMap((part, index) =>
      index === 0 ? [sql.raw(part)] : [sql`${value.args[index - 1]}`, sql.raw(part)],
    ),
    sql``,
  );
}

/** The trusted factory owns a separate empty database and its disposal. No filesystem callbacks run. */
export async function validateLocalRecoverySnapshot(
  createDatabase: () => Promise<DB>,
  input: unknown,
  expected: LocalRecoveryIdentity,
): Promise<LocalRecoverySnapshot> {
  // Copy and reject malformed or mismatched transport before allocating any database.
  const snapshot = requireLocalRecoveryIdentity(input, expected);
  localRecoveryAssetManifest(snapshot);
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
      throw new LocalRecoveryError("Local recovery validation requires the canonical schema");
    for (const table of canonicalSchemaManifest.filter(
      (entry) => entry.type === "table" && entry.name !== "__drizzle_migrations",
    ))
      if ((await tx.values(sql.raw(`SELECT 1 FROM ${quote(table.name)} LIMIT 1`))).length)
        throw new LocalRecoveryError("Local recovery validation requires an empty database");
    await tx.run(sql`SAVEPOINT local_recovery_validation`);
    try {
      for (const table of plan.loadOrder)
        for (const row of target.rows(table.name))
          await tx.run(statement(installationInsert(table.name, row)));
      if ((await tx.values(sql`PRAGMA foreign_key_check`)).length)
        throw new LocalRecoveryError("Local recovery validation foreign-key check failed");
      for (const table of plan.loadOrder) {
        const loaded = await tx.values(
          sql.raw(`SELECT ${captureRowSql(table.columns)} FROM ${quote(table.name)}`),
        );
        target.verifyInstalledRows(
          table.name,
          loaded.map((row) => {
            if (typeof row[0] !== "string")
              throw new LocalRecoveryError("Local recovery validation did not return a row image");
            return decodeCapturedRow(row[0]);
          }),
        );
      }
      await verifyActionConnection(execute);
    } finally {
      // Successful validation must leave no attachments, intents or pins in the isolated database.
      await tx.run(sql`ROLLBACK TO local_recovery_validation`);
      await tx.run(sql`RELEASE local_recovery_validation`);
    }
  });
  return snapshot;
}
