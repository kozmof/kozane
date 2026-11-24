/** Stage local rows once in an empty destination. This never activates a workspace. */
import { sql } from "drizzle-orm";
import { withReadTx, withTx, type DB, type Tx, type ReadTx } from "../database.js";
import { localRecoveryInstallationTable as receipt } from "../schema.js";
import { canonicalSchemaManifest } from "../generated/schema-manifest.js";
import { readSchemaManifest } from "../migrations/schema-reader.js";
import { compareSchemaManifests } from "../migrations/schema.js";
import { validateMigrationHistory } from "../migrations/history.js";
import { localTableNames } from "./local-tables.js";
import { createRestorationPlan } from "./restoration-plan.js";
import { createRowProjection } from "./projection.js";
import {
  captureRowSql,
  decodeCapturedRow,
  installationInsert,
  type InstallationValue,
} from "./sql-codec.js";
import { configureActionConnection, verifyActionConnection } from "./connection.js";
import {
  LocalRecoveryError,
  parseLocalRecoveryIdentity,
  requireLocalRecoveryIdentity,
  type LocalRecoveryIdentity,
} from "./local-recovery.js";
import { requireLocalRecoveryCheckpoint } from "./local-recovery-checkpoint.js";
import { validateLocalRecoveryCheckpoint } from "./local-recovery-validation.js";
import {
  parseRecoveryBundleCheckpoint,
  type RecoveryBundleCheckpoint,
} from "./recovery-bundle-index.js";

