/** Inspect current pending journal evidence from a staged complete recovery without replay. */
import { sql } from "drizzle-orm";
import { withReadTx, type DB, type Tx, type ReadTx } from "../database.js";
import { canonicalSchemaManifest } from "../generated/schema-manifest.js";
import {
  parseLocalRecoveryIdentity,
  LocalRecoveryError,
  type LocalRecoveryIdentity,
} from "./local-recovery.js";
import {
  parseRecoveryBundleCheckpoint,
  type RecoveryBundleCheckpoint,
} from "./recovery-bundle-index.js";
import { readLocalRecoveryInstallation } from "./local-recovery-installation.js";
import { requireRecoveryDestinationSchema } from "./recovery-destination.js";
import { captureRowSql, decodeCapturedRow } from "./sql-codec.js";
import type { TaggedRow } from "./row-codec.js";
export interface PendingRecoveryFileOperationOptions {
  readonly limit?: number;
  readonly offset?: number;
}
export interface PendingRecoveryFileOperationPage {
  readonly checkpoint: RecoveryBundleCheckpoint;
  readonly total: string;
  readonly offset: number;
  readonly limit: number;
  readonly operations: readonly TaggedRow[];
  readonly nextOffset: number | null;
}
const columns = canonicalSchemaManifest
  .find((entry) => entry.type === "table" && entry.name === "local_file_operation")!
  .columns!.map((column) => String(column[1]));
function request(
  checkpoint: unknown,
  expected: LocalRecoveryIdentity,
  options: PendingRecoveryFileOperationOptions,
) {
  const identity = parseLocalRecoveryIdentity(expected),
    value = parseRecoveryBundleCheckpoint(checkpoint),
    limit = options.limit === undefined ? 25 : options.limit,
    offset = options.offset === undefined ? 0 : options.offset;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    throw new LocalRecoveryError(
      "Pending recovery inspection requires a limit from 1 to 100 and a safe nonnegative offset",
    );
  if (
    JSON.stringify(value.runAssetCheckpoint.binding.localCheckpoint.identity) !==
    JSON.stringify(identity)
  )
    throw new LocalRecoveryError("Pending recovery inspection identity mismatch");
  return Object.freeze({ checkpoint: value, limit, offset });
}
async function readPage(
  tx: Tx | ReadTx,
  input: ReturnType<typeof request>,
): Promise<PendingRecoveryFileOperationPage> {
  await requireRecoveryDestinationSchema(tx);
  const installed = await readLocalRecoveryInstallation(tx);
  if (JSON.stringify(installed) !== JSON.stringify(input.checkpoint))
    throw new LocalRecoveryError(
      "Pending recovery inspection requires the matching local installation",
    );
  const counts = await tx.values(
    sql`SELECT CAST(count(*) AS TEXT) FROM local_file_operation WHERE state='pending'`,
  );
  const total = counts[0]?.[0];
  if (
    typeof total !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(total) ||
    BigInt(total) > 9223372036854775807n
  )
    throw new LocalRecoveryError("Pending recovery count requires exact nonnegative INTEGER text");
  const rows = await tx.values(
    sql`SELECT ${sql.raw(captureRowSql(columns))} FROM local_file_operation WHERE state='pending' ORDER BY id COLLATE BINARY LIMIT ${input.limit} OFFSET ${input.offset}`,
  );
  const operations = Object.freeze(
    rows.map((row) => {
      if (typeof row[0] !== "string")
        throw new LocalRecoveryError("Pending recovery inspection did not return a row image");
      return decodeCapturedRow(row[0]);
    }),
  );
  const next = BigInt(input.offset) + BigInt(operations.length);
  if (next < BigInt(total) && next > BigInt(Number.MAX_SAFE_INTEGER))
    throw new LocalRecoveryError("Pending recovery inspection offset exceeds the safe range");
  return Object.freeze({
    ...input,
    total,
    operations,
    nextOffset: next < BigInt(total) ? Number(next) : null,
  });
}
/** Reuse the caller's consistent transaction. Receipt metadata acknowledges staging, not current-row equality. */
export async function readPendingRecoveryFileOperations(
  tx: Tx | ReadTx,
  checkpoint: unknown,
  expected: LocalRecoveryIdentity,
  options: PendingRecoveryFileOperationOptions = {},
) {
  return readPage(tx, request(checkpoint, expected, options));
}
/** Own expectations before opening one read snapshot. No validation databases or filesystem callbacks run. */
export async function inspectPendingRecoveryFileOperations(
  db: DB,
  checkpoint: unknown,
  expected: LocalRecoveryIdentity,
  options: PendingRecoveryFileOperationOptions = {},
) {
  const input = request(checkpoint, expected, options);
  return withReadTx(db, (tx) => readPage(tx, input));
}
