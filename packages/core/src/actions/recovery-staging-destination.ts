/** Authenticate destination staging metadata without treating it as activation authority. */
import { withReadTx, type DB, type Tx, type ReadTx } from "../database.js";
import { parseLocalRecoveryIdentity, type LocalRecoveryIdentity } from "./local-recovery.js";
import {
  parseRecoveryBundleCheckpoint,
  type RecoveryBundleCheckpoint,
} from "./recovery-bundle-index.js";
import { readLocalRecoveryInstallation } from "./local-recovery-installation.js";
import { readSharedRecoveryInstallation } from "./shared-recovery-installation.js";
import { readSharedOnlyRecoveryInstallation } from "./shared-only-recovery-installation.js";
import { requireRecoveryDestinationSchema } from "./recovery-destination.js";
import { SharedRecoveryError } from "./shared-recovery.js";
export interface RecoveryStagingDestination {
  readonly checkpoint: RecoveryBundleCheckpoint;
  readonly destinationIdentity: LocalRecoveryIdentity;
  readonly mode: "complete" | "shared-only";
}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function request(
  checkpoint: unknown,
  expected: LocalRecoveryIdentity,
  destinationExpected: LocalRecoveryIdentity,
  mode: RecoveryStagingDestination["mode"],
): RecoveryStagingDestination {
  const source = parseLocalRecoveryIdentity(expected),
    destinationIdentity = parseLocalRecoveryIdentity(destinationExpected),
    value = parseRecoveryBundleCheckpoint(checkpoint);
  if (mode !== "complete" && mode !== "shared-only")
    throw new SharedRecoveryError("Choose an explicit recovery staging mode");
  if (!same(value.runAssetCheckpoint.binding.localCheckpoint.identity, source))
    throw new SharedRecoveryError("Recovery staging source identity mismatch");
  for (const key of ["workspaceId", "epochId", "checkpointId", "schemaId"] as const)
    if (source[key] !== destinationIdentity[key])
      throw new SharedRecoveryError("Recovery staging destination identity mismatch");
  if (mode === "complete" && source.deviceId !== destinationIdentity.deviceId)
    throw new SharedRecoveryError("Complete recovery requires the originating device identity");
  return Object.freeze({ checkpoint: value, destinationIdentity, mode });
}
async function read(tx: Tx | ReadTx, input: RecoveryStagingDestination) {
  await requireRecoveryDestinationSchema(tx);
  const local = await readLocalRecoveryInstallation(tx),
    shared = await readSharedRecoveryInstallation(tx),
    sharedOnly = await readSharedOnlyRecoveryInstallation(tx);
  if (input.mode === "complete") {
    if (sharedOnly)
      throw new SharedRecoveryError(
        "Recovery staging mode conflicts with shared-only installation",
      );
    if (!same(local, input.checkpoint) || !same(shared, input.checkpoint))
      throw new SharedRecoveryError(
        "Recovery destination requires matching local and shared installations",
      );
  } else {
    if (local || shared)
      throw new SharedRecoveryError("Recovery staging mode conflicts with complete installation");
    if (
      !same(sharedOnly, {
        checkpoint: input.checkpoint,
        destinationIdentity: input.destinationIdentity,
      })
    )
      throw new SharedRecoveryError(
        "Recovery destination requires matching shared-only installation",
      );
  }
  return input;
}
/** The caller owns a consistent read or write transaction. This checks metadata, not current row equality. */
export async function readRecoveryStagingDestination(
  tx: Tx | ReadTx,
  checkpoint: unknown,
  expected: LocalRecoveryIdentity,
  destinationExpected: LocalRecoveryIdentity,
  mode: RecoveryStagingDestination["mode"],
) {
  return read(tx, request(checkpoint, expected, destinationExpected, mode));
}
/** Own both host identities and the descriptor before opening a consistent read snapshot. */
export async function inspectRecoveryStagingDestination(
  db: DB,
  checkpoint: unknown,
  expected: LocalRecoveryIdentity,
  destinationExpected: LocalRecoveryIdentity,
  mode: RecoveryStagingDestination["mode"],
) {
  const input = request(checkpoint, expected, destinationExpected, mode);
  return withReadTx(db, (tx) => read(tx, input));
}
