import { sql } from "drizzle-orm";
import {
  withMigration,
  withReadTx,
  type DB,
  type DatabaseHandle,
  type MigrationBatchStatement,
} from "../database.js";
import { schemaVersion } from "../generated/migrations.js";
import type {
  MigrationHistoryMode,
  MigrationHistoryValidation,
  MigrationApplicationResult,
} from "../migration-types.js";
import { validateMigrationHistory } from "./history.js";
import { migrationHistoryTableSql } from "./history-sql.js";

async function history(handle: DatabaseHandle): Promise<unknown[]> {
  const rows = await handle.values<unknown[]>(
    sql`SELECT hash, created_at FROM "__drizzle_migrations" ORDER BY created_at`,
  );
  return rows.map((row) => ({ hash: row[0], created_at: row[1] }));
}
/** Read actual candidate history consistently without creating or repairing its table. */
export async function validateDatabaseMigrationHistory(
  db: DB,
  mode: MigrationHistoryMode,
): Promise<MigrationHistoryValidation> {
  return withReadTx(db, async (tx) => {
    const tables = await tx.values(
      sql`SELECT name FROM sqlite_schema WHERE type = 'table' AND name = '__drizzle_migrations'`,
    );
    return validateMigrationHistory(tables.length ? await history(tx) : [], mode);
  });
}
/** Strict application for new public consumers. The ordinary Node compatibility path is separate. */
export async function applyMigrations(db: DB): Promise<MigrationApplicationResult> {
  let appliedIds: readonly string[] = [];
  await withMigration(db, async (handle) => {
    // Match Drizzle's history format and initialization outside the atomic migration batch.
    await handle.run(sql.raw(migrationHistoryTableSql));
    const prefix = validateMigrationHistory(await history(handle), "prefix");
    appliedIds = Object.freeze(prefix.pending.map((record) => record.id));
    const statements: MigrationBatchStatement[] = [];
    for (const record of prefix.pending) {
      for (const statement of record.statements)
        statements.push(Object.freeze({ sql: statement, args: Object.freeze([]) }));
      statements.push(
        Object.freeze({
          sql: 'INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)',
          args: Object.freeze([record.hash, record.when]),
        }),
      );
    }
    return Object.freeze(statements);
  });
  // Do not report success until the committed database contains the complete expected history.
  await validateDatabaseMigrationHistory(db, "complete");
  return Object.freeze({ schemaVersion, appliedIds });
}
