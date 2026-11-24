/** Stage reconstructed shared rows once after the same bundle's local snapshot. */
import { sql } from "drizzle-orm";
import { withReadTx, withTx, type DB, type Tx, type ReadTx } from "../database.js";
import { sharedRecoveryInstallationTable as receipt } from "../schema.js";
import { canonicalSchemaManifest } from "../generated/schema-manifest.js";
import { requireRecoveryDestinationSchema } from "./recovery-destination.js";
import { configureActionConnection, verifyActionConnection } from "./connection.js";
import {
  readLocalRecoveryInstallation,
  parseLocalRecoveryInstallationRecord,
} from "./local-recovery-installation.js";
import { parseLocalRecoveryIdentity, type LocalRecoveryIdentity } from "./local-recovery.js";
import {
  parseRecoveryBundleCheckpoint,
  type RecoveryBundleCheckpoint,
} from "./recovery-bundle-index.js";
import { requireSharedRecoveryCheckpoint } from "./shared-recovery-checkpoint.js";
import {
  SharedRecoveryError,
  sharedRecoveryPlan,
  validateSharedRecoveryProjection,
  writeSharedRecoveryProjection,
  verifySharedRecoveryProjection,
} from "./shared-recovery.js";
import { captureRowSql } from "./sql-codec.js";
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const shared = new Set(sharedRecoveryPlan.loadOrder.map((table) => table.name));
const protectedTables = canonicalSchemaManifest.filter(
  (entry) =>
    entry.type === "table" &&
    entry.name !== "shared_recovery_installation" &&
    !shared.has(entry.name),
);
function wanted(checkpoint: unknown, expected: LocalRecoveryIdentity) {
  const identity = parseLocalRecoveryIdentity(expected),
    value = parseRecoveryBundleCheckpoint(checkpoint);
  if (!same(value.runAssetCheckpoint.binding.localCheckpoint.identity, identity))
    throw new SharedRecoveryError("Shared installation identity mismatch");
  return { checkpoint: value, identity };
}
/** Historical receipt inspection never authorizes installation or activation. */
export function parseSharedRecoveryInstallationRecord(descriptor: unknown) {
  return parseLocalRecoveryInstallationRecord(descriptor);
}
export async function readSharedRecoveryInstallation(db: DB | Tx | ReadTx) {
  const row = await db
    .select({ descriptor: receipt.descriptor })
    .from(receipt)
    .where(sql`${receipt.id}=1`)
    .get();
  return row ? parseSharedRecoveryInstallationRecord(row.descriptor) : null;
}
export function inspectSharedRecoveryInstallation(db: DB) {
  return withReadTx(db, (tx) => readSharedRecoveryInstallation(tx));
}
async function checked(tx: Tx | ReadTx, checkpoint: RecoveryBundleCheckpoint) {
  await requireRecoveryDestinationSchema(tx);
  if (!same(await readLocalRecoveryInstallation(tx), checkpoint))
    throw new SharedRecoveryError("Shared installation requires the matching local installation");
  const existing = await readSharedRecoveryInstallation(tx);
  if (existing) {
    if (!same(existing, checkpoint))
      throw new SharedRecoveryError("Destination already has a different shared installation");
    return existing;
  }
  for (const table of sharedRecoveryPlan.loadOrder)
    if ((await tx.values(sql.raw(`SELECT 1 FROM ${quote(table.name)} LIMIT 1`))).length)
      throw new SharedRecoveryError("Shared installation requires empty shared tables");
  return null;
}
/** Matching receipts only acknowledge initial projection staging, not current rows or activation. */
export async function checkSharedRecoveryInstallation(
  db: DB,
  checkpoint: unknown,
  expected: LocalRecoveryIdentity,
) {
  const input = wanted(checkpoint, expected);
  return withReadTx(db, (tx) => checked(tx, input.checkpoint));
}
async function protectedRows(tx: Tx) {
  const result: Record<string, readonly string[]> = {};
  for (const table of protectedTables) {
    const columns = table.columns!.map((column) => String(column[1]));
    result[table.name] = (
      await tx.values(sql.raw(`SELECT ${captureRowSql(columns)} FROM ${quote(table.name)}`))
    )
      .map((row) => {
        if (typeof row[0] !== "string")
          throw new SharedRecoveryError("Shared installation did not return protected row images");
        return row[0];
      })
      .sort();
  }
  return result;
}
/** Trusted hosts verify the complete bundle before first staging. No history records or images are installed. */
export async function installSharedRecoverySnapshot(
  destination: DB,
  createValidationDatabase: () => Promise<DB>,
  input: unknown,
  checkpoint: unknown,
  expected: LocalRecoveryIdentity,
) {
  const request = wanted(checkpoint, expected);
  const sharedCheckpoint =
    request.checkpoint.runAssetCheckpoint.binding.checkpoint.checkpoint.checkpoint.checkpoint
      .checkpoint;
  const prepared = await requireSharedRecoveryCheckpoint(input, sharedCheckpoint, request.identity);
  const existing = await withReadTx(destination, (tx) => checked(tx, request.checkpoint));
  if (existing) return Object.freeze({ checkpoint: existing, changed: false });
  const snapshot = await validateSharedRecoveryProjection(async () => {
    const db = await createValidationDatabase();
    if (db === destination)
      throw new SharedRecoveryError("Shared installation requires a separate validation database");
    return db;
  }, prepared.projection);
  return withTx(destination, async (tx) => {
    await tx.run(sql`UPDATE shared_recovery_installation SET descriptor=descriptor WHERE 0`);
    const prior = await checked(tx, request.checkpoint);
    if (prior) return Object.freeze({ checkpoint: prior, changed: false });
    const execute = (query: string) => tx.values(sql.raw(query));
    await configureActionConnection(execute);
    const before = await protectedRows(tx);
    await writeSharedRecoveryProjection(tx, snapshot);
    await tx.insert(receipt).values({
      id: 1,
      descriptor: JSON.stringify(request.checkpoint),
      installedAt: Math.floor(Date.now() / 1000),
    });
    await verifySharedRecoveryProjection(tx, snapshot);
    if (!same(await protectedRows(tx), before))
      throw new SharedRecoveryError("Shared installation changed protected local metadata");
    if (!same(await readSharedRecoveryInstallation(tx), request.checkpoint))
      throw new SharedRecoveryError("Shared installation receipt changed during installation");
    await requireRecoveryDestinationSchema(tx);
    await verifyActionConnection(execute);
    return Object.freeze({ checkpoint: request.checkpoint, changed: true });
  });
}
