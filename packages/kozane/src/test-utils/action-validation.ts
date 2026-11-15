/** Test-only isolated validation. This does not install a live workspace or enable restore mode. */
import { sql } from "drizzle-orm";
import { withTx, type DB } from "../../../core/src/database.js";
import {
  configureActionConnection,
  verifyActionConnection,
} from "../../../core/src/actions/connection.js";
import { createRestorationPlan } from "../../../core/src/actions/restoration-plan.js";
import { createRowProjection } from "../../../core/src/actions/projection.js";
import { installationInsert, type InstallationValue } from "../../../core/src/actions/sql-codec.js";
import { canonicalSchemaManifest } from "../../../core/src/generated/schema-manifest.js";
import { compareSchemaManifests } from "../../../core/src/migrations/schema.js";
import { readSchemaManifest } from "../../../core/src/migrations/schema-reader.js";
import { capturedTables, captureApplicationRows } from "./action-tables.js";

export function installationStatement(value: InstallationValue) {
  // The canonical application identifiers contain no question marks.
  const parts = value.sql.split("?");
  if (parts.length !== value.args.length + 1)
    throw new Error("Unexpected installation placeholders");
  return sql.join(
    parts.flatMap((part, index) =>
      index === 0 ? [sql.raw(part)] : [sql`${value.args[index - 1]}`, sql.raw(part)],
    ),
    sql``,
  );
}

export async function validateApplicationProjection(
  createDatabase: () => Promise<DB>,
  target: ReturnType<typeof createRowProjection>,
) {
  const plan = createRestorationPlan(
    canonicalSchemaManifest,
    capturedTables.map(({ name }) => name),
  );
  // Copy and validate all complete target images before allocating the validation database.
  const snapshot = createRowProjection(
    plan.loadOrder,
    plan.loadOrder.flatMap(({ name }) => target.rows(name).map((row) => ({ table: name, row }))),
  );
  const db = await createDatabase();
  await withTx(db, async (tx) => {
    await configureActionConnection((query) => tx.values(sql.raw(query)));
    const actual = await readSchemaManifest(async (query) =>
      (await tx.values(sql.raw(query))).map((row) => Array.from(row)),
    );
    if (!compareSchemaManifests(actual).matches)
      throw new Error("Validation requires the canonical schema");
    if ((await captureApplicationRows(tx)).length)
      throw new Error("Validation requires an empty database");
    // Remove only the two mutating triggers inside this isolated validation transaction.
    // Keep all table constraints, indexes, FKs and validation-only triggers active.
    await tx.run(sql`DROP TRIGGER card_inventory_clear_slot`);
    await tx.run(sql`DROP TRIGGER card_stamp_missing_timestamps`);
    for (const { name } of plan.loadOrder)
      for (const row of snapshot.rows(name))
        await tx.run(installationStatement(installationInsert(name, row)));
    if ((await tx.values(sql`PRAGMA foreign_key_check`)).length)
      throw new Error("Validation foreign-key check failed");
    if (
      (
        await tx.values(
          sql`SELECT id FROM card WHERE (inventory_id IS NULL) <> (inventory_slot IS NULL)`,
        )
      ).length
    )
      throw new Error("Validation inventory pair invariant failed");
    const loaded = await captureApplicationRows(tx);
    for (const { name } of plan.loadOrder)
      snapshot.verifyInstalledRows(
        name,
        loaded.filter(({ table }) => table === name).map(({ row }) => row),
      );
    await verifyActionConnection((query) => tx.values(sql.raw(query)));
  });
  return db;
}
