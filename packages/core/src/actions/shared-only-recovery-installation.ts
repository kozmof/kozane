/** Explicit shared-only staging never installs the source device's local rows. */
import { sql } from "drizzle-orm";
import { withReadTx, withTx, type DB, type Tx, type ReadTx } from "../database.js";
import { migrations } from "../generated/migrations.js";
import { canonicalSchemaManifest } from "../generated/schema-manifest.js";
import { sharedOnlyRecoveryInstallationTable as receipt } from "../schema.js";
import {
  requireRecoveryDestinationSchema,
  captureRecoveryDestinationRows,
} from "./recovery-destination.js";
import { configureActionConnection, verifyActionConnection } from "./connection.js";
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
export interface SharedOnlyRecoveryInstallation {
  readonly checkpoint: RecoveryBundleCheckpoint;
  readonly destinationIdentity: LocalRecoveryIdentity;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const mutableTables = new Set([
  ...sharedRecoveryPlan.loadOrder.map((table) => table.name),
  "shared_only_recovery_installation",
]);
function compatible(source: LocalRecoveryIdentity, destination: LocalRecoveryIdentity) {
  for (const key of ["workspaceId", "epochId", "checkpointId", "schemaId"] as const)
    if (source[key] !== destination[key])
      throw new SharedRecoveryError("Shared-only destination identity mismatch");
}
function wanted(
  checkpoint: unknown,
  expected: LocalRecoveryIdentity,
  destinationExpected: LocalRecoveryIdentity,
): SharedOnlyRecoveryInstallation {
  const source = parseLocalRecoveryIdentity(expected),
    destinationIdentity = parseLocalRecoveryIdentity(destinationExpected),
    value = parseRecoveryBundleCheckpoint(checkpoint);
  if (!same(value.runAssetCheckpoint.binding.localCheckpoint.identity, source))
    throw new SharedRecoveryError("Shared-only source identity mismatch");
  compatible(source, destinationIdentity);
  return Object.freeze({ checkpoint: value, destinationIdentity });
}
/** Known historical metadata remains readable without authorizing staging. */
export function parseSharedOnlyRecoveryInstallationRecord(
  descriptor: unknown,
  destinationDescriptor: unknown,
): SharedOnlyRecoveryInstallation {
  if (typeof descriptor !== "string" || typeof destinationDescriptor !== "string")
    throw new SharedRecoveryError("Shared-only installation descriptors require TEXT");
  const checkpoint = parseRecoveryBundleCheckpoint(JSON.parse(descriptor)),
    destinationIdentity = parseLocalRecoveryIdentity(
      JSON.parse(destinationDescriptor),
      migrations.map((m) => m.id),
    );
  compatible(checkpoint.runAssetCheckpoint.binding.localCheckpoint.identity, destinationIdentity);
  return Object.freeze({ checkpoint, destinationIdentity });
}
export async function readSharedOnlyRecoveryInstallation(db: DB | Tx | ReadTx) {
  const row = await db
    .select({ descriptor: receipt.descriptor, destinationIdentity: receipt.destinationIdentity })
    .from(receipt)
    .where(sql`${receipt.id}=1`)
    .get();
  return row
    ? parseSharedOnlyRecoveryInstallationRecord(row.descriptor, row.destinationIdentity)
    : null;
}
export function inspectSharedOnlyRecoveryInstallation(db: DB) {
  return withReadTx(db, (tx) => readSharedOnlyRecoveryInstallation(tx));
}
async function checked(tx: Tx | ReadTx, request: SharedOnlyRecoveryInstallation) {
  await requireRecoveryDestinationSchema(tx);
  const existing = await readSharedOnlyRecoveryInstallation(tx);
  if (existing) {
    if (!same(existing, request))
      throw new SharedRecoveryError("Destination already has a different shared-only installation");
    return existing;
  }
  for (const table of canonicalSchemaManifest.filter(
    (entry) => entry.type === "table" && entry.name !== "__drizzle_migrations",
  )) {
    const name = '"' + table.name.replaceAll('"', '""') + '"';
    if ((await tx.values(sql.raw(`SELECT 1 FROM ${name} LIMIT 1`))).length)
      throw new SharedRecoveryError("Shared-only installation requires an empty destination");
  }
  return null;
}
/** A matching record acknowledges initial staging, not current rows or activation. */
export async function checkSharedOnlyRecoveryInstallation(
  db: DB,
  checkpoint: unknown,
  expected: LocalRecoveryIdentity,
  destinationExpected: LocalRecoveryIdentity,
) {
  const request = wanted(checkpoint, expected, destinationExpected);
  return withReadTx(db, (tx) => checked(tx, request));
}
/** Trusted hosts validate the complete bundle before first staging. Only shared application rows are installed. */
export async function installSharedOnlyRecoverySnapshot(
  destination: DB,
  createValidationDatabase: () => Promise<DB>,
  input: unknown,
  checkpoint: unknown,
  expected: LocalRecoveryIdentity,
  destinationExpected: LocalRecoveryIdentity,
) {
  const request = wanted(checkpoint, expected, destinationExpected),
    source = request.checkpoint.runAssetCheckpoint.binding.localCheckpoint.identity;
  const sharedCheckpoint =
    request.checkpoint.runAssetCheckpoint.binding.checkpoint.checkpoint.checkpoint.checkpoint
      .checkpoint;
  const prepared = await requireSharedRecoveryCheckpoint(input, sharedCheckpoint, source);
  const existing = await withReadTx(destination, (tx) => checked(tx, request));
  if (existing) return Object.freeze({ ...existing, changed: false });
  const snapshot = await validateSharedRecoveryProjection(async () => {
    const db = await createValidationDatabase();
    if (db === destination)
      throw new SharedRecoveryError(
        "Shared-only installation requires a separate validation database",
      );
    return db;
  }, prepared.projection);
  return withTx(destination, async (tx) => {
    await tx.run(sql`UPDATE shared_only_recovery_installation SET descriptor=descriptor WHERE 0`);
    const prior = await checked(tx, request);
    if (prior) return Object.freeze({ ...prior, changed: false });
    const execute = (query: string) => tx.values(sql.raw(query));
    await configureActionConnection(execute);
    const before = await captureRecoveryDestinationRows(tx, mutableTables);
    await writeSharedRecoveryProjection(tx, snapshot);
    await tx.insert(receipt).values({
      id: 1,
      descriptor: JSON.stringify(request.checkpoint),
      destinationIdentity: JSON.stringify(request.destinationIdentity),
      installedAt: Math.floor(Date.now() / 1000),
    });
    await verifySharedRecoveryProjection(tx, snapshot);
    if (!same(await captureRecoveryDestinationRows(tx, mutableTables), before))
      throw new SharedRecoveryError(
        "Shared-only installation changed protected destination metadata",
      );
    if (!same(await readSharedOnlyRecoveryInstallation(tx), request))
      throw new SharedRecoveryError("Shared-only installation record changed during installation");
    await requireRecoveryDestinationSchema(tx);
    await verifyActionConnection(execute);
    return Object.freeze({ ...request, changed: true });
  });
}
