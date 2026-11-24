/** Explicitly stage one local snapshot from a complete registered bundle. No activation or filesystem actions run. */
import type { DB } from "../../db/database.js";
import {
  checkLocalRecoveryInstallation,
  installLocalRecoverySnapshot,
  parseLocalRecoveryIdentity,
  parseRecoveryBundleCheckpoint,
} from "@kozane/core/recovery";
import { loadRegisteredRecoveryBundle } from "./recovery-bundle.js";

type Options = Parameters<typeof loadRegisteredRecoveryBundle>[0] & { destination: DB };
export async function installRegisteredRecoveryBundleLocalSnapshot(options: Options) {
  const {
    root,
    db,
    destination,
    createValidationDatabase,
    maxBytes,
    localMaxBytes,
    sharedMaxBytes,
    executionMaxBytes,
    actionMaxBytes,
    actionArchiveMaxBytes,
    runArchiveMaxBytes,
    assetMaxBytes,
    runAssetMaxBytes,
  } = options;
  if (
    ![
      maxBytes,
      localMaxBytes,
      sharedMaxBytes,
      executionMaxBytes,
      actionMaxBytes,
      actionArchiveMaxBytes,
      runArchiveMaxBytes,
      assetMaxBytes,
      runAssetMaxBytes,
    ].every((n) => Number.isSafeInteger(n) && n > 0)
  )
    throw new Error("Payload read limits must be positive safe integers");
  const expected = parseLocalRecoveryIdentity(options.expected),
    checkpoint = parseRecoveryBundleCheckpoint(options.checkpoint);
  const already = await checkLocalRecoveryInstallation(destination, checkpoint, expected);
  if (already) return Object.freeze({ checkpoint: already, changed: false });
  const bundle = await loadRegisteredRecoveryBundle({
    root,
    db,
    expected,
    checkpoint,
    createValidationDatabase,
    maxBytes,
    localMaxBytes,
    sharedMaxBytes,
    executionMaxBytes,
    actionMaxBytes,
    actionArchiveMaxBytes,
    runArchiveMaxBytes,
    assetMaxBytes,
    runAssetMaxBytes,
  });
  return installLocalRecoverySnapshot(
    destination,
    createValidationDatabase,
    bundle.contents.localSnapshot,
    checkpoint,
    expected,
  );
}