const plan = createRestorationPlan(canonicalSchemaManifest, localTableNames);
const tables = canonicalSchemaManifest.filter(
  (entry) => entry.type === "table" && entry.name !== "__drizzle_migrations",
);
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function wanted(checkpoint: unknown, expected: LocalRecoveryIdentity) {
  const identity = parseLocalRecoveryIdentity(expected),
    value = parseRecoveryBundleCheckpoint(checkpoint);
  if (!same(value.runAssetCheckpoint.binding.localCheckpoint.identity, identity))
    throw new LocalRecoveryError("Local installation identity mismatch");
  return { checkpoint: value, identity };
}
/** Inspect known historical destination metadata without converting its installation timestamp. */
export function parseLocalRecoveryInstallationRecord(descriptor: unknown) {
  if (typeof descriptor !== "string")
    throw new LocalRecoveryError("Installation descriptor requires TEXT");
  return parseRecoveryBundleCheckpoint(JSON.parse(descriptor));
}
export async function readLocalRecoveryInstallation(db: DB | Tx | ReadTx) {
  const row = await db
    .select({ descriptor: receipt.descriptor })
    .from(receipt)
    .where(sql`${receipt.id}=1`)
    .get();
  return row ? parseLocalRecoveryInstallationRecord(row.descriptor) : null;
}
export function inspectLocalRecoveryInstallation(db: DB) {
  return withReadTx(db, (tx) => readLocalRecoveryInstallation(tx));
}
async function schema(tx: Tx | ReadTx) {
  const actual = await readSchemaManifest(async (query) =>
    (await tx.values(sql.raw(query))).map((row) => Array.from(row)),
  );
  if (!compareSchemaManifests(actual).matches)
    throw new LocalRecoveryError("Local installation requires the canonical destination schema");
  const history = await tx.values(
    sql`SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at`,
  );
  validateMigrationHistory(
    history.map((row) => ({ hash: row[0], created_at: row[1] })),
    "complete",
  );
}
async function empty(tx: Tx | ReadTx, names = tables.map((t) => t.name)) {
  for (const name of names)
    if ((await tx.values(sql.raw(`SELECT 1 FROM ${quote(name)} LIMIT 1`))).length)
      throw new LocalRecoveryError("Local installation requires an empty destination");
}
async function checked(tx: Tx | ReadTx, checkpoint: RecoveryBundleCheckpoint) {
  await schema(tx);
  const existing = await readLocalRecoveryInstallation(tx);
  if (existing) {
    if (!same(existing, checkpoint))
      throw new LocalRecoveryError("Destination already has a different local installation");
    return existing;
  }
  await empty(tx);
  return null;
}
/** A matching local receipt only acknowledges earlier staging. It never authorizes activation. */
export async function checkLocalRecoveryInstallation(
  db: DB,
  checkpoint: unknown,
  expected: LocalRecoveryIdentity,
) {
  const input = wanted(checkpoint, expected);
  return withReadTx(db, (tx) => checked(tx, input.checkpoint));
}
function statement(value: InstallationValue) {
  const parts = value.sql.split("?");
  if (parts.length !== value.args.length + 1)
    throw new LocalRecoveryError("Invalid local installation statement");
  return sql.join(
    parts.flatMap((part, i) =>
      i === 0 ? [sql.raw(part)] : [sql`${value.args[i - 1]}`, sql.raw(part)],
    ),
    sql``,
  );
}
/** Install owned, independently validated local data with one immutable destination receipt. */
export async function installLocalRecoverySnapshot(
  destination: DB,
  createValidationDatabase: () => Promise<DB>,
  input: unknown,
  checkpoint: unknown,
  expected: LocalRecoveryIdentity,
) {
  const request = wanted(checkpoint, expected),
    snapshot = requireLocalRecoveryIdentity(input, request.identity),
    localCheckpoint = request.checkpoint.runAssetCheckpoint.binding.localCheckpoint;
  await requireLocalRecoveryCheckpoint(snapshot, localCheckpoint);
  const existing = await withReadTx(destination, (tx) => checked(tx, request.checkpoint));
  if (existing) return Object.freeze({ checkpoint: existing, changed: false });
  const validated = await validateLocalRecoveryCheckpoint(
    async () => {
      const db = await createValidationDatabase();
      if (db === destination)
        throw new LocalRecoveryError("Local installation requires a separate validation database");
      return db;
    },
    snapshot,
    localCheckpoint,
    request.identity,
  );
  const projection = createRowProjection(
    plan.loadOrder,
    validated.tables.flatMap((table) => table.rows.map((row) => ({ table: table.name, row }))),
  );
  return withTx(destination, async (tx) => {
    await tx.run(sql`UPDATE local_recovery_installation SET descriptor=descriptor WHERE 0`);
    const prior = await checked(tx, request.checkpoint);
    if (prior) return Object.freeze({ checkpoint: prior, changed: false });
    const execute = (query: string) => tx.values(sql.raw(query));
    await configureActionConnection(execute);
    for (const table of plan.loadOrder)
      for (const row of projection.rows(table.name))
        await tx.run(statement(installationInsert(table.name, row)));
    await tx.insert(receipt).values({
      id: 1,
      descriptor: JSON.stringify(request.checkpoint),
      installedAt: Math.floor(Date.now() / 1000),
    });
    if ((await tx.values(sql`PRAGMA foreign_key_check`)).length)
      throw new LocalRecoveryError("Local installation foreign-key check failed");
    for (const table of plan.loadOrder) {
      const rows = await tx.values(
        sql.raw(`SELECT ${captureRowSql(table.columns)} FROM ${quote(table.name)}`),
      );
      projection.verifyInstalledRows(
        table.name,
        rows.map((row) => {
          if (typeof row[0] !== "string")
            throw new LocalRecoveryError("Local installation did not return a row image");
          return decodeCapturedRow(row[0]);
        }),
      );
    }
    await empty(
      tx,
      tables
        .filter(
          (t) => !localTableNames.includes(t.name) && t.name !== "local_recovery_installation",
        )
        .map((t) => t.name),
    );
    if (!same(await readLocalRecoveryInstallation(tx), request.checkpoint))
      throw new LocalRecoveryError("Local installation receipt changed during installation");
    await schema(tx);
    await verifyActionConnection(execute);
    return Object.freeze({ checkpoint: request.checkpoint, changed: true });
  });
}
